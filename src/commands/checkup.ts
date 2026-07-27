import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadContext } from './context.js';
import { configSearchPaths } from '../config/config-manager.js';
import { TOKEN_PROVIDERS } from '../config/schema.js';
import { resolveClaudeBinary } from '../exec/resolve-claude.js';
import { credentialsPath, statePath, IS_WINDOWS } from '../util/paths.js';
import { describeRef } from '../accounts/token-source.js';
import { renderConfig } from '../config/write-config.js';
import { logger } from '../log/logger.js';

/**
 * `claudex checkup` (alias `claudex cfo doctor`) — diagnose an installation
 * without running a prompt. Named `checkup` so it does not shadow the real
 * `claude doctor`, which must remain reachable through the wrapper.
 */
export async function checkupCommand(argv: string[]): Promise<number> {
  const timing = argv.includes('--timing');
  const startedAt = process.hrtime.bigint();
  const out: string[] = [];
  let problems = 0;

  out.push('claudex checkup');
  out.push('');

  // 1. Configuration. Loaded first so `claude_path` can inform step 2, but a
  //    missing config must not stop us from reporting on the binary.
  let context: Awaited<ReturnType<typeof loadContext>> | null = null;
  let configError: Error | null = null;
  try {
    context = await loadContext();
  } catch (error) {
    configError = error as Error;
  }

  // 2. The real CLI.
  try {
    const binary = await resolveClaudeBinary({ explicit: context?.config.defaults.claudePath });
    out.push(`✓ claude binary       ${binary}`);
  } catch (error) {
    out.push(`✗ claude binary       ${(error as Error).message.split('\n')[0]}`);
    problems++;
  }

  if (!context) {
    out.push(`✗ config              ${configError?.message.split('\n')[0] ?? 'unavailable'}`);
    out.push('  fix                 run: claudex init');
    problems++;
  } else {
    const { config, manager, fromEnv } = context;
    out.push(`✓ config              ${config.source}${fromEnv ? ' (environment only)' : ''}`);
    out.push(`  accounts            ${config.accounts.length}`);
    for (const account of config.accounts) {
      const source =
        TOKEN_PROVIDERS.includes(account.provider)
          ? describeRef(account.token ?? '(none)')
          : account.provider === 'configdir'
            ? account.configDir ?? '(none)'
            : `${account.keychainService}/${account.keychainAccount}`;
      out.push(`    ${account.name.padEnd(14)} ${account.provider.padEnd(10)} ${source}`);
    }
    for (const warning of config.warnings) {
      out.push(`⚠ config warning      ${warning}`);
      problems++;
    }
    // Notes are not problems, but a provider that resolved to something other
    // than what the file says has to be visible somewhere by default.
    for (const note of config.notes) out.push(`· config note         ${note}`);

    out.push(`✓ state file          ${manager.store.path}`);
    out.push(
      `  token fd injection  ${
        manager.state.fdInjectionWorks === undefined
          ? 'not yet determined (learned on first run)'
          : manager.state.fdInjectionWorks
            ? 'supported'
            : 'unsupported, using environment variable'
      }`,
    );

    if (argv.includes('--print-config')) {
      out.push('');
      out.push('--- effective config (secrets are references, never values) ---');
      out.push(renderConfig({ defaults: config.defaults, accounts: config.accounts }));
    }
  }

  // 3. Permissions, but only on files that actually hold a secret. The
  //    credential store always does; a config file only does if it contains a
  //    literal token rather than a reference.
  for (const path of [credentialsPath(), ...configSearchPaths()]) {
    if (!existsSync(path)) continue;
    const isStore = path === credentialsPath();
    if (!isStore && !(await readFile(path, 'utf8').catch(() => '')).includes('sk-ant-')) {
      out.push(`✓ permissions         ${path} (no literal secrets)`);
      continue;
    }
    if (IS_WINDOWS) {
      out.push(`· permissions         ${path} (not checked on Windows)`);
      continue;
    }
    const info = await stat(path);
    const mode = (info.mode & 0o777).toString(8).padStart(3, '0');
    if ((info.mode & 0o077) !== 0) {
      out.push(`⚠ permissions         ${path} is mode ${mode}; run: chmod 600 ${path}`);
      problems++;
    } else {
      out.push(`✓ permissions         ${path} (${mode})`);
    }
  }

  out.push(`· state path          ${statePath()}`);

  if (timing) {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    out.push(`· checkup duration    ${elapsedMs.toFixed(1)}ms`);
  }

  out.push('');
  out.push(problems === 0 ? 'No problems found.' : `${problems} problem(s) found.`);
  process.stdout.write(out.join('\n') + '\n');
  if (problems > 0) logger.debug('checkup found problems');
  return problems > 0 ? 1 : 0;
}
