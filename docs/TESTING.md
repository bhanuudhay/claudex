# Testing

```bash
npm test                # build, then unit + integration
npm run test:unit
npm run test:integration
npm run typecheck
```

Nothing in the suite touches the network, a real account, or your real
configuration. Every test runs against a temporary `HOME`, `XDG_CONFIG_HOME` and
`XDG_STATE_HOME`, and against a scripted stand-in for the Claude CLI.

## Layers

### Unit — `test/unit/`

| File | Covers |
|---|---|
| `config.test.js` | the YAML subset parser, `${VAR}` expansion, schema validation, per-provider requirements, `CLAUDE_TOKEN_*` mode |
| `error-detector.test.js` | the failure taxonomy against real CLI strings, reset-time extraction, evidence redaction |
| `rotation.test.js` | cooldown computation, eligibility, priority/sticky/pinned selection, the exhausted report |
| `security.test.js` | redaction, logger levels, self-detection during binary resolution, state-store concurrency |
| `args.test.js` | argument analysis, session-id injection, resume rewriting, `--cfo-*` partitioning, transcript paths |

Unit tests import from `dist/`, so `npm run build` runs first.

### Integration — `test/integration/`

`harness.js` builds a disposable installation and returns an environment plus a
call log. `fake-claude.js` stands in for the real CLI and is driven entirely by
environment variables:

```js
const sandbox = await makeSandbox({
  accounts: ['Personal', 'Work'],
  script: [{ fail: 'usage_limit' }, { exit: 0, stdout: 'done\n' }],
});
const result = await runClaudex(sandbox, ['-p', 'refactor']);
const calls = await sandbox.calls();   // what the fake CLI saw, per invocation
```

Scripted steps are `{ "fail": "<class>" }`, `{ "exit": 0, "stdout": "..." }`, or
both together (`{ "fail": "usage_limit", "stdout": "partial…" }`) to simulate a
limit that lands *after* output has been emitted. The last step repeats once the
script is exhausted.

The fake CLI records, per invocation: the arguments it received, how it was given
a credential (`fd`, `env`, `configdir`), a short **hash** of that credential, the
active config dir, and whether an API key leaked through. Recording a hash rather
than the token is deliberate — assertions can prove "a different account ran"
without a secret ever reaching a log file.

What the integration suite asserts:

- stdout is byte-identical to an unwrapped run, and wrapper chatter never
  appears on it
- exit codes pass through, including `77` for all-accounts-exhausted
- `--cfo-*` flags never reach the child, and user arguments are forwarded verbatim
- rotation happens for `usage_limit`, `rate_limit`, `credit_exhausted`; does not
  happen for `unknown`; and retries the same account for `overloaded`
- an auth failure first falls back from fd to env injection on the same account,
  and only rotates if it persists
- a mid-response limit resumes the session instead of replaying the prompt, and
  refuses to resume into an isolated `configdir` account
- cooldowns persist across separate invocations
- no token material appears in output, even at `--cfo-debug`

## Manual verification against the real CLI

```bash
node bin/claudex.js checkup --timing        # resolution, config, permissions, overhead
node bin/claudex.js health                  # `claude auth status --json` per account
node bin/claudex.js -p "say hi in 3 words"  # compare against plain `claude -p`
```

To watch the rotation messages without spending real quota:

```bash
CLAUDEX_FORCE_FAIL=usage_limit node bin/claudex.js -p "hi"
```

`CLAUDEX_FORCE_FAIL` synthesises a failure of the given class *without spawning
the CLI at all*, so nothing is billed. Scope it to particular accounts with
`CLAUDEX_FORCE_FAIL_ACCOUNTS=Personal,Work`.

## Re-deriving the detection patterns

`src/detect/patterns.ts` holds signatures taken from the shipped CLI rather than
invented. When a new version changes its wording, re-derive them from the
binary:

```bash
BIN=$(readlink -f "$(command -v claude)")
grep -ao '.\{60\}usage limit reached.\{80\}' "$BIN" | head
grep -ao 'five_hour\|seven_day_opus\|seven_day_sonnet\|seven_day' "$BIN" | sort -u
grep -ac 'rate_limit_error\|overloaded_error\|authentication_error' "$BIN"
```

Add the new string to `PATTERN_RULES` with a weight that ranks it against the
existing rules, then add a case to `error-detector.test.js` using the exact text.
Patterns without a test are not considered done: the test *is* the record of what
the CLI actually emitted.
