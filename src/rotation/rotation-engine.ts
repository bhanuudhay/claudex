import type { AccountConfig } from '../types.js';
import type { AccountManager, AccountView } from '../accounts/account-manager.js';

export interface SelectOptions {
  /** Accounts already tried (and failed) during this invocation. */
  excluded?: ReadonlySet<string>;
  /** Explicit account requested for this run, or pinned via `claudex use`. */
  pinned?: string;
  now?: Date;
}

/**
 * Chooses which account runs next.
 *
 * Ordering is deterministic — priority ascending, then declaration order — so
 * two shells started at the same time make the same choice and users can reason
 * about which account is being spent.
 *
 * The active account is sticky across invocations: once a run succeeds on
 * "Work", later runs stay on "Work" rather than snapping back to the highest
 * priority account. That keeps prompt caching warm on one org instead of
 * thrashing between accounts on every command.
 */
export class RotationEngine {
  readonly #manager: AccountManager;

  constructor(manager: AccountManager) {
    this.#manager = manager;
  }

  select(options: SelectOptions = {}): AccountConfig | null {
    const now = options.now ?? new Date();
    const excluded = options.excluded ?? new Set<string>();
    const views = this.#manager.views(now);

    const pinnedName = options.pinned ?? this.#manager.state.pinnedAccount;
    if (pinnedName) {
      const pinned = views.find((view) => view.config.name.toLowerCase() === pinnedName.toLowerCase());
      // An explicitly chosen account is honoured even while cooling down: the
      // user asked for it, and refusing would be more surprising than trying.
      if (pinned && !excluded.has(pinned.config.name) && !pinned.config.unconfigured) {
        return pinned.config;
      }
      if (pinned && excluded.has(pinned.config.name)) return null;
    }

    // Stickiness is opt-in. When enabled it keeps a run on the last successful
    // account instead of returning to a higher-priority one, which keeps prompt
    // caching warm — at the cost of making the configured order look ignored.
    if (this.#manager.config.defaults.sticky) {
      const sticky = this.#manager.state.activeAccount;
      if (sticky && !excluded.has(sticky)) {
        const view = views.find((candidate) => candidate.config.name === sticky);
        if (view?.eligible) return view.config;
      }
    }

    for (const view of views) {
      if (excluded.has(view.config.name)) continue;
      if (!view.eligible) continue;
      return view.config;
    }
    return null;
  }

  /** Every account that could still be selected, ignoring exclusions. */
  eligible(now: Date = new Date()): AccountView[] {
    return this.#manager.views(now).filter((view) => view.eligible);
  }
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return 'now';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatWhen(iso: string | undefined, now: Date): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const local = date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `resets ${local} (in ${formatDuration(date.getTime() - now.getTime())})`;
}

/**
 * The message shown when there is nothing left to fail over to. It names every
 * account, why it is unavailable, and the soonest moment work can continue —
 * enough to decide whether to wait or to add another account.
 */
export function renderExhaustedReport(manager: AccountManager, now: Date = new Date()): string {
  const views = manager.views(now);
  const lines: string[] = [];
  lines.push(`✗ All ${views.length} configured account${views.length === 1 ? '' : 's'} are unavailable.`);
  lines.push('');

  const width = Math.max(...views.map((view) => view.config.name.length), 4);
  let soonest: { name: string; at: Date } | null = null;

  for (const view of views) {
    const name = view.config.name.padEnd(width);
    if (view.config.unconfigured) {
      lines.push(`  ${name}  not configured    ${view.config.unconfigured}`);
      continue;
    }
    if (view.state.health === 'needs_reauth') {
      lines.push(
        `  ${name}  needs re-auth     run: claudex accounts add --name ${JSON.stringify(view.config.name)}`,
      );
      continue;
    }
    const reason = (view.state.reason ?? view.state.health).padEnd(16);
    lines.push(`  ${name}  ${reason}  ${formatWhen(view.state.cooldownUntil, now)}`.trimEnd());

    if (view.state.cooldownUntil) {
      const at = new Date(view.state.cooldownUntil);
      if (!Number.isNaN(at.getTime()) && (!soonest || at < soonest.at)) {
        soonest = { name: view.config.name, at };
      }
    }
  }

  lines.push('');
  if (soonest) {
    lines.push(
      `  Earliest availability: ${soonest.name}, in ${formatDuration(soonest.at.getTime() - now.getTime())}`,
    );
  } else {
    lines.push('  No account has a known reset time. Run `claudex health` to re-check.');
  }
  lines.push('  Add another account with: claudex accounts add');
  return lines.join('\n');
}
