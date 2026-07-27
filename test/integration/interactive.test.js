import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../../dist/accounts/account-manager.js';
import { StateStore } from '../../dist/state/state-store.js';
import { runWithFailover } from '../../dist/retry/retry-manager.js';
import { projectSlug } from '../../dist/detect/session-probe.js';
import { FAKE_CLAUDE } from './harness.js';

/**
 * Interactive failover.
 *
 * A TUI session does not exit when it hits a usage limit — it draws a banner on
 * stdout, which claudex deliberately does not intercept, and keeps running. The
 * only durable evidence is the session transcript on disk, so that is what
 * claudex reads once the session ends. These tests drive `runWithFailover`
 * directly because an interactive run needs a TTY that a test harness cannot
 * provide.
 */
const SESSION_ID = '11111111-2222-3333-4444-555555555555';

function makeConfig(accounts) {
  return {
    version: 1,
    source: 'test',
    warnings: [],
    notes: [],
    defaults: {
      provider: 'oauth',
      maxSwitches: 3,
      rotateOn: ['usage_limit', 'rate_limit', 'overloaded', 'auth_expired', 'credit_exhausted'],
      quiet: true,
      sticky: false,
    },
    accounts,
  };
}

async function makeFixture({ script = [{ exit: 0 }], seedTranscript } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'claudex-tui-'));
  const configDir = join(dir, 'claude-config');
  const cwd = join(dir, 'project');
  await mkdir(cwd, { recursive: true });

  const projectDir = join(configDir, 'projects', projectSlug(cwd));
  await mkdir(projectDir, { recursive: true });
  const transcriptPath = join(projectDir, `${SESSION_ID}.jsonl`);
  await writeFile(transcriptPath, seedTranscript ?? '');

  process.env['CLAUDE_CONFIG_DIR'] = configDir;
  process.env['FAKE_CLAUDE_LOG'] = join(dir, 'calls.jsonl');
  process.env['FAKE_CLAUDE_SCRIPT'] = JSON.stringify(script);
  process.env['FAKE_CLAUDE_STATE'] = join(dir, 'fake-state');
  process.env['FAKE_CLAUDE_TRANSCRIPT_PATH'] = transcriptPath;

  const manager = await AccountManager.create(
    makeConfig([
      { name: 'Work', provider: 'oauth', priority: 1, token: 'sk-ant-oat01-work-token-0000' },
      { name: 'Personal', provider: 'oauth', priority: 2, token: 'sk-ant-oat01-personal-tok-0' },
    ]),
    new StateStore(join(dir, 'state.json')),
  );

  return { dir, cwd, manager, logPath: join(dir, 'calls.jsonl'), transcriptPath };
}

async function readCalls(logPath) {
  const { readFile } = await import('node:fs/promises');
  try {
    return (await readFile(logPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function cleanup(fixture) {
  delete process.env['CLAUDE_CONFIG_DIR'];
  delete process.env['FAKE_CLAUDE_LOG'];
  delete process.env['FAKE_CLAUDE_SCRIPT'];
  delete process.env['FAKE_CLAUDE_STATE'];
  delete process.env['FAKE_CLAUDE_TRANSCRIPT_PATH'];
  await rm(fixture.dir, { recursive: true, force: true });
}

describe('interactive session failover', () => {
  test('a limit recorded in the transcript switches accounts and resumes', async () => {
    // What a limited session leaves behind: the CLI exits cleanly (the user
    // typed /exit), but the transcript holds the API error.
    const fixture = await makeFixture({
      script: [
        // First session records a usage limit, then the user quits.
        { exit: 0, transcript: 'Claude AI usage limit reached|1900000000' },
        // The relaunched session is healthy and records nothing.
        { exit: 0 },
      ],
    });
    try {
      await runWithFailover({
        manager: fixture.manager,
        binary: FAKE_CLAUDE,
        args: ['--session-id', SESSION_ID],
        interactive: true,
        sessionId: SESSION_ID,
        maxSwitches: 2,
        rotateOn: ['usage_limit'],
        noRotate: false,
        cwd: fixture.cwd,
      });

      const calls = await readCalls(fixture.logPath);
      assert.equal(calls.length, 2, 'the session should have been relaunched once');
      assert.notEqual(calls[0].tokenHash, calls[1].tokenHash, 'relaunch must use the other account');
      // The relaunch continues the same conversation rather than starting over.
      assert.deepEqual(calls[1].args.slice(0, 2), ['--resume', SESSION_ID]);

      assert.equal(fixture.manager.stateOf('Work').health, 'exhausted');
    } finally {
      await cleanup(fixture);
    }
  });

  test('a clean session with no limit in the transcript does not relaunch', async () => {
    const fixture = await makeFixture({
      seedTranscript:
        JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: 'all good' }) +
        '\n',
    });
    try {
      await runWithFailover({
        manager: fixture.manager,
        binary: FAKE_CLAUDE,
        args: ['--session-id', SESSION_ID],
        interactive: true,
        sessionId: SESSION_ID,
        maxSwitches: 2,
        rotateOn: ['usage_limit'],
        noRotate: false,
        cwd: fixture.cwd,
      });

      const calls = await readCalls(fixture.logPath);
      assert.equal(calls.length, 1, 'quitting a healthy session must not spend a switch');
    } finally {
      await cleanup(fixture);
    }
  });

  test('a limit from an earlier attempt does not exhaust the next account', async () => {
    // Transcripts are append-only. Without bounding the probe to the current
    // attempt, the error that ended the session on account one is still in the
    // file when account two finishes, and a single real limit would cascade
    // through every configured account.
    const fixture = await makeFixture({
      script: [{ exit: 0, transcript: 'Claude AI usage limit reached|1900000000' }, { exit: 0 }],
    });
    try {
      await runWithFailover({
        manager: fixture.manager,
        binary: FAKE_CLAUDE,
        args: ['--session-id', SESSION_ID],
        interactive: true,
        sessionId: SESSION_ID,
        maxSwitches: 2,
        rotateOn: ['usage_limit'],
        noRotate: false,
        cwd: fixture.cwd,
      });

      assert.equal(fixture.manager.stateOf('Work').health, 'exhausted');
      assert.notEqual(
        fixture.manager.stateOf('Personal').health,
        'exhausted',
        'the stale error must not be attributed to the second account',
      );
      const { readFile } = await import('node:fs/promises');
      assert.match(
        await readFile(fixture.transcriptPath, 'utf8'),
        /usage limit reached/,
        'the stale entry is still on disk; the bound is what protects us',
      );
    } finally {
      await cleanup(fixture);
    }
  });

  test('a missing transcript is not treated as a failure', async () => {
    const fixture = await makeFixture();
    try {
      await runWithFailover({
        manager: fixture.manager,
        binary: FAKE_CLAUDE,
        args: ['--session-id', SESSION_ID],
        interactive: true,
        sessionId: SESSION_ID,
        maxSwitches: 2,
        rotateOn: ['usage_limit'],
        noRotate: false,
        cwd: fixture.cwd,
      });
      assert.equal((await readCalls(fixture.logPath)).length, 1);
    } finally {
      await cleanup(fixture);
    }
  });
});
