import { loadContext } from './context.js';
import { logger } from '../log/logger.js';

/**
 * `claudex use <name>` — pin an account across invocations.
 * `claudex use --clear` — release the pin and return to automatic selection.
 *
 * A pinned account is used even while it is cooling down: the user asked for it
 * explicitly, and silently overriding that would be more surprising than trying
 * and failing.
 */
export async function useCommand(argv: string[]): Promise<number> {
  const { manager } = await loadContext();

  if (argv.includes('--clear') || argv[0] === 'none') {
    await manager.setPinned(undefined);
    logger.success('pin cleared; account selection is automatic again');
    return 0;
  }

  const name = argv[0];
  if (!name) {
    logger.error('usage: claudex use <account>   |   claudex use --clear');
    return 2;
  }

  const account = manager.find(name);
  if (!account) {
    logger.error(
      `no account named "${name}" (configured: ${manager.config.accounts.map((a) => a.name).join(', ')})`,
    );
    return 1;
  }

  await manager.setPinned(account.name);
  const state = manager.stateOf(account.name);
  logger.success(`pinned to ${account.name}`);
  if (state.cooldownUntil && new Date(state.cooldownUntil) > new Date()) {
    logger.warn(
      `${account.name} is currently in cooldown (${state.reason ?? state.health}); ` +
        `commands will still be sent to it`,
    );
  }
  return 0;
}

/** `claudex reset [name]` — clear cooldowns recorded by earlier failures. */
export async function resetCommand(argv: string[]): Promise<number> {
  const { manager } = await loadContext();
  const name = argv[0];
  if (name && !manager.find(name)) {
    logger.error(`no account named "${name}"`);
    return 1;
  }
  await manager.reset(name ? manager.find(name)?.name : undefined);
  logger.success(name ? `cleared state for ${name}` : 'cleared state for all accounts');
  return 0;
}
