/**
 * Secret redaction.
 *
 * Two layers, because either one alone is insufficient:
 *   1. A shape-based regex, which catches tokens we never loaded ourselves
 *      (e.g. a token echoed back inside a child process error message).
 *   2. An exact-match registry of every secret this process has touched, which
 *      catches secrets whose shape we did not anticipate.
 *
 * Every write in `Logger` goes through `redact()`. Nothing else is allowed to
 * write token-bearing text to a stream.
 */

/**
 * Anthropic credential shapes:
 *   sk-ant-oat01-...   OAuth token from `claude setup-token`
 *   sk-ant-api03-...   API key from the console
 *   sk-ant-...         anything else Anthropic mints in the same family
 */
const TOKEN_SHAPE = /sk-ant-[A-Za-z0-9]{2,12}-[A-Za-z0-9_-]{6,}/g;

const secrets = new Set<string>();

/** Register a known secret so it is scrubbed even if its shape is unusual. */
export function registerSecret(secret: string | undefined | null): void {
  if (typeof secret !== 'string') return;
  const trimmed = secret.trim();
  // Very short strings would cause catastrophic over-redaction of normal text.
  if (trimmed.length < 12) return;
  secrets.add(trimmed);
}

export function clearSecrets(): void {
  secrets.clear();
}

/** `sk-ant-oat01-AbCd...WxYz` -> `sk-ant-oat01-…WxYz` */
export function maskToken(token: string): string {
  const shapeMatch = /^(sk-ant-[A-Za-z0-9]{2,12}-)/.exec(token);
  const prefix = shapeMatch?.[1] ?? token.slice(0, 6);
  const tail = token.slice(-4);
  return `${prefix}…${tail}`;
}

/** Redact every known and shape-matching secret in `text`. */
export function redact(text: string): string {
  let out = text.replace(TOKEN_SHAPE, (match) => maskToken(match));
  for (const secret of secrets) {
    if (!secret || !out.includes(secret)) continue;
    out = out.split(secret).join(maskToken(secret));
  }
  return out;
}

/** Redact an environment map for debug output. Values, not keys, are masked. */
export function redactEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const sensitiveKey = /token|key|secret|password|credential/i;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    out[key] = sensitiveKey.test(key) ? maskToken(value) : redact(value);
  }
  return out;
}
