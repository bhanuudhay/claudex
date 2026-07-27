# Architecture

## Goal and constraint

claudex is a wrapper, not a client. It never speaks to the Anthropic API. Its
entire job is to decide *which credential the real Claude CLI runs with*, notice
when that credential has stopped working, and run the CLI again with a different
one.

Everything below follows from one constraint: **a wrapper that changes the
experience has failed, no matter how good its failover is.** Output must be
byte-identical, exit codes must survive, Ctrl-C must behave, and the TUI must
own the terminal.

## Module map

```
bin/claudex.js
      │
      ▼
  src/cli.ts ─────────────── flag partition, subcommand dispatch
      │
      ├── config/config-manager.ts ── discovery ▸ mini-yaml ▸ schema ▸ env-config
      │
      ├── accounts/account-manager.ts ── config ⨯ persisted state
      │        │
      │        ├── state/state-store.ts ── locked, atomic JSON
      │        └── accounts/providers/ ─── oauth │ configdir │ keychain
      │                    │
      │                    └── accounts/token-source.ts ── ${VAR} env: file: keychain: store:
      │
      └── retry/retry-manager.ts ── the loop
               │
               ├── rotation/rotation-engine.ts ── who runs next, and the exhausted report
               ├── exec/claude-executor.ts ────── spawn, tee, signal forwarding
               ├── exec/resolve-claude.ts ─────── find the real binary, refuse to find ourselves
               └── detect/error-detector.ts ───── classify what went wrong
                        │
                        ├── detect/patterns.ts ────── signatures taken from the shipped CLI
                        └── detect/session-probe.ts ─ transcript evidence for TUI sessions
```

`log/logger.ts` is imported everywhere and is the only component permitted to
write wrapper output. It writes to stderr and redacts every line.

## The request path

1. **Flag partition.** `--cfo-*` flags are removed; everything else is forwarded
   untouched. There is no argument parser for Claude's own flags, because any
   parser would eventually disagree with the real CLI about what an argument
   means. `analyzeArgs` only *reads* the vector to answer three questions: is
   this print mode, is a session already in play, is this a subcommand.
2. **Config load.** First config file found, otherwise `CLAUDE_TOKEN_*`. With
   neither, claudex degrades to a plain passthrough — an unconfigured install
   still behaves exactly like `claude`.
3. **Session id injection.** For a fresh conversation, claudex generates a UUID
   and passes `--session-id`. Knowing the id up front is what makes resuming on
   another account possible later; it costs nothing when no failure occurs.
4. **Account selection.** Priority ascending, sticky on the last success.
5. **Spawn.** See "Process handling" below.
6. **Classification.** See "Failure taxonomy" below.
7. **Rotate or return.**

## Process handling

| Mode | stdin | stdout | stderr | Why |
|---|---|---|---|---|
| interactive | inherit | inherit | pipe | The TUI must own the terminal. stderr is teed because that is where errors land, and nothing draws there. |
| print | inherit | pipe | pipe | Output is streamed straight through, and teeing is what tells us whether anything has been emitted yet. |

Piping stdout would normally cost colour, because the CLI checks whether stdout
is a TTY. claudex sets `FORCE_COLOR=1` for the child when its own stdout is a
terminal, so the bytes match an unwrapped run.

The credential is passed on **file descriptor 3**
(`CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3`) rather than in the environment, so
it is not visible in `ps -E` or `/proc/<pid>/environ`. Whether a given CLI build
honours this is learned at runtime rather than probed on the hot path: if an
attempt using fd injection fails with an auth error, claudex records
`fdInjectionWorks: false`, retries the same account over
`CLAUDE_CODE_OAUTH_TOKEN`, and uses the environment path from then on. That costs
one extra attempt, once per machine, and never costs an account switch.

`SIGINT`, `SIGTERM` and `SIGHUP` are forwarded to the child; a child that dies
from a signal causes the wrapper to re-raise the same signal on itself, so shell
job control sees what it expects.

## Failure taxonomy

| Class | Signature | Action | Cooldown |
|---|---|---|---|
| `usage_limit` | `usage limit reached`, `five_hour`, `seven_day[_opus\|_sonnet]`, `/upgrade to keep using` | rotate | reported reset time, else 5 h or 7 d by window |
| `rate_limit` | `rate_limit_error`, HTTP 429 | rotate | `retry-after`, else 60 s |
| `overloaded` | `overloaded_error`, 5xx, 408, 409 | retry the **same** account twice with backoff, then rotate | 30 s, account stays healthy |
| `auth_expired` | `authentication_error`, `invalid_api_key`, token expired/revoked, 401 | fd→env fallback once, then rotate | 1 h, marked `needs_reauth` |
| `credit_exhausted` | `credit balance too low`, `billing_error` | rotate | 24 h |
| `unknown` | everything else | **never rotates** | none |

`unknown` is the important row. A failing build, a bad prompt, a hook error and
a Ctrl-C all exit non-zero. Rotating on any of them would burn an account switch
for a problem no account can fix, and would make the tool feel unpredictable. A
signalled child short-circuits to "no failure" before classification even runs.

Evidence sources are ranked: a `--output-format json` result object outranks
every text pattern, because it is structured and unambiguous. Text patterns are
weighted so that a specific match (`usage limit reached`) beats a generic one
(`rate limit`) when both appear.

## The transparency rule

When a limit is hit, the retry is only invisible if nothing has been printed yet.
The executor counts stdout bytes, which gives two cases:

- **Nothing emitted** — the common case, because limits are rejected before the
  first token. The original arguments are re-run on the next account. The user
  sees the answer once and never knows a switch happened.
- **Something already emitted** — those bytes cannot be recalled. Replaying the
  prompt would duplicate output and redo work, so claudex instead converts the
  invocation into `--resume <session-id>`, continuing the same conversation on
  the new account.

The second case requires that both accounts share a session transcript
directory. `configdir` accounts do not, so `SpawnMods.resumeAcrossAccounts` is
false for them and claudex stops with an explanation rather than silently
re-running the prompt. Being honest about the boundary is better than producing
duplicate output.

## Interactive sessions

The CLI does not exit when a subscription limit is hit — it draws a banner and
keeps running, and that banner is drawn on stdout, which claudex deliberately
does not intercept. There is therefore no mid-session hot swap without a PTY,
and a PTY would put a scanner between the terminal and the TUI.

What claudex does instead:

- picks a healthy account before launch, and injects `--session-id`;
- after the session exits, classifies stderr and, failing that, reads the tail
  of the session transcript at
  `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<session-id>.jsonl`;
- if that shows an account-level failure, rotates and relaunches with
  `--resume <session-id>` on the next account.

## Concurrency

Two shells running claudex at once must not both conclude that the same
exhausted account is healthy. Every state mutation is a read-modify-write under
an `O_EXCL` lock file (5 s stale break) followed by an atomic rename. If the lock
cannot be taken within 3 s, claudex proceeds anyway: losing a cooldown update is
a far better failure mode than refusing to run the user's command.

The `keychain` provider takes an additional cross-process mutex, because it
mutates machine-wide state rather than per-process state.

## Extending to other providers

A credential source is one class:

```ts
class MyProvider implements TokenProvider {
  readonly kind = 'my-provider';
  async prepare(account: AccountConfig): Promise<SpawnMods> {
    return baseMods({ env: { ... }, unsetEnv: otherAuthVars([...]), injection: 'env' });
  }
}
```

Register it in `providerFor()` in `src/accounts/providers/index.ts` and add its
required fields to `parseAccount()`. Nothing in the rotation, retry, detection or
execution path needs to change — providers only describe how a child process
should be set up. An API-key provider, a Bedrock/Vertex profile or a corporate
token broker all fit this shape.
