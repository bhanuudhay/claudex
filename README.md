# claudex

**The Claude CLI, with automatic account failover.**

`claudex` is a drop-in wrapper around the official `claude` command. It forwards
everything you type, straight through. When the account you are on hits its
usage limit, gets rate limited, or stops authenticating, claudex switches to the
next account you configured and runs the command again — without you retyping
anything.

```console
$ claudex -p "Refactor this project"
✓ Using Personal
⚠ Personal exhausted (five_hour)
↻ Switching to Work
✓ Command resumed
```

Everything else is untouched: same flags, same output bytes, same exit codes,
the same interactive session. Wrapper messages go to stderr, so
`claudex -p "x" > out.txt` writes exactly what `claude -p "x" > out.txt` would.

> [!IMPORTANT]
> Rotating between accounts to continue past a usage limit may conflict with
> Anthropic's Consumer Terms and Usage Policy. claudex is built for accounts you
> own and are authorised to use. See [docs/SECURITY.md](docs/SECURITY.md).

---

## Contents

- [Why](#why) · [Install](#install) · [Quick start](#quick-start)
- [How it works](#how-it-works) · [What triggers a switch](#what-triggers-a-switch)
- [Configuration](#configuration) · [Commands](#commands)
- [Security](#security) · [Development](#development) · [Docs](#documentation)

---

## Why

If you have more than one Claude account, hitting a 5-hour limit means stopping
work, or manually logging out and back in. claudex removes that step. It knows
which accounts you have, which are healthy, and which are cooling down, and it
picks one for every command.

What it is careful about:

- **Fidelity.** stdout is byte-identical to an unwrapped run. The TUI owns the
  terminal outright — nothing sits between you and it.
- **Not over-reacting.** A failing build, a bad prompt, a `Ctrl-C` — none of
  those rotate. Only account-level failures do.
- **Not duplicating work.** If a limit lands after output has already been
  printed, claudex resumes the same conversation on the next account rather
  than replaying your prompt.
- **Credentials.** Tokens are passed on a file descriptor, never in the child's
  environment, and every log line is redacted.

---

## Install

Requires Node.js ≥ 20 and a working Claude CLI.

```bash
git clone https://github.com/bhanuudhay/claudex.git && cd claudex
./install.sh                 # installs `claudex` to ~/.local/bin
```

Windows: `.\install.ps1`

Optionally shadow `claude` itself, so existing commands and editor integrations
gain failover without being changed:

```bash
./install.sh --as-claude
export PATH="$HOME/.local/share/claudex/shim:$PATH"   # add to your shell profile
```

The shim goes in its own directory, never next to the real binary — on a normal
install `~/.local/bin/claude` is a symlink into `~/.local/share/claude/versions/`,
and writing over it would destroy the CLI. Undo any time with
`./install.sh --uninstall`, which only removes files carrying claudex's marker.

---

## Quick start

Mint a long-lived token per account — log in as that account and run
`claude setup-token` — then:

```bash
claudex init                            # writes ~/.config/claudex/config.yaml
claudex accounts add --name Personal    # paste the token; input is hidden
claudex accounts add --name Work
claudex health                          # verify both, spends no quota
```

```console
$ claudex health
ACCOUNT   PROVIDER  HEALTH  PLAN         DETAIL
Personal  oauth     ok      oauth_token  -
Work      oauth     ok      oauth_token  -
```

Now use it exactly like `claude`, from any directory:

```bash
claudex                          # interactive session
claudex "explain this repo"
claudex -p "summarise src/" --model opus
echo "review this diff" | claudex -p
```

Prefer environment variables? No config file needed — `CLAUDE_TOKEN_1`,
`CLAUDE_TOKEN_2`, … become accounts in order. claudex also reads its own env
file at `~/.config/claudex/.env`, so nothing has to be exported.

---

## How it works

```
you ──▶ claudex ──▶ picks an account ──▶ runs the real claude
                          ▲                      │
                          └──── switch ◀─── classifies how it exited
```

claudex never talks to the API. It chooses a credential, runs `claude` with it,
watches how that exits, and may run it again with a different one.

**Print mode** (`-p`, pipes, scripts): fully transparent. The command fails,
claudex switches, reruns, you see one clean answer.

**Interactive mode**: the Claude TUI does not exit when it hits a limit — it
draws a banner and keeps running, on a stdout claudex deliberately does not
intercept, because anything sitting in the middle of a full-screen TUI has to
re-interpret every cursor move, resize and paste. So there is no mid-session hot
swap. Instead: quit the session with `/exit`, and claudex reads the session
transcript, switches accounts, and relaunches with `--resume` — same
conversation, full history.

```console
$ claudex
✓ Using Work
  [ you work; Claude shows "5-hour limit reached · resets 9:00 PM" ]
  [ you type /exit ]
⚠ Work exhausted (five_hour)
↻ Switching to Personal
  [ Claude reopens on Personal, same conversation ]
```

Quitting with `Ctrl-C` deliberately does *not* switch — a user interrupt should
never spend an account.

---

## What triggers a switch

| Situation | Behaviour | Cooldown |
|---|---|---|
| 5-hour or weekly usage limit | switch | until the reported reset, else 5 h / 7 d |
| Rate limited (429) | switch | `retry-after`, else 60 s |
| Service overloaded (529/5xx) | retry the **same** account twice with backoff, then switch | 30 s, account stays healthy |
| Auth expired or revoked | switch, marked `needs_reauth` | until you re-add the token |
| Credit balance too low | switch | 24 h |
| **Anything else** | **no switch** — passed through untouched | none |

When nothing is left, claudex says so precisely and exits `77`:

```console
✗ All 3 configured accounts are unavailable.

  Personal  five_hour         resets 28/07/2026, 03:00 (in 4h 12m)
  Work      seven_day         resets 01/08/2026, 09:00
  Backup    needs re-auth     run: claudex accounts add --name "Backup"

  Earliest availability: Personal, in 4h 12m
```

---

## Configuration

`~/.config/claudex/config.yaml`:

```yaml
version: 1

defaults:
  provider: oauth
  max_switches: 3
  rotate_on: [usage_limit, rate_limit, overloaded, auth_expired, credit_exhausted]
  sticky: false        # true = stay on the last successful account

accounts:
  - name: Personal
    priority: 1
    token: store:Personal      # or ${CLAUDE_TOKEN_1}, file:…, keychain:…

  - name: Work
    priority: 2
    token: store:Work
```

**Precedence**, highest first: `--cfo-account` → `claudex use` → stickiness (if
enabled) → `CLAUDEX_ACCOUNT_<N>_PRIORITY` → `priority:` → declaration order. The
environment overrides the config file, and the claudex env file feeds that chain
exactly as an exported variable would.

Three credential mechanisms:

| `provider` | How | Resume across accounts | Platforms |
|---|---|---|---|
| `oauth` *(default)* | token injected per process, sharing `~/.claude` | yes | all |
| `configdir` | separate `CLAUDE_CONFIG_DIR` per account | no — history is siloed | all |
| `keychain` | swaps the machine-wide macOS keychain item | yes | macOS only |

See [`examples/`](examples/) for fully commented configs.

---

## Commands

```bash
claudex status              # who runs next, and which rule chose it
claudex health [--deep]     # verify every credential
claudex accounts list       # state, priority, cooldowns, token source
claudex accounts add|remove
claudex use <name>          # pin an account   (--clear to release)
claudex reset [name]        # clear cooldowns and stickiness
claudex checkup             # diagnose the installation
```

Per-run flags, stripped before forwarding: `--cfo-account`, `--cfo-no-rotate`,
`--cfo-max-switches`, `--cfo-quiet`, `--cfo-verbose`, `--cfo-debug`.

Everything else goes to `claude` unchanged. Full list in
[docs/COMMANDS.md](docs/COMMANDS.md).

Watch a failover without spending quota:

```bash
CLAUDEX_FORCE_FAIL=usage_limit claudex -p "hi"
```

---

## Security

- Tokens are passed to the child on **file descriptor 3**, so they never appear
  in its environment or in `ps -E`. An environment-variable fallback is used
  only where that is unsupported, and the choice is learned once.
- Every log line passes through redaction — by token shape *and* by exact match
  on every secret loaded. A test asserts nothing leaks even at `--cfo-debug`.
- Stored tokens live in `~/.config/claudex/credentials.json`, mode 600. Runtime
  state never contains a token.
- Config files holding a literal token are checked for permissions and warned
  about.

Details and threat model: [docs/SECURITY.md](docs/SECURITY.md).

---

## Development

```bash
npm install
npm run build       # esbuild: src/ -> dist/, plus a bundled entry point
npm run typecheck
npm test            # 121 tests, no network, no real accounts
```

Zero runtime dependencies — including a small YAML reader for the documented
config subset, so startup stays off the module-resolution path.

Tests run against a scripted stand-in for the Claude CLI that records which
credential it was handed (as a hash, never the token), so rotation can be
asserted without a secret reaching a log file. See
[docs/TESTING.md](docs/TESTING.md).

---

## Documentation

| Document | Contents |
|---|---|
| [MANUAL.md](docs/MANUAL.md) | Full guide: install, accounts, configuration, precedence, troubleshooting |
| [COMMANDS.md](docs/COMMANDS.md) | One-page reference: every command, flag, variable, config key, exit code |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module map, failure taxonomy, process handling, adding a provider |
| [SECURITY.md](docs/SECURITY.md) | Credential handling, redaction, threat model |
| [TESTING.md](docs/TESTING.md) | Test layers and the fake-CLI harness |
| [ROADMAP.md](docs/ROADMAP.md) | What is next, and what is deliberately out of scope |

---

## License

MIT
