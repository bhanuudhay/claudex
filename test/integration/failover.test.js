import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox, runClaudex } from './harness.js';

describe('passthrough', () => {
  test('forwards output and exit code unchanged on success', async () => {
    const sandbox = await makeSandbox({ script: [{ exit: 0, stdout: 'hello from claude\n' }] });
    try {
      const result = await runClaudex(sandbox, ['-p', 'say hi']);
      assert.equal(result.code, 0);
      assert.equal(result.stdout, 'hello from claude\n');
      // Wrapper chatter must never contaminate stdout.
      assert.ok(!result.stdout.includes('Using'));
    } finally {
      await sandbox.cleanup();
    }
  });

  test('forwards user arguments verbatim and strips claudex flags', async () => {
    const sandbox = await makeSandbox({ script: [{ exit: 0, stdout: 'ok\n' }] });
    try {
      await runClaudex(sandbox, ['--cfo-verbose', '-p', 'refactor', '--model', 'opus']);
      const [call] = await sandbox.calls();
      assert.ok(!call.args.some((arg) => arg.startsWith('--cfo-')));
      assert.deepEqual(call.args.slice(2), ['-p', 'refactor', '--model', 'opus']);
      // A session id is injected so a later account can resume the conversation.
      assert.equal(call.args[0], '--session-id');
    } finally {
      await sandbox.cleanup();
    }
  });

  test('preserves a non-zero exit code for unrelated failures without rotating', async () => {
    const sandbox = await makeSandbox({ script: [{ fail: 'unknown' }] });
    try {
      const result = await runClaudex(sandbox, ['-p', 'boom']);
      assert.equal(result.code, 3);
      assert.equal((await sandbox.calls()).length, 1, 'must not spend an account switch');
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe('failover', () => {
  test('switches accounts on a usage limit and retries transparently', async () => {
    const sandbox = await makeSandbox({
      script: [{ fail: 'usage_limit' }, { exit: 0, stdout: 'done on account two\n' }],
    });
    try {
      const result = await runClaudex(sandbox, ['-p', 'refactor']);
      assert.equal(result.code, 0);
      // The user sees the successful output once, with no duplication.
      assert.equal(result.stdout, 'done on account two\n');
      assert.match(result.stderr, /Using Personal/);
      assert.match(result.stderr, /Personal exhausted/);
      assert.match(result.stderr, /Switching to Work/);
      assert.match(result.stderr, /Command resumed/);

      const calls = await sandbox.calls();
      assert.equal(calls.length, 2);
      assert.notEqual(calls[0].tokenHash, calls[1].tokenHash, 'second attempt must use a new token');
      // Nothing was emitted before the failure, so the prompt is replayed as-is.
      assert.ok(!calls[1].args.includes('--resume'));
    } finally {
      await sandbox.cleanup();
    }
  });

  test('rotates on rate limits and exhausted credit', async () => {
    for (const failure of ['rate_limit', 'credit_exhausted']) {
      const sandbox = await makeSandbox({ script: [{ fail: failure }, { exit: 0, stdout: 'ok\n' }] });
      try {
        const result = await runClaudex(sandbox, ['-p', 'hi']);
        assert.equal(result.code, 0, `${failure} should have failed over`);
        const calls = await sandbox.calls();
        assert.equal(calls.length, 2, `${failure} should have retried once`);
        assert.notEqual(calls[0].tokenHash, calls[1].tokenHash, `${failure} should switch accounts`);
      } finally {
        await sandbox.cleanup();
      }
    }
  });

  test('an auth failure first falls back from fd to env injection on the same account', async () => {
    // The first auth rejection is ambiguous: it may mean the credential is bad,
    // or it may mean this build does not accept a token on a file descriptor.
    // claudex resolves the ambiguity by retrying the same account over the
    // environment variable before spending a switch.
    const sandbox = await makeSandbox({
      script: [{ fail: 'auth_expired' }, { exit: 0, stdout: 'ok\n' }],
    });
    try {
      const result = await runClaudex(sandbox, ['-p', 'hi']);
      assert.equal(result.code, 0);
      const calls = await sandbox.calls();
      assert.equal(calls.length, 2);
      assert.equal(calls[0].via, 'fd');
      assert.equal(calls[1].via, 'env');
      assert.equal(calls[0].tokenHash, calls[1].tokenHash, 'same account, different injection');
    } finally {
      await sandbox.cleanup();
    }
  });

  test('a persistent auth failure rotates once the injection fallback is exhausted', async () => {
    const sandbox = await makeSandbox({
      script: [{ fail: 'auth_expired' }, { fail: 'auth_expired' }, { exit: 0, stdout: 'ok\n' }],
    });
    try {
      const result = await runClaudex(sandbox, ['-p', 'hi']);
      assert.equal(result.code, 0);
      const calls = await sandbox.calls();
      assert.equal(calls.length, 3);
      assert.notEqual(calls[1].tokenHash, calls[2].tokenHash, 'third attempt is a different account');
    } finally {
      await sandbox.cleanup();
    }
  });

  test('retries the same account on a server-side overload before switching', async () => {
    const sandbox = await makeSandbox({
      script: [{ fail: 'overloaded' }, { exit: 0, stdout: 'recovered\n' }],
    });
    try {
      const result = await runClaudex(sandbox, ['-p', 'hi']);
      assert.equal(result.code, 0);
      const calls = await sandbox.calls();
      assert.equal(calls.length, 2);
      assert.equal(calls[0].tokenHash, calls[1].tokenHash, 'overload is not the account\'s fault');
    } finally {
      await sandbox.cleanup();
    }
  });

  test('resumes the session instead of replaying when output was already emitted', async () => {
    const sandbox = await makeSandbox({
      script: [
        { fail: 'usage_limit', stdout: 'partial answer so far…\n' },
        { exit: 0, stdout: '…and the rest\n' },
      ],
    });
    try {
      const result = await runClaudex(sandbox, ['-p', 'long task']);
      assert.equal(result.code, 0);
      assert.equal(result.stdout, 'partial answer so far…\n…and the rest\n');

      const calls = await sandbox.calls();
      const sessionId = calls[0].args[1];
      assert.deepEqual(calls[1].args.slice(0, 2), ['--resume', sessionId]);
    } finally {
      await sandbox.cleanup();
    }
  });

  test('reports every account and exits 77 when nothing is left', async () => {
    const sandbox = await makeSandbox({ script: [{ fail: 'usage_limit' }] });
    try {
      const result = await runClaudex(sandbox, ['-p', 'hi']);
      assert.equal(result.code, 77);
      assert.match(result.stderr, /All 2 configured accounts are unavailable/);
      assert.match(result.stderr, /Earliest availability/);
      assert.equal(result.stdout, '');
    } finally {
      await sandbox.cleanup();
    }
  });

  test('honours --cfo-no-rotate', async () => {
    const sandbox = await makeSandbox({ script: [{ fail: 'usage_limit' }, { exit: 0 }] });
    try {
      const result = await runClaudex(sandbox, ['--cfo-no-rotate', '-p', 'hi']);
      assert.equal(result.code, 1);
      assert.equal((await sandbox.calls()).length, 1);
    } finally {
      await sandbox.cleanup();
    }
  });

  test('honours --cfo-account by pinning a single account for the run', async () => {
    const sandbox = await makeSandbox({ script: [{ exit: 0, stdout: 'ok\n' }] });
    try {
      await runClaudex(sandbox, ['--cfo-account', 'Work', '-p', 'hi']);
      const [call] = await sandbox.calls();
      assert.match(call.tokenHash, /^[0-9a-f]{8}$/);

      const other = await makeSandbox({ script: [{ exit: 0, stdout: 'ok\n' }] });
      try {
        await runClaudex(other, ['-p', 'hi']);
        const [defaultCall] = await other.calls();
        assert.notEqual(call.tokenHash, defaultCall.tokenHash, '--cfo-account must not pick account 1');
      } finally {
        await other.cleanup();
      }
    } finally {
      await sandbox.cleanup();
    }
  });

  test('respects max_switches', async () => {
    const sandbox = await makeSandbox({
      accounts: ['A', 'B', 'C'],
      defaults: { maxSwitches: 1 },
      script: [{ fail: 'usage_limit' }],
    });
    try {
      const result = await runClaudex(sandbox, ['-p', 'hi']);
      assert.equal((await sandbox.calls()).length, 2, 'one switch, then stop');
      assert.match(result.stderr, /switch limit reached/);
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe('cooldowns persist across invocations', () => {
  test('a limited account is skipped by the next command', async () => {
    const sandbox = await makeSandbox({
      script: [{ fail: 'usage_limit' }, { exit: 0, stdout: 'ok\n' }, { exit: 0, stdout: 'ok\n' }],
    });
    try {
      await runClaudex(sandbox, ['-p', 'first']);
      await runClaudex(sandbox, ['-p', 'second']);
      const calls = await sandbox.calls();
      assert.equal(calls.length, 3);
      // Attempts 2 and 3 both run on the second account: the first is cooling down.
      assert.equal(calls[1].tokenHash, calls[2].tokenHash);
      assert.notEqual(calls[0].tokenHash, calls[2].tokenHash);
    } finally {
      await sandbox.cleanup();
    }
  });
});
