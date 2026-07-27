# claudex manual

A complete guide to installing, configuring and operating claudex.

For what it is and why, see the [README](../README.md). For a one-page list of
every command, flag and variable, see [COMMANDS](COMMANDS.md). For how it works
internally, see [ARCHITECTURE](ARCHITECTURE.md).

---

## Contents

1. [Mental model](#1-mental-model)
2. [Install](#2-install)
3. [Add accounts](#3-add-accounts)
4. [Configuration reference](#4-configuration-reference)
5. [Precedence: what beats what](#5-precedence-what-beats-what)
6. [Daily use](#6-daily-use)
7. [Choosing which account runs](#7-choosing-which-account-runs)
8. [Command reference](#8-command-reference)
9. [What triggers a switch](#9-what-triggers-a-switch)
10. [Using it in every repo](#10-using-it-in-every-repo)
11. [Troubleshooting](#11-troubleshooting)
12. [Uninstall](#12-uninstall)

---

## 1. Mental model

Four things are worth holding in your head. Most confusion comes from one of
them.

**claudex is a launcher, not a client.** It never talks to the API. It picks a
credential, runs the real `claude` with it, watches how that exits, and may run
`claude` again with a different credential. Every flag you pass is forwarded
untouched.

**Configuration is global, state is global.** Config lives in
`~/.config/claudex/config.yaml`, runtime state in
`~/.local/state/claudex/state.json`. Neither is per-project, so claudex behaves
identically in every repo. There is nothing to set up per project.

**Priority means priority.** Commands run on the highest-priority account that
is currently available. Accounts in cooldown are skipped, so a limit naturally
moves work to the next one and it moves back when the limit resets. Optional
stickiness (`sticky: true`, or `CLAUDEX_STICKY=1`) keeps a run on the last
successful account instead, which keeps prompt caching warm on one organisation
— at the cost of making a reordered config look ignored.

**Wrapper output goes to stderr, never stdout.** `claudex -p "x" > out.txt`
writes exactly what `claude -p "x" > out.txt` would. The `✓`/`⚠`/`↻` lines are on
stderr, so pipes and redirects are unaffected.

---



## 2. Install

Requires Node.js ≥ 20 and a working Claude CLI.

```bash
git clone <repo> claudex && cd claudex
./install.sh
```

That puts `claudex` in `~/.local/bin`. Confirm:

```bash
claudex --cfo-version
claudex checkup
```

`checkup` is the thing to run whenever something looks wrong. It reports which
`claude` binary was found, which config file is in use, and the permissions of
every file that can hold a secret.

Windows uses `.\install.ps1` with the same options.

Optionally, [shadow](#10-using-it-in-every-repo) `claude` [itself](#10-using-it-in-every-repo).

---



## 3. Add accounts

You need a long-lived token per account. Mint one by logging in as that account
and running:

```bash
claude setup-token
```

It prints an `sk-ant-oat01-…` token. Then either store it in claudex (simplest,
recommended) or supply it through the environment.

### Option A — the credential store

```bash
claudex init                             # writes a starter config
claudex accounts add --name Personal     # paste the token; input is hidden
claudex accounts add --name Work
claudex health                           # verify both
```

Tokens go to `~/.config/claudex/credentials.json`, mode 600, and the config
refers to them as `token: store:Personal`. Nothing to export, works in every
shell, survives reboots.

Non-interactive (CI, scripts):

```bash
printf '%s' "$TOKEN" | claudex accounts add --name Work --provider oauth --priority 2
```



### Option B — environment variables

No config file needed at all. `CLAUDE_TOKEN_1`, `CLAUDE_TOKEN_2`, … become
accounts in numeric order:

```bash
export CLAUDE_TOKEN_1=sk-ant-oat01-...
export CLAUDE_TOKEN_2=sk-ant-oat01-...
export CLAUDEX_ACCOUNT_1_NAME=Personal    # optional
export CLAUDEX_ACCOUNT_1_PRIORITY=1       # optional
claudex health
```

### Option C — the claudex env file

If you would rather keep everything in a file but not have to export anything,
put it where claudex looks for it:

```bash
mkdir -p ~/.config/claudex
cat > ~/.config/claudex/.env <<'EOF'
CLAUDE_TOKEN_1=sk-ant-oat01-...
CLAUDE_TOKEN_2=sk-ant-oat01-...
CLAUDEX_ACCOUNT_1_NAME=Personal
CLAUDEX_ACCOUNT_1_PRIORITY=2
CLAUDEX_ACCOUNT_2_NAME=Work
CLAUDEX_ACCOUNT_2_PRIORITY=1
EOF
chmod 600 ~/.config/claudex/.env
```

claudex reads this itself, before anything else, in every shell — no `source`,
no `export`, nothing to remember. Set `$CLAUDEX_ENV_FILE` to use a different
path.

Two rules keep it predictable:

- **The real environment always wins.** An exported variable, or a one-off
  `CLAUDE_TOKEN_1=… claudex …`, beats the file.
- **Only this location is read.** A `.env` in whatever repo you happen to be in
  is deliberately ignored, so a checked-out project cannot change which
  credential runs.

> A `.env` file anywhere *else* is inert. Nothing loads it, and even
> `source .env` only sets shell variables without exporting them, so a child
> process never sees them. If you must keep one elsewhere, load it with
> `set -a; source /path/to/.env; set +a` — or just move it to
> `~/.config/claudex/.env` and stop thinking about it.



### Verify either way

```bash
claudex health
```

```
ACCOUNT   PROVIDER  HEALTH  PLAN         DETAIL
Personal  oauth     ok      oauth_token  -
Work      oauth     ok      oauth_token  -
```

`health` runs `claude auth status --json` per account and spends no quota.
`claudex health --deep` additionally sends one tiny prompt per account, which
does cost quota but proves the account can serve a request right now.

---



## 4. Configuration reference

Searched in order, first match wins:

1. `$CLAUDEX_CONFIG`
2. `~/.config/claudex/config.yaml`
3. `~/.claudex.yaml`
4. environment only (`CLAUDE_TOKEN_*`)

```yaml
version: 1

# Optional: explicit path to the real Claude CLI.
claude_path: ~/.local/bin/claude

defaults:
  provider: oauth
  max_switches: 3
  rotate_on: [usage_limit, rate_limit, overloaded, auth_expired, credit_exhausted]
  quiet: false

accounts:
  - name: Personal
    provider: oauth
    priority: 1
    token: ${CLAUDE_TOKEN_1}

  - name: Work
    provider: oauth
    priority: 2
    token: store:Work
```



### `defaults`


| Key            | Meaning                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------ |
| `provider`     | credential mechanism for accounts that don't name one                                      |
| `max_switches` | maximum account switches within a single command                                           |
| `rotate_on`    | which failure classes may trigger a switch — remove one to have claudex surface it instead |
| `quiet`        | errors only, as if `--cfo-quiet` were always passed                                        |




### `accounts`


| Key                                     | Meaning                                                  |
| --------------------------------------- | -------------------------------------------------------- |
| `name`                                  | how the account appears in output and in `--cfo-account` |
| `priority`                              | lower runs first; ties broken by declaration order       |
| `token`                                 | a *reference*, see below                                 |
| `provider`                              | `oauth` (default), `configdir`, or `keychain`            |
| `config_dir`                            | required for `configdir`                                 |
| `keychain_service` / `keychain_account` | required for `keychain`                                  |




### Token references

Prefer a reference over a literal token:


| Reference                                   | Source                                                               |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `${CLAUDE_TOKEN_1}` or `env:CLAUDE_TOKEN_1` | environment variable                                                 |
| `file:~/.secrets/claude-token`              | first line of a file                                                 |
| `keychain:claudex/personal`                 | macOS keychain item                                                  |
| `store:Personal`                            | claudex credential store                                             |
| `sk-ant-oat01-…`                            | literal — works, but claudex will warn if the file is group-readable |


Resolution is lazy: only the account that actually runs has its credential
resolved, so a broken reference on account #3 costs nothing while #1 is healthy.

### Providers


| `provider`          | How it works                                                                    | Resume across accounts             | Platforms  |
| ------------------- | ------------------------------------------------------------------------------- | ---------------------------------- | ---------- |
| `oauth` *(default)* | injects a token per process, sharing `~/.claude`                                | yes                                | all        |
| `configdir`         | separate `CLAUDE_CONFIG_DIR` per account, each with its own `claude auth login` | **no** — session history is siloed | all        |
| `keychain`          | swaps the machine-wide macOS keychain item for one command                      | yes                                | macOS only |


`configdir` is for accounts that need genuinely separate CLI state (different
orgs, different MCP servers). The cost: a conversation interrupted by a limit
cannot be resumed on it, because the transcript lives in the other config dir.

`keychain` mutates global state — any other `claude` running at the same time
sees the swap. Read [SECURITY](SECURITY.md#the-keychain-provider) before using it.

### Environment variables


| Variable                       | Effect                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `CLAUDE_TOKEN_<N>`             | defines account N                                                                          |
| `CLAUDEX_ACCOUNT_<N>_NAME`     | names account N                                                                            |
| `CLAUDEX_ACCOUNT_<N>_PRIORITY` | priority for account N                                                                     |
| `CLAUDEX_CONFIG`               | explicit config file path                                                                  |
| `CLAUDEX_CLAUDE_BIN`           | explicit path to the real `claude`                                                         |
| `CLAUDEX_MAX_SWITCHES`         | switch cap (environment-only mode)                                                         |
| `CLAUDEX_DEBUG=1`              | full debug logging                                                                         |
| `CLAUDEX_FORCE_FAIL=<class>`   | synthesise a failure without running `claude` — see [Troubleshooting](#11-troubleshooting) |


---



## 5. Precedence: what beats what

**The environment overrides the config file.** An account named in both keeps its
file definition but takes the environment's token, and takes the environment's
priority *when* `CLAUDEX_ACCOUNT_<N>_PRIORITY` *was set explicitly*. A priority
merely inferred from the variable's number is not treated as a choice and will
not silently reorder your file. Every override is announced on stderr.

Accounts that exist only in the environment are appended to the file's accounts.

For a single run, `--cfo-account` beats everything.

Ordered, highest first:

```
--cfo-account <name>                 this run only
claudex use <name>                   until you clear it
sticky last successful account       only when sticky is enabled
CLAUDEX_ACCOUNT_<N>_PRIORITY         when explicitly set
priority: in the config file
declaration order in the config file
```

Settings behave the same way: `CLAUDEX_STICKY`, `CLAUDEX_MAX_SWITCHES`,
`CLAUDEX_ROTATE_ON`, `CLAUDEX_QUIET` and `CLAUDEX_CLAUDE_BIN` all override the
file's `defaults`. The claudex env file feeds this chain exactly as an exported
variable would, and loses to a real environment variable.

---



## 6. Daily use

Use it exactly like `claude`, from any directory:

```bash
claudex "explain this repo"
claudex -p "summarise src/" --model opus
claudex --resume 4f1c…
echo "review this diff" | claudex -p
claudex mcp list
```

A quiet success looks like nothing happened. A failover looks like this:

```
✓ Using Personal
⚠ Personal exhausted (five_hour)
↻ Switching to Work
✓ Command resumed
```

When nothing is left:

```
✗ All 3 configured accounts are unavailable.

  Personal  five_hour         resets 28/07/2026, 03:00 (in 4h 12m)
  Work      seven_day         resets 01/08/2026, 09:00
  Backup    needs re-auth     run: claudex accounts add --name "Backup"

  Earliest availability: Personal, in 4h 12m
```

Exit code `77` means exactly that, so scripts can branch on it:

```bash
claudex -p "$PROMPT"
if [ $? -eq 77 ]; then
  echo "all accounts spent; try later"
fi
```



### Interactive sessions

The Claude TUI does not exit when it hits a limit — it draws a banner and keeps
running, on a stdout claudex deliberately does not intercept. So there is **no
mid-session hot swap**.

What you get instead: claudex picks a healthy account before launch and tags the
session with an id. **When you quit the session**, claudex reads the session
transcript, and if the limit is there it switches accounts and relaunches Claude
with `--resume` — same conversation, full history, no retyping. You do exactly
one thing: quit.

```console
$ claudex
✓ Using Work
  [ you work; Claude shows "5-hour limit reached · resets 9:00 PM" ]
  [ you type /exit ]
⚠ Work exhausted (five_hour)
↻ Switching to Personal
  [ Claude reopens on Personal, same conversation ]
```

**Quit with `/exit` or Ctrl-D, not Ctrl-C.** A signalled exit is treated as "the
user interrupted this", which never spends an account switch — the same rule
that stops a Ctrl-C during a long print-mode run from burning an account. After
a Ctrl-C, run `claudex` again and it will start on the next healthy account,
though as a new conversation unless you pass `--resume`.

Print mode (`-p`, pipes, scripts) gets the full transparent retry.

---



## 7. Choosing which account runs

The most common question is *"why is it still using that account?"* — usually
stickiness. `claudex status` now answers it directly:

```console
$ claudex status
config:   /Users/you/.config/claudex/config.yaml
accounts: 2 configured, 2 available now
active:   Personal
next:     Personal  (sticky: last successful account — `claudex reset` to release)
token fd: supported
```

Three ways to change it:


| Want                     | Command                                              |
| ------------------------ | ---------------------------------------------------- |
| One run only             | `claudex --cfo-account Work -p "..."`                |
| Until you change it back | `claudex use Work`, then `claudex use --clear`       |
| Change the default order | edit `priority:` in the config, then `claudex reset` |


`claudex reset` **clears cooldowns and releases stickiness.** With the default
(non-sticky) selection a priority change takes effect immediately; you need
`reset` only when an account is still in a recorded cooldown, or when stickiness
is enabled.

A pinned account (`claudex use`) is used even while it is cooling down — you
asked for it explicitly, so claudex tries it rather than quietly overriding you.

---



## 8. Command reference



### claudex's own flags

Stripped before forwarding; `claude` never sees them.


| Flag                     | Effect                        |
| ------------------------ | ----------------------------- |
| `--cfo-account <name>`   | use this account for this run |
| `--cfo-max-switches <n>` | cap switches for this run     |
| `--cfo-no-rotate`        | run once, never fail over     |
| `--cfo-quiet`            | errors only                   |
| `--cfo-verbose`          | explain each attempt          |
| `--cfo-debug`            | verbose plus internals        |
| `--cfo-help`             | wrapper help                  |
| `--cfo-version`          | wrapper version               |




### Subcommands


| Command                                                         | Purpose                                           |
| --------------------------------------------------------------- | ------------------------------------------------- |
| `claudex init [--force]`                                        | write a starter config                            |
| `claudex accounts list`                                         | table of accounts, state, cooldowns, token source |
| `claudex accounts add [--name N] [--provider P] [--priority N]` | add an account                                    |
| `claudex accounts remove <name>`                                | remove an account and its stored token            |
| `claudex status`                                                | active account, next account and why, cooldowns   |
| `claudex health [--deep]`                                       | check every credential                            |
| `claudex use <name>` / `use --clear`                            | pin / unpin                                       |
| `claudex reset [name]`                                          | clear cooldowns and stickiness                    |
| `claudex checkup [--timing] [--print-config]`                   | diagnose the installation                         |


Anything else is forwarded to `claude`. If a claudex subcommand name ever
collides with a real `claude` one, prefix it: `claudex cfo status`.

### Exit codes


| Code          | Meaning                                 |
| ------------- | --------------------------------------- |
| `77`          | every configured account is unavailable |
| anything else | whatever `claude` returned              |


---



## 9. What triggers a switch


| Situation                    | Behaviour                                                  | Cooldown                                 |
| ---------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| 5-hour or weekly usage limit | switch                                                     | until the reported reset, else 5 h / 7 d |
| Rate limited (429)           | switch                                                     | `retry-after`, else 60 s                 |
| Service overloaded (529/5xx) | retry the **same** account twice with backoff, then switch | 30 s, account stays healthy              |
| Auth expired or revoked      | switch, account marked `needs_reauth`                      | 1 h                                      |
| Credit balance too low       | switch                                                     | 24 h                                     |
| **Anything else**            | **no switch** — passed through untouched                   | none                                     |


That last row is deliberate. A failing build, a bad prompt, a hook error and a
`Ctrl-C` all exit non-zero; rotating on them would burn an account for a problem
no account can fix.

If a limit lands *after* output has already been printed, claudex cannot un-print
it, so it resumes the same conversation on the next account rather than replaying
your prompt. If the next account uses `configdir` (siloed history), it stops and
says so instead of silently re-running the work.

Narrow the triggers with `rotate_on` in the config, or disable per run with
`--cfo-no-rotate`.

---



## 10. Using it in every repo

claudex is already global — config and state live in your home directory, so
`claudex` works from any directory with no per-project setup.

If you want existing `claude` commands, scripts and editor integrations to gain
failover without being retyped:

```bash
cd /path/to/claudex
./install.sh --as-claude
export PATH="$HOME/.local/share/claudex/shim:$PATH"   # add to ~/.zshrc
```

The shim goes in its **own directory**, never next to the real binary. On a
normal install `~/.local/bin/claude` is a symlink into
`~/.local/share/claude/versions/`, and writing a file over that symlink would
destroy the real CLI. The installer also resolves the real binary first, refuses
to shim something that is already a shim or that does not run, and records the
resolved path inside the shim so resolution never has to search a PATH
containing it.

It is still the higher-blast-radius option: every `claude` invocation on the
machine goes through the wrapper.

---



## 11. Troubleshooting

**Start here:**

```bash
claudex checkup            # binary, config, permissions
claudex status             # who runs next and why
claudex --cfo-verbose ...  # per-attempt reasoning
```



### Watch a failover without spending quota

```bash
CLAUDEX_FORCE_FAIL=usage_limit claudex -p "hi"
```

Synthesises the failure *without spawning* `claude` *at all*, so nothing is billed.
Classes: `usage_limit`, `rate_limit`, `overloaded`, `auth_expired`,
`credit_exhausted`. Scope it with
`CLAUDEX_FORCE_FAIL_ACCOUNTS=Personal,Work`.

### "could not find the real claude binary"

Set the path explicitly:

```bash
claude_path: /path/to/claude      # in config.yaml
CLAUDEX_CLAUDE_BIN=/path/to/claude  # or in the environment
```



### "claudex resolved to itself"

A `claude` on your PATH is a claudex shim, and the real binary was not found
behind it. Point `claude_path` at the real one, or reinstall the shim with
`./install.sh --as-claude`, which records the resolved path.

### My priority change did nothing

Three possible causes, in order of likelihood:

1. **A cooldown, or stickiness.** Run `claudex reset`. Check `claudex status` —
  it names the rule that chose the account.
2. **You edited a** `.env` **that is not loaded.** Only `~/.config/claudex/.env`
  (or `$CLAUDEX_ENV_FILE`) is read automatically. See
  [Option C](#option-c--the-claudex-env-file).
3. **You edited the wrong file.** `claudex status` prints the config path
  actually in use.



### An account is skipped and I disagree

```bash
claudex reset <name>       # clear its recorded cooldown
claudex use <name>         # force it, cooldown or not
```



### Health check fails for one account

```bash
claudex health             # read the DETAIL column
claudex accounts add --name <name>   # re-mint after `claude setup-token`
```

`needs_reauth` means the token was rejected; a new token is the fix.

### Output looks wrong when piping

It should not — stdout is passed through untouched. Confirm with:

```bash
diff <(claude --version) <(claudex --version)
```

If that differs, file a bug: byte-identical stdout is a hard requirement.

---



## 12. Uninstall

```bash
cd /path/to/claudex
./install.sh --uninstall
```

Removes `claudex` and the `claude` shim. It only deletes files carrying
claudex's own marker and refuses to touch anything else, including symlinks.

Then remove what you no longer want:

```bash
rm -rf ~/.config/claudex     # config and stored tokens
rm -rf ~/.local/state/claudex # cooldowns and selection state
```

Revoke tokens you stored by re-running `claude setup-token` for those accounts.