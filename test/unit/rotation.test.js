import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager, cooldownFor, isEligible } from '../../dist/accounts/account-manager.js';
import { RotationEngine, renderExhaustedReport, formatDuration } from '../../dist/rotation/rotation-engine.js';
import { StateStore } from '../../dist/state/state-store.js';

const config = {
  version: 1,
  source: 'test',
  warnings: [],
  defaults: { provider: 'oauth', maxSwitches: 3, rotateOn: ['usage_limit'], quiet: false },
  accounts: [
    { name: 'Personal', provider: 'oauth', priority: 1, token: 'sk-ant-oat01-aaaaaaaaaa' },
    { name: 'Work', provider: 'oauth', priority: 2, token: 'sk-ant-oat01-bbbbbbbbbb' },
    { name: 'Backup', provider: 'oauth', priority: 3, token: 'sk-ant-oat01-cccccccccc' },
  ],
};

let dir;
let manager;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'claudex-rotation-'));
  manager = await AccountManager.create(config, new StateStore(join(dir, 'state.json')));
});

test.after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('cooldownFor', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  test('uses the reported reset time when the CLI supplied one', () => {
    const resetsAt = new Date('2026-01-01T04:00:00Z');
    const { until, health } = cooldownFor({ class: 'usage_limit', resetsAt }, now);
    assert.equal(until.toISOString(), resetsAt.toISOString());
    assert.equal(health, 'exhausted');
  });

  test('falls back to the window length', () => {
    assert.equal(
      cooldownFor({ class: 'usage_limit', window: 'five_hour' }, now).until.toISOString(),
      '2026-01-01T05:00:00.000Z',
    );
    assert.equal(
      cooldownFor({ class: 'usage_limit', window: 'seven_day' }, now).until.toISOString(),
      '2026-01-08T00:00:00.000Z',
    );
  });

  test('keeps an account healthy after a server-side overload', () => {
    assert.equal(cooldownFor({ class: 'overloaded' }, now).health, 'ok');
  });

  test('marks expired credentials as needing re-auth', () => {
    assert.equal(cooldownFor({ class: 'auth_expired' }, now).health, 'needs_reauth');
  });
});

describe('isEligible', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  test('excludes accounts still cooling down, includes ones past their reset', () => {
    assert.equal(isEligible({ health: 'exhausted', cooldownUntil: '2026-01-01T01:00:00Z' }, now), false);
    assert.equal(isEligible({ health: 'exhausted', cooldownUntil: '2025-12-31T23:00:00Z' }, now), true);
    assert.equal(isEligible({ health: 'needs_reauth' }, now), false);
  });
});

describe('RotationEngine', () => {
  test('selects by priority when nothing has run yet', async () => {
    const engine = new RotationEngine(manager);
    assert.equal(engine.select().name, 'Personal');
  });

  test('skips excluded accounts', async () => {
    const engine = new RotationEngine(manager);
    assert.equal(engine.select({ excluded: new Set(['Personal']) }).name, 'Work');
    assert.equal(engine.select({ excluded: new Set(['Personal', 'Work']) }).name, 'Backup');
    assert.equal(engine.select({ excluded: new Set(['Personal', 'Work', 'Backup']) }), null);
  });

  test('skips accounts that are cooling down', async () => {
    await manager.markFailure('Personal', { class: 'usage_limit', window: 'five_hour' });
    assert.equal(new RotationEngine(manager).select().name, 'Work');
  });

  test('sticks to the last successful account instead of resetting to priority 1', async () => {
    await manager.markSuccess('Work');
    assert.equal(new RotationEngine(manager).select().name, 'Work');
  });

  test('honours a pinned account even while it is cooling down', async () => {
    await manager.markFailure('Backup', { class: 'usage_limit', window: 'five_hour' });
    assert.equal(new RotationEngine(manager).select({ pinned: 'Backup' }).name, 'Backup');
  });

  test('returns null once a pinned account has already failed this run', async () => {
    const engine = new RotationEngine(manager);
    assert.equal(engine.select({ pinned: 'Work', excluded: new Set(['Work']) }), null);
  });
});

describe('renderExhaustedReport', () => {
  test('names every account, its reason, and the soonest reset', async () => {
    await manager.markFailure('Personal', {
      class: 'usage_limit',
      window: 'five_hour',
      resetsAt: new Date(Date.now() + 3_600_000),
    });
    await manager.markFailure('Work', {
      class: 'usage_limit',
      window: 'seven_day',
      resetsAt: new Date(Date.now() + 86_400_000),
    });
    await manager.markFailure('Backup', { class: 'auth_expired' });

    const report = renderExhaustedReport(manager);
    assert.match(report, /All 3 configured accounts are unavailable/);
    assert.match(report, /Personal\s+five_hour/);
    assert.match(report, /Backup\s+needs re-auth/);
    assert.match(report, /Earliest availability: Personal/);
  });
});

describe('formatDuration', () => {
  test('renders human-readable spans', () => {
    assert.equal(formatDuration(-5), 'now');
    assert.equal(formatDuration(45_000), '45s');
    assert.equal(formatDuration(90_000), '1m');
    assert.equal(formatDuration(3_600_000 * 4 + 720_000), '4h 12m');
    assert.equal(formatDuration(86_400_000 * 2 + 3_600_000 * 3), '2d 3h');
  });
});

describe('reset', () => {
  test('clears the sticky pointer, not just cooldowns', async () => {
    // Reordering priorities has no visible effect while selection stays glued
    // to the previously successful account, so reset must release it.
    await manager.markSuccess('Work');
    assert.equal(new RotationEngine(manager).select().name, 'Work');

    await manager.reset();
    assert.equal(manager.state.activeAccount, undefined);
    assert.equal(new RotationEngine(manager).select().name, 'Personal');
  });

  test('resetting one account only releases stickiness for that account', async () => {
    await manager.markSuccess('Work');
    await manager.reset('Personal');
    assert.equal(manager.state.activeAccount, 'Work');
    await manager.reset('Work');
    assert.equal(manager.state.activeAccount, undefined);
  });
});
