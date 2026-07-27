import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { IS_WINDOWS } from '../util/paths.js';

/** Marker written into installer-generated shims so we can recognise our own. */
export const SHIM_MARKER = 'CLAUDEX_SHIM';

/**
 * Set in the child environment. If claudex ever sees it on startup, it means a
 * wrapper resolved to itself and we are one level into an infinite spawn loop.
 */
export const CHILD_ENV_MARKER = 'CLAUDEX_ACTIVE';

export class ClaudeNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeNotFoundError';
  }
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    if (IS_WINDOWS) return true;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `candidate` is claudex itself — either the same file as the running
 * entrypoint, or a shim the installer generated.
 *
 * This is the guard that makes installing claudex as `claude` safe. Without it,
 * a wrapper named `claude` would find itself on PATH and fork-bomb.
 */
export async function isSelf(candidate: string, selfPath: string): Promise<boolean> {
  try {
    const [candidateReal, selfReal] = await Promise.all([
      realpath(candidate),
      realpath(selfPath).catch(() => selfPath),
    ]);
    if (candidateReal === selfReal) return true;
    return await hasShimMarker(candidateReal);
  } catch {
    return false;
  }
}

/**
 * Shims are small text scripts. The real CLI is a ~250 MB native binary, so the
 * size check is what keeps binary resolution off the critical path — reading it
 * to search for a marker string would add over a second to every invocation.
 */
const MAX_SHIM_BYTES = 64 * 1024;

async function hasShimMarker(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (info.size > MAX_SHIM_BYTES) return false;
    const contents = await readFile(path, 'utf8');
    return contents.includes(SHIM_MARKER);
  } catch {
    return false;
  }
}

function pathCandidates(name: string, env: NodeJS.ProcessEnv): string[] {
  const pathValue = env['PATH'] ?? env['Path'] ?? '';
  const exts = IS_WINDOWS ? (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  const out: string[] = [];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      out.push(join(dir, name + ext.toLowerCase()));
    }
  }
  return out;
}

export interface ResolveOptions {
  /** `claude_path` from config. */
  explicit?: string;
  env?: NodeJS.ProcessEnv;
  /** Path of the running claudex entrypoint; used for self-detection. */
  selfPath?: string;
}

/**
 * Locate the real Claude CLI.
 *
 * Order: explicit config -> CLAUDEX_CLAUDE_BIN -> PATH (skipping ourselves) ->
 * the default native install location.
 */
export async function resolveClaudeBinary(options: ResolveOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const selfPath = options.selfPath ?? process.argv[1] ?? '';
  const attempted: string[] = [];

  const explicit = options.explicit ?? env['CLAUDEX_CLAUDE_BIN'];
  if (explicit) {
    const path = resolve(explicit);
    attempted.push(path);
    if (await isExecutableFile(path)) {
      if (await isSelf(path, selfPath)) {
        throw new ClaudeNotFoundError(
          `configured claude binary points back at claudex: ${path}\n` +
            `  set claude_path (or CLAUDEX_CLAUDE_BIN) to the real Claude CLI`,
        );
      }
      return path;
    }
    throw new ClaudeNotFoundError(`configured claude binary is not executable: ${path}`);
  }

  for (const candidate of pathCandidates('claude', env)) {
    if (!(await isExecutableFile(candidate))) continue;
    attempted.push(candidate);
    if (await isSelf(candidate, selfPath)) continue;
    return candidate;
  }

  const fallbacks = IS_WINDOWS
    ? [
        join(homedir(), '.local', 'bin', 'claude.exe'),
        join(homedir(), 'AppData', 'Local', 'claude', 'claude.exe'),
      ]
    : [join(homedir(), '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'];

  for (const candidate of fallbacks) {
    attempted.push(candidate);
    if (!(await isExecutableFile(candidate))) continue;
    if (await isSelf(candidate, selfPath)) continue;
    return candidate;
  }

  throw new ClaudeNotFoundError(
    `could not find the real claude binary\n` +
      `  tried: ${attempted.join(', ') || '(nothing on PATH)'}\n` +
      `  fix: set claude_path in your claudex config, or CLAUDEX_CLAUDE_BIN in the environment`,
  );
}

/** Abort early if claudex somehow spawned itself. */
export function assertNotRecursing(env: NodeJS.ProcessEnv = process.env): void {
  if (env[CHILD_ENV_MARKER] === '1') {
    throw new ClaudeNotFoundError(
      `claudex resolved to itself (${CHILD_ENV_MARKER} is already set)\n` +
        `  the \`claude\` on PATH is a claudex shim; point claude_path at the real binary`,
    );
  }
}
