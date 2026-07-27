/** Shared domain types. Kept dependency-free so every module can import them. */

export type ProviderKind = 'oauth' | 'configdir' | 'keychain';

/**
 * How a failed `claude` invocation is classified. Drives rotation policy.
 * `unknown` deliberately never rotates — see docs/ARCHITECTURE.md.
 */
export type FailureClass =
  | 'usage_limit'
  | 'rate_limit'
  | 'overloaded'
  | 'auth_expired'
  | 'credit_exhausted'
  | 'unknown';

/** Subscription limit windows, named as the Claude CLI names them internally. */
export type LimitWindow = 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet';

export interface Failure {
  class: FailureClass;
  /** Which limit window tripped, when the output identified one. */
  window?: LimitWindow;
  /** Absolute reset time, when the CLI or API told us one. */
  resetsAt?: Date;
  /** Human-readable evidence, already redacted. Shown in verbose mode. */
  evidence?: string;
}

export interface AccountConfig {
  name: string;
  provider: ProviderKind;
  /** Lower runs first. Ties broken by order of definition. */
  priority: number;
  /** Unresolved token reference: `${VAR}`, `env:VAR`, `keychain:svc/acct`, `file:/p`, `store`, or a literal. */
  token?: string;
  /** `configdir` provider: the CLAUDE_CONFIG_DIR to use. */
  configDir?: string;
  /** `keychain` provider: which keychain item holds this account's credentials. */
  keychainService?: string;
  keychainAccount?: string;
  /** Set when the account cannot be used at all (e.g. `${VAR}` did not resolve). */
  unconfigured?: string;
  /**
   * Index N of the `CLAUDE_TOKEN_<N>` that produced this account, for accounts
   * built from the environment. Used when merging environment settings over a
   * config file; not part of the user-facing config format.
   */
  envIndex?: number;
}

export interface ConfigDefaults {
  provider: ProviderKind;
  /** Maximum number of account switches within a single invocation. */
  maxSwitches: number;
  /** Failure classes that are allowed to trigger rotation. */
  rotateOn: FailureClass[];
  quiet: boolean;
  /**
   * Keep using the last successful account even when a higher-priority one is
   * available. Off by default: priority means priority, and a selection that
   * silently ignores the configured order is the single most confusing thing
   * this tool can do. Turn it on to keep prompt caching warm on one org.
   */
  sticky: boolean;
  /** Explicit path to the real `claude` binary; overrides discovery. */
  claudePath?: string;
}

export interface ClaudexConfig {
  version: number;
  defaults: ConfigDefaults;
  accounts: AccountConfig[];
  /** Where the config came from, for `claudex doctor`. */
  source: string;
  /** Warnings collected during load (bad perms, unresolved vars, ...). */
  warnings: string[];
  /**
   * Expected, non-problematic facts about how the config was assembled, such as
   * the environment overriding a file value. Shown only in verbose mode: they
   * are useful when diagnosing "why that account", but printing them on every
   * successful command would be noise.
   */
  notes: string[];
}

export type AccountHealth = 'ok' | 'exhausted' | 'rate_limited' | 'needs_reauth' | 'unknown';

export interface AccountState {
  health: AccountHealth;
  /** Why the account entered its current state, e.g. `five_hour`. */
  reason?: string;
  /** ISO timestamp; the account is skipped until this passes. */
  cooldownUntil?: string;
  /** ISO timestamp of the last successful invocation. */
  lastOk?: string;
  consecutiveFailures: number;
}

export interface PersistedState {
  version: number;
  /** Sticky account: reused across invocations while it stays eligible. */
  activeAccount?: string;
  /** Set by `claudex use <name>`; survives until `claudex use --clear`. */
  pinnedAccount?: string;
  accounts: Record<string, AccountState>;
  /** Session id injected into the last interactive run, for resume-on-rotate. */
  lastSessionId?: string;
  lastRotationReason?: string;
  /**
   * Whether this machine's `claude` build accepts a token on a file descriptor
   * (CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR). Learned once at runtime; see
   * `src/accounts/providers/oauth-provider.ts`.
   */
  fdInjectionWorks?: boolean;
}
