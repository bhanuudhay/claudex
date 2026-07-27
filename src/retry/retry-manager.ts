import { setTimeout as sleep } from 'node:timers/promises';
import type { AccountConfig, Failure, FailureClass } from '../types.js';
import type { AccountManager } from '../accounts/account-manager.js';
import { providerFor } from '../accounts/providers/index.js';
import type { SpawnMods } from '../accounts/providers/provider.js';
import { TokenResolutionError } from '../accounts/token-source.js';
import { classify, describeFailure } from '../detect/error-detector.js';
import { readTranscriptSince } from '../detect/session-probe.js';
import { runClaude, type RunResult } from '../exec/claude-executor.js';
import { toResumeArgs } from '../exec/args.js';
import { logger } from '../log/logger.js';
import { RotationEngine, renderExhaustedReport } from '../rotation/rotation-engine.js';

/** Exit code used when every account is unavailable. */
export const EXIT_ALL_EXHAUSTED = 77;

/** In-run retries against the same account for server-side failures. */
const OVERLOADED_RETRIES = 2;
const OVERLOADED_BACKOFF_MS = 750;

export class AllAccountsExhaustedError extends Error {
  readonly report: string;
  constructor(report: string) {
    super('all configured accounts are unavailable');
    this.name = 'AllAccountsExhaustedError';
    this.report = report;
  }
}

export interface FailoverOptions {
  manager: AccountManager;
  binary: string;
  /** User arguments, already stripped of claudex's own flags. */
  args: string[];
  interactive: boolean;
  /** Session id injected into the run, when one was injected. */
  sessionId?: string;
  maxSwitches: number;
  rotateOn: FailureClass[];
  /** Disable rotation entirely for this run (`--cfo-no-rotate`). */
  noRotate: boolean;
  /** Account requested for this run (`--cfo-account`). */
  pinned?: string;
  cwd?: string;
}

/**
 * Run `claude`, and on an account-level failure switch accounts and run it
 * again.
 *
 * The loop is deliberately conservative about what counts as an account-level
 * failure: only classes listed in `rotateOn` rotate, `unknown` never does, and
 * a server-side overload retries the *same* account before spending a switch.
 */
export async function runWithFailover(options: FailoverOptions): Promise<RunResult> {
  const { manager, binary, interactive } = options;
  const rotation = new RotationEngine(manager);
  const excluded = new Set<string>();

  let currentArgs = options.args;
  let switches = 0;
  let overloadedRetries = 0;
  let pendingResume = false;
  let previous: AccountConfig | null = null;
  const announce = manager.config.accounts.length > 1;
  // Set while a single auth failure is being re-tested with environment
  // injection, to find out whether the file descriptor or the token was at
  // fault. Never persisted from here: only the outcome of the retry decides.
  let fdProbe: { account: string } | null = null;
  let fdProbeSpent = false;

  for (;;) {
    const account = rotation.select({ excluded, pinned: options.pinned });
    if (!account) throw new AllAccountsExhaustedError(renderExhaustedReport(manager));

    const useFd = manager.state.fdInjectionWorks !== false && !fdProbe;
    const provider = providerFor(account, { useFdInjection: useFd });

    let mods: SpawnMods;
    try {
      mods = await provider.prepare(account);
    } catch (error) {
      // A credential that cannot be resolved is a configuration problem with
      // this account only; skip it and keep the invocation alive.
      logger.warn(`${account.name} unavailable: ${(error as Error).message}`);
      excluded.add(account.name);
      if (error instanceof TokenResolutionError || error instanceof Error) continue;
      throw error;
    }

    if (pendingResume && !mods.resumeAcrossAccounts) {
      await mods.cleanup();
      throw new AllAccountsExhaustedError(
        `✗ Response was interrupted mid-stream and the next account (${account.name}) uses an\n` +
          `  isolated config dir, so the conversation cannot be resumed there.\n` +
          `  Re-run with --cfo-account <name> to pick an account that shares session history,\n` +
          `  or resume manually: claude --resume ${options.sessionId ?? '<session-id>'}`,
      );
    }

    if (previous) logger.rotate(`Switching to ${account.name}`);
    else if (announce) logger.success(`Using ${account.name}`);
    else logger.info(`Using ${account.name}`);
    logger.debug(
      `provider=${account.provider} injection=${mods.injection} resumeAcross=${mods.resumeAcrossAccounts}`,
    );

    // Bounds the transcript probe below: only what this attempt wrote counts.
    const attemptStartedAt = new Date();
    let result: RunResult;
    try {
      result = await forcedResult(account.name) ?? await runClaude({
        binary,
        args: currentArgs,
        mods,
        interactive,
        cwd: options.cwd,
      });
    } finally {
      await mods.cleanup();
    }

    const failure = await classifyRun(result, options, attemptStartedAt);

    if (!failure) {
      await manager.markSuccess(account.name, options.sessionId);
      if (mods.injection === 'fd') await manager.setFdInjectionWorks(true);
      // The probe only concludes anything if the environment retry *worked*:
      // that is the one outcome that acquits the token and convicts fd
      // injection. A genuinely expired token fails both ways and must not
      // leave the machine permanently downgraded.
      else if (mods.injection === 'env' && fdProbe?.account === account.name) {
        await manager.setFdInjectionWorks(false);
      }
      if (previous) logger.success('Command resumed');
      return result;
    }

    // An auth error under fd injection has two possible causes: this build of
    // the CLI ignores the descriptor, or the token really is expired. Re-test
    // the same account with the environment variable once to tell them apart,
    // without spending a switch.
    if (failure.class === 'auth_expired' && mods.injection === 'fd' && useFd && !fdProbeSpent) {
      logger.info(
        `${account.name}: auth rejected with file-descriptor token injection; ` +
          'retrying once with the environment variable',
      );
      fdProbe = { account: account.name };
      fdProbeSpent = true;
      continue;
    }
    // The retry failed too, so the descriptor was never the problem: leave the
    // machine's injection preference alone and judge the account instead.
    if (fdProbe) fdProbe = null;

    if (options.noRotate || !options.rotateOn.includes(failure.class)) {
      if (failure.class !== 'unknown') {
        logger.warn(`${account.name}: ${describeFailure(failure)} (rotation disabled)`);
      }
      return result;
    }

    // Server-side overload is not the account's fault; wait and try again on
    // the same account before spending a switch.
    if (failure.class === 'overloaded' && overloadedRetries < OVERLOADED_RETRIES) {
      overloadedRetries++;
      const delay = OVERLOADED_BACKOFF_MS * 2 ** (overloadedRetries - 1) + Math.random() * 250;
      logger.warn(
        `${account.name}: service overloaded, retrying in ${Math.round(delay / 1000)}s ` +
          `(${overloadedRetries}/${OVERLOADED_RETRIES})`,
      );
      await sleep(delay);
      continue;
    }
    overloadedRetries = 0;

    await manager.markFailure(account.name, failure);
    logger.warn(`${account.name} ${failureVerb(failure.class)} (${describeFailure(failure)})`);
    if (failure.evidence) logger.info(`evidence: ${failure.evidence}`);

    if (switches >= options.maxSwitches) {
      logger.error(
        `switch limit reached (${options.maxSwitches}); raise defaults.max_switches to keep going`,
      );
      return result;
    }
    switches++;
    excluded.add(account.name);
    previous = account;

    // The transparency rule: if nothing has been printed yet, re-running the
    // original command is invisible to the user. Once bytes have been emitted
    // they cannot be taken back, so continue the same conversation instead of
    // replaying the prompt and duplicating output.
    if (!interactive && result.stdoutBytes > 0) {
      if (!options.sessionId) {
        logger.error(
          'output was already emitted and no session id is available to resume; stopping here',
        );
        return result;
      }
      currentArgs = toResumeArgs(currentArgs, options.sessionId);
      pendingResume = true;
      logger.info(`resuming session ${options.sessionId} on the next account`);
    } else if (interactive && options.sessionId) {
      currentArgs = toResumeArgs(currentArgs, options.sessionId);
      pendingResume = true;
    }
  }
}

/**
 * Classify a finished run. For interactive sessions the limit banner is drawn
 * inside the TUI rather than written to stderr, so the session transcript is
 * consulted as a second source.
 */
async function classifyRun(
  result: RunResult,
  options: FailoverOptions,
  attemptStartedAt: Date,
): Promise<Failure | null> {
  const direct = classify({
    exitCode: result.exitCode,
    signal: result.signal,
    stderr: result.stderr,
    stdout: result.stdout,
  });
  if (direct) return direct;
  if (!options.interactive || !options.sessionId || result.signal) return null;

  const transcript = await readTranscriptSince(
    options.sessionId,
    attemptStartedAt,
    options.cwd ?? process.cwd(),
  );
  if (!transcript) return null;
  // The transcript is evidence of what happened during the session, not of how
  // it ended, so it is only consulted with a synthetic non-zero exit code.
  return classify({ exitCode: 1, signal: null, stderr: '', stdout: transcript });
}

function failureVerb(failureClass: FailureClass): string {
  switch (failureClass) {
    case 'usage_limit':
    case 'credit_exhausted':
      return 'exhausted';
    case 'rate_limit':
      return 'rate limited';
    case 'auth_expired':
      return 'needs re-authentication';
    default:
      return 'failed';
  }
}

/**
 * Test hook. `CLAUDEX_FORCE_FAIL=usage_limit claudex -p "hi"` exercises the
 * whole rotation path without spending real quota; optionally scoped to
 * specific accounts with CLAUDEX_FORCE_FAIL_ACCOUNTS.
 */
async function forcedResult(accountName: string): Promise<RunResult | null> {
  const forced = process.env['CLAUDEX_FORCE_FAIL']?.trim();
  if (!forced) return null;
  const scope = process.env['CLAUDEX_FORCE_FAIL_ACCOUNTS'];
  if (scope && !scope.split(',').map((name) => name.trim()).includes(accountName)) return null;

  const messages: Record<string, string> = {
    usage_limit: 'Claude AI usage limit reached|' + Math.floor(Date.now() / 1000 + 3600),
    rate_limit: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
    overloaded: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
    auth_expired: 'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
    credit_exhausted: 'API Error: 400 Your credit balance is too low',
  };
  const message = messages[forced] ?? messages['usage_limit'] as string;
  return {
    exitCode: 1,
    signal: null,
    stderr: `[claudex forced failure] ${message}\n`,
    stdout: '',
    stdoutBytes: 0,
    durationMs: 0,
  };
}
