import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileProvider, defaultProfileDir } from '../../dist/accounts/providers/index.js';

/**
 * The profile provider is what makes a switched-to account actually *be* the
 * account: the CLI's cached identity, stored login and usage counters live in
 * CLAUDE_CONFIG_DIR, so injecting a token while leaving that directory shared
 * meant the second account kept reporting the first one's expired token and
 * usage. These tests pin the split: account state isolated, transcripts shared.
 */
async function makeShared() {
  const dir = await mkdtemp(join(tmpdir(), 'claudex-profile-'));
  const shared = join(dir, 'claude');
  await mkdir(join(shared, 'projects', '-tmp-proj'), { recursive: true });
  await mkdir(join(shared, 'commands'), { recursive: true });
  await writeFile(join(shared, 'projects', '-tmp-proj', 'session.jsonl'), 'transcript\n');
  await writeFile(join(shared, 'settings.json'), '{"theme":"dark"}\n');
  await writeFile(join(shared, 'CLAUDE.md'), '# house rules\n');
  await writeFile(
    join(shared, '.claude.json'),
    JSON.stringify({
      oauthAccount: { emailAddress: 'personal@example.test' },
      userID: 'user-1',
      subscriptionType: 'pro',
      projects: { '/tmp/proj': { hasTrustDialogAccepted: true } },
      mcpServers: { local: { command: 'echo' } },
      hasCompletedOnboarding: true,
    }) + '\n',
  );
  // A stored interactive login for the account that logged in last. Sharing this
  // is what let an expired credential outrank an injected, valid token.
  await writeFile(join(shared, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"expired"}}\n');
  process.env['CLAUDE_CONFIG_DIR'] = shared;
  // Redirect claudex's own config dir as well, so a derived profile path lands in
  // the sandbox rather than in the real one.
  process.env['XDG_CONFIG_HOME'] = join(dir, 'xdg');
  return { dir, shared };
}

async function cleanup(fixture) {
  delete process.env['CLAUDE_CONFIG_DIR'];
  delete process.env['XDG_CONFIG_HOME'];
  await rm(fixture.dir, { recursive: true, force: true });
}

const account = (name, dir) => ({
  name,
  provider: 'profile',
  priority: 1,
  token: 'sk-ant-oat01-token-for-' + name,
  configDir: dir,
});

describe('profile provider', () => {
  test('gives each account its own credential and usage state', async () => {
    const fixture = await makeShared();
    try {
      const personal = join(fixture.dir, 'profile-personal');
      const work = join(fixture.dir, 'profile-work');
      const provider = new ProfileProvider(false);

      const personalMods = await provider.prepare(account('Personal', personal));
      const workMods = await provider.prepare(account('Work', work));

      assert.equal(personalMods.env.CLAUDE_CONFIG_DIR, personal);
      assert.equal(workMods.env.CLAUDE_CONFIG_DIR, work);
      assert.notEqual(personalMods.env.CLAUDE_CONFIG_DIR, workMods.env.CLAUDE_CONFIG_DIR);

      // The stored login of whoever logged in interactively must not follow the
      // account: that is the file that reported "token expired" after a switch.
      for (const dir of [personal, work]) {
        await assert.rejects(stat(join(dir, '.credentials.json')), 'a profile starts with no stored login');
      }

      // Identity and usage keys are dropped; installation state is carried over
      // so switching accounts does not mean re-trusting the workspace.
      const seeded = JSON.parse(await readFile(join(personal, '.claude.json'), 'utf8'));
      assert.deepEqual(Object.keys(seeded).sort(), [
        'hasCompletedOnboarding',
        'mcpServers',
        'projects',
      ]);
      assert.equal(seeded.projects['/tmp/proj'].hasTrustDialogAccepted, true);
    } finally {
      await cleanup(fixture);
    }
  });

  test('shares transcripts and setup so a conversation can resume across accounts', async () => {
    const fixture = await makeShared();
    try {
      const dir = join(fixture.dir, 'profile-work');
      const mods = await new ProfileProvider(false).prepare(account('Work', dir));

      assert.equal(mods.resumeAcrossAccounts, true, 'transcripts are shared, so resume must be allowed');
      assert.equal(await readlink(join(dir, 'projects')), join(fixture.shared, 'projects'));
      assert.equal(
        await readFile(join(dir, 'projects', '-tmp-proj', 'session.jsonl'), 'utf8'),
        'transcript\n',
      );
      assert.equal(await readFile(join(dir, 'settings.json'), 'utf8'), '{"theme":"dark"}\n');
      assert.equal(await readFile(join(dir, 'CLAUDE.md'), 'utf8'), '# house rules\n');
    } finally {
      await cleanup(fixture);
    }
  });

  test('injects the account token and clears every competing auth variable', async () => {
    const fixture = await makeShared();
    try {
      const dir = join(fixture.dir, 'profile-work');
      const env = await new ProfileProvider(false).prepare(account('Work', dir));
      assert.equal(env.env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-token-for-Work');
      assert.ok(env.unsetEnv.includes('ANTHROPIC_API_KEY'));
      assert.ok(env.unsetEnv.includes('CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'));

      const fd = await new ProfileProvider(true).prepare(account('Work', dir));
      assert.equal(fd.injection, 'fd');
      assert.equal(fd.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, '3');
      assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in fd.env), 'the token itself must stay out of the environment');
    } finally {
      await cleanup(fixture);
    }
  });

  test('keeps existing profile state instead of reseeding it', async () => {
    const fixture = await makeShared();
    try {
      const dir = join(fixture.dir, 'profile-work');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, '.claude.json'), '{"mine":true}\n');
      await new ProfileProvider(false).prepare(account('Work', dir));
      assert.equal(await readFile(join(dir, '.claude.json'), 'utf8'), '{"mine":true}\n');
    } finally {
      await cleanup(fixture);
    }
  });

  test('carries installation state over from the legacy file location', async () => {
    // With no CLAUDE_CONFIG_DIR set, the CLI keeps `.claude.json` beside the home
    // directory rather than inside `~/.claude`, and that is where an existing
    // install's project trust lives. A profile that ignored it would make every
    // account re-approve every workspace.
    const dir = await mkdtemp(join(tmpdir(), 'claudex-profile-home-'));
    const home = join(dir, 'home');
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({
        projects: { '/tmp/proj': { hasTrustDialogAccepted: true } },
        hasCompletedOnboarding: true,
        oauthAccount: { emailAddress: 'personal@example.test' },
      }) + '\n',
    );
    await writeFile(join(home, '.claude', '.claude.json'), JSON.stringify({ machineID: 'm-1' }) + '\n');
    const realHome = process.env.HOME;
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, '.claude');
    process.env.XDG_CONFIG_HOME = join(dir, 'xdg');
    try {
      const profile = join(dir, 'profile-work');
      await new ProfileProvider(false).prepare(account('Work', profile));
      const seeded = JSON.parse(await readFile(join(profile, '.claude.json'), 'utf8'));
      assert.equal(seeded.projects['/tmp/proj'].hasTrustDialogAccepted, true);
      assert.equal(seeded.hasCompletedOnboarding, true);
      assert.equal(seeded.machineID, 'm-1', 'the config dir copy is merged over the legacy one');
      assert.ok(!('oauthAccount' in seeded), 'identity must not follow the account');
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
      delete process.env.CLAUDE_CONFIG_DIR;
      delete process.env.XDG_CONFIG_HOME;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('re-points a shared link that names a directory which has moved', async () => {
    // A profile is long-lived; CLAUDE_CONFIG_DIR is not. A link left pointing at
    // the old location looks like a working share while hiding every transcript.
    const fixture = await makeShared();
    try {
      const dir = join(fixture.dir, 'profile-work');
      await mkdir(dir, { recursive: true });
      const { symlink } = await import('node:fs/promises');
      await symlink(join(fixture.dir, 'gone', 'projects'), join(dir, 'projects'));

      const mods = await new ProfileProvider(false).prepare(account('Work', dir));
      assert.equal(await readlink(join(dir, 'projects')), join(fixture.shared, 'projects'));
      assert.equal(mods.resumeAcrossAccounts, true);
    } finally {
      await cleanup(fixture);
    }
  });

  test('never replaces state the profile owns with a link to the shared copy', async () => {
    const fixture = await makeShared();
    try {
      const dir = join(fixture.dir, 'profile-work');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'settings.json'), '{"theme":"light"}\n');
      await new ProfileProvider(false).prepare(account('Work', dir));
      assert.equal(await readFile(join(dir, 'settings.json'), 'utf8'), '{"theme":"light"}\n');
    } finally {
      await cleanup(fixture);
    }
  });

  test('derives a profile directory when the config does not name one', async () => {
    const fixture = await makeShared();
    try {
      const expected = defaultProfileDir('My Work Account');
      assert.match(expected, /profiles[/\\]my-work-account$/);
      const mods = await new ProfileProvider(false).prepare({
        name: 'My Work Account',
        provider: 'profile',
        priority: 1,
        token: 'sk-ant-oat01-derived',
      });
      assert.equal(mods.env.CLAUDE_CONFIG_DIR, expected);
    } finally {
      await cleanup(fixture);
    }
  });
});
