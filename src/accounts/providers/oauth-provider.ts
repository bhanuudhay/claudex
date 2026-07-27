import type { AccountConfig } from '../../types.js';
import { resolveToken } from '../token-source.js';
import { baseMods, otherAuthVars, type SpawnMods, type TokenProvider } from './provider.js';

/**
 * Injects a long-lived OAuth token (from `claude setup-token`) into the child.
 *
 * Two injection modes:
 *
 *   fd  — the token is written into a pipe handed to the child as file
 *         descriptor 3, and only the *number* 3 appears in the environment.
 *         The token is therefore never visible in `ps -E` or
 *         /proc/<pid>/environ, which matters on shared machines.
 *   env — CLAUDE_CODE_OAUTH_TOKEN, the universally supported path.
 *
 * `fd` is preferred but not assumed: if an attempt using fd injection fails
 * with an auth error, the retry manager records `fdInjectionWorks: false` in
 * persisted state and every later run uses `env`. That self-heals on builds or
 * platforms where the file-descriptor path is unavailable, without requiring a
 * separate probe on the hot path.
 */
export class OAuthProvider implements TokenProvider {
  readonly kind = 'oauth' as const;
  readonly #useFd: boolean;

  constructor(useFd: boolean) {
    this.#useFd = useFd;
  }

  async prepare(account: AccountConfig): Promise<SpawnMods> {
    const token = await resolveToken(account);

    if (!this.#useFd) {
      return baseMods({
        env: { CLAUDE_CODE_OAUTH_TOKEN: token },
        unsetEnv: otherAuthVars(['CLAUDE_CODE_OAUTH_TOKEN']),
        injection: 'env',
      });
    }

    return baseMods({
      env: { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3' },
      unsetEnv: otherAuthVars(['CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR']),
      extraStdio: ['pipe'],
      injection: 'fd',
      onSpawn: (child) => {
        const pipe = child.stdio[3] as NodeJS.WritableStream | undefined;
        if (!pipe) return;
        // A closed pipe here means the child exited first; nothing to recover.
        pipe.on('error', () => {});
        pipe.end(token);
      },
    });
  }
}
