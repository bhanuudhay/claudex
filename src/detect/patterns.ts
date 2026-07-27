import type { FailureClass, LimitWindow } from '../types.js';

/**
 * Failure signatures.
 *
 * Every pattern here was taken from strings present in the shipped Claude CLI
 * (2.1.x) or from the Anthropic API error taxonomy it surfaces, rather than
 * being invented. When a new CLI version changes its wording, this table is the
 * only file that needs updating — see docs/TESTING.md for how to re-derive it.
 */
export interface PatternRule {
  class: FailureClass;
  pattern: RegExp;
  /** Higher wins when several rules match the same output. */
  weight: number;
  window?: LimitWindow;
}

export const PATTERN_RULES: PatternRule[] = [
  // --- Subscription usage limits -------------------------------------------
  { class: 'usage_limit', pattern: /usage limit reached/i, weight: 100 },
  { class: 'usage_limit', pattern: /Claude (?:AI )?usage limit/i, weight: 100 },
  { class: 'usage_limit', pattern: /\bfive_hour\b/, weight: 95, window: 'five_hour' },
  { class: 'usage_limit', pattern: /\bseven_day_opus\b/, weight: 96, window: 'seven_day_opus' },
  { class: 'usage_limit', pattern: /\bseven_day_sonnet\b/, weight: 96, window: 'seven_day_sonnet' },
  { class: 'usage_limit', pattern: /\bseven_day\b/, weight: 95, window: 'seven_day' },
  { class: 'usage_limit', pattern: /\bsession limit\b/i, weight: 90, window: 'five_hour' },
  { class: 'usage_limit', pattern: /\bweekly limit\b/i, weight: 90, window: 'seven_day' },
  { class: 'usage_limit', pattern: /\bOpus limit\b/i, weight: 90, window: 'seven_day_opus' },
  { class: 'usage_limit', pattern: /\bSonnet limit\b/i, weight: 90, window: 'seven_day_sonnet' },
  { class: 'usage_limit', pattern: /upgrade to keep using Claude Code/i, weight: 88 },
  { class: 'usage_limit', pattern: /you(?:'ve| have) (?:reached|hit) your .{0,40}limit/i, weight: 88 },

  // --- Billing --------------------------------------------------------------
  { class: 'credit_exhausted', pattern: /credit balance (?:is )?too low/i, weight: 85 },
  { class: 'credit_exhausted', pattern: /"type"\s*:\s*"billing_error"/i, weight: 85 },
  { class: 'credit_exhausted', pattern: /\bbilling_error\b/i, weight: 80 },

  // --- Rate limiting --------------------------------------------------------
  { class: 'rate_limit', pattern: /\brate_limit_error\b/i, weight: 75 },
  { class: 'rate_limit', pattern: /\brate limit(?:ed|ing)?\b/i, weight: 60 },
  { class: 'rate_limit', pattern: /\b(?:status|API Error:?)\s*[:=]?\s*429\b/i, weight: 70 },
  { class: 'rate_limit', pattern: /\b429\b[^\d]{0,20}too many requests/i, weight: 70 },

  // --- Authentication -------------------------------------------------------
  { class: 'auth_expired', pattern: /\bauthentication_error\b/i, weight: 65 },
  { class: 'auth_expired', pattern: /\binvalid_api_key\b/i, weight: 65 },
  { class: 'auth_expired', pattern: /auth(?:entication)? token (?:has )?(?:expired|revoked)/i, weight: 65 },
  { class: 'auth_expired', pattern: /OAuth token (?:has )?(?:expired|revoked|is invalid)/i, weight: 65 },
  { class: 'auth_expired', pattern: /\b(?:status|API Error:?)\s*[:=]?\s*401\b/i, weight: 60 },
  { class: 'auth_expired', pattern: /invalid bearer token/i, weight: 60 },
  { class: 'auth_expired', pattern: /please run .{0,10}claude (?:auth )?login/i, weight: 58 },

  // --- Transient server-side ------------------------------------------------
  { class: 'overloaded', pattern: /\boverloaded_error\b/i, weight: 55 },
  { class: 'overloaded', pattern: /\bapi_error\b/i, weight: 40 },
  { class: 'overloaded', pattern: /\b(?:status|API Error:?)\s*[:=]?\s*5\d{2}\b/i, weight: 50 },
  { class: 'overloaded', pattern: /\b(?:status|API Error:?)\s*[:=]?\s*40[89]\b/i, weight: 45 },
  { class: 'overloaded', pattern: /\b(?:service unavailable|bad gateway|gateway timeout)\b/i, weight: 45 },
];

/** Extractors for "when does this reset", best source first. */
export const RESET_PATTERNS: RegExp[] = [
  // The CLI's own encoding: `Claude AI usage limit reached|1753660800`
  /usage limit reached\|(\d{9,13})/i,
  /"resets?_?at"\s*:\s*"([^"]+)"/i,
  /"resets?_?at"\s*:\s*(\d{9,13})/i,
  /resets? (?:at|on)\s+([0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:]{5,8}(?:Z|[+-][0-9:]{4,5})?)/i,
];

export const RETRY_AFTER_PATTERNS: RegExp[] = [
  /retry[-\s]?after["'\s:=]+(\d+)/i,
  /try again in (\d+)\s*(seconds?|minutes?|hours?)/i,
];
