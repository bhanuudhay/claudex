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

const TAIL_BYTES = 256 * 1024;

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

/**
 * Return only the transcript entries written since `since`.
 *
 * This bound is essential, not an optimisation. A transcript is append-only: the
 * usage-limit error that ended the session on the first account stays in the
 * file forever. When claudex relaunches the same session on a second account, an
 * unbounded read would find that stale error again and mark the second account
 * exhausted too — one real limit would cascade through every configured
 * account. Restricting the read to the attempt that just ran keeps each
 * account judged only on its own turn.
 *
 * Entries without a timestamp are skipped: they cannot be attributed to an
 * attempt, and guessing would reintroduce the cascade.
 */
export async function readTranscriptSince(
  sessionId: string,
  since: Date,
  cwd = process.cwd(),
  configDir?: string,
): Promise<string> {
  const contents = await readTranscriptTail(sessionId, cwd, configDir);
  if (!contents) return '';

  const kept: string[] = [];
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed: { timestamp?: unknown };
    try {
      parsed = JSON.parse(trimmed) as { timestamp?: unknown };
    } catch {
      // A truncated final line is normal while the CLI is still writing.
      continue;
    }
    if (typeof parsed.timestamp !== 'string') continue;
    const at = new Date(parsed.timestamp);
    if (Number.isNaN(at.getTime()) || at.getTime() < since.getTime()) continue;
    kept.push(trimmed);
  }
  return kept.join('\n');
}
