# claudex

The Claude CLI, with automatic account failover.

`claudex` forwards every command to the real `claude` binary. When the account
you are on hits its usage limit, gets rate limited, or stops authenticating, it
switches to the next account you configured and runs the command again — without
you retyping anything.

```console
$ claudex "Refactor this project"
✓ Using Personal
⚠ Personal exhausted (five_hour)
↻ Switching to Work
✓ Command resumed
```

Everything else is untouched: same flags, same output bytes, same exit codes,
same TUI. The status lines above go to stderr, so `claudex -p "x" > out.txt`
writes exactly what `claude -p "x" > out.txt` would.

> **Before you configure this:** rotating between accounts to continue past a
> usage limit may conflict with Anthropic's Consumer Terms and Usage Policy.
> claudex is for accounts you own and are authorised to use. See
> [docs/SECURITY.md](docs/SECURITY.md).

**Full manual:** [docs/MANUAL.md](docs/MANUAL.md) — install, accounts,
configuration, precedence rules, account selection, troubleshooting.
**Command reference:** [docs/COMMANDS.md](docs/COMMANDS.md).

## Requirements

- Node.js ≥ 20
- The real Claude CLI installed and working
- Two or more Claude accounts you are authorised to use

## Install

```bash
git clone <this repo> claudex && cd claudex
./install.sh                 # installs `claudex`
./install.sh --as-claude     # also installs a `claude` shim (optional)
```

Windows:

```powershell
.\install.ps1
.\install.ps1 -AsClaude
```

Or from the repo without installing:

```bash
npm install && npm run build && node bin/claudex.js --cfo-help
```

### About the `claude` shim

`--as-claude` writes a `claude` command into its own directory
(`~/.local/share/claudex/shim`, or `%LOCALAPPDATA%\claudex\shim`) which you put
at the **front** of your PATH. Existing commands, scripts and editor
integrations then gain failover without being changed:

```bash
export PATH="$HOME/.local/share/claudex/shim:$PATH"
```

The shim never goes next to the real binary. On a normal install
`~/.local/bin/claude` is a *symlink* into `~/.local/share/claude/versions/`, and
writing a file over that symlink would destroy the real 250 MB CLI. The
installer also resolves the real binary before creating anything, refuses to
shim something that is already a shim or that does not run, and records the
resolved path inside the shim.

It is still the higher-blast-radius option — every `claude` invocation on the
machine goes through the wrapper. Undo at any time:

```bash
./install.sh --uninstall
```

Uninstall only removes files carrying claudex's own marker; it refuses to delete
anything else.

## Configure

### Quickest path

```bash
claudex init                              # writes ~/.config/claudex/config.yaml
claudex accounts add --name Personal      # paste a token, stored mode 0600
claudex accounts add --name Work
claudex health                            # verify both
```

To mint a token: log in as that account, then run `claude setup-token`. It prints
an `sk-ant-oat01-…` token.

### Config file

```yaml
version: 1

defaults:
  provider: oauth
  max_switches: 3
  rotate_on: [usage_limit, rate_limit, overloaded, auth_expired, credit_exhausted]
  quiet: false

accounts:
  - name: Personal
    priority: 1
    token: ${CLAUDE_TOKEN_1}

  - name: Work
    priority: 2
    token: ${CLAUDE_TOKEN_2}
```

Searched in order: `$CLAUDEX_CONFIG`, `~/.config/claudex/config.yaml`,
`~/.claudex.yaml`. See [`examples/`](examples/) for a fully commented file and a
multi-provider example.

### Environment only

No config file needed — `CLAUDE_TOKEN_1`, `CLAUDE_TOKEN_2`, … become accounts in
numeric order:

```bash
export CLAUDE_TOKEN_1=sk-ant-oat01-...
export CLAUDE_TOKEN_2=sk-ant-oat01-...
export CLAUDEX_ACCOUNT_1_NAME=Personal   # optional
claudex -p "say hi"
```

See [`examples/.env.example`](examples/.env.example).

### Token references

Never put a literal token in a config file if you can avoid it:

| Reference | Source |
|---|---|
| `${CLAUDE_TOKEN_1}` / `env:CLAUDE_TOKEN_1` | environment variable |
| `file:~/.secrets/claude-token` | first line of a file |
| `keychain:claudex/personal` | macOS keychain item |
| `store:Personal` | claudex credential store (written by `accounts add`) |

### Credential mechanisms

| `provider` | How it works | Resume across accounts | Platforms |
|---|---|---|---|
| `oauth` *(default)* | injects a token per process, sharing `~/.claude` | yes | all |
| `configdir` | separate `CLAUDE_CONFIG_DIR` per account, each with its own login | no — history is siloed | all |
| `keychain` | swaps the machine-wide macOS keychain item for one command | yes | macOS only |

`keychain` mutates global state and is opt-in; read
[docs/SECURITY.md](docs/SECURITY.md#the-keychain-provider) first.

## Usage

Use it exactly like `claude`:

```bash
claudex "explain this repo"
claudex -p "summarise src/" --model opus
claudex --resume 4f1c…
echo "review this" | claudex -p
```

### claudex's own flags

Stripped before forwarding; never seen by `claude`.

| Flag | Effect |
|---|---|
| `--cfo-account <name>` | use this account for this run |
| `--cfo-max-switches <n>` | cap switches for this run |
| `--cfo-no-rotate` | run once, never fail over |
| `--cfo-quiet` | errors only |
| `--cfo-verbose` | explain each attempt |
| `--cfo-debug` | verbose plus internals |
| `--cfo-help`, `--cfo-version` | wrapper help and version |

### Subcommands

| Command | Purpose |
|---|---|
| `claudex init` | write a starter config |
| `claudex accounts list \| add \| remove` | manage accounts |
| `claudex status` | active account, next account, cooldowns |
| `claudex health [--deep]` | check every credential (`--deep` sends one tiny prompt) |
| `claudex use <name>` / `--clear` | pin or unpin an account |
| `claudex reset [name]` | clear recorded cooldowns |
| `claudex checkup [--timing]` | diagnose the installation |

Prefix any of them with `cfo` (`claudex cfo status`) if a name ever collides
with a real `claude` subcommand. Everything not in this table is forwarded.

### Exit codes

| Code | Meaning |
|---|---|
| `77` | every configured account is unavailable |
| anything else | whatever `claude` returned |

## What triggers a switch

| Situation | Behaviour |
|---|---|
| 5-hour or weekly usage limit | switch, cooldown until the reported reset time |
| Rate limited (429) | switch, cooldown from `retry-after` |
| Service overloaded (529/5xx) | retry the **same** account twice with backoff, then switch |
| Auth expired or revoked | switch, account marked as needing re-auth |
| Credit balance too low | switch, 24-hour cooldown |
| Anything else | **no switch** — the error is yours, and is passed through untouched |

That last row is deliberate: a failing build, a bad prompt or a `Ctrl-C` must
never spend an account.

If a limit lands *after* some output has already been printed, claudex cannot
un-print it, so it resumes the same conversation on the next account instead of
replaying your prompt.

When nothing is left:

```console
✗ All 3 configured accounts are unavailable.

  Personal  five_hour         resets 28/07/2026, 03:00 (in 4h 12m)
  Work      seven_day         resets 01/08/2026, 09:00
  Backup    needs re-auth     run: claudex accounts add --name "Backup"

  Earliest availability: Personal, in 4h 12m
```

## Interactive sessions

The Claude TUI does not exit when it hits a limit — it draws a banner and keeps
running, on a stdout that claudex deliberately does not intercept. So there is no
mid-session hot swap.

What you get instead: claudex picks a healthy account before launch and tags the
session with an id. If the session ends with an account-level failure, it
switches accounts and relaunches with `--resume`, continuing where you were.

Print mode (`-p`, pipes, scripts) gets the full transparent retry.

## Troubleshooting

```bash
claudex checkup            # binary resolution, config, file permissions
claudex checkup --timing   # wrapper overhead
claudex status             # cooldowns, active account, injection mode
claudex --cfo-verbose ...  # per-attempt reasoning
```

**"could not find the real claude binary"** — set `claude_path` in your config or
`CLAUDEX_CLAUDE_BIN` in the environment.

**"claudex resolved to itself"** — a `claude` on your PATH is a claudex shim and
the real binary was not found behind it. Point `claude_path` at the real one.

**An account is skipped and you disagree** — `claudex reset <name>` clears its
recorded cooldown, or `claudex use <name>` forces it.

**Watch a failover without spending quota:**

```bash
CLAUDEX_FORCE_FAIL=usage_limit claudex -p "hi"
```

## Development

```bash
npm install
npm run build       # esbuild transpile, src/ -> dist/
npm run typecheck
npm test            # 92 tests, no network, no real accounts
```

- [docs/MANUAL.md](docs/MANUAL.md) — full user manual: install, accounts,
  configuration, precedence, account selection, troubleshooting
- [docs/COMMANDS.md](docs/COMMANDS.md) — one-page reference: every subcommand,
  flag, environment variable, config key and exit code
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — module map, failure taxonomy,
  process handling, how to add a provider
- [docs/SECURITY.md](docs/SECURITY.md) — credential handling and threat model
- [docs/TESTING.md](docs/TESTING.md) — test layers and the fake-CLI harness
- [docs/ROADMAP.md](docs/ROADMAP.md) — what is next, and what is deliberately out

## License

MIT
