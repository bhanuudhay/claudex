import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redact, registerSecret, maskToken, clearSecrets, redactEnv } from '../../dist/util/redact.js';
import { Logger, LogLevel } from '../../dist/log/logger.js';
import { isSelf, resolveClaudeBinary, assertNotRecursing } from '../../dist/exec/resolve-claude.js';
import { StateStore } from '../../dist/state/state-store.js';

const REAL_SHAPE_TOKEN = 'sk-ant-oat01-AbCdEfGh1234567890_QwErTyUiOpAsDfGhJkLzXcVbNm-';

describe('redaction', () => {
  test('masks tokens by shape, keeping the prefix and last four characters', () => {
    const masked = redact(`bearer ${REAL_SHAPE_TOKEN} failed`);
    assert.ok(!masked.includes('AbCdEfGh'));
    assert.match(masked, /sk-ant-oat01-…/);
    assert.equal(maskToken('sk-ant-api03-abcdefghijkl'), 'sk-ant-api03-…ijkl');
  });

  test('masks registered secrets that do not match the known shape', () => {
    clearSecrets();
    registerSecret('an-unusual-corporate-token-value');
    assert.ok(!redact('token=an-unusual-corporate-token-value').includes('corporate'));
    clearSecrets();
  });

  test('ignores strings too short to be secrets', () => {
    clearSecrets();
    registerSecret('abc');
    assert.equal(redact('abc def'), 'abc def');
  });

  test('masks sensitive environment values', () => {
    const masked = redactEnv({ CLAUDE_CODE_OAUTH_TOKEN: REAL_SHAPE_TOKEN, PATH: '/usr/bin' });
    assert.ok(!masked.CLAUDE_CODE_OAUTH_TOKEN.includes('AbCdEfGh'));
    assert.equal(masked.PATH, '/usr/bin');
  });
});

describe('Logger', () => {
  function capture(level) {
    const lines = [];
    const stream = { write: (text) => lines.push(text) };
    return { logger: new Logger({ level, color: false, stream }), lines };
  }

  test('redacts every write', () => {
    const { logger, lines } = capture(LogLevel.normal);
    logger.warn(`account failed with ${REAL_SHAPE_TOKEN}`);
    assert.ok(!lines.join('').includes('AbCdEfGh'));
  });

  test('quiet mode still reports errors', () => {
    const { logger, lines } = capture(LogLevel.quiet);
    logger.success('using account');
    logger.error('everything is exhausted');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /exhausted/);
  });

  test('verbose output is suppressed at the default level', () => {
    const { logger, lines } = capture(LogLevel.normal);
    logger.info('attempt details');
    assert.equal(lines.length, 0);
  });
});

describe('binary resolution', () => {
  test('recognises itself by path and by shim marker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claudex-resolve-'));
    try {
      const shim = join(dir, 'claude');
      await writeFile(shim, '#!/bin/sh\n# CLAUDEX_SHIM\nexec claudex "$@"\n');
      await chmod(shim, 0o755);
      const real = join(dir, 'real-claude');
      await writeFile(real, '#!/bin/sh\necho hi\n');
      await chmod(real, 0o755);

      assert.equal(await isSelf(shim, join(dir, 'claudex.js')), true);
      assert.equal(await isSelf(real, join(dir, 'claudex.js')), false);
      assert.equal(await isSelf(real, real), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('skips a shim on PATH and finds the real binary behind it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claudex-path-'));
    const realDir = await mkdtemp(join(tmpdir(), 'claudex-real-'));
    try {
      const shim = join(dir, 'claude');
      await writeFile(shim, '#!/bin/sh\n# CLAUDEX_SHIM\n');
      await chmod(shim, 0o755);
      const real = join(realDir, 'claude');
      await writeFile(real, '#!/bin/sh\necho hi\n');
      await chmod(real, 0o755);

      const found = await resolveClaudeBinary({
        env: { PATH: `${dir}:${realDir}` },
        selfPath: join(dir, 'claudex.js'),
      });
      assert.equal(found, real);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(realDir, { recursive: true, force: true });
    }
  });

  test('refuses to run when it has already spawned itself once', () => {
    assert.throws(() => assertNotRecursing({ CLAUDEX_ACTIVE: '1' }), /resolved to itself/);
    assert.doesNotThrow(() => assertNotRecursing({}));
  });
});

describe('StateStore', () => {
  test('serialises concurrent updates without losing writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claudex-state-'));
    try {
      const path = join(dir, 'state.json');
      const writers = Array.from({ length: 12 }, (_, index) =>
        new StateStore(path).update((state) => {
          state.accounts[`account-${index}`] = { health: 'ok', consecutiveFailures: index };
        }),
      );
      await Promise.all(writers);

      const final = await new StateStore(path).read();
      assert.equal(Object.keys(final.accounts).length, 12);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('treats a corrupt state file as empty rather than failing the run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claudex-state-'));
    try {
      const path = join(dir, 'state.json');
      await writeFile(path, '{ not json');
      const state = await new StateStore(path).read();
      assert.deepEqual(state.accounts, {});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
