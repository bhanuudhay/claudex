#!/usr/bin/env node
/**
 * Scripted stand-in for the real Claude CLI.
 *
 * Integration tests put this on PATH (or point CLAUDEX_CLAUDE_BIN at it) and
 * drive it with environment variables:
 *
 *   FAKE_CLAUDE_SCRIPT  JSON array, one entry per invocation. Each entry is
 *                       { "fail": "<class>" } or
 *                       { "exit": 0, "stdout": "...", "stderr": "..." }.
 *                       The last entry repeats once the array is exhausted.
 *   FAKE_CLAUDE_STATE   file used to count invocations across processes.
 *   FAKE_CLAUDE_LOG     JSONL file recording what each invocation saw.
 *
 * It records the credential it was given as a short hash, never the token
 * itself, so tests can assert "account 2 was used" without a secret ever
 * reaching a log file.
 */
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const FAILURES = {
  usage_limit: {
    exit: 1,
    stderr: `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 3600}\n`,
  },
  usage_limit_weekly: {
    exit: 1,
    stderr: 'Error: seven_day limit reached. /upgrade to keep using Claude Code\n',
  },
  rate_limit: {
    exit: 1,
    stderr: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}\n',
  },
  overloaded: {
    exit: 1,
    stderr: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}\n',
  },
  auth_expired: {
    exit: 1,
    stderr: 'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}\n',
  },
  credit_exhausted: {
    exit: 1,
    stderr: 'API Error: 400 Your credit balance is too low to continue\n',
  },
  unknown: { exit: 3, stderr: 'Error: something unrelated went wrong\n' },
};

function readToken() {
  const fd = process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR;
  if (fd) {
    try {
      return { via: 'fd', token: readFileSync(Number.parseInt(fd, 10), 'utf8').trim() };
    } catch {
      return { via: 'fd-failed', token: '' };
    }
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { via: 'env', token: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  }
  if (process.env.CLAUDE_CONFIG_DIR) {
    return { via: 'configdir', token: process.env.CLAUDE_CONFIG_DIR };
  }
  return { via: 'none', token: '' };
}

function hash(value) {
  return value ? createHash('sha256').update(value).digest('hex').slice(0, 8) : '';
}

function nextStep() {
  const script = JSON.parse(process.env.FAKE_CLAUDE_SCRIPT ?? '[]');
  const statePath = process.env.FAKE_CLAUDE_STATE;
  let index = 0;
  if (statePath) {
    try {
      index = Number.parseInt(readFileSync(statePath, 'utf8').trim(), 10) || 0;
    } catch {
      index = 0;
    }
    writeFileSync(statePath, String(index + 1));
  }
  if (script.length === 0) return { exit: 0, stdout: 'ok\n' };
  return script[Math.min(index, script.length - 1)];
}

const args = process.argv.slice(2);
const credential = readToken();

if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    JSON.stringify({
      args,
      via: credential.via,
      tokenHash: hash(credential.token),
      configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
      hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
      claudexActive: process.env.CLAUDEX_ACTIVE ?? null,
    }) + '\n',
  );
}

// `claude auth status --json`, used by `claudex health`.
if (args[0] === 'auth' && args[1] === 'status') {
  const healthy = credential.token !== '' && process.env.FAKE_CLAUDE_UNHEALTHY !== hash(credential.token);
  process.stdout.write(
    JSON.stringify({
      loggedIn: healthy,
      authMethod: 'claude.ai',
      email: `${hash(credential.token)}@example.test`,
      subscriptionType: 'pro',
    }) + '\n',
  );
  process.exit(healthy ? 0 : 1);
}

if (args.includes('--version')) {
  process.stdout.write('9.9.9 (Fake Claude Code)\n');
  process.exit(0);
}

const step = nextStep();
// `{ "fail": "...", "stdout": "..." }` emits output *before* failing, which is
// how a mid-response limit looks to the wrapper.
const behavior = step.fail
  ? { ...(FAILURES[step.fail] ?? FAILURES.unknown), ...(step.stdout ? { stdout: step.stdout } : {}) }
  : step;

if (behavior.stdout) process.stdout.write(behavior.stdout);
if (behavior.stderr) process.stderr.write(behavior.stderr);
process.exit(behavior.exit ?? 0);
