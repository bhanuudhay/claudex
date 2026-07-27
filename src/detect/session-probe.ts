import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Interactive sessions render their limit banner inside the TUI, on stdout,
 * which claudex deliberately does not intercept. The transcript on disk is the
 * remaining evidence: `claude` appends every turn — including API errors — to
 * `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<session-id>.jsonl`.
 *
 * After an interactive run exits we read the tail of that file and feed it to
 * the same detector used for print mode. This is what lets `claudex` notice
 * "you were rate limited" for a TUI session and offer the next account on
 * relaunch.
 */

/** `/Users/x/proj` -> `-Users-x-proj`, matching the CLI's own directory naming. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function transcriptPath(sessionId: string, cwd = process.cwd(), configDir?: string): string {
  const base = configDir ?? process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');
  return join(base, 'projects', projectSlug(cwd), `${sessionId}.jsonl`);
}

const TAIL_BYTES = 64 * 1024;

/** Return the tail of a session transcript, or '' when it cannot be read. */
export async function readTranscriptTail(
  sessionId: string,
  cwd = process.cwd(),
  configDir?: string,
): Promise<string> {
  try {
    const contents = await readFile(transcriptPath(sessionId, cwd, configDir), 'utf8');
    return contents.length > TAIL_BYTES ? contents.slice(-TAIL_BYTES) : contents;
  } catch {
    return '';
  }
}
