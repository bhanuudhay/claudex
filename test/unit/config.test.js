import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, YamlError } from '../../dist/config/mini-yaml.js';
import { parseConfig, expandVars, ConfigError } from '../../dist/config/schema.js';
import { loadEnvConfig } from '../../dist/config/env-config.js';

describe('mini-yaml', () => {
  test('parses the documented config shape', () => {
    const parsed = parseYaml(`
version: 1

defaults:
  provider: oauth       # inline comment
  max_switches: 3
  rotate_on: [usage_limit, rate_limit]
  quiet: false

accounts:
  - name: Personal
    provider: oauth
    priority: 1
    token: \${CLAUDE_TOKEN_1}
  - name: Work
    priority: 2
    token: "env:WORK_TOKEN"
`);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.defaults.provider, 'oauth');
    assert.equal(parsed.defaults.max_switches, 3);
    assert.deepEqual(parsed.defaults.rotate_on, ['usage_limit', 'rate_limit']);
    assert.equal(parsed.defaults.quiet, false);
    assert.equal(parsed.accounts.length, 2);
    assert.equal(parsed.accounts[0].name, 'Personal');
    assert.equal(parsed.accounts[0].token, '${CLAUDE_TOKEN_1}');
    assert.equal(parsed.accounts[1].token, 'env:WORK_TOKEN');
  });

  test('accepts a sequence at the parent indentation', () => {
    const parsed = parseYaml('accounts:\n- name: A\n  priority: 1\n- name: B\n  priority: 2\n');
    assert.deepEqual(parsed.accounts.map((a) => a.name), ['A', 'B']);
  });

  test('parses JSON documents', () => {
    assert.deepEqual(parseYaml('{"version":1,"accounts":[]}'), { version: 1, accounts: [] });
  });

  test('rejects tab indentation and duplicate keys with a line number', () => {
    assert.throws(() => parseYaml('a: 1\n\tb: 2\n'), YamlError);
    assert.throws(() => parseYaml('a: 1\na: 2\n'), /duplicate key "a" \(line 2\)/);
  });

  test('does not treat a hash inside a value as a comment', () => {
    assert.equal(parseYaml('token: abc#def\n').token, 'abc#def');
  });
});

describe('expandVars', () => {
  test('substitutes set variables and reports unset ones', () => {
    const missing = [];
    assert.equal(expandVars('${A}/x', { A: 'home' }, missing), 'home/x');
    assert.deepEqual(missing, []);
    assert.equal(expandVars('${NOPE}/x', {}, missing), '/x');
    assert.deepEqual(missing, ['NOPE']);
  });
});

describe('parseConfig', () => {
  const base = {
    version: 1,
    accounts: [
      { name: 'Personal', token: '${T1}', priority: 1 },
      { name: 'Work', token: '${T2}', priority: 2 },
    ],
  };

  test('applies defaults and preserves token references verbatim', () => {
    const config = parseConfig(base, 'test.yaml', { T1: 'a', T2: 'b' });
    // `profile` is the default: token injection alone leaves the CLI reading the
    // previous account's cached identity and usage out of the shared config dir.
    assert.equal(config.defaults.provider, 'profile');
    assert.equal(config.defaults.maxSwitches, 3);
    // Tokens stay unresolved at parse time; resolution is lazy and per-run.
    assert.equal(config.accounts[0].token, '${T1}');
  });

  test('normalises provider oauth to profile and says so', () => {
    // Injecting a token into the shared config dir left the CLI reporting the
    // previously logged-in account's expired token and usage after a switch, so
    // the old name now selects the isolating provider.
    const config = parseConfig(
      { accounts: [{ name: 'Personal', provider: 'oauth', token: 'sk-ant-oat01-x' }] },
      'test.yaml',
      {},
    );
    assert.equal(config.accounts[0].provider, 'profile');
    assert.equal(config.notes.length, 1);
    assert.match(config.notes[0], /own profile directory/);
  });

  test('provider oauth-shared keeps the shared config dir behaviour', () => {
    const config = parseConfig(
      { accounts: [{ name: 'Personal', provider: 'oauth-shared', token: 'sk-ant-oat01-x' }] },
      'test.yaml',
      {},
    );
    assert.equal(config.accounts[0].provider, 'oauth-shared');
    assert.deepEqual(config.notes, []);
  });

  test('defaults an oauth account with no token to the credential store', () => {
    const config = parseConfig({ accounts: [{ name: 'Solo' }] }, 'test.yaml', {});
    assert.equal(config.accounts[0].token, 'store:Solo');
  });

  test('rejects duplicate names and empty account lists', () => {
    assert.throws(
      () => parseConfig({ accounts: [{ name: 'A' }, { name: 'a' }] }, 't', {}),
      ConfigError,
    );
    assert.throws(() => parseConfig({ accounts: [] }, 't', {}), ConfigError);
  });

  test('requires provider-specific fields', () => {
    assert.throws(
      () => parseConfig({ accounts: [{ name: 'A', provider: 'configdir' }] }, 't', {}),
      /requires config_dir/,
    );
    assert.throws(
      () => parseConfig({ accounts: [{ name: 'A', provider: 'keychain' }] }, 't', {}),
      /requires keychain_account/,
    );
  });

  test('warns about unknown rotate_on values instead of failing', () => {
    const config = parseConfig(
      { defaults: { rotate_on: ['usage_limit', 'nonsense'] }, accounts: [{ name: 'A' }] },
      't',
      {},
    );
    assert.deepEqual(config.defaults.rotateOn, ['usage_limit']);
    assert.match(config.warnings.join(' '), /nonsense/);
  });
});

describe('loadEnvConfig', () => {
  test('builds accounts from CLAUDE_TOKEN_N in numeric order', () => {
    const config = loadEnvConfig({
      CLAUDE_TOKEN_2: 'b',
      CLAUDE_TOKEN_10: 'c',
      CLAUDE_TOKEN_1: 'a',
      CLAUDEX_ACCOUNT_1_NAME: 'Personal',
    });
    assert.deepEqual(config.accounts.map((a) => a.name), ['Personal', 'Account 2', 'Account 10']);
    assert.deepEqual(config.accounts.map((a) => a.token), [
      'env:CLAUDE_TOKEN_1',
      'env:CLAUDE_TOKEN_2',
      'env:CLAUDE_TOKEN_10',
    ]);
  });

  test('returns null when no tokens are present', () => {
    assert.equal(loadEnvConfig({ PATH: '/usr/bin' }), null);
  });
});
