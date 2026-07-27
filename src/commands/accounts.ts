import { existsSync } from 'node:fs';
import type { AccountConfig, ProviderKind } from '../types.js';
import { loadContext } from './context.js';
import { loadConfig } from '../config/config-manager.js';
import { describeRef } from '../accounts/token-source.js';
import {
  defaultConfigPath,
  removeStoredToken,
  starterConfig,
  storeToken,
  writeConfigFile,
} from '../config/write-config.js';
import { configSearchPaths } from '../config/config-manager.js';
import { TOKEN_PROVIDERS } from '../config/schema.js';
import { formatDuration } from '../rotation/rotation-engine.js';
import { promptLine, promptSecret } from '../util/prompt.js';
import { logger } from '../log/logger.js';
import { renderTable } from '../util/table.js';

export async function accountsCommand(argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  switch (sub) {
    case 'list':
    case 'ls':
      return listAccounts();
    case 'add':
      return addAccount(argv.slice(1));
    case 'remove':
    case 'rm':
      return removeAccount(argv.slice(1));
    default:
      logger.error(`unknown subcommand: accounts ${sub}`);
      logger.line('usage: claudex accounts [list|add|remove]');
      return 2;
  }
}

async function listAccounts(): Promise<number> {
  const { config, manager } = await loadContext();
  const now = new Date();
  const rows = manager.views(now).map((view) => {
    const cooldown = view.state.cooldownUntil
      ? formatDuration(new Date(view.state.cooldownUntil).getTime() - now.getTime())
      : '-';
    return [
      view.config.name + (manager.state.activeAccount === view.config.name ? ' *' : ''),
      view.config.provider,
      String(view.config.priority),
      view.eligible ? 'available' : view.state.health,
      view.state.reason ?? '-',
      cooldown,
      view.config.token ? describeRef(view.config.token) : '-',
    ];
  });

  process.stdout.write(
    renderTable(['ACCOUNT', 'PROVIDER', 'PRIORITY', 'STATE', 'REASON', 'COOLDOWN', 'TOKEN'], rows),
  );
  process.stdout.write(`\nconfig: ${config.source}\n`);
  if (manager.state.activeAccount) {
    process.stdout.write(`active: ${manager.state.activeAccount} (* above)\n`);
  }
  if (manager.state.pinnedAccount) {
    process.stdout.write(`pinned: ${manager.state.pinnedAccount} (claudex use --clear to release)\n`);
  }
  for (const warning of config.warnings) logger.warn(warning);
  for (const note of config.notes) logger.info(note);
  return 0;
}

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index !== -1) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}

async function addAccount(argv: string[]): Promise<number> {
  const name = flagValue(argv, '--name') ?? (await promptLine('Account name: '));
  if (!name) {
    logger.error('an account name is required');
    return 2;
  }
  const provider = ((flagValue(argv, '--provider') ??
    (await promptLine('Provider [profile]: ', 'profile'))) as ProviderKind) || 'profile';
  const priority = Number.parseInt(flagValue(argv, '--priority') ?? '', 10);

  const account: AccountConfig = {
    name,
    provider,
    priority: Number.isNaN(priority) ? 0 : priority,
  };

  if (TOKEN_PROVIDERS.includes(provider)) {
    logger.line('');
    logger.line('Mint a long-lived token for this account:');
    logger.line('  1. In a separate terminal, log in as the account you want to add');
    logger.line('  2. Run: claude setup-token');
    logger.line('  3. Paste the sk-ant-oat01-… token below (input is hidden)');
    logger.line('');
    const token = await promptSecret('Token: ');
    if (!token) {
      logger.error('no token provided');
      return 2;
    }
    if (!token.startsWith('sk-ant-')) {
      logger.error('that does not look like an Anthropic token (expected a leading "sk-ant-")');
      return 2;
    }
    const path = await storeToken(name, token);
    account.token = `store:${name}`;
    logger.success(`token stored in ${path} (mode 600)`);
  } else if (provider === 'configdir') {
    const dir = flagValue(argv, '--config-dir') ?? (await promptLine('CLAUDE_CONFIG_DIR path: '));
    if (!dir) {
      logger.error('provider "configdir" requires --config-dir');
      return 2;
    }
    account.configDir = dir;
    logger.line('');
    logger.line(`Log this profile in once with: CLAUDE_CONFIG_DIR=${dir} claude auth login`);
  } else if (provider === 'keychain') {
    account.keychainService =
      flagValue(argv, '--keychain-service') ?? 'Claude Code-credentials';
    const keychainAccount =
      flagValue(argv, '--keychain-account') ?? (await promptLine('Keychain item account: '));
    if (!keychainAccount) {
      logger.error('provider "keychain" requires --keychain-account');
      return 2;
    }
    account.keychainAccount = keychainAccount;
  } else {
    logger.error(`unknown provider: ${provider}`);
    return 2;
  }

  // Merge into the existing config file, or create one.
  const existingPath = configSearchPaths().find((candidate) => existsSync(candidate));
  const path = existingPath ?? defaultConfigPath();

  let accounts: AccountConfig[] = [];
  let defaults;
  let previousPriority: number | undefined;
  if (existingPath) {
    const { config } = await loadConfig();
    const existing = config.accounts.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    previousPriority = existing?.priority;
    accounts = config.accounts.filter((entry) => entry.name.toLowerCase() !== name.toLowerCase());
    defaults = config.defaults;
  }
  // Re-adding an account is the normal way to replace an expired token, so it
  // has to keep its place in the order. Appending would silently demote the
  // account the user just repaired.
  if (!account.priority) account.priority = previousPriority ?? accounts.length + 1;
  accounts.push(account);

  const next = starterConfig(accounts);
  if (defaults) next.defaults = defaults;
  await writeConfigFile(path, next);
  logger.success(`added account "${name}" to ${path}`);
  return 0;
}

async function removeAccount(argv: string[]): Promise<number> {
  const name = argv[0] ?? flagValue(argv, '--name');
  if (!name) {
    logger.error('usage: claudex accounts remove <name>');
    return 2;
  }
  const existingPath = configSearchPaths().find((candidate) => existsSync(candidate));
  if (!existingPath) {
    logger.error('no config file to edit');
    return 1;
  }
  const { config } = await loadConfig();
  const remaining = config.accounts.filter((entry) => entry.name.toLowerCase() !== name.toLowerCase());
  if (remaining.length === config.accounts.length) {
    logger.error(`no account named "${name}"`);
    return 1;
  }
  await writeConfigFile(existingPath, { defaults: config.defaults, accounts: remaining });
  await removeStoredToken(name);
  logger.success(`removed account "${name}"`);
  return 0;
}
