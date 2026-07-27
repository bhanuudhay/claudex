import { AccountManager } from './accounts/account-manager.js';
import { baseMods } from './accounts/providers/provider.js';
import { accountsCommand } from './commands/accounts.js';
import { checkupCommand } from './commands/checkup.js';
import { healthCommand } from './commands/health.js';
import { initCommand } from './commands/init.js';
import { statusCommand } from './commands/status.js';
import { resetCommand, useCommand } from './commands/use.js';
import { ConfigError } from './config/schema.js';
import { loadConfig } from './config/config-manager.js';
import { analyzeArgs, injectSessionId, newSessionId, shouldInjectSessionId } from './exec/args.js';
import { exitLike, runClaude } from './exec/claude-executor.js';
import { assertNotRecursing, resolveClaudeBinary } from './exec/resolve-claude.js';
import { LogLevel, logger, type LogLevelValue } from './log/logger.js';
import { AllAccountsExhaustedError, EXIT_ALL_EXHAUSTED, runWithFailover } from './retry/retry-manager.js';

const HELP = `claudex — the Claude CLI, with automatic account failover

USAGE
  claudex [claudex flags] [any claude arguments]     run claude with failover
  claudex <subcommand> [args]                        manage claudex itself

CLAUDEX FLAGS (stripped, never forwarded to claude)
  --cfo-account <name>     use this account for this run
  --cfo-max-switches <n>   maximum account switches for this run
  --cfo-no-rotate          run once, never fail over
  --cfo-quiet              errors only
  --cfo-verbose            explain each attempt
  --cfo-debug              verbose plus internals
  --cfo-help               this message
  --cfo-version            print the claudex version

SUBCOMMANDS
  init                     write a starter config
  accounts list|add|remove manage configured accounts
  status                   show the active account and cooldowns
  health [--deep]          check every configured credential
  use <name> | --clear     pin (or unpin) an account
  reset [name]             clear recorded cooldowns
  checkup [--timing]       diagnose the installation

Every other argument is forwarded to the real claude binary unchanged.
Prefix any subcommand with \`cfo\` (\`claudex cfo status\`) to disambiguate it
from a claude subcommand of the same name.

EXIT CODES
  ${EXIT_ALL_EXHAUSTED}                       every configured account is unavailable
  anything else            whatever claude returned
`;

const SUBCOMMANDS = new Set(['init', 'accounts', 'status', 'health', 'use', 'reset', 'checkup']);

interface ParsedFlags {
  account?: string;
  maxSwitches?: number;
  noRotate: boolean;
  level?: LogLevelValue;
  help: boolean;
  version: boolean;
  /** Arguments destined for the real CLI, in their original order. */
  rest: string[];
}

export function parseOwnFlags(argv: string[]): ParsedFlags {
  const flags: ParsedFlags = { noRotate: false, help: false, version: false, rest: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--cfo-')) {
      flags.rest.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
    const takeValue = (): string | undefined => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) return undefined;
      i++;
      return next;
    };

    switch (name) {
      case '--cfo-account':
        flags.account = takeValue();
        break;
      case '--cfo-max-switches': {
        const value = takeValue();
        const parsed = Number.parseInt(value ?? '', 10);
        if (!Number.isNaN(parsed)) flags.maxSwitches = parsed;
        break;
      }
      case '--cfo-no-rotate':
        flags.noRotate = true;
        break;
      case '--cfo-quiet':
        flags.level = LogLevel.quiet;
        break;
      case '--cfo-verbose':
        flags.level = LogLevel.verbose;
        break;
      case '--cfo-debug':
        flags.level = LogLevel.debug;
        break;
      case '--cfo-help':
        flags.help = true;
        break;
      case '--cfo-version':
        flags.version = true;
        break;
      default:
        logger.warn(`unknown claudex flag ${name} (ignored, not forwarded)`);
        break;
    }
  }

  return flags;
}

async function runSubcommand(name: string, argv: string[]): Promise<number> {
  switch (name) {
    case 'init':
      return initCommand(argv);
    case 'accounts':
      return accountsCommand(argv);
    case 'status':
      return statusCommand();
    case 'health':
      return healthCommand(argv);
    case 'use':
      return useCommand(argv);
    case 'reset':
      return resetCommand(argv);
    case 'checkup':
    case 'doctor':
      return checkupCommand(argv);
    default:
      logger.error(`unknown claudex subcommand: ${name}`);
      return 2;
  }
}

/**
 * Fall back to a plain passthrough when claudex has nothing to fail over
 * between. An unconfigured install must still behave exactly like `claude`.
 */
async function passthroughOnly(args: string[], reason: string): Promise<never> {
  logger.info(`no failover configured (${reason}); running claude directly`);
  const binary = await resolveClaudeBinary();
  const facts = analyzeArgs(args);
  const result = await runClaude({
    binary,
    args,
    mods: baseMods(),
    interactive: !facts.isPrint,
  });
  exitLike(result);
}

export async function main(argv: string[]): Promise<void> {
  try {
    assertNotRecursing();

    const flags = parseOwnFlags(argv);
    if (flags.level !== undefined) logger.setLevel(flags.level);
    if (process.env['CLAUDEX_DEBUG'] === '1') logger.setLevel(LogLevel.debug);

    if (flags.help) {
      process.stdout.write(HELP);
      process.exit(0);
    }
    if (flags.version) {
      process.stdout.write(`${await readVersion()}\n`);
      process.exit(0);
    }

    // Subcommands: `claudex status` or the unambiguous `claudex cfo status`.
    const [first, ...restArgs] = flags.rest;
    if (first === 'cfo') {
      const [name, ...args] = restArgs;
      if (!name) {
        process.stdout.write(HELP);
        process.exit(0);
      }
      process.exit(await runSubcommand(name, args));
    }
    if (first && SUBCOMMANDS.has(first)) {
      process.exit(await runSubcommand(first, restArgs));
    }

    await runPassthrough(flags);
  } catch (error) {
    if (error instanceof AllAccountsExhaustedError) {
      logger.block(error.report);
      process.exit(EXIT_ALL_EXHAUSTED);
    }
    logger.error((error as Error).message);
    if (process.env['CLAUDEX_DEBUG'] === '1') logger.debug(String((error as Error).stack));
    process.exit(1);
  }
}

async function runPassthrough(flags: ParsedFlags): Promise<never> {
  const args = flags.rest;

  let loaded;
  try {
    loaded = await loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) await passthroughOnly(args, 'no accounts configured');
    throw error;
  }
  const { config } = loaded;

  if (config.defaults.quiet && flags.level === undefined) logger.setLevel(LogLevel.quiet);
  for (const warning of config.warnings) logger.warn(warning);

  const binary = await resolveClaudeBinary({ explicit: config.defaults.claudePath });
  const facts = analyzeArgs(args);

  // Meta invocations (`--help`, `--version`) never touch the API, so they get
  // the shortest possible path: no state, no account selection.
  if (facts.isMetaOnly) {
    const result = await runClaude({ binary, args, mods: baseMods(), interactive: false });
    exitLike(result);
  }

  const manager = await AccountManager.create(config);

  let finalArgs = args;
  let sessionId = facts.sessionId;
  if (shouldInjectSessionId(facts)) {
    sessionId = newSessionId();
    finalArgs = injectSessionId(args, sessionId);
  }

  const result = await runWithFailover({
    manager,
    binary,
    args: finalArgs,
    interactive: !facts.isPrint,
    sessionId,
    maxSwitches: flags.maxSwitches ?? config.defaults.maxSwitches,
    rotateOn: config.defaults.rotateOn,
    noRotate: flags.noRotate,
    pinned: flags.account,
  });

  exitLike(result);
}

async function readVersion(): Promise<string> {
  try {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8')) as {
      version: string;
    };
    return `claudex ${pkg.version}`;
  } catch {
    return 'claudex (version unknown)';
  }
}
