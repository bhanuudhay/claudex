import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeArgs,
  injectSessionId,
  shouldInjectSessionId,
  toResumeArgs,
} from '../../dist/exec/args.js';
import { parseOwnFlags } from '../../dist/cli.js';
import { projectSlug, transcriptPath } from '../../dist/detect/session-probe.js';

describe('analyzeArgs', () => {
  test('detects print mode from the flag and from a non-tty stdout', () => {
    assert.equal(analyzeArgs(['-p', 'hi'], true).isPrint, true);
    assert.equal(analyzeArgs(['--print', 'hi'], true).isPrint, true);
    assert.equal(analyzeArgs(['hi'], true).isPrint, false);
    assert.equal(analyzeArgs(['hi'], false).isPrint, true);
  });

  test('reads the output format in both spellings', () => {
    assert.equal(analyzeArgs(['-p', '--output-format', 'json'], true).outputFormat, 'json');
    assert.equal(analyzeArgs(['-p', '--output-format=stream-json'], true).outputFormat, 'stream-json');
  });

  test('recognises an existing session and resume flags', () => {
    assert.equal(analyzeArgs(['--session-id', 'abc'], true).sessionId, 'abc');
    assert.equal(analyzeArgs(['--resume', 'abc'], true).isResuming, true);
    assert.equal(analyzeArgs(['-c'], true).isResuming, true);
  });

  test('treats claude subcommands as non-interactive and never injects into them', () => {
    const facts = analyzeArgs(['mcp', 'list'], true);
    assert.equal(facts.subcommand, 'mcp');
    assert.equal(facts.isPrint, true);
    assert.equal(shouldInjectSessionId(facts), false);
  });

  test('does not mistake a flag value for a subcommand', () => {
    assert.equal(analyzeArgs(['--model', 'doctor', 'hello'], true).subcommand, undefined);
  });

  test('never injects a session id into --help or an existing session', () => {
    assert.equal(shouldInjectSessionId(analyzeArgs(['--help'], true)), false);
    assert.equal(shouldInjectSessionId(analyzeArgs(['--resume', 'x'], true)), false);
    assert.equal(shouldInjectSessionId(analyzeArgs(['-p', 'hi'], true)), true);
  });
});

describe('argument rewriting', () => {
  test('injects a session id ahead of the user arguments', () => {
    assert.deepEqual(injectSessionId(['-p', 'hi'], 'uuid'), ['--session-id', 'uuid', '-p', 'hi']);
  });

  test('converts a run into a resume, dropping conflicting flags', () => {
    assert.deepEqual(toResumeArgs(['--session-id', 'old', '-p', 'hi'], 'new'), [
      '--resume',
      'new',
      '-p',
      'hi',
    ]);
    assert.deepEqual(toResumeArgs(['--continue', '-p', 'hi'], 'new'), ['--resume', 'new', '-p', 'hi']);
  });

  test('preserves every unrelated argument verbatim', () => {
    const args = ['-p', 'refactor', '--model', 'opus', '--output-format', 'json', '--verbose'];
    assert.deepEqual(toResumeArgs(args, 'id').slice(2), args);
  });
});

describe('parseOwnFlags', () => {
  test('strips claudex flags and forwards everything else untouched', () => {
    const flags = parseOwnFlags([
      '--cfo-account',
      'Work',
      '-p',
      'refactor this',
      '--cfo-verbose',
      '--model',
      'opus',
    ]);
    assert.equal(flags.account, 'Work');
    assert.deepEqual(flags.rest, ['-p', 'refactor this', '--model', 'opus']);
  });

  test('accepts inline values', () => {
    const flags = parseOwnFlags(['--cfo-max-switches=5', '--cfo-no-rotate', 'hi']);
    assert.equal(flags.maxSwitches, 5);
    assert.equal(flags.noRotate, true);
    assert.deepEqual(flags.rest, ['hi']);
  });

  test('does not swallow a following claude flag as a value', () => {
    const flags = parseOwnFlags(['--cfo-account', '--verbose']);
    assert.equal(flags.account, undefined);
    assert.deepEqual(flags.rest, ['--verbose']);
  });
});

describe('session transcript location', () => {
  test('slugifies the working directory the way the CLI does', () => {
    assert.equal(projectSlug('/Users/x/proj'), '-Users-x-proj');
    assert.equal(projectSlug('/Users/x/.claude'), '-Users-x--claude');
  });

  test('builds the transcript path under the active config dir', () => {
    const path = transcriptPath('abc-123', '/Users/x/proj', '/cfg');
    assert.equal(path, '/cfg/projects/-Users-x-proj/abc-123.jsonl');
  });
});
