# ADR-0021: Claude subscription auth on a headless EC2 host, not API-key billing

## Status

Accepted. Live verification against a real subscription and real AWS Secrets Manager is
`[NOT YET EXECUTED]` — see `docs/runbooks/sergeant-claude-subscription-auth.md`.

## Context

UNF-195 built the Claude worker adapter (`crates/sergeant-core/src/worker/claude/`) and already
detects authentication failures in a run's output, but nothing made Claude Code itself installed,
authenticated, and usable by the dedicated `sergeant` OS user on the real Unforgotten EC2 host
(UNF-207). The captain already runs multiple Claude Code subscription accounts successfully on his
development machines through `accounts-axi` (`projects/ai-accounts/`): one isolated
`CLAUDE_CONFIG_DIR` per named account (`claudePersonal`, `claudeTerros`), with `quota-axi` reading
each account's quota for `accounts-axi quota`/`auto-switch`.

The captain's explicit intent (UNF-239) was to preserve that subscription-auth model on the EC2
host if it can be made reliable, rather than defaulting to `ANTHROPIC_API_KEY`/metered billing
merely because that's easier to automate — and to prove it with his own named profiles before
UNF-240 resolves the longer-term question of multi-seat/cloud-hosted terms with Anthropic.

Two things this ticket discovered while implementing, not assumed going in:

1. **`accounts-axi`'s own credential model doesn't transplant to a headless Linux host as-is.**
   Its per-account `CLAUDE_CONFIG_DIR` directories hold an interactive `/login` session that, on
   the captain's Mac, is backed by the macOS Keychain — a device-bound credential, not something
   designed to be copied to another machine. `claude setup-token` is Anthropic's own documented
   mechanism for this exact case: it opens the same OAuth approval flow and prints a one-year
   bearer token instead of saving anything, meant to become the `CLAUDE_CODE_OAUTH_TOKEN`
   environment variable wherever Claude Code should run. It is genuinely interactive (confirmed
   directly: it hangs waiting on browser approval, even with stdin closed) — there is no way to
   script past that step, and this ticket does not attempt to.
2. **`quota-axi` cannot read quota for a profile authenticated this way.** Its Claude support only
   reads an `oauth-file` (`.credentials.json`, written by an interactive `/login`) or the macOS
   Keychain — never a bare `CLAUDE_CODE_OAUTH_TOKEN` environment variable. Reusing it as-is for the
   EC2 host's profiles would silently report every one of them as `credentials_missing` regardless
   of real health.

## Decision

**Subscription auth via `claude setup-token`, never `ANTHROPIC_API_KEY`.** Each named profile's
long-lived OAuth bearer token is generated once, interactively, by the captain
(`docs/runbooks/sergeant-claude-subscription-auth.md` step 1) and pushed into AWS Secrets Manager
(`scripts/push-claude-profile-token.sh`; since UNF-689, `sgt config claude-profile <installation> <name>`) under
`sergeant/<environment>/claude-profile-<name>-token` — the same `sergeant/<environment>/*` prefix
`deploy/terraform/iam.tf`'s `ReadEnvironmentSecrets` statement already grants the instance role
read access to (no IAM change was needed). The token never touches disk on the host: the daemon
fetches it from Secrets Manager exactly once, at startup, as part of profile selection
(`worker::claude::secret::ClaudeTokenResolver`, `worker::claude::secret_aws::
SecretsManagerClaudeTokenResolver`, feature-gated `claude-live`, mirroring `github::secret`/
`github::secret_aws` exactly) and never written to a file, a run record, or a log line. The
resolved value is then held only in memory for that daemon process's lifetime
(`ClaudeAdapterConfig.profile`) and handed to each turn's spawned `claude` process as a real OS
environment variable when that process is launched — a per-turn *process spawn*, not a per-turn
*Secrets Manager fetch*.

**One isolated `CLAUDE_CONFIG_DIR`-equivalent directory per named profile**, under
`/var/lib/sergeant/claude-profiles/<name>/`, reusing `accounts-axi`'s own isolation model rather
than inventing a second one — `worker::claude::profile::ClaudeProfile` is the Rust-side
equivalent of one `accounts.json` entry. `deploy/host/install.sh` (UNF-376; formerly inline in
`deploy/terraform/user_data.sh.tpl`) creates only the parent directory; each profile's own
subdirectory is created lazily, on first resolve
(`ClaudeProfile::resolve`), since Terraform has no reason to know profile names in advance.

**Health-probe-based selection, not `quota-axi`'s quota windows.** Given the `quota-axi`
limitation above, `worker::claude::profile::select_profile` picks the first healthy profile (in a
caller-given preference order) using the same harmless non-interactive `claude -p` invocation
`sgt doctor` and a real Run both need anyway, rather than forcing `quota-axi` into a shape it
doesn't support or fabricating a `.credentials.json` from a token never meant to populate one.
This trades numeric quota-window visibility for something that actually works against this host's
real authentication shape. `crates/sergeant-cli/src/commands/doctor/claude_profiles.rs` reuses
this exact probe for `sgt doctor`'s per-profile readiness check, replacing/extending the
pre-existing bare `claude --version` check (`doctor/binaries.rs`, still kept — "is the CLI on
PATH" remains a useful, cheaper signal alongside the deeper per-profile check).

*Superseded by [ADR-0036](0036-per-run-worker-account-selection-by-observed-quota.md) (UNF-541):
every healthy profile now forms a pool and one is chosen per Run from observed quota. The next
paragraph records the original V1 decision.*

**Selection happens once per daemon process start, not per Run — a deliberate, documented V1
limitation, not an oversight.** This daemon (`sergeant-daemon`) constructs exactly one
`ClaudeWorker` per process, at startup (`crates/sergeant-daemon/src/serve.rs`), same as before this
ticket. `select_claude_profile` there picks a profile once and bakes it into that single
`ClaudeAdapterConfig`; every Run dispatched during that process's lifetime records the same
profile name as non-secret provenance (`Run.resolved_context`, a small
`{"claude_profile": "<name>"}` JSON object — the first thing to actually populate that
previously-unused column, threaded through `orchestrator::dispatch::RunInput::resolved_context`
from `sergeant-daemon`'s `ImplementationDeps::claude_profile_name`). A genuine per-Run
reselection needs more than one concurrent worker to plug into, which doesn't exist yet — building
that speculatively here would be exactly the kind of generic multi-account platform UNF-239's own
non-goals rule out.

**Proof-of-model scope, enforced by convention not code.** Only captain-owned profiles are
configured (`SERGEANT_CLAUDE_PROFILES`, set by the operator, never populated automatically from
any directory of "everyone's" credentials). Nothing in this ticket adds a second employee's seat;
that stays blocked on UNF-240's written Anthropic answer.

**Fail closed once the operator has opted in, fail open only when they haven't.**
`serve.rs::select_claude_profile` draws the line on whether `SERGEANT_CLAUDE_PROFILES` was set at
all, not on any other signal: genuinely unset is the intended laptop/dev-mode path (`claude`
authenticates however it picks up ambiently — the pre-UNF-239 default). Set but broken in any way
(malformed spec, the token resolver failing to initialize, no configured profile currently
healthy, or a resolve error after selection) fails the whole daemon's startup — before any loop is
spawned or the HTTP listener is bound — rather than silently falling through to whatever ambient
credential happens to be present. Silently falling back once the operator has explicitly opted
into named-profile auth is exactly the accidental metered-billing risk this ticket exists to
avoid; a loud, systemd-visible crash-loop is the correct failure mode for a genuine
misconfiguration, not a background log line nobody is watching.

## Consequences

- A normal `systemctl restart sergeant` or a full EC2 reboot requires no interactive step: the
  daemon fetches the token from Secrets Manager exactly once, at startup, and re-fetches it the
  same way on its next restart. Nothing profile-related is stored on the host's local disk to have
  gone stale. Between resolutions, the token is held only in memory for that process's lifetime and
  handed to each turn's spawned `claude` process as a real OS environment variable — a per-turn
  process spawn, never a per-turn Secrets Manager fetch.
- Re-authenticating an expired/revoked token is exactly steps 1–2 of the runbook, repeated for that
  one profile — no Terraform change, no code change.
- `sgt doctor`'s per-profile check spends a small amount of real subscription quota (Haiku,
  `worker::claude::profile::PROBE_MODEL`) every time it runs, since there is no free way to check
  "is this profile authenticated" without a real call given the `quota-axi` gap above. This is
  acceptable for an operator-invoked diagnostic; it is why *selection* (which could otherwise run
  on every dispatch) is deliberately not re-probed per Run today.
- Richer quota-window visibility (headroom, reset timing, `auto-switch`-style weekly-vs-session
  tie-breaking) is not available on this host today. If that turns out to matter in practice, the
  documented path is an *additional*, optional interactive `/login` per profile purely so
  `quota-axi` has something to read — never replacing the `CLAUDE_CODE_OAUTH_TOKEN` env var, which
  still outranks a stored `/login` credential in Claude Code's own precedence order.

## What this ticket does not attempt

Per its own explicit sandbox constraint: no real `claude setup-token` was run, no real Claude
subscription login was touched (including the captain's own macOS Keychain-backed sessions for his
existing `accounts-axi` accounts), and no real AWS Secrets Manager call was made. Everything above
is verified by unit tests against fakes (`worker::claude::secret::fake::FakeClaudeTokenResolver`,
`worker::claude::profile`'s `FakeProbe`s) — see
`docs/runbooks/sergeant-claude-subscription-auth.md`'s `[NOT YET EXECUTED]` steps for the real
verification this still needs before anything here is trusted against production Runs.
