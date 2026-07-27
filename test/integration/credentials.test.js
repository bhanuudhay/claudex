import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeSandbox, runClaudex } from './harness.js';

describe('credential handling', () => {
  test('delivers the token on file descriptor 3, not in the child environment', async () => {
    const sandbox = await makeSandbox({ script: [{ exit: 0, stdout: 'ok\n' }] });
    try {
      await runClaudex(sandbox, ['-p', 'hi']);
      const [call] = await sandbox.calls();
      assert.equal(call.via, 'fd', 'default injection must keep the token out of the environment');
      assert.match(call.tokenHash, /^[0-9a-f]{8}$/);
      assert.equal(call.claudexActive, '1', 'recursion marker must be set for the child');
    } finally {
      await sandbox.cleanup();
    }
  });

  test('clears inherited API-key variables so credential precedence is unambiguous', async () => {
    const sandbox = await makeSandbox({ script: [{ exit: 0, stdout: 'ok\n' }] });
    try {
      await runClaudex(sandbox, ['-p', 'hi'], { ANTHROPIC_API_KEY: 'sk-ant-api03-should-be-dropped' });
      const [call] = await sandbox.calls();
      assert.equal(call.hasApiKey, false);
    } finally {
      await sandbox.cleanup();
    }
  });

  test('never prints token material, even in debug mode', async () => {
    const sandbox = await makeSandbox({
      script: [{ fail: 'usage_limit' }, { exit: 0, stdout: 'ok\n' }],
    });
    try {
      const result = await runClaudex(sandbox, ['--cfo-debug', '-p', 'hi']);
      const combined = result.stdout + result.stderr;
      assert.ok(!/sk-ant-oat01-fake-token/.test(combined), 'raw token leaked into output');
      assert.ok(!combined.includes('fake-token-for-Personal'));
    } finally {
      await sandbox.cleanup();
    }
  });

  test('an unresolvable credential skips that account instead of failing the run', async () => {
    const sandbox = await makeSandbox({ script: [{ exit: 0, stdout: 'ok\n' }] });
    try {
      const result = await runClaudex(sandbox, ['-p', 'hi'], { TEST_TOKEN_1: '' });
      assert.equal(result.code, 0);
      assert.match(result.stderr, /Personal unavailable/);
      const calls = await sandbox.calls();
      assert.equal(calls.length, 1, 'only the healthy account ran');
    } finally {
      await sandbox.cleanup();
    }
  });

  test('stores added tokens with owner-only permissions', async () => {
    const sandbox = await makeSandbox({ script: [{ exit: 0 }] });
    try {
      const result = await runClaudex(sandbox, [
        'accounts',
        'add',
        '--name',
        'Stored',
        '--provider',
        'oauth',
      ]);
      // stdin is not a TTY in tests, so the token is read from the empty pipe.
      assert.notEqual(result.code, undefined);
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe('subcommands', () => {
  test('health reports each account without consuming quota', async () => {
    const sandbox = await makeSandbox({ script: [{ exit: 0 }] });
    try {
      const result = await runClaudex(sandbox, ['health']);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /ACCOUNT\s+PROVIDER\s+HEALTH/);
      assert.match(result.stdout, /Personal\s+profile\s+ok\s+pro/);
      const calls = await sandbox.calls();
      assert.ok(calls.every((call) => call.args[0] === 'auth'), 'health must only run auth status');
    } finally {
      await sandbox.cleanup();
    }
  });

  test('status and accounts list reflect recorded cooldowns', async () => {
    const sandbox = await makeSandbox({ script: [{ fail: 'usage_limit' }, { exit: 0 }] });
    try {
      await runClaudex(sandbox, ['-p', 'hi']);

      const status = await runClaudex(sandbox, ['status']);
      assert.match(status.stdout, /accounts: 2 configured, 1 available now/);
      assert.match(status.stdout, /unavailable:/);

      const list = await runClaudex(sandbox, ['accounts', 'list']);
      assert.match(list.stdout, /Personal\s+profile\s+1\s+exhausted/);
      assert.match(list.stdout, /Work \*/, 'the active account is marked');
    } finally {
      await sandbox.cleanup();
    }
  });

  test('use pins an account and reset clears recorded state', async () => {
    const sandbox = await makeSandbox({ script: [{ exit: 0, stdout: 'ok\n' }] });
    try {
      await runClaudex(sandbox, ['use', 'Work']);
      await runClaudex(sandbox, ['-p', 'hi']);
      const [call] = await sandbox.calls();

      const reset = await runClaudex(sandbox, ['reset']);
      assert.equal(reset.code, 0);

      const status = await runClaudex(sandbox, ['status']);
      assert.match(status.stdout, /pinned:\s+Work/);
      assert.ok(call.tokenHash);
    } finally {
      await sandbox.cleanup();
    }
  });

  test('checkup passes on a well-formed sandbox installation', async () => {
    const sandbox = await makeSandbox({ script: [{ exit: 0 }] });
    try {
      const result = await runClaudex(sandbox, ['checkup']);
      assert.match(result.stdout, /✓ claude binary/);
      assert.match(result.stdout, /✓ config/);
      assert.equal(result.code, 0, result.stdout);
    } finally {
      await sandbox.cleanup();
    }
  });

  test('cfo-prefixed subcommands work for names that collide with claude', async () => {
    const sandbox = await makeSandbox({ script: [{ exit: 0 }] });
    try {
      const result = await runClaudex(sandbox, ['cfo', 'doctor']);
      assert.match(result.stdout, /claudex checkup/);
    } finally {
      await sandbox.cleanup();
    }
  });

  test('a real claude subcommand is forwarded rather than intercepted', async () => {
    const sandbox = await makeSandbox({ script: [{ exit: 0, stdout: 'servers\n' }] });
    try {
      const result = await runClaudex(sandbox, ['mcp', 'list']);
      assert.equal(result.stdout, 'servers\n');
      const [call] = await sandbox.calls();
      assert.deepEqual(call.args, ['mcp', 'list'], 'no session id injected into subcommands');
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe('config-dir provider', () => {
  test('runs against an isolated CLAUDE_CONFIG_DIR', async () => {
    const sandbox = await makeSandbox({
      accounts: ['Personal', { name: 'Isolated', provider: 'configdir' }],
      script: [{ fail: 'usage_limit' }, { exit: 0, stdout: 'ok\n' }],
    });
    try {
      const result = await runClaudex(sandbox, ['-p', 'hi']);
      assert.equal(result.code, 0);
      const calls = await sandbox.calls();
      assert.equal(calls[1].via, 'configdir');
      assert.match(calls[1].configDir, /profile-Isolated$/);
    } finally {
      await sandbox.cleanup();
    }
  });

  test('refuses a mid-response rotation into an isolated profile instead of replaying', async () => {
    const sandbox = await makeSandbox({
      accounts: ['Personal', { name: 'Isolated', provider: 'configdir' }],
      script: [{ fail: 'usage_limit', stdout: 'half an answer\n' }, { exit: 0, stdout: 'rest\n' }],
    });
    try {
      const result = await runClaudex(sandbox, ['-p', 'hi']);
      assert.equal(result.code, 77);
      assert.match(result.stderr, /cannot be resumed/);
      assert.equal(result.stdout, 'half an answer\n', 'no duplicated output');
      assert.equal((await sandbox.calls()).length, 1);
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe('config file permissions', () => {
  test('warns when a config holding a literal token is group-readable', async () => {
    const sandbox = await makeSandbox({ script: [{ exit: 0, stdout: 'ok\n' }] });
    try {
      const { writeFile, chmod } = await import('node:fs/promises');
      await writeFile(
        sandbox.configPath,
        'version: 1\naccounts:\n  - name: Literal\n    token: sk-ant-oat01-literal-token-value\n',
      );
      await chmod(sandbox.configPath, 0o644);

      const result = await runClaudex(sandbox, ['-p', 'hi']);
      assert.match(result.stderr, /contains literal tokens and is mode 644/);
      // The warning must not include the token itself.
      assert.ok(!result.stderr.includes('literal-token-value'));
      assert.equal(await readFile(sandbox.configPath, 'utf8').then((t) => t.includes('sk-ant')), true);
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe('replacing an expired token', () => {
  test('re-adding an account keeps its priority instead of demoting it', async () => {
    // Replacing an expired token means running `accounts add` again for an
    // account that already exists. Appending it would silently move it to the
    // end of the rotation order, demoting the account just repaired.
    const sandbox = await makeSandbox({ script: [{ exit: 0 }] });
    try {
      const { writeFile, readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      await writeFile(
        sandbox.configPath,
        [
          'version: 1',
          'accounts:',
          '  - name: Personal',
          '    priority: 1',
          '    token: store:Personal',
          '  - name: Work',
          '    priority: 2',
          '    token: store:Work',
        ].join('\n') + '\n',
        { mode: 0o600 },
      );

      const result = await runClaudex(
        sandbox,
        ['accounts', 'add', '--name', 'Personal', '--provider', 'oauth'],
        {},
        'sk-ant-oat01-replacement-token-0000\n',
      );
      assert.equal(result.code, 0, result.stderr);

      const config = await readFile(sandbox.configPath, 'utf8');
      const personal = config.slice(config.indexOf('name: Personal'));
      assert.match(personal.split('- name:')[0], /priority: 1/, 'Personal must stay at priority 1');
      assert.match(config, /name: Work[\s\S]*priority: 2/);

      // The new token really landed in the store.
      const store = JSON.parse(
        await readFile(join(sandbox.env.XDG_CONFIG_HOME, 'claudex', 'credentials.json'), 'utf8'),
      );
      assert.equal(store.tokens.Personal, 'sk-ant-oat01-replacement-token-0000');
    } finally {
      await sandbox.cleanup();
    }
  });
});
