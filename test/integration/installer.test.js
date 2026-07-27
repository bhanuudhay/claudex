import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, chmod, symlink, readFile, stat, lstat, rm, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './harness.js';

const execFileAsync = promisify(execFile);

/**
 * Regression tests for the installer.
 *
 * A real Claude install puts a *symlink* at ~/.local/bin/claude pointing into
 * ~/.local/share/claude/versions/. An earlier version of install.sh wrote the
 * `claude` shim with `cat > "$BIN_DIR/claude"`, which followed that symlink and
 * overwrote the 250 MB binary with a few hundred bytes of shell script. These
 * tests exist so that cannot happen again.
 */
async function makeFakeInstall() {
  const home = await mkdtemp(join(tmpdir(), 'claudex-install-'));
  const binDir = join(home, 'bin');
  const versionsDir = join(home, 'share', 'claude', 'versions');
  await mkdir(binDir, { recursive: true });
  await mkdir(versionsDir, { recursive: true });

  // Stand-in for the real binary: a distinctive payload we can check byte for byte.
  const realBinary = join(versionsDir, '9.9.9');
  const payload = `#!/bin/sh\n# REAL CLAUDE BINARY PAYLOAD\necho "9.9.9 (Claude Code)"\n`;
  await writeFile(realBinary, payload);
  await chmod(realBinary, 0o755);
  await symlink(realBinary, join(binDir, 'claude'));

  return { home, binDir, versionsDir, realBinary, payload, shimDir: join(home, 'shim') };
}

function runInstaller(fixture, args) {
  return execFileAsync('bash', [join(ROOT, 'install.sh'), ...args], {
    env: {
      ...process.env,
      HOME: fixture.home,
      PATH: `${fixture.binDir}:${process.env.PATH}`,
      CLAUDEX_BIN_DIR: fixture.binDir,
      CLAUDEX_SHIM_DIR: fixture.shimDir,
      CLAUDEX_SKIP_BUILD: '1',
    },
  });
}

describe('installer', () => {
  test('--as-claude never writes through the symlink to the real binary', async () => {
    const fixture = await makeFakeInstall();
    try {
      const before = await stat(fixture.realBinary);
      await runInstaller(fixture, ['--as-claude']);

      const after = await stat(fixture.realBinary);
      assert.equal(after.size, before.size, 'real binary size changed');
      assert.equal(await readFile(fixture.realBinary, 'utf8'), fixture.payload);

      // The PATH entry must still be the untouched symlink to the real binary.
      const link = await lstat(join(fixture.binDir, 'claude'));
      assert.ok(link.isSymbolicLink(), 'bin/claude must remain a symlink');
      assert.equal(await readlink(join(fixture.binDir, 'claude')), fixture.realBinary);
    } finally {
      await rm(fixture.home, { recursive: true, force: true });
    }
  });

  test('the shim lands in its own directory and records the resolved real binary', async () => {
    const fixture = await makeFakeInstall();
    try {
      await runInstaller(fixture, ['--as-claude']);
      const shim = await readFile(join(fixture.shimDir, 'claude'), 'utf8');
      assert.match(shim, /CLAUDEX_SHIM/);
      // Recorded as the resolved target, not the symlink, so it cannot be re-shimmed.
      assert.ok(shim.includes(fixture.realBinary), 'shim must record the real binary path');
    } finally {
      await rm(fixture.home, { recursive: true, force: true });
    }
  });

  test('refuses to shim a claude that is already a claudex shim', async () => {
    const fixture = await makeFakeInstall();
    try {
      await writeFile(fixture.realBinary, '#!/bin/sh\n# CLAUDEX_SHIM\n');
      await assert.rejects(
        () => runInstaller(fixture, ['--as-claude']),
        (error) => /already a claudex shim/.test(error.stderr ?? ''),
      );
    } finally {
      await rm(fixture.home, { recursive: true, force: true });
    }
  });

  test('refuses to shim a claude that does not run', async () => {
    const fixture = await makeFakeInstall();
    try {
      await writeFile(fixture.realBinary, '#!/bin/sh\nexit 1\n');
      await chmod(fixture.realBinary, 0o755);
      await assert.rejects(
        () => runInstaller(fixture, ['--as-claude']),
        (error) => /refusing to shim a broken install/.test(error.stderr ?? ''),
      );
    } finally {
      await rm(fixture.home, { recursive: true, force: true });
    }
  });

  test('uninstall removes only claudex files and leaves the real binary alone', async () => {
    const fixture = await makeFakeInstall();
    try {
      await runInstaller(fixture, ['--as-claude']);
      await runInstaller(fixture, ['--uninstall']);

      assert.equal(await readFile(fixture.realBinary, 'utf8'), fixture.payload);
      const link = await lstat(join(fixture.binDir, 'claude'));
      assert.ok(link.isSymbolicLink());
      await assert.rejects(() => stat(join(fixture.shimDir, 'claude')));
    } finally {
      await rm(fixture.home, { recursive: true, force: true });
    }
  });

  test('uninstall refuses to delete a claude that is not ours', async () => {
    const fixture = await makeFakeInstall();
    try {
      await mkdir(fixture.shimDir, { recursive: true });
      await writeFile(join(fixture.shimDir, 'claude'), '#!/bin/sh\n# someone else\n');
      const result = await runInstaller(fixture, ['--uninstall']);
      assert.match(result.stderr, /not a claudex shim/);
      assert.match(await readFile(join(fixture.shimDir, 'claude'), 'utf8'), /someone else/);
    } finally {
      await rm(fixture.home, { recursive: true, force: true });
    }
  });
});
