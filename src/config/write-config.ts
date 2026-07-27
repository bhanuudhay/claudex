import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AccountConfig, ClaudexConfig } from '../types.js';
import { configDir, credentialsPath } from '../util/paths.js';
import { DEFAULT_DEFAULTS } from './schema.js';

/**
 * Serializer for the documented config subset. It exists so that
 * `claudex init` and `claudex accounts add` can write a file a human would
 * have written, rather than a JSON blob.
 */
function quoteIfNeeded(value: string): string {
  if (/^[A-Za-z0-9_./${}:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

export function renderConfig(config: Pick<ClaudexConfig, 'defaults' | 'accounts'>): string {
  const lines: string[] = ['version: 1', '', 'defaults:'];
  lines.push(`  provider: ${config.defaults.provider}`);
  lines.push(`  max_switches: ${config.defaults.maxSwitches}`);
  lines.push(`  rotate_on: [${config.defaults.rotateOn.join(', ')}]`);
  lines.push(`  quiet: ${config.defaults.quiet}`);
  lines.push(`  sticky: ${config.defaults.sticky}`);
  if (config.defaults.claudePath) {
    lines.push(`  # explicit path to the real Claude CLI`);
    lines.push(`claude_path: ${quoteIfNeeded(config.defaults.claudePath)}`);
  }
  lines.push('', 'accounts:');
  for (const account of config.accounts) {
    lines.push(`  - name: ${quoteIfNeeded(account.name)}`);
    lines.push(`    provider: ${account.provider}`);
    lines.push(`    priority: ${account.priority}`);
    if (account.token) lines.push(`    token: ${quoteIfNeeded(account.token)}`);
    if (account.configDir) lines.push(`    config_dir: ${quoteIfNeeded(account.configDir)}`);
    if (account.keychainService) {
      lines.push(`    keychain_service: ${quoteIfNeeded(account.keychainService)}`);
    }
    if (account.keychainAccount) {
      lines.push(`    keychain_account: ${quoteIfNeeded(account.keychainAccount)}`);
    }
    lines.push('');
  }
  return lines.join('\n').replace(/\n{3,}$/, '\n');
}

export function defaultConfigPath(): string {
  return join(configDir(), 'config.yaml');
}

export async function writeConfigFile(
  path: string,
  config: Pick<ClaudexConfig, 'defaults' | 'accounts'>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, renderConfig(config), { mode: 0o600 });
}

export function starterConfig(accounts: AccountConfig[]): Pick<ClaudexConfig, 'defaults' | 'accounts'> {
  return {
    defaults: { ...DEFAULT_DEFAULTS, rotateOn: [...DEFAULT_DEFAULTS.rotateOn] },
    accounts,
  };
}

interface CredentialStore {
  version: number;
  tokens: Record<string, string>;
}

async function readStore(): Promise<CredentialStore> {
  try {
    const parsed = JSON.parse(await readFile(credentialsPath(), 'utf8')) as CredentialStore;
    if (parsed && typeof parsed.tokens === 'object') return parsed;
  } catch {
    // A missing or unreadable store simply starts empty.
  }
  return { version: 1, tokens: {} };
}

/** Store a token in the claudex credential store with owner-only permissions. */
export async function storeToken(name: string, token: string): Promise<string> {
  const path = credentialsPath();
  const store = await readStore();
  store.tokens[name] = token;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

export async function removeStoredToken(name: string): Promise<void> {
  const path = credentialsPath();
  const store = await readStore();
  if (!(name in store.tokens)) return;
  delete store.tokens[name];
  await writeFile(path, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
}
