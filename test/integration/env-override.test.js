import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { makeSandbox, runClaudex } from './harness.js';

/**
 * Precedence between a config file and CLAUDE_TOKEN_* variables.
 *
 * The environment wins. An account named in both keeps its file definition but
 * takes the environment's token, and takes the environment's priority when
 * CLAUDEX_ACCOUNT_<N>_PRIORITY was set explicitly. A priority that was merely
 * inferred from the variable's number is not treated as a choice and does not
 * override the file.
 */
async function writeConfig(sandbox, body) {
  await writeFile(sandbox.configPath, body, { mode: 0o600 });
}

const TWO_ACCOUNTS = `version: 1
accounts:
  - name: Personal
    priority: 1
    token: env:FILE_TOKEN_1
  - name: Work
    priority: 2
    token: env:FILE_TOKEN_2
`;

describe('environment overrides the config file', () => {
  test('an explicit env priority reorders accounts defined in the file', async () => {
    const sandbox = await makeSandbox({ script: [{ exit: 0, stdout: 'ok\n' }] });
    try {
      await writeConfig(sandbox, TWO_ACCOUNTS);
      const result = await runClaudex(sandbox, ['status'], {
        FILE_TOKEN_1: 'sk-ant-oat01-file-one-0000',
        FILE_TOKEN_2: 'sk-ant-oat01-file-two-0000',
        CLAUDE_TOKEN_1: 'sk-ant-oat01-env-one-0000',
        CLAUDE_TOKEN_2: 'sk-ant-oat01-env-two-0000',
        CLAUDEX_ACCOUNT_1_NAME: 'Personal',
        CLAUDEX_ACCOUNT_1_PRIORITY: '2',
        CLAUDEX_ACCOUNT_2_NAME: 'Work',
        CLAUDEX_ACCOUNT_2_PRIORITY: '1',
      });
      assert.match(result.stdout, /next:\s+Work/, result.stdout + result.stderr);
    } finally {
      await sandbox.cleanup();
    }
  });

  test('the env token replaces the one the file names, for a matching account', async () => {
    const sandbox = await makeSandbox({ script: [{ exit: 0, stdout: 'ok\n' }] });
    try {
      await writeConfig(sandbox, TWO_ACCOUNTS);
      await runClaudex(sandbox, ['-p', 'hi'], {
        FILE_TOKEN_1: 'sk-ant-oat01-file-one-0000',
        FILE_TOKEN_2: 'sk-ant-oat01-file-two-0000',
        CLAUDE_TOKEN_1: 'sk-ant-oat01-env-one-0000',
        CLAUDEX_ACCOUNT_1_NAME: 'Personal',
      });
      const [call] = await sandbox.calls();
      const { createHash } = await import('node:crypto');
      const envHash = createHash('sha256')
        .update('sk-ant-oat01-env-one-0000')
        .digest('hex')
        .slice(0, 8);
      assert.equal(call.tokenHash, envHash, 'the environment token must win');
    } finally {
      await sandbox.cleanup();
    }
  });

  test('an inferred priority does not silently override the file', async () => {
    const sandbox = await makeSandbox({ script: [{ exit: 0, stdout: 'ok\n' }] });
    try {
      // File order is Personal, Work. The env supplies a token for Work as
      // CLAUDE_TOKEN_1, whose inferred priority would be 1 — but no explicit
      // priority was set, so the file's ordering must stand.
      await writeConfig(sandbox, TWO_ACCOUNTS);
      const result = await runClaudex(sandbox, ['status'], {
        FILE_TOKEN_1: 'sk-ant-oat01-file-one-0000',
        FILE_TOKEN_2: 'sk-ant-oat01-file-two-0000',
        CLAUDE_TOKEN_1: 'sk-ant-oat01-env-one-0000',
        CLAUDEX_ACCOUNT_1_NAME: 'Work',
      });
      assert.match(result.stdout, /next:\s+Personal/, result.stdout + result.stderr);
    } finally {
      await sandbox.cleanup();
    }
  });

  test('an env account with a new name is added to the file accounts', async () => {
    const sandbox = await makeSandbox({ script: [{ exit: 0, stdout: 'ok\n' }] });
    try {
      await writeConfig(sandbox, TWO_ACCOUNTS);
      const result = await runClaudex(sandbox, ['accounts', 'list'], {
        FILE_TOKEN_1: 'sk-ant-oat01-file-one-0000',
        FILE_TOKEN_2: 'sk-ant-oat01-file-two-0000',
        CLAUDE_TOKEN_3: 'sk-ant-oat01-env-three-000',
        CLAUDEX_ACCOUNT_3_NAME: 'Extra',
      });
      assert.match(result.stdout, /Extra\s+oauth/);
    } finally {
      await sandbox.cleanup();
    }
  });

  test('the override is explained in verbose mode, and silent otherwise', async () => {
    const sandbox = await makeSandbox({ script: [{ exit: 0, stdout: 'ok\n' }] });
    try {
      await writeConfig(sandbox, TWO_ACCOUNTS);
      const result = await runClaudex(sandbox, ['--cfo-verbose', '-p', 'hi'], {
        FILE_TOKEN_1: 'sk-ant-oat01-file-one-0000',
        FILE_TOKEN_2: 'sk-ant-oat01-file-two-0000',
        CLAUDE_TOKEN_1: 'sk-ant-oat01-env-one-0000',
        CLAUDEX_ACCOUNT_1_NAME: 'Personal',
        CLAUDEX_ACCOUNT_1_PRIORITY: '5',
      });
      // Expected behaviour is explained on request, not shouted every run.
      assert.match(result.stderr, /environment overrides/);
      assert.match(result.stderr, /priority 5 from the environment/);
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe('priority beats stickiness by default', () => {
  test('a later command returns to the highest-priority account', async () => {
    const sandbox = await makeSandbox({
      script: [{ fail: 'usage_limit' }, { exit: 0, stdout: 'ok\n' }, { exit: 0, stdout: 'ok\n' }],
    });
    try {
      // First command fails over to Work and succeeds there.
      await runClaudex(sandbox, ['-p', 'one']);
      // Clear the cooldown so Personal is eligible again, then run once more.
      await runClaudex(sandbox, ['reset']);
      const status = await runClaudex(sandbox, ['status']);
      assert.match(status.stdout, /next:\s+Personal\s+\(highest priority available\)/, status.stdout);
    } finally {
      await sandbox.cleanup();
    }
  });

  test('CLAUDEX_STICKY=1 restores the previous behaviour', async () => {
    const sandbox = await makeSandbox({
      script: [{ fail: 'usage_limit' }, { exit: 0, stdout: 'ok\n' }],
    });
    try {
      await runClaudex(sandbox, ['-p', 'one'], { CLAUDEX_STICKY: '1' });
      await runClaudex(sandbox, ['reset', 'Personal'], { CLAUDEX_STICKY: '1' });
      const status = await runClaudex(sandbox, ['status'], { CLAUDEX_STICKY: '1' });
      assert.match(status.stdout, /next:\s+Work\s+\(sticky/, status.stdout);
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe('the claudex env file', () => {
  test('drives configuration without any shell exports', async () => {
    const sandbox = await makeSandbox({ script: [{ exit: 0, stdout: 'ok\n' }] });
    try {
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { join } = await import('node:path');
      await writeConfig(sandbox, TWO_ACCOUNTS);
      const claudexConfigDir = join(sandbox.env.XDG_CONFIG_HOME, 'claudex');
      await mkdir(claudexConfigDir, { recursive: true });
      // Deliberately includes the `KEY= value` slip that breaks `source`.
      await writeFile(
        join(claudexConfigDir, '.env'),
        [
          'FILE_TOKEN_1=sk-ant-oat01-file-one-0000',
          'FILE_TOKEN_2= sk-ant-oat01-file-two-0000',
          'CLAUDEX_ACCOUNT_1_NAME=Personal',
          'CLAUDEX_ACCOUNT_1_PRIORITY=2',
          'CLAUDEX_ACCOUNT_2_NAME=Work',
          'CLAUDEX_ACCOUNT_2_PRIORITY=1',
          'CLAUDE_TOKEN_1=sk-ant-oat01-env-one-0000',
          'CLAUDE_TOKEN_2=sk-ant-oat01-env-two-0000',
        ].join('\n'),
      );

      const result = await runClaudex(sandbox, ['status']);
      assert.match(result.stdout, /next:\s+Work/, result.stdout + result.stderr);
    } finally {
      await sandbox.cleanup();
    }
  });
});
