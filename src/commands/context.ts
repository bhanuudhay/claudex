import { AccountManager } from '../accounts/account-manager.js';
import { loadConfig } from '../config/config-manager.js';
import { resolveClaudeBinary } from '../exec/resolve-claude.js';
import type { ClaudexConfig } from '../types.js';

export interface CommandContext {
  config: ClaudexConfig;
  manager: AccountManager;
  fromEnv: boolean;
}

/** Shared bootstrap for every claudex subcommand. */
export async function loadContext(): Promise<CommandContext> {
  const { config, fromEnv } = await loadConfig();
  const manager = await AccountManager.create(config);
  return { config, manager, fromEnv };
}

export async function resolveBinary(config: ClaudexConfig): Promise<string> {
  return resolveClaudeBinary({ explicit: config.defaults.claudePath });
}
