import { createInterface, type Interface } from 'node:readline';

/**
 * Small prompt helpers.
 *
 * Prompts are written to stderr so that a subcommand's real output on stdout
 * stays pipeable, and secret input is never echoed to the terminal.
 */

interface MutableInterface extends Interface {
  _writeToOutput?: (text: string) => void;
  output?: NodeJS.WritableStream;
}

export async function promptLine(question: string, fallback = ''): Promise<string> {
  if (!process.stdin.isTTY) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim() || fallback));
    });
  } finally {
    rl.close();
  }
}

/** Read a line without echoing it. Falls back to plain read on a non-TTY. */
export async function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Piped input: read everything available, e.g. `echo $TOKEN | claudex accounts add`.
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/, 1)[0]?.trim() ?? '';
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  }) as MutableInterface;

  let muted = false;
  rl._writeToOutput = (text: string): void => {
    if (!muted) process.stderr.write(text);
    else if (text.includes('\n')) process.stderr.write('\n');
  };

  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (answer) => {
        muted = false;
        resolve(answer.trim());
      });
      muted = true;
    });
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const answer = (await promptLine(question + suffix)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}
