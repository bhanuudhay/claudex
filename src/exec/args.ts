/**
 * Analysis of the user's own argument vector.
 *
 * claudex never rewrites arguments it does not understand: the vector is passed
 * to `claude` byte-for-byte apart from the two documented injections (a session
 * id, and a resume flag when recovering mid-response). Everything here is
 * therefore read-only inspection plus those two explicit transforms.
 */

export type OutputFormat = 'text' | 'json' | 'stream-json' | undefined;

export interface ArgFacts {
  /** True when `claude` will run non-interactively. */
  isPrint: boolean;
  outputFormat: OutputFormat;
  sessionId?: string;
  /** The user is already resuming or continuing a conversation. */
  isResuming: boolean;
  /** `--help`/`--version`-style invocations that should never trigger rotation. */
  isMetaOnly: boolean;
  /** A `claude` subcommand (mcp, doctor, install, ...) rather than a prompt. */
  subcommand?: string;
}

const CLAUDE_SUBCOMMANDS = new Set([
  'agents',
  'auth',
  'auto-mode',
  'doctor',
  'gateway',
  'install',
  'mcp',
  'plugin',
  'plugins',
  'project',
  'setup-token',
  'ultrareview',
  'update',
  'upgrade',
  'help',
]);

function valueOf(args: string[], index: number, inline: string | undefined): string | undefined {
  if (inline !== undefined) return inline;
  const next = args[index + 1];
  return next && !next.startsWith('-') ? next : undefined;
}

export function analyzeArgs(args: string[], stdoutIsTty = process.stdout.isTTY): ArgFacts {
  const facts: ArgFacts = { isPrint: false, outputFormat: undefined, isResuming: false, isMetaOnly: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);

    switch (flag) {
      case '-p':
      case '--print':
        facts.isPrint = true;
        break;
      case '--output-format':
        facts.outputFormat = valueOf(args, i, inline) as OutputFormat;
        break;
      case '--session-id':
        facts.sessionId = valueOf(args, i, inline);
        break;
      case '-r':
      case '--resume':
      case '-c':
      case '--continue':
      case '--from-pr':
        facts.isResuming = true;
        break;
      case '-h':
      case '--help':
      case '-v':
      case '--version':
        facts.isMetaOnly = true;
        break;
      default:
        break;
    }

    if (!facts.subcommand && !arg.startsWith('-') && CLAUDE_SUBCOMMANDS.has(arg)) {
      // Only the first bare token can be a subcommand; later ones are prompts.
      const precededByValueFlag =
        i > 0 && ['--output-format', '--session-id', '--model', '--agent'].includes(args[i - 1] as string);
      if (!precededByValueFlag) facts.subcommand = arg;
    }
  }

  // A non-TTY stdout puts the CLI in non-interactive mode even without `-p`.
  if (!stdoutIsTty) facts.isPrint = true;
  if (facts.subcommand) facts.isPrint = true;

  return facts;
}

/** UUID v4 for the injected `--session-id`. */
export function newSessionId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Add `--session-id <uuid>` when the user did not pick one and is not already
 * resuming. Knowing the id up front is what makes it possible to continue the
 * same conversation on another account after a limit is hit.
 */
export function injectSessionId(args: string[], sessionId: string): string[] {
  return ['--session-id', sessionId, ...args];
}

export function shouldInjectSessionId(facts: ArgFacts): boolean {
  return !facts.sessionId && !facts.isResuming && !facts.isMetaOnly && !facts.subcommand;
}

/**
 * Rebuild an argument vector that resumes `sessionId` instead of restarting.
 * Used only when output was already emitted, so re-running the original prompt
 * would duplicate work the user has already seen.
 */
export function toResumeArgs(args: string[], sessionId: string): string[] {
  const cleaned: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (flag === '--session-id') {
      if (!arg.includes('=') && args[i + 1] && !(args[i + 1] as string).startsWith('-')) i++;
      continue;
    }
    if (flag === '-r' || flag === '--resume' || flag === '-c' || flag === '--continue') {
      if (!arg.includes('=') && args[i + 1] && !(args[i + 1] as string).startsWith('-')) i++;
      continue;
    }
    cleaned.push(arg);
  }
  return ['--resume', sessionId, ...cleaned];
}
