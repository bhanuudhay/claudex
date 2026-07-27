# Security

## Terms of service

Rotating between accounts to keep working past a usage limit may conflict with
Anthropic's Consumer Terms and Usage Policy. claudex is built for accounts you
own and are authorised to use, and it does nothing to conceal that rotation is
happening — every switch is announced on stderr and recorded in state. Read your
plan's terms before configuring multiple accounts.

## Where secrets live

| Location | Contents | Mode |
|---|---|---|
| `~/.config/claudex/credentials.json` | tokens added via `claudex accounts add` | 0600 |
| config file | *references* (`${VAR}`, `env:`, `file:`, `keychain:`, `store:`) — literals discouraged | 0600 recommended |
| `~/.local/state/claudex/state.json` | account names, health, cooldowns — **never tokens** | 0600 |
| logs / stderr | nothing unmasked, ever | — |

`claudex checkup` reports the mode of every file that can hold a secret, and the
config loader warns when a file containing a literal `sk-ant-` token is group- or
world-readable. It warns rather than refuses: locking you out of your own tool
over a permission bit is a worse outcome than a loud message.

## Token references

Prefer a reference over a literal:

```yaml
token: ${CLAUDE_TOKEN_1}              # environment
token: env:CLAUDE_TOKEN_1             # environment, explicit
token: file:~/.secrets/claude-token   # secret manager output
token: keychain:claudex/personal      # macOS keychain
token: store:Personal                 # claudex credential store
```

Resolution is lazy: only the account that actually runs has its credential
resolved, so a broken reference on the third account costs nothing while the
first is healthy.

## Passing the credential to the child

By default the token is written into a pipe handed to the child as **file
descriptor 3**, and only the number `3` appears in the child environment
(`CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3`). The token is therefore not visible
to `ps -E`, `/proc/<pid>/environ`, or anything else that reads another process's
environment.

If a CLI build rejects that path, claudex falls back to
`CLAUDE_CODE_OAUTH_TOKEN` in the child environment — the universally supported
mechanism, and the same exposure any manual `export` would have. The fallback is
learned once and recorded in state; `claudex status` shows which path is in use.

Whichever mechanism is active, the other auth variables
(`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and the unused OAuth variable) are
**removed** from the child environment, so a stale shell export cannot silently
take precedence over the account you selected.

## Redaction

`Logger` is the only component allowed to write wrapper output, and every write
passes through `redact()`, which applies two independent layers:

1. a shape match on `sk-ant-<kind>-<body>`, which catches tokens claudex never
   loaded — for example one echoed back inside a child error message;
2. exact-match scrubbing of every secret this process has resolved, which
   catches credentials whose shape we did not anticipate.

Masked output keeps the prefix and the last four characters
(`sk-ant-oat01-…WxYz`), which is enough to tell two accounts apart while
remaining useless if leaked. An integration test asserts that no token material
reaches stdout or stderr even at `--cfo-debug`.

## The keychain provider

The `keychain` provider is opt-in and carries risks the others do not:

- **It mutates machine-wide state.** While a command runs, the
  `Claude Code-credentials` keychain item holds a different account. Any *other*
  `claude` process started during that window — an editor integration, a second
  terminal — will use the swapped account.
- **A cross-process mutex prevents claudex from racing itself**, but cannot stop
  a `claude` you started by hand.
- **The original item is restored** on normal exit, on error, and from
  `SIGINT`/`SIGTERM` handlers. A `SIGKILL` will leave the swapped credential in
  place until the next claudex run repairs it.
- **The credential is passed to `security(1)` as an argument** (`-w <value>`),
  which is briefly visible in the process list. This is a limitation of the
  `security` CLI, not something claudex can work around.

Use `oauth` unless an account genuinely cannot mint a long-lived token.

## Threat model, stated plainly

claudex protects against **accidental** exposure: tokens in logs, tokens in
shared shell history, tokens visible to other users through the process table,
and tokens sitting in world-readable files.

It does not protect against an attacker who already has your user account. Any
process running as you can read `credentials.json`, read the config, and run
`claude` directly. That is the same trust boundary the Claude CLI itself
operates under.

## Reporting

Found something? Open an issue without the reproducing credential, or rotate the
affected token first with `claude setup-token` and remove the old account with
`claudex accounts remove <name>`.
