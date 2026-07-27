import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvFile, loadEnvFile, envFilePath } from '../../dist/config/env-file.js';

describe('parseEnvFile', () => {
  test('reads plain assignments', () => {
    const parsed = parseEnvFile('CLAUDE_TOKEN_1=sk-ant-oat01-abc\nCLAUDEX_ACCOUNT_1_NAME=Personal\n');
    assert.equal(parsed.get('CLAUDE_TOKEN_1'), 'sk-ant-oat01-abc');
    assert.equal(parsed.get('CLAUDEX_ACCOUNT_1_NAME'), 'Personal');
  });

  test('tolerates a stray space after the equals sign', () => {
    // `KEY= value` is a common slip and silently breaks `source`; the value is
    // clearly the token, not an empty string followed by a command.
    assert.equal(parseEnvFile('CLAUDE_TOKEN_2= sk-ant-oat01-xyz\n').get('CLAUDE_TOKEN_2'), 'sk-ant-oat01-xyz');
  });

  test('accepts an export prefix, quotes and comments', () => {
    const parsed = parseEnvFile(
      [
        '# a comment',
        'export CLAUDE_TOKEN_1="sk-ant-oat01-quoted"',
        "CLAUDEX_ACCOUNT_1_NAME='Personal'",
        'CLAUDEX_MAX_SWITCHES=2 # trailing note',
        '',
        'not a valid line',
        '=nokey',
      ].join('\n'),
    );
    assert.equal(parsed.get('CLAUDE_TOKEN_1'), 'sk-ant-oat01-quoted');
    assert.equal(parsed.get('CLAUDEX_ACCOUNT_1_NAME'), 'Personal');
    assert.equal(parsed.get('CLAUDEX_MAX_SWITCHES'), '2');
    assert.equal(parsed.size, 3);
  });

  test('keeps a hash that is part of an unquoted value', () => {
    assert.equal(parseEnvFile('KEY=abc#def\n').get('KEY'), 'abc#def');
  });
});

describe('loadEnvFile', () => {
  test('applies file values and never overwrites the real environment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claudex-envfile-'));
    try {
      const path = join(dir, '.env');
      await writeFile(path, 'CLAUDE_TOKEN_1=from-file\nCLAUDE_TOKEN_2=from-file\n');

      const env = { CLAUDEX_ENV_FILE: path, CLAUDE_TOKEN_1: 'from-shell' };
      const result = loadEnvFile(env);

      assert.equal(result.path, path);
      // An explicit export must win over the file.
      assert.equal(env.CLAUDE_TOKEN_1, 'from-shell');
      assert.equal(env.CLAUDE_TOKEN_2, 'from-file');
      assert.deepEqual(result.applied, ['CLAUDE_TOKEN_2']);
      assert.deepEqual(result.skipped, ['CLAUDE_TOKEN_1']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('is a no-op when no file exists', () => {
    const env = { CLAUDEX_ENV_FILE: '/nonexistent/path/.env' };
    const result = loadEnvFile(env);
    assert.equal(result.path, null);
    assert.deepEqual(result.applied, []);
  });

  test('falls back to the claudex config directory, never the current directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claudex-envhome-'));
    try {
      await mkdir(join(dir, 'claudex'), { recursive: true });
      await writeFile(join(dir, 'claudex', '.env'), 'CLAUDE_TOKEN_9=x\n');
      const previous = process.env['XDG_CONFIG_HOME'];
      process.env['XDG_CONFIG_HOME'] = dir;
      try {
        assert.equal(envFilePath({}), join(dir, 'claudex', '.env'));
      } finally {
        if (previous === undefined) delete process.env['XDG_CONFIG_HOME'];
        else process.env['XDG_CONFIG_HOME'] = previous;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
