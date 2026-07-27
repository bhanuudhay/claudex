import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import type { SpawnMods } from '../accounts/providers/provider.js';
import { CHILD_ENV_MARKER } from './resolve-claude.js';

/** Bounded tail buffer: we only ever need the end of a stream for detection. */
class Tail {
  #chunks: Buffer[] = [];
  #size = 0;
  #bytes = 0;
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  get bytes(): number {
    return this.#bytes;
  }

  append(chunk: Buffer): void {
    this.#bytes += chunk.length;
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    while (this.#size > this.#limit && this.#chunks.length > 1) {
      const dropped = this.#chunks.shift();
      this.#size -= dropped?.length ?? 0;
    }
  }

  toString(): string {
    return Buffer.concat(this.#chunks).subarray(-this.#limit).toString('utf8');
  }
}

const STDERR_TAIL_BYTES = 16 * 1024;
/** Larger, because a `--output-format json` result object can be sizeable. */
const STDOUT_TAIL_BYTES = 512 * 1024;

const FORWARDED_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export interface RunOptions {
  binary: string;
  args: string[];
  mods: SpawnMods;
  /** Interactive runs inherit every stream; print runs tee stdout and stderr. */
  interactive: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  /** Undefined for interactive runs, where stdout is never intercepted. */
  stdout?: string;
  /** How many bytes the child wrote to stdout. Drives the transparency rule. */
  stdoutBytes: number;
  durationMs: number;
}

function buildEnv(mods: SpawnMods, base: NodeJS.ProcessEnv, interactive: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...mods.env, [CHILD_ENV_MARKER]: '1' };
  for (const key of mods.unsetEnv) delete env[key];

  // Print mode routes stdout through this process, which would otherwise make
  // the CLI think it is writing to a pipe and drop its colours. Restore them
  // when our own stdout really is a terminal, so output matches an unwrapped
  // run byte for byte.
  if (!interactive && process.stdout.isTTY && !base['FORCE_COLOR'] && base['NO_COLOR'] === undefined) {
    env['FORCE_COLOR'] = '1';
  }
  return env;
}

/**
 * Run the real Claude CLI once.
 *
 * Interactive runs use `stdio: 'inherit'` throughout: nothing sits between the
 * terminal and the TUI, so rendering, resizing, mouse reporting and paste
 * behaviour are exactly as they are without claudex.
 *
 * Print runs tee stdout and stderr so failures can be classified and so we know
 * whether any output has already reached the user, while still writing every
 * byte straight through in order.
 */
export function runClaude(options: RunOptions): Promise<RunResult> {
  const { binary, args, mods, interactive } = options;
  const startedAt = Date.now();

  // stdout is inherited for interactive runs so the TUI owns the terminal
  // outright; stderr is teed in both modes because that is where the CLI writes
  // the errors we classify.
  const extra: StdioOptions = mods.extraStdio;
  const stdio: StdioOptions = interactive
    ? ['inherit', 'inherit', 'pipe', ...extra]
    : ['inherit', 'pipe', 'pipe', ...extra];

  const child: ChildProcess = spawn(binary, args, {
    stdio,
    env: buildEnv(mods, options.env ?? process.env, interactive),
    cwd: options.cwd,
    windowsHide: true,
  });

  const stderrTail = new Tail(STDERR_TAIL_BYTES);
  const stdoutTail = new Tail(STDOUT_TAIL_BYTES);

  if (child.stdout) {
    child.stdout.on('data', (chunk: Buffer) => stdoutTail.append(chunk));
    child.stdout.pipe(process.stdout, { end: false });
  }
  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer) => stderrTail.append(chunk));
    child.stderr.pipe(process.stderr, { end: false });
  }

  mods.onSpawn?.(child);

  const forward = (signal: NodeJS.Signals) => (): void => {
    if (!child.killed) child.kill(signal);
  };
  const handlers = FORWARDED_SIGNALS.map((signal) => {
    const handler = forward(signal);
    process.on(signal, handler);
    return { signal, handler };
  });

  return new Promise<RunResult>((resolvePromise, rejectPromise) => {
    const finish = (result: RunResult): void => {
      for (const { signal, handler } of handlers) process.off(signal, handler);
      resolvePromise(result);
    };

    child.once('error', (error) => {
      for (const { signal, handler } of handlers) process.off(signal, handler);
      rejectPromise(error);
    });

    child.once('close', (code, signal) => {
      finish({
        exitCode: code,
        signal: signal ?? null,
        stderr: stderrTail.toString(),
        stdout: interactive ? undefined : stdoutTail.toString(),
        stdoutBytes: stdoutTail.bytes,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

/**
 * Exit the way the child did, so shell pipelines and job control behave the
 * same as they would running `claude` directly.
 */
export function exitLike(result: RunResult): never {
  if (result.signal) {
    process.removeAllListeners(result.signal);
    process.kill(process.pid, result.signal);
  }
  process.exit(result.exitCode ?? 0);
}
