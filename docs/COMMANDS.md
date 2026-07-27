# Command reference

Everything claudex responds to, in one page. For explanation and workflows see
the [manual](MANUAL.md).

> **claudex has no slash commands.** Slash commands (`/help`, `/resume`,
> `/model`, `/clear`, and any you have installed) belong to Claude itself and
> are typed *inside* a running session. claudex forwards every keystroke to the
> real CLI, so all of them work exactly as they do without the wrapper.
> claudex's own commands are ordinary subcommands, listed below.

---

## The main use

```bash
claudex                     # opens the normal Claude TUI
claudex "explain this repo" # same, with an opening prompt
claudex -p "summarise src/" # non-interactive
```

Anything not listed in this file is forwarded to `claude` byte-for-byte.

---

## claudex subcommands

| Command | Arguments | Purpose |
|---|---|---|
| `claudex init` | `[--force]` | Write a starter config to `~/.config/claudex/config.yaml`. `--force` overwrites an existing one. |
| `claudex accounts list` | — | Table of accounts: provider, priority, state, reason, cooldown, token source. `*` marks the active account. Alias: `ls`. |
| `claudex accounts add` | `[--name N] [--provider P] [--priority N] [--config-dir D] [--keychain-service S] [--keychain-account A]` | Add an account. Prompts for anything not given; the token is read without echo. Accepts a piped token for scripts. |
| `claudex accounts remove` | `<name>` | Remove an account from the config and delete its stored token. Alias: `rm`. |
| `claudex status` | — | Config in use, how many accounts are available, the active account, which account runs next **and which rule chose it**, cooldowns, injection mode. |
| `claudex health` | `[--deep]` | Verify every credential with `claude auth status --json` (no quota). `--deep` also sends one tiny prompt per account, which does cost quota. |
| `claudex use` | `<name>` \| `--clear` | Pin an account across invocations, or release the pin. A pinned account is used even while cooling down. |
| `claudex reset` | `[name]` | Clear recorded cooldowns **and** the sticky pointer, for one account or all. Run this after changing priorities. |
| `claudex checkup` | `[--timing] [--print-config]` | Diagnose the install: resolved binary, config source, accounts, permissions of secret-bearing files. `--timing` reports overhead. |

Any subcommand can be prefixed with `cfo` — `claudex cfo status` — if its name
would otherwise collide with a real `claude` subcommand.

---

## claudex flags

Stripped from the argument vector; `claude` never sees them.

| Flag | Effect |
|---|---|
| `--cfo-account <name>` | Use this account for this run only. Beats pinning, stickiness and priority. |
| `--cfo-max-switches <n>` | Cap account switches for this run. |
| `--cfo-no-rotate` | Run once; never fail over. |
| `--cfo-quiet` | Errors only. |
| `--cfo-verbose` | Explain each attempt, and print configuration notes. |
| `--cfo-debug` | Verbose plus internals. |
| `--cfo-help` | claudex's help (not Claude's). |
| `--cfo-version` | claudex's version (not Claude's — `claudex --version` gives you that). |

---

## Environment variables

Read from the real environment, and from the claudex env file at
`~/.config/claudex/.env` (or `$CLAUDEX_ENV_FILE`). The real environment always
wins over the file.

### Accounts

| Variable | Effect |
|---|---|
| `CLAUDE_TOKEN_<N>` | Defines account N. Overrides the token of a config-file account with the same name. |
| `CLAUDEX_ACCOUNT_<N>_NAME` | Names account N. Matching a config-file account by name merges into it. |
| `CLAUDEX_ACCOUNT_<N>_PRIORITY` | Priority for account N. Overrides the config file **only when set explicitly**. |

### Behaviour

| Variable | Effect |
|---|---|
| `CLAUDEX_STICKY` | `1` to keep using the last successful account instead of returning to the highest-priority one. Off by default. |
| `CLAUDEX_MAX_SWITCHES` | Switch cap. |
| `CLAUDEX_ROTATE_ON` | Comma-separated failure classes allowed to rotate. |
| `CLAUDEX_QUIET` | `1` for errors only. |

### Paths

| Variable | Effect |
|---|---|
| `CLAUDEX_CONFIG` | Explicit config file path. |
| `CLAUDEX_ENV_FILE` | Explicit env file path. |
| `CLAUDEX_CLAUDE_BIN` | Explicit path to the real `claude` binary. |

### Diagnostics

| Variable | Effect |
|---|---|
| `CLAUDEX_DEBUG=1` | Full debug logging. |
| `CLAUDEX_FORCE_FAIL=<class>` | Synthesise a failure **without running `claude`**, so rotation can be exercised without spending quota. Classes: `usage_limit`, `rate_limit`, `overloaded`, `auth_expired`, `credit_exhausted`. |
| `CLAUDEX_FORCE_FAIL_ACCOUNTS` | Comma-separated account names to scope the forced failure to. |

---

## Config file keys

`~/.config/claudex/config.yaml`

### `defaults`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `provider` | `profile` \| `oauth-shared` \| `configdir` \| `keychain` | `profile` | Credential mechanism for accounts that don't name one. `oauth` is accepted and means `profile`. |
| `max_switches` | integer | `3` | Maximum account switches per command. |
| `rotate_on` | list | all five classes | Which failures may trigger a switch. |
| `quiet` | boolean | `false` | Errors only. |
| `sticky` | boolean | `false` | Prefer the last successful account over priority order. |

Top level: `claude_path` sets the real binary explicitly.

### `accounts[]`

| Key | Required for | Meaning |
|---|---|---|
| `name` | all | Used in output and `--cfo-account`. |
| `priority` | all | Lower runs first; ties broken by declaration order. |
| `token` | `profile`, `oauth-shared` | A reference — see below. |
| `provider` | — | Defaults to `defaults.provider`. |
| `config_dir` | `configdir` | The `CLAUDE_CONFIG_DIR` to use. For `profile`, where that account's isolated state lives (default `~/.config/claudex/profiles/<account>`). |
| `keychain_service`, `keychain_account` | `keychain` | Which keychain item holds the credentials. |

### Token references

| Form | Source |
|---|---|
| `${CLAUDE_TOKEN_1}` / `env:CLAUDE_TOKEN_1` | Environment variable |
| `file:~/.secrets/token` | First line of a file |
| `keychain:service/account` | macOS keychain item |
| `store:Personal` | claudex credential store |
| `sk-ant-oat01-…` | Literal (warns if the file is group-readable) |

---

## Exit codes

| Code | Meaning |
|---|---|
| `77` | Every configured account is unavailable. |
| anything else | Whatever `claude` returned. |

---

## Selection order

Highest wins:

```
1.  --cfo-account <name>                 this run only
2.  claudex use <name>                   until cleared
3.  sticky last successful account       only when sticky is enabled
4.  CLAUDEX_ACCOUNT_<N>_PRIORITY         when explicitly set
5.  priority: in the config file
6.  declaration order in the config file
```

Accounts in cooldown or needing re-auth are skipped at every level except 1 and
2, which are explicit user instructions and are honoured regardless.

---

## Files

| Path | Contents | Mode |
|---|---|---|
| `~/.config/claudex/config.yaml` | accounts and defaults | 600 |
| `~/.config/claudex/credentials.json` | tokens added via `accounts add` | 600 |
| `~/.config/claudex/.env` | environment settings claudex loads itself | 600 |
| `~/.local/state/claudex/state.json` | cooldowns, active account — never tokens | 600 |
| `~/.local/bin/claudex` | the command | 755 |
| `~/.local/share/claudex/shim/claude` | optional `claude` shim | 755 |
