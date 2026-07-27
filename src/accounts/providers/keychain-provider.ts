import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import type { AccountConfig } from '../../types.js';
import { AUTH_ENV_VARS, baseMods, type SpawnMods, type TokenProvider } from './provider.js';
import { FileLock } from '../../util/file-lock.js';
import { IS_MACOS, stateDir } from '../../util/paths.js';
import { registerSecret } from '../../util/redact.js';
import { logger } from '../../log/logger.js';

const execFileAsync = promisify(execFile);

/** The keychain item the Claude CLI reads its credentials from on macOS. */
export const LIVE_SERVICE = 'Claude Code-credentials';

/**
 * Swaps the machine-wide Claude Code keychain item for the duration of one
 * invocation, then restores it.
 *
 * This is opt-in and deliberately not the default, because unlike the other
 * providers it mutates *global* state: any other `claude` process running on
 * this machine at the same time will pick up the swapped credentials. A
 * cross-process lock keeps two claudex runs from interleaving, and the original
 * item is restored on normal exit, on throw, and from signal handlers — but a
 * SIGKILL will leave the swapped account in place until the next claudex run
 * repairs it.
 *
 * Prefer the `oauth` provider unless an account genuinely cannot mint a
 * long-lived token.
 */
export class KeychainProvider implements TokenProvider {
  readonly kind = 'keychain' as const;

  async prepare(account: AccountConfig): Promise<SpawnMods> {
    if (!IS_MACOS) {
      throw new Error(
        `account "${account.name}": the keychain provider is macOS-only; ` +
          `use the oauth or configdir provider on this platform`,
      );
    }

    const sourceService = account.keychainService ?? LIVE_SERVICE;
    const sourceAccount = account.keychainAccount;
    if (!sourceAccount) {
      throw new Error(`account "${account.name}": provider "keychain" requires keychain_account`);
    }

    const lock = new FileLock(join(stateDir(), 'keychain.lock'), {
      staleMs: 60_000,
      timeoutMs: 15_000,
    });
    if (!(await lock.acquire())) {
      throw new Error(
        `another claudex process is holding the keychain lock; ` +
          `wait for it to finish or delete ${lock.path} if it is stale`,
      );
    }

    let restore: (() => Promise<void>) | null = null;
    const onSignal = (): void => {
      // Synchronous best effort: an async restore would not finish before exit.
      lock.releaseSync();
    };

    try {
      const snapshot = await readItem(LIVE_SERVICE);
      const incoming = await readItem(sourceService, sourceAccount);
      if (!incoming) {
        throw new Error(
          `keychain item "${sourceService}" / "${sourceAccount}" not found for account "${account.name}"`,
        );
      }
      registerSecret(incoming.password);
      if (snapshot) registerSecret(snapshot.password);

      const liveAccount = snapshot?.account ?? sourceAccount;
      await writeItem(LIVE_SERVICE, liveAccount, incoming.password);

      restore = async () => {
        try {
          if (snapshot) await writeItem(LIVE_SERVICE, snapshot.account, snapshot.password);
          else await deleteItem(LIVE_SERVICE, liveAccount);
        } catch (error) {
          logger.error(
            `failed to restore the original keychain credentials: ${(error as Error).message}`,
          );
        }
      };

      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);

      return baseMods({
        // The CLI reads the keychain itself; inherited tokens would take priority.
        unsetEnv: [...AUTH_ENV_VARS],
        injection: 'none',
        // The config dir is untouched, so transcripts are shared. Resume across
        // accounts still works.
        resumeAcrossAccounts: true,
        cleanup: async () => {
          process.off('SIGINT', onSignal);
          process.off('SIGTERM', onSignal);
          if (restore) await restore();
          await lock.release();
        },
      });
    } catch (error) {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      if (restore) await (restore as () => Promise<void>)();
      await lock.release();
      throw error;
    }
  }
}

interface KeychainItem {
  service: string;
  account: string;
  password: string;
}

/** Read a generic password item, or null when it does not exist. */
export async function readItem(service: string, account?: string): Promise<KeychainItem | null> {
  const args = ['find-generic-password', '-s', service];
  if (account) args.push('-a', account);
  try {
    // `-g` writes the password to stderr and the attributes to stdout.
    const { stdout, stderr } = await execFileAsync('security', [...args, '-g'], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    const acct = /"acct"<blob>="((?:[^"\\]|\\.)*)"/.exec(stdout)?.[1];
    const password = /^password: "((?:[^"\\]|\\.)*)"$/m.exec(stderr)?.[1];
    if (password === undefined) return null;
    return {
      service,
      account: unescapeKeychain(acct ?? account ?? ''),
      password: unescapeKeychain(password),
    };
  } catch {
    return null;
  }
}

async function writeItem(service: string, account: string, password: string): Promise<void> {
  // `-U` updates the item in place when it already exists.
  await execFileAsync('security', [
    'add-generic-password',
    '-U',
    '-s',
    service,
    '-a',
    account,
    '-w',
    password,
  ]);
}

async function deleteItem(service: string, account: string): Promise<void> {
  await execFileAsync('security', ['delete-generic-password', '-s', service, '-a', account]);
}

function unescapeKeychain(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}
