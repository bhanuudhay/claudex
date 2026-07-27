import type { ChildProcess } from 'node:child_process';
import type { AccountConfig, ProviderKind } from '../../types.js';

/** How the child process receives its credential. */
export type InjectionMode = 'fd' | 'env' | 'none';

/**
 * Everything a provider contributes to one `claude` invocation. Providers never
 * spawn anything themselves; they only describe how the child should be set up,
 * which keeps the executor the single place that knows about process handling.
 */
export interface SpawnMods {
  /** Variables to set in the child environment. */
  env: Record<string, string>;
  /** Variables to remove from the inherited environment. */
  unsetEnv: string[];
  /** Extra stdio slots appended after stdin/stdout/stderr (fd 3 and up). */
  extraStdio: ('pipe' | 'ignore')[];
  /** Called immediately after spawn, e.g. to write a token into fd 3. */
  onSpawn?: (child: ChildProcess) => void;
  injection: InjectionMode;
  /**
   * Whether a session started under a *different* account can be resumed under
   * this one. True only when the session transcript directory is shared, i.e.
   * when CLAUDE_CONFIG_DIR is not being changed.
   */
  resumeAcrossAccounts: boolean;
  /** Always called, success or failure, before the next attempt starts. */
  cleanup: () => Promise<void>;
}

export interface TokenProvider {
  readonly kind: ProviderKind;
  prepare(account: AccountConfig): Promise<SpawnMods>;
}

const NOOP_CLEANUP = async (): Promise<void> => {};

/** Baseline mods; providers override the fields they care about. */
export function baseMods(overrides: Partial<SpawnMods> = {}): SpawnMods {
  return {
    env: {},
    unsetEnv: [],
    extraStdio: [],
    injection: 'none',
    resumeAcrossAccounts: true,
    cleanup: NOOP_CLEANUP,
    ...overrides,
  };
}

/**
 * Auth environment variables the Claude CLI honours. Whichever provider is
 * active clears the ones it does not set, so credential precedence is never
 * ambiguous and a stale shell export cannot silently win.
 */
export const AUTH_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
] as const;

export function otherAuthVars(keep: string[]): string[] {
  return AUTH_ENV_VARS.filter((name) => !keep.includes(name));
}
