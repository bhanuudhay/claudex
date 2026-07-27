import { mkdir, readFile, rename, writeFile, rm, stat, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PersistedState } from '../types.js';
import { statePath } from '../util/paths.js';

const STATE_VERSION = 1;
/** A lock older than this is assumed to belong to a crashed process. */
const LOCK_STALE_MS = 5_000;
const LOCK_POLL_MS = 25;
const LOCK_TIMEOUT_MS = 3_000;

export function emptyState(): PersistedState {
  return { version: STATE_VERSION, accounts: {} };
}

/**
 * Persisted rotation state, safe under concurrent `claudex` processes.
 *
 * Two shells running `claudex` at the same time must not both decide that the
 * same exhausted account is still healthy, so every read-modify-write goes
 * through an exclusive lock file and an atomic rename.
 */
export class StateStore {
  readonly path: string;
  readonly #lockPath: string;

  constructor(path: string = statePath()) {
    this.path = path;
    this.#lockPath = `${path}.lock`;
  }

  /** Read without locking. Callers that mutate must use `update()`. */
  async read(): Promise<PersistedState> {
    try {
      const contents = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(contents) as PersistedState;
      if (!parsed || typeof parsed !== 'object') return emptyState();
      return {
        version: STATE_VERSION,
        activeAccount: parsed.activeAccount,
        pinnedAccount: parsed.pinnedAccount,
        accounts: parsed.accounts && typeof parsed.accounts === 'object' ? parsed.accounts : {},
        lastSessionId: parsed.lastSessionId,
        lastRotationReason: parsed.lastRotationReason,
        fdInjectionWorks: parsed.fdInjectionWorks,
      };
    } catch {
      // Missing or corrupt state is not fatal: rotation state is a cache, and
      // rebuilding it costs at most one wasted attempt on an exhausted account.
      return emptyState();
    }
  }

  /**
   * Apply `mutate` to the current state under an exclusive lock and persist the
   * result. Returns the state as written.
   */
  async update(
    mutate: (state: PersistedState) => void | Promise<void>,
  ): Promise<PersistedState> {
    await this.#acquireLock();
    try {
      const state = await this.read();
      await mutate(state);
      await this.#writeAtomic(state);
      return state;
    } finally {
      await this.#releaseLock();
    }
  }

  async #writeAtomic(state: PersistedState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    await rename(tmp, this.path);
  }

  async #acquireLock(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const handle = await open(this.#lockPath, 'wx', 0o600);
        await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
        await handle.close();
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await this.#breakStaleLock()) continue;
        if (Date.now() > deadline) {
          // Proceeding without the lock is better than refusing to run the
          // user's command; the worst case is a lost cooldown update.
          return;
        }
        await sleep(LOCK_POLL_MS);
      }
    }
  }

  async #breakStaleLock(): Promise<boolean> {
    try {
      const info = await stat(this.#lockPath);
      if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(this.#lockPath, { force: true });
        return true;
      }
    } catch {
      // Lock vanished between EEXIST and stat: retry immediately.
      return true;
    }
    return false;
  }

  async #releaseLock(): Promise<void> {
    await rm(this.#lockPath, { force: true });
  }
}
