import { mkdir, lstat, readFile, readlink, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AccountConfig } from '../../types.js';
import { configDir as claudexConfigDir, IS_WINDOWS } from '../../util/paths.js';
import { logger } from '../../log/logger.js';
import { resolveToken } from '../token-source.js';
import { baseMods, otherAuthVars, type SpawnMods, type TokenProvider } from './provider.js';

/**
 * Runs `claude` against a per-account config dir that shares the parts of the
 * real one which are not account-specific.
 *
 * Why this exists, and why it is the default:
 *
 * The `oauth` provider injects a token but leaves CLAUDE_CONFIG_DIR pointing at
 * the user's own `~/.claude`. That directory also holds the *stored* login
 * (`.credentials.json`) and the cached account identity and usage counters
 * (`.claude.json`, `stats-cache.json`, `policy-limits.json`). Those files belong
 * to whichever account logged in interactively, so after claudex switched
 * accounts the CLI kept reporting the previous account's state: an expired-token
 * banner and a `/usage` readout for the account that had just run out, even
 * though requests were going out on a valid token. Switching the credential
 * without switching the state it is cached alongside can only ever half-work.
 *
 * The `configdir` provider avoids that by isolating everything — including
 * `projects/`, where session transcripts live, which is why it cannot resume a
 * conversation started under another account.
 *
 * This provider splits the directory instead of choosing a side:
 *
 *   isolated  .credentials.json, .claude.json, and every usage/identity cache,
 *             so the CLI's idea of "who am I and how much have I used" is this
 *             account's and nobody else's.
 *   shared    projects/ (so `--resume` still finds the conversation), plus
 *             settings, CLAUDE.md, commands, agents, skills, plugins and hooks,
 *             which are the user's setup rather than any account's state.
 *
 * Sharing is done with symlinks, so edits made through one account are visible
 * from all of them and nothing has to be kept in sync.
 */

/**
 * Entries symlinked back to the real config dir. `projects` is the load-bearing
 * one: transcripts must stay in one place for cross-account resume to work.
 */
const SHARED_ENTRIES = [
  'projects',
  'settings.json',
  'CLAUDE.md',
  'commands',
  'agents',
  'skills',
  'plugins',
  'hooks',
  'ide',
  'statusline-command.sh',
  'plans',
  'todos',
];

/**
 * Top-level `.claude.json` keys that describe *an account* rather than the
 * installation. Everything else (project trust, MCP servers, onboarding state)
 * is copied into a new profile so switching accounts does not mean re-approving
 * the workspace.
 */
const ACCOUNT_STATE_KEY = /oauth|account|user|org|subscription|usage|limit|billing|token|email/i;

export function profileSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || 'account';
}

/** The user's own Claude config dir — the one being partially shared. */
export function sharedConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');
}

/** Where an account's isolated state lives when the config does not say. */
export function defaultProfileDir(name: string): string {
  return join(claudexConfigDir(), 'profiles', profileSlug(name));
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Link one shared entry into the profile. Returns false when the link could not
 * be created, which on Windows without developer mode is a normal outcome.
 *
 * An existing symlink is re-pointed when it no longer names the current target:
 * CLAUDE_CONFIG_DIR can move, and a profile silently wired to a directory that
 * is gone would look like a working share while hiding every transcript.
 */
async function link(target: string, path: string): Promise<boolean> {
  const existing = await lstat(path).catch(() => null);
  if (existing?.isSymbolicLink()) {
    if ((await readlink(path).catch(() => null)) === target) return true;
    if (!(await exists(target))) return false;
    await unlink(path);
  } else if (existing) {
    // A real file or directory in the profile is the account's own state; never
    // replace it with a link to the shared one.
    return true;
  }
  if (!(await exists(target))) return false;
  const type = IS_WINDOWS ? ((await lstat(target)).isDirectory() ? 'junction' : 'file') : undefined;
  try {
    await symlink(target, path, type);
    return true;
  } catch {
    return false;
  }
}

/**
 * Seed `.claude.json` from the shared one, minus anything account-specific.
 * Runs only when the profile does not have one yet, so later divergence is the
 * account's own.
 */
async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function seedInstallationState(shared: string, profile: string): Promise<void> {
  const destination = join(profile, '.claude.json');
  if (await exists(destination)) return;

  // Two locations are in play. With no CLAUDE_CONFIG_DIR set, the CLI keeps this
  // file at `~/.claude.json`, which is where an existing installation's project
  // trust and onboarding state actually live; once a config dir is in use it is
  // `$CLAUDE_CONFIG_DIR/.claude.json`. Merge both, config dir winning, so a new
  // profile does not ask the user to re-approve every workspace.
  const legacy = shared === join(homedir(), '.claude') ? await readJson(join(homedir(), '.claude.json')) : null;
  const current = await readJson(join(shared, '.claude.json'));
  if (!legacy && !current) return;

  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries({ ...legacy, ...current })) {
    if (ACCOUNT_STATE_KEY.test(key)) continue;
    kept[key] = value;
  }
  await writeFile(destination, JSON.stringify(kept, null, 2), { mode: 0o600 });
}

export class ProfileProvider implements TokenProvider {
  readonly kind = 'profile' as const;
  readonly #useFd: boolean;

  constructor(useFd: boolean) {
    this.#useFd = useFd;
  }

  async prepare(account: AccountConfig): Promise<SpawnMods> {
    const token = await resolveToken(account);
    const shared = sharedConfigDir();
    const profile = account.configDir ?? defaultProfileDir(account.name);

    await mkdir(profile, { recursive: true, mode: 0o700 });
    // Transcripts are the one entry created rather than merely linked: on a fresh
    // installation `projects/` does not exist yet, and treating that as "cannot
    // share" would refuse every mid-response rotation for no reason.
    await mkdir(join(shared, 'projects'), { recursive: true, mode: 0o700 });

    let transcriptsShared = true;
    const unlinked: string[] = [];
    for (const entry of SHARED_ENTRIES) {
      const linked = await link(join(shared, entry), join(profile, entry));
      if (linked) continue;
      if (entry === 'projects') transcriptsShared = false;
      unlinked.push(entry);
    }
    if (unlinked.includes('projects')) {
      logger.debug(
        `${account.name}: could not share ${join(shared, 'projects')}; ` +
          'cross-account resume is unavailable for this account',
      );
    }
    await seedInstallationState(shared, profile);

    const env: Record<string, string> = { CLAUDE_CONFIG_DIR: profile };
    if (this.#useFd) {
      env['CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'] = '3';
      return baseMods({
        env,
        unsetEnv: otherAuthVars(['CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR']),
        extraStdio: ['pipe'],
        injection: 'fd',
        resumeAcrossAccounts: transcriptsShared,
        onSpawn: (child) => {
          const pipe = child.stdio[3] as NodeJS.WritableStream | undefined;
          if (!pipe) return;
          pipe.on('error', () => {});
          pipe.end(token);
        },
      });
    }

    env['CLAUDE_CODE_OAUTH_TOKEN'] = token;
    return baseMods({
      env,
      unsetEnv: otherAuthVars(['CLAUDE_CODE_OAUTH_TOKEN']),
      injection: 'env',
      resumeAcrossAccounts: transcriptsShared,
    });
  }
}
