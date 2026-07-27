import type { Failure, FailureClass, LimitWindow } from '../types.js';
import { redact } from '../util/redact.js';
import { PATTERN_RULES, RESET_PATTERNS, RETRY_AFTER_PATTERNS } from './patterns.js';

export interface DetectInput {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Tail of the child's stderr. Always captured. */
  stderr: string;
  /** Tail of the child's stdout. Only captured for JSON output formats. */
  stdout?: string;
}

/** Longest evidence snippet kept for verbose logging. */
const EVIDENCE_CONTEXT = 160;

/**
 * Classify a finished `claude` invocation.
 *
 * Returns `null` when the run should be treated as a success or as a
 * user-initiated stop. Returns a `Failure` otherwise — including the deliberate
 * `unknown` class, which the retry manager refuses to rotate on. Rotating on
 * `unknown` would burn an account switch every time a prompt fails, a hook
 * errors, or the user's own code exits non-zero.
 */
export function classify(input: DetectInput): Failure | null {
  // A signalled child is almost always Ctrl-C. Never spend an account on it.
  if (input.signal) return null;

  const haystack = `${input.stderr}\n${input.stdout ?? ''}`;
  const structured = classifyStructured(input.stdout);

  let best: { class: FailureClass; weight: number; window?: LimitWindow; index: number } | null =
    structured ? { ...structured, index: 0 } : null;

  for (const rule of PATTERN_RULES) {
    const match = rule.pattern.exec(haystack);
    if (!match) continue;
    if (best && best.weight >= rule.weight) continue;
    best = { class: rule.class, weight: rule.weight, window: rule.window, index: match.index };
  }

  if (!best) {
    if (input.exitCode === 0 || input.exitCode === null) return null;
    return {
      class: 'unknown',
      evidence: evidenceFor(haystack, 0),
    };
  }

  // A clean exit that merely mentioned a limit (for example a status banner in
  // a successful run) is not a failure.
  if (input.exitCode === 0) return null;

  const failure: Failure = {
    class: best.class,
    evidence: evidenceFor(haystack, best.index),
  };

  const window = best.window ?? detectWindow(haystack);
  if (window) failure.window = window;

  const resetsAt = detectResetTime(haystack);
  if (resetsAt) failure.resetsAt = resetsAt;

  return failure;
}

/**
 * `--output-format json|stream-json` gives us a machine-readable result object.
 * When present it is more trustworthy than regex matching, so it outranks every
 * text pattern.
 */
function classifyStructured(
  stdout: string | undefined,
): { class: FailureClass; weight: number; window?: LimitWindow } | null {
  if (!stdout) return null;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed['type'] !== 'result' && parsed['is_error'] !== true) continue;
    if (parsed['is_error'] !== true) continue;

    const text = [parsed['subtype'], parsed['result'], parsed['error'], parsed['message']]
      .filter((value) => typeof value === 'string')
      .join(' ');
    for (const rule of PATTERN_RULES) {
      if (rule.pattern.test(text)) {
        return { class: rule.class, weight: rule.weight + 1000, window: rule.window };
      }
    }
    return { class: 'unknown', weight: 1000 };
  }
  return null;
}

function detectWindow(text: string): LimitWindow | undefined {
  for (const rule of PATTERN_RULES) {
    if (rule.window && rule.pattern.test(text)) return rule.window;
  }
  return undefined;
}

/** Absolute reset time, from an explicit timestamp or a relative retry-after. */
export function detectResetTime(text: string, now: Date = new Date()): Date | undefined {
  for (const pattern of RESET_PATTERNS) {
    const match = pattern.exec(text);
    const raw = match?.[1];
    if (!raw) continue;
    const parsed = parseTimestamp(raw);
    if (parsed && parsed.getTime() > now.getTime()) return parsed;
  }

  for (const pattern of RETRY_AFTER_PATTERNS) {
    const match = pattern.exec(text);
    if (!match?.[1]) continue;
    const amount = Number.parseInt(match[1], 10);
    if (Number.isNaN(amount)) continue;
    const unit = match[2]?.toLowerCase() ?? 'seconds';
    const multiplier = unit.startsWith('hour') ? 3_600_000 : unit.startsWith('minute') ? 60_000 : 1000;
    return new Date(now.getTime() + amount * multiplier);
  }

  return undefined;
}

function parseTimestamp(raw: string): Date | undefined {
  if (/^\d+$/.test(raw)) {
    const value = Number.parseInt(raw, 10);
    // Ten-digit values are seconds; thirteen-digit values are milliseconds.
    const date = new Date(raw.length <= 10 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function evidenceFor(text: string, index: number): string {
  const start = Math.max(0, index - EVIDENCE_CONTEXT / 2);
  const snippet = text.slice(start, start + EVIDENCE_CONTEXT).replace(/\s+/g, ' ').trim();
  return redact(snippet);
}

/** Human-readable label used in status lines. */
export function describeFailure(failure: Failure): string {
  if (failure.window) return failure.window;
  switch (failure.class) {
    case 'usage_limit':
      return 'usage limit';
    case 'rate_limit':
      return 'rate limited';
    case 'overloaded':
      return 'service overloaded';
    case 'auth_expired':
      return 'auth expired';
    case 'credit_exhausted':
      return 'out of credit';
    default:
      return 'unknown error';
  }
}
