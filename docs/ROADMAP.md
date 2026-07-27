# Future enhancements

Ordered by value per unit of risk, with the reasoning that makes each one worth
or not worth doing.

## Near term

**API-key accounts.** An `apikey` provider setting `ANTHROPIC_API_KEY` would let
console-billed accounts sit in the same rotation as subscription accounts. This
is one class implementing `TokenProvider` plus one case in `providerFor()`; the
detector already recognises `credit balance too low` and `invalid_api_key`. Left
out of v0.1 only because the accounts in question were subscription accounts.

**Quota-aware pre-emptive rotation.** Today an account is discovered to be
exhausted by hitting the limit, which costs one failed request. The CLI already
knows how much of each window is consumed. Reading that before dispatch would let
claudex switch *before* the wall, and would let `claudex status` show remaining
headroom rather than only cooldowns. Depends on a stable way to read usage
without a billed request.

**`--cfo-strategy`.** Selection is currently priority-with-stickiness. Two other
strategies are defensible: `round-robin` (spread load evenly, at the cost of
prompt-cache warmth) and `least-used` (drain the account with most headroom
first). The rotation engine is already the single decision point, so this is a
contained change.

**Live interactive detection.** The TUI limit banner is drawn on stdout, which
claudex does not intercept, so interactive detection reads the session
transcript once the session ends — which is why a limit inside the TUI costs one
quit-and-relaunch. Watching that file *during* the session would let claudex
notice a limit in real time and offer the switch immediately, still without a
PTY. This is the cheapest remaining win for interactive users.

## Medium term

**Third-party model providers.** Bedrock, Vertex and Foundry use their own
credentials and their own env vars. Each is a provider class; the interesting
work is the failure taxonomy, since their throttling errors differ from the
first-party ones.

**Daemon mode.** State is currently a locked file read on every invocation. A
small background process holding state in memory would remove the file lock from
the hot path and allow instant propagation of a cooldown to every open shell.
Worth doing only if measurements show the lock actually costs something; today it
does not.

**Structured event output.** `--cfo-json` emitting one JSON object per rotation
event would let CI systems and dashboards consume what is currently prose on
stderr.

**Usage accounting.** Recording tokens and cost per account per window would
answer "which account is doing the work" without external tooling. The data is
already in the `--output-format json` result objects claudex parses for errors.

## Deliberately not planned

**PTY-based mid-session hot swap.** Putting a pseudo-terminal between the user
and the TUI would allow scanning rendered output for the limit banner and
swapping accounts without the session ending. It also means a native dependency,
a scanner that must parse escape sequences correctly, and new failure modes
around resize, mouse reporting and bracketed paste. The cost lands on every
interactive session; the benefit applies only when a limit is hit. Reconsider
only if transcript-based detection proves insufficient in practice.

**Token brokering / sharing.** Anything that distributes credentials between
machines or users is out of scope. claudex handles credentials that already
belong to the person running it.

**Bypassing limits.** claudex fails over between accounts a user owns. It will
not implement anything whose purpose is to disguise that, spread a single
workload across accounts to evade a per-account limit, or otherwise work around
the terms the accounts are held under.
