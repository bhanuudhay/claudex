import { existsSync } from 'node:fs';
import { defaultConfigPath, starterConfig, writeConfigFile } from '../config/write-config.js';
import { configSearchPaths } from '../config/config-manager.js';
import { logger } from '../log/logger.js';

/** `claudex init` — write a starter config the user can fill in. */
export async function initCommand(argv: string[]): Promise<number> {
  const force = argv.includes('--force');
  const existing = configSearchPaths().find((candidate) => existsSync(candidate));
  if (existing && !force) {
    logger.error(`config already exists at ${existing} (use --force to overwrite)`);
    return 1;
  }

  const path = existing ?? defaultConfigPath();
  await writeConfigFile(
    path,
    starterConfig([
      { name: 'Personal', provider: 'oauth', priority: 1, token: '${CLAUDE_TOKEN_1}' },
      { name: 'Work', provider: 'oauth', priority: 2, token: '${CLAUDE_TOKEN_2}' },
    ]),
  );

  logger.success(`wrote ${path}`);
  logger.line('');
  logger.line('Next steps:');
  logger.line('  1. Log in as each account and run `claude setup-token` to mint a token');
  logger.line('  2. Either export CLAUDE_TOKEN_1 / CLAUDE_TOKEN_2, or store the tokens with:');
  logger.line('       claudex accounts add --name Personal');
  logger.line('  3. Verify with: claudex health');
  logger.line('  4. Use it: claudex -p "say hi"');
  return 0;
}
