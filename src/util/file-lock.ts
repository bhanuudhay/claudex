import { rmSync } from 'node:fs';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface FileLockOptions {
  /** A lock file older than this is treated as abandoned. */
  staleMs?: number;
  /** How long to wait for the holder to release before giving up. */
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Cross-process advisory lock built on `open(..., 'wx')`, which is atomic on
 * every platform we target. Used where two claudex processes must not interleave
 * a mutation of shared global state.
 */
export class FileLock {
  readonly path: string;
  readonly #staleMs: number;
  readonly #timeoutMs: number;
  readonly #pollMs: number;
  #held = false;

  constructor(path: string, options: FileLockOptions = {}) {
    this.path = path;
    this.#staleMs = options.staleMs ?? 30_000;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#pollMs = options.pollMs ?? 50;
  }

  get held(): boolean {
    return this.#held;
  }

  /** Returns false if the lock could not be taken within the timeout. */
  async acquire(): Promise<boolean> {
    await mkdir(dirname(this.path), { recursive: true });
    const deadline = Date.now() + this.#timeoutMs;
    for (;;) {
      try {
        const handle = await open(this.path, 'wx', 0o600);
        await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
        await handle.close();
        this.#held = true;
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await this.#breakIfStale()) continue;
        if (Date.now() > deadline) return false;
        await sleep(this.#pollMs);
      }
    }
  }

  async #breakIfStale(): Promise<boolean> {
    try {
      const info = await stat(this.path);
      if (Date.now() - info.mtimeMs > this.#staleMs) {
        await rm(this.path, { force: true });
        return true;
      }
    } catch {
      return true;
    }
    return false;
  }

  async release(): Promise<void> {
    if (!this.#held) return;
    this.#held = false;
    await rm(this.path, { force: true });
  }

  /** Best-effort synchronous release for exit handlers. */
  releaseSync(): void {
    if (!this.#held) return;
    this.#held = false;
    try {
      rmSync(this.path, { force: true });
    } catch {
      // Nothing useful to do while the process is already tearing down.
    }
  }
}
