import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, expandTilde } from '../util/paths.js';

/**
 * Reads a claudex-owned `.env` file into the process environment.
 *
 * This exists because a `.env` file is inert on its own: nothing loads it, and
 * even `source .env` only sets shell variables without exporting them, so a
 * child process never sees them. Requiring users to remember
 * `set -a; source …; set +a` for configuration to take effect is a bad contract,
 * so claudex loads its own env file directly.
 *
 * Two rules keep this predictable:
 *
 *   - The real environment always wins. A variable already set in the process is
 *     never overwritten, so an explicit `export` or a one-off
 *     `CLAUDE_TOKEN_1=… claudex …` still beats the file.
 *   - Only a claudex-owned location is read (`$CLAUDEX_ENV_FILE`, else
 *     `~/.config/claudex/.env`). The current directory is deliberately *not*
 *     searched: silently sourcing a `.env` from whatever repo you happen to be
 *     in would let any checked-out project change which credential runs.
 */

export interface EnvFileResult {
  path: string | null;
  /** Names of variables actually applied. Never values. */
  applied: string[];
  /** Names present in the file but already set in the environment. */
  skipped: string[];
}

const EMPTY: EnvFileResult = { path: null, applied: [], skipped: [] };

export function envFilePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env['CLAUDEX_ENV_FILE']?.trim();
  if (explicit) {
    const path = expandTilde(explicit);
    return existsSync(path) ? path : null;
  }
  const candidate = join(configDir(), '.env');
  return existsSync(candidate) ? candidate : null;
}

/** Parse `KEY=VALUE` lines. Tolerates `export`, quotes, comments and stray spaces. */
export function parseEnvFile(contents: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;

    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    // `KEY= value` is a common slip; the leading space is not part of a token.
    let value = body.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      // Strip a trailing `# comment` only on unquoted values.
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }
    out.set(key, value);
  }
  return out;
}

export function loadEnvFile(env: NodeJS.ProcessEnv = process.env): EnvFileResult {
  const path = envFilePath(env);
  if (!path) return EMPTY;

  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return { path, applied: [], skipped: [] };
  }

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const [key, value] of parseEnvFile(contents)) {
    if (env[key] !== undefined && env[key] !== '') {
      skipped.push(key);
      continue;
    }
    env[key] = value;
    applied.push(key);
  }
  return { path, applied, skipped };
}
