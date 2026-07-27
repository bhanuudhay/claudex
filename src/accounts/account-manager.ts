import type {
  AccountConfig,
  AccountHealth,
  AccountState,
  ClaudexConfig,
  Failure,
  PersistedState,
} from '../types.js';
import { StateStore } from '../state/state-store.js';

/** Default cooldowns when the CLI did not tell us when the limit resets. */
const COOLDOWN_MS = {
  five_hour: 5 * 60 * 60 * 1000,
  seven_day: 7 * 24 * 60 * 60 * 1000,
  rate_limit: 60 * 1000,
  overloaded: 30 * 1000,
  auth_expired: 60 * 60 * 1000,
  credit_exhausted: 24 * 60 * 60 * 1000,
} as const;

export interface AccountView {
  config: AccountConfig;
  state: AccountState;
  /** False while a cooldown is still running or the account needs re-auth. */
  eligible: boolean;
}

export function defaultAccountState(): AccountState {
  return { health: 'unknown', consecutiveFailures: 0 };
}

/** Compute when an account should become selectable again after `failure`. */
export function cooldownFor(failure: Failure, now: Date): { until: Date; health: AccountHealth } {
  if (failure.resetsAt && failure.resetsAt.getTime() > now.getTime()) {
    const health: AccountHealth =
      failure.class === 'rate_limit'
        ? 'rate_limited'
        : failure.class === 'auth_expired'
          ? 'needs_reauth'
          : 'exhausted';
    return { until: failure.resetsAt, health };
  }

  switch (failure.class) {
    case 'usage_limit': {
      const ms = failure.window && failure.window.startsWith('seven_day')
        ? COOLDOWN_MS.seven_day
        : COOLDOWN_MS.five_hour;
      return { until: new Date(now.getTime() + ms), health: 'exhausted' };
    }
    case 'rate_limit':
      return { until: new Date(now.getTime() + COOLDOWN_MS.rate_limit), health: 'rate_limited' };
    case 'overloaded':
      // Server-side, not account-side: a short pause, and the account stays healthy.
      return { until: new Date(now.getTime() + COOLDOWN_MS.overloaded), health: 'ok' };
    case 'auth_expired':
      return { until: new Date(now.getTime() + COOLDOWN_MS.auth_expired), health: 'needs_reauth' };
    case 'credit_exhausted':
      return { until: new Date(now.getTime() + COOLDOWN_MS.credit_exhausted), health: 'exhausted' };
    default:
      return { until: now, health: 'unknown' };
  }
}

export function isEligible(state: AccountState, now: Date): boolean {
  if (state.health === 'needs_reauth') return false;
  if (!state.cooldownUntil) return true;
  return new Date(state.cooldownUntil).getTime() <= now.getTime();
}

/**
 * Owns the merge of static configuration with persisted runtime state, and is
 * the only writer of that state. Rotation and retry read from it; they never
 * touch the store directly.
 */
export class AccountManager {
  readonly config: ClaudexConfig;
  readonly #store: StateStore;
  #state: PersistedState;

  private constructor(config: ClaudexConfig, store: StateStore, state: PersistedState) {
    this.config = config;
    this.#store = store;
    this.#state = state;
  }

  static async create(config: ClaudexConfig, store: StateStore = new StateStore()): Promise<AccountManager> {
    const state = await store.read();
    return new AccountManager(config, store, state);
  }

  get state(): PersistedState {
    return this.#state;
  }

  get store(): StateStore {
    return this.#store;
  }

  stateOf(name: string): AccountState {
    return this.#state.accounts[name] ?? defaultAccountState();
  }

  find(name: string): AccountConfig | undefined {
    const lower = name.toLowerCase();
    return this.config.accounts.find((account) => account.name.toLowerCase() === lower);
  }

  /** All accounts in priority order, annotated with current eligibility. */
  views(now: Date = new Date()): AccountView[] {
    return [...this.config.accounts]
      .map((config, index) => ({ config, index }))
      .sort((a, b) => a.config.priority - b.config.priority || a.index - b.index)
      .map(({ config }) => {
        const state = this.stateOf(config.name);
        return { config, state, eligible: !config.unconfigured && isEligible(state, now) };
      });
  }

  async markSuccess(name: string, sessionId?: string): Promise<void> {
    this.#state = await this.#store.update((state) => {
      const existing = state.accounts[name] ?? defaultAccountState();
      state.accounts[name] = {
        ...existing,
        health: 'ok',
        consecutiveFailures: 0,
        lastOk: new Date().toISOString(),
        reason: undefined,
        cooldownUntil: undefined,
      };
      state.activeAccount = name;
      if (sessionId) state.lastSessionId = sessionId;
    });
  }

  async markFailure(name: string, failure: Failure, now: Date = new Date()): Promise<void> {
    const { until, health } = cooldownFor(failure, now);
    this.#state = await this.#store.update((state) => {
      const existing = state.accounts[name] ?? defaultAccountState();
      state.accounts[name] = {
        ...existing,
        health,
        reason: failure.window ?? failure.class,
        cooldownUntil: until.getTime() > now.getTime() ? until.toISOString() : undefined,
        consecutiveFailures: existing.consecutiveFailures + 1,
      };
      state.lastRotationReason = `${name}: ${failure.window ?? failure.class}`;
    });
  }

  async setActive(name: string, sessionId?: string): Promise<void> {
    this.#state = await this.#store.update((state) => {
      state.activeAccount = name;
      if (sessionId) state.lastSessionId = sessionId;
    });
  }

  async setPinned(name: string | undefined): Promise<void> {
    this.#state = await this.#store.update((state) => {
      state.pinnedAccount = name;
    });
  }

  async setFdInjectionWorks(works: boolean): Promise<void> {
    if (this.#state.fdInjectionWorks === works) return;
    this.#state = await this.#store.update((state) => {
      state.fdInjectionWorks = works;
    });
  }

  /** Clear cooldowns for one account, or all of them. */
  async reset(name?: string): Promise<void> {
    this.#state = await this.#store.update((state) => {
      if (name) delete state.accounts[name];
      else state.accounts = {};
    });
  }
}
