import { loadContext, resolveBinary } from './context.js';
import { providerFor } from '../accounts/providers/index.js';
import { captureClaude } from '../exec/capture.js';
import { classify, describeFailure } from '../detect/error-detector.js';
import { renderTable } from '../util/table.js';
import { logger } from '../log/logger.js';

interface AuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
}

/**
 * `claudex health` — verify every configured credential.
 *
 * The shallow check runs `claude auth status --json`, which validates the
 * credential and reports the plan without consuming any quota. `--deep` adds a
 * one-token prompt, which does consume quota but proves the account can
 * actually serve a request right now.
 */
export async function healthCommand(argv: string[]): Promise<number> {
  const deep = argv.includes('--deep');
  const { config, manager } = await loadContext();
  const binary = await resolveBinary(config);
  const useFd = manager.state.fdInjectionWorks !== false;

  const rows: string[][] = [];
  let failures = 0;

  for (const view of manager.views()) {
    const account = view.config;
    let mods;
    try {
      mods = await providerFor(account, { useFdInjection: useFd }).prepare(account);
    } catch (error) {
      rows.push([account.name, account.provider, 'unconfigured', '-', (error as Error).message]);
      failures++;
      continue;
    }

    try {
      const result = await captureClaude(binary, ['auth', 'status', '--json'], mods);
      let parsed: AuthStatus | null = null;
      try {
        parsed = JSON.parse(result.stdout.trim()) as AuthStatus;
      } catch {
        parsed = null;
      }

      if (parsed?.loggedIn) {
        rows.push([
          account.name,
          account.provider,
          'ok',
          parsed.subscriptionType ?? parsed.authMethod ?? '-',
          parsed.email ?? parsed.orgName ?? '-',
        ]);
      } else {
        const failure = classify({
          exitCode: result.exitCode,
          signal: null,
          stderr: result.stderr,
          stdout: result.stdout,
        });
        rows.push([
          account.name,
          account.provider,
          'FAILED',
          failure ? describeFailure(failure) : 'not logged in',
          firstLine(result.stderr || result.stdout),
        ]);
        failures++;
      }

      if (deep && parsed?.loggedIn) {
        const probe = await captureClaude(
          binary,
          ['-p', 'reply with the single word: ok', '--max-turns', '1'],
          mods,
          60_000,
        );
        const failure = classify({
          exitCode: probe.exitCode,
          signal: null,
          stderr: probe.stderr,
          stdout: probe.stdout,
        });
        if (failure) {
          const row = rows[rows.length - 1];
          if (row) {
            row[2] = 'LIMITED';
            row[4] = describeFailure(failure);
          }
          failures++;
        }
      }
    } finally {
      await mods.cleanup();
    }
  }

  process.stdout.write(renderTable(['ACCOUNT', 'PROVIDER', 'HEALTH', 'PLAN', 'DETAIL'], rows));
  if (failures > 0) logger.warn(`${failures} account(s) need attention`);
  return failures > 0 ? 1 : 0;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim()) ?? '-';
}
