import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ClaudexConfig } from '../types.js';
import { configDir, expandTilde, IS_WINDOWS } from '../util/paths.js';
import { parseYaml } from './mini-yaml.js';
import { ConfigError, parseConfig } from './schema.js';
import { loadEnvConfig } from './env-config.js';

/** Candidate config locations, highest precedence first. */
export function configSearchPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env['CLAUDEX_CONFIG']?.trim();
  if (explicit) return [expandTilde(explicit)];
  return [
    join(configDir(), 'config.yaml'),
    join(configDir(), 'config.yml'),
    join(homedir(), '.claudex.yaml'),
    join(homedir(), '.claudex.yml'),
  ];
}

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      const info = await stat(path);
      if (info.isFile()) return path;
    } catch {
      // Missing candidate; try the next one.
    }
  }
  return null;
}

/**
 * A config file holding literal tokens must not be world- or group-readable.
 * We warn rather than refuse: locking the user out of their own tool over file
 * permissions is a worse failure mode than a loud warning.
 */
async function permissionWarning(path: string, contents: string): Promise<string | null> {
  if (IS_WINDOWS) return null;
  if (!/sk-ant-/.test(contents)) return null;
  try {
    const info = await stat(path);
    const mode = info.mode & 0o077;
    if (mode !== 0) {
      const octal = (info.mode & 0o777).toString(8).padStart(3, '0');
      return `${path} contains literal tokens and is mode ${octal}; run: chmod 600 ${path}`;
    }
  } catch {
    // Unreadable stat is not worth failing the run over.
  }
  return null;
}

export interface LoadResult {
  config: ClaudexConfig;
  /** True when configuration came from environment variables only. */
  fromEnv: boolean;
}

/**
 * Load configuration from the first config file found, else from
 * `CLAUDE_TOKEN_*`. Throws `ConfigError` when neither source yields accounts.
 */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<LoadResult> {
  const searchPaths = configSearchPaths(env);
  const path = await firstExisting(searchPaths);

  if (!path) {
    const envConfig = loadEnvConfig(env);
    if (envConfig) return { config: envConfig, fromEnv: true };
    throw new ConfigError(
      `no claudex configuration found\n` +
        `  looked for: ${searchPaths.join(', ')}\n` +
        `  or CLAUDE_TOKEN_1..N in the environment\n` +
        `  run \`claudex init\` to create a starter config`,
    );
  }

  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`cannot read ${path}: ${(error as Error).message}`);
  }

  let parsed;
  try {
    parsed = parseYaml(contents);
  } catch (error) {
    throw new ConfigError(`${path}: ${(error as Error).message}`);
  }

  const config = parseConfig(parsed, path, env);

  const warning = await permissionWarning(path, contents);
  if (warning) config.warnings.push(warning);

  const envConfig = loadEnvConfig(env);
  if (envConfig) mergeEnvAccounts(config, envConfig.accounts, env);

  return { config, fromEnv: false };
}

/**
 * Merge `CLAUDE_TOKEN_*` accounts over the ones a config file defines.
 *
 * The environment wins, which is the precedence people expect and the one that
 * makes a checked-in config usable in CI: an account named in both places keeps
 * its file definition but takes the environment's token, and takes the
 * environment's priority when `CLAUDEX_ACCOUNT_<N>_PRIORITY` was set
 * explicitly. A default priority is not treated as an override, since it was
 * inferred from the variable's number rather than chosen.
 *
 * Accounts that appear only in the environment are appended.
 */
function mergeEnvAccounts(
  config: ClaudexConfig,
  envAccounts: ClaudexConfig['accounts'],
  env: NodeJS.ProcessEnv,
): void {
  for (const envAccount of envAccounts) {
    const index = config.accounts.findIndex(
      (account) => account.name.toLowerCase() === envAccount.name.toLowerCase(),
    );
    if (index === -1) {
      config.accounts.push(envAccount);
      continue;
    }

    const fileAccount = config.accounts[index];
    if (!fileAccount) continue;

    const merged = { ...fileAccount, token: envAccount.token };
    const explicitPriority =
      envAccount.envIndex !== undefined &&
      env[`CLAUDEX_ACCOUNT_${envAccount.envIndex}_PRIORITY`]?.trim();
    if (explicitPriority) merged.priority = envAccount.priority;

    config.accounts[index] = merged;
    config.warnings.push(
      `account "${fileAccount.name}": using the token from CLAUDE_TOKEN_${envAccount.envIndex}` +
        (explicitPriority ? ` and priority ${envAccount.priority} from the environment` : '') +
        ` (environment overrides ${config.source})`,
    );
  }
}
