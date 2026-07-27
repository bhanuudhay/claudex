import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classify, describeFailure, detectResetTime } from '../../dist/detect/error-detector.js';

/**
 * The strings below are the ones the shipped Claude CLI actually emits, or the
 * Anthropic API error bodies it forwards. See docs/TESTING.md for how they were
 * derived.
 */
const failing = (stderr, extra = {}) =>
  classify({ exitCode: 1, signal: null, stderr, ...extra });

describe('classify', () => {
  test('detects subscription usage limits and their window', () => {
    const failure = failing('Claude AI usage limit reached|1753660800\n');
    assert.equal(failure.class, 'usage_limit');

    assert.equal(failing('Error: five_hour limit reached').window, 'five_hour');
    assert.equal(failing('seven_day_opus limit reached').window, 'seven_day_opus');
    assert.equal(failing('You have reached your weekly limit').window, 'seven_day');
    assert.equal(failing('/upgrade to keep using Claude Code').class, 'usage_limit');
  });

  test('detects rate limiting', () => {
    assert.equal(
      failing('API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}').class,
      'rate_limit',
    );
  });

  test('detects transient server-side failures separately from account limits', () => {
    assert.equal(
      failing('API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}').class,
      'overloaded',
    );
    assert.equal(failing('API Error: 503 Service Unavailable').class, 'overloaded');
  });

  test('detects auth and billing failures', () => {
    assert.equal(failing('{"type":"authentication_error"}').class, 'auth_expired');
    assert.equal(failing('OAuth token has expired').class, 'auth_expired');
    assert.equal(failing('Your credit balance is too low').class, 'credit_exhausted');
  });

  test('classifies anything unrecognised as unknown, never as an account failure', () => {
    const failure = failing('TypeError: cannot read property of undefined');
    assert.equal(failure.class, 'unknown');
  });

  test('returns null for success and for signalled exits', () => {
    assert.equal(classify({ exitCode: 0, signal: null, stderr: '' }), null);
    // A clean exit that merely mentions a limit is not a failure.
    assert.equal(classify({ exitCode: 0, signal: null, stderr: 'usage limit reached' }), null);
    // Ctrl-C must never spend an account switch.
    assert.equal(classify({ exitCode: null, signal: 'SIGINT', stderr: 'usage limit reached' }), null);
  });

  test('prefers a structured JSON result over text matching', () => {
    const failure = classify({
      exitCode: 1,
      signal: null,
      stderr: 'API Error: 529 overloaded_error',
      stdout: '{"type":"result","is_error":true,"result":"rate_limit_error"}',
    });
    assert.equal(failure.class, 'rate_limit');
  });

  test('extracts the reset time from the CLI encoding', () => {
    const epoch = Math.floor(Date.now() / 1000) + 7200;
    const failure = failing(`Claude AI usage limit reached|${epoch}`);
    assert.equal(failure.resetsAt.getTime(), epoch * 1000);
  });

  test('never leaks a token into the evidence snippet', () => {
    const failure = failing('auth error for sk-ant-oat01-SECRETVALUE1234567890 rate_limit_error');
    assert.ok(!failure.evidence.includes('SECRETVALUE'));
    assert.match(failure.evidence, /sk-ant-oat01-…/);
  });
});

describe('detectResetTime', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  test('honours retry-after in seconds and minutes', () => {
    assert.equal(detectResetTime('retry-after: 30', now).toISOString(), '2026-01-01T00:00:30.000Z');
    assert.equal(
      detectResetTime('try again in 5 minutes', now).toISOString(),
      '2026-01-01T00:05:00.000Z',
    );
  });

  test('ignores reset times in the past', () => {
    assert.equal(detectResetTime('"resets_at": "2020-01-01T00:00:00Z"', now), undefined);
  });
});

describe('describeFailure', () => {
  test('prefers the limit window when one is known', () => {
    assert.equal(describeFailure({ class: 'usage_limit', window: 'five_hour' }), 'five_hour');
    assert.equal(describeFailure({ class: 'rate_limit' }), 'rate limited');
  });
});
