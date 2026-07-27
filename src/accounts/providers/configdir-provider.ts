import { mkdir } from 'node:fs/promises';
import type { AccountConfig } from '../../types.js';
import { AUTH_ENV_VARS, baseMods, type SpawnMods, type TokenProvider } from './provider.js';

/**
 * Runs `claude` against an isolated CLAUDE_CONFIG_DIR, each holding its own
 * interactive login.
 *
 * Trade-off, and the reason this is not the default: session transcripts live
 * at `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<session-id>.jsonl`. Pointing the
 * CLI at a different config dir therefore hides the current conversation, so a
 * mid-response rotation into this provider cannot resume — it would silently
 * restart the prompt instead. `resumeAcrossAccounts` is false to make the retry
 * manager stop and say so rather than re-running work. MCP OAuth state and
 * per-project settings are siloed the same way.
 *
 * Use it when accounts need genuinely separate CLI state (different orgs,
 * different MCP servers) or when an account cannot mint a long-lived token.
 */
export class ConfigDirProvider implements TokenProvider {
  readonly kind = 'configdir' as const;

  async prepare(account: AccountConfig): Promise<SpawnMods> {
    const dir = account.configDir;
    if (!dir) {
      throw new Error(`account "${account.name}": provider "configdir" requires config_dir`);
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });

    return baseMods({
      env: { CLAUDE_CONFIG_DIR: dir },
      // The profile authenticates itself; an inherited token would override it.
      unsetEnv: [...AUTH_ENV_VARS],
      injection: 'none',
      resumeAcrossAccounts: false,
    });
  }
}
