import { redact } from '../util/redact.js';

/**
 * All wrapper output goes to stderr, never stdout.
 *
 * This is load-bearing: `claudex -p "x" > out.txt` must produce exactly the
 * bytes `claude -p "x" > out.txt` would have produced. Status lines, warnings
 * and errors all belong on stderr.
 */
export const LogLevel = {
  quiet: 0,
  normal: 1,
  verbose: 2,
  debug: 3,
} as const;

export type LogLevelName = keyof typeof LogLevel;
export type LogLevelValue = (typeof LogLevel)[LogLevelName];

export interface LoggerOptions {
  level?: LogLevelValue;
  color?: boolean;
  stream?: NodeJS.WritableStream;
}

const ANSI = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  cyan: '\u001b[36m',
} as const;

function colorEnabled(stream: NodeJS.WritableStream): boolean {
  if (process.env['NO_COLOR'] !== undefined) return false;
  if (process.env['FORCE_COLOR'] === '1') return true;
  return Boolean((stream as NodeJS.WriteStream).isTTY);
}

export class Logger {
  #level: LogLevelValue;
  #color: boolean;
  #stream: NodeJS.WritableStream;

  constructor(options: LoggerOptions = {}) {
    this.#stream = options.stream ?? process.stderr;
    this.#level = options.level ?? LogLevel.normal;
    this.#color = options.color ?? colorEnabled(this.#stream);
  }

  get level(): LogLevelValue {
    return this.#level;
  }

  setLevel(level: LogLevelValue): void {
    this.#level = level;
  }

  #paint(text: string, color: keyof typeof ANSI): string {
    return this.#color ? `${ANSI[color]}${text}${ANSI.reset}` : text;
  }

  #write(level: LogLevelValue, line: string): void {
    if (this.#level < level) return;
    this.#stream.write(redact(line) + '\n');
  }

  /** `✓ Using Personal` — routine progress, suppressed by --cfo-quiet. */
  success(message: string): void {
    this.#write(LogLevel.normal, `${this.#paint('✓', 'green')} ${message}`);
  }

  /** `⚠ Personal exhausted (five_hour)` */
  warn(message: string): void {
    this.#write(LogLevel.normal, `${this.#paint('⚠', 'yellow')} ${message}`);
  }

  /** `↻ Switching to Work` */
  rotate(message: string): void {
    this.#write(LogLevel.normal, `${this.#paint('↻', 'cyan')} ${message}`);
  }

  /** Errors survive --cfo-quiet: a silent failure is worse than noise. */
  error(message: string): void {
    this.#write(LogLevel.quiet, `${this.#paint('✗', 'red')} ${message}`);
  }

  /** Multi-line block (e.g. the all-exhausted report). Printed verbatim. */
  block(text: string): void {
    if (this.#level < LogLevel.quiet) return;
    this.#stream.write(redact(text.endsWith('\n') ? text : text + '\n'));
  }

  info(message: string): void {
    this.#write(LogLevel.verbose, `${this.#paint('·', 'blue')} ${message}`);
  }

  debug(message: string): void {
    this.#write(LogLevel.debug, `${this.#paint('debug', 'dim')} ${message}`);
  }

  /** Plain line at normal level, no symbol. Used by subcommand output. */
  line(message = ''): void {
    this.#write(LogLevel.normal, message);
  }
}

/** Process-wide logger. Level is set once by the CLI after parsing its flags. */
export const logger = new Logger();
