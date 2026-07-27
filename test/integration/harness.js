import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..', '..');
export const CLAUDEX_BIN = join(ROOT, 'bin', 'claudex.js');
export const FAKE_CLAUDE = join(ROOT, 'test', 'fixtures', 'fake-claude.js');

/**
 * Build an isolated claudex installation: its own config file, credential
 * store, state directory, and a scripted stand-in for the Claude CLI. Nothing
 * here touches the user's real configuration.
 */
export async function makeSandbox({ accounts = ['Personal', 'Work'], script = [], defaults = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'claudex-it-'));
  await chmod(FAKE_CLAUDE, 0o755);

  const configPath = join(dir, 'config.yaml');
  const lines = ['version: 1', 'defaults:'];
  lines.push(`  max_switches: ${defaults.maxSwitches ?? 5}`);
  lines.push(`  provider: ${defaults.provider ?? 'oauth'}`);
  lines.push('accounts:');
  const env = {};
  accounts.forEach((account, index) => {
    const name = typeof account === 'string' ? account : account.name;
    lines.push(`  - name: ${name}`);
    lines.push(`    priority: ${index + 1}`);
    if (typeof account === 'object' && account.provider === 'configdir') {
      lines.push('    provider: configdir');
      lines.push(`    config_dir: ${join(dir, `profile-${name}`)}`);
    } else {
      lines.push(`    token: env:TEST_TOKEN_${index + 1}`);
      env[`TEST_TOKEN_${index + 1}`] = `sk-ant-oat01-fake-token-for-${name}-0000`;
    }
  });
  await writeFile(configPath, lines.join('\n') + '\n', { mode: 0o600 });

  const logPath = join(dir, 'calls.jsonl');
  const statePath = join(dir, 'fake-state');

  return {
    dir,
    configPath,
    logPath,
    env: {
      ...env,
      PATH: process.env.PATH,
      HOME: dir,
      CLAUDEX_CONFIG: configPath,
      CLAUDEX_CLAUDE_BIN: FAKE_CLAUDE,
      XDG_STATE_HOME: join(dir, 'state'),
      XDG_CONFIG_HOME: join(dir, 'config'),
      FAKE_CLAUDE_SCRIPT: JSON.stringify(script),
      FAKE_CLAUDE_STATE: statePath,
      FAKE_CLAUDE_LOG: logPath,
      NO_COLOR: '1',
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
    /** Everything the fake CLI saw, in invocation order. */
    async calls() {
      try {
        const contents = await readFile(logPath, 'utf8');
        return contents
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
  };
}

/** Run claudex with a sandbox environment and collect its output. */
export function runClaudex(sandbox, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLAUDEX_BIN, ...args], {
      env: { ...sandbox.env, ...extraEnv },
      cwd: sandbox.dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}
