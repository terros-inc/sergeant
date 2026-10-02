# ADR-0024: `sgt login` — browser-based Linear OAuth for the human CLI identity

## Status

Accepted. Amended 2026-09-28 (UNF-459): the original "second, separately registered Linear OAuth
application" decision is replaced by one application per installation plus the credential
invariants below.

## Context

UNF-359 asks for a clean-box onboarding path: a human runs `sgt login` on a fresh Sergeant
installation, approves access in a browser, and Sergeant subsequently knows which human is
configuring repositories/tools (`sgt whoami`) — without SSH into the Sergeant host and without
pasting a long-lived Linear API key anywhere.

This is explicitly **administrative identity for the CLI, not task authorization**. It must not
become a rule that Linear issue authors/assignees determine worker authority, and it must not be
conflated with Sergeant's own service/agent Linear identity (`SERGEANT_LINEAR_*`,
`docs/runbooks/sergeant-linear-agent-integration.md`, UNF-236), which authenticates the daemon
itself and is what issues get delegated to. ADR-0008/`docs/security/threat-model.md` already model
a `human` `Principal` kind conceptually, but explicitly defer persisting `Principal`/`Connection`/
`Grant` until a real consumer needs them (§13) — this ticket is not that consumer: it adds no
SQLite schema, no daemon-side wiring, and no authorization check. It only makes a human's own
Linear identity available locally to the CLI.

## Decision

- **Browser-based OAuth 2.0 Authorization Code flow + PKCE (RFC 7636), `actor=user`.** No pasted
  API key. `crates/sergeant-core/src/linear/oauth/` holds the pure, testable halves (PKCE
  generation, authorize-URL building, token-response parsing) plus the real `ureq`-backed token
  exchange, built un-gated like `linear::http_transport::LinearHttpTransport` — no `-live` feature
  exists to gate either of them behind, and neither is exercised against Linear's real API by this
  repo's test suite (no real OAuth application credential exists in the sandbox). `actor=user` is
  what tells Linear the resulting token authenticates as the human, not Sergeant's own agent
  identity — see `oauth/pkce.rs::AUTHORIZE_ACTOR`'s doc comment.
- **One Linear application per Sergeant installation; the two identities are two credentials.**
  (Amended by UNF-459 — this originally required a second, separately registered "Sergeant CLI
  Login" application.) The installation's single "Sergeant" Linear application backs both the
  daemon's service/agent identity and human `sgt login`; they are distinct identities because the
  credentials Linear issues represent different actors, not because they come from different
  applications. `SERGEANT_LINEAR_OAUTH_CLIENT_ID`/`SERGEANT_LINEAR_OAUTH_CLIENT_SECRET[_SECRET_ID]`
  (`commands::auth::config`) stay distinct env vars from the service identity's own
  `SERGEANT_LINEAR_TEAM_ID`/`SERGEANT_LINEAR_AGENT_USER_ID`/`SERGEANT_LINEAR_API_TOKEN`/
  `SERGEANT_LINEAR_WEBHOOK_SECRET`, even though the client id names the same application. The
  invariants that keep the identities apart:
  1. Daemon/service credentials authenticate as the Sergeant app/agent.
  2. `sgt login` always uses PKCE + `actor=user`.
  3. The CLI never receives the daemon's service token.
  4. The daemon never receives the human's OAuth token.
  5. No shared client secret is distributed to CLI users.
  6. Human credentials remain profile-scoped locally.
  7. Service credentials remain installation-owned and secrets-managed.

  An `sgt` profile selects exactly one installation, and one installation manages many
  repositories, so a repository boundary never implies another application or installation. See
  `docs/runbooks/sergeant-cli-linear-oauth-login.md` for configuring the application's client id.
- **`sgt login`/`logout`/`whoami` run entirely on the host `sgt` is invoked from, like `doctor`.**
  They never talk to a running daemon (`crates/sergeant-cli/src/cli.rs`'s own doc comment on each
  command) — the loopback OAuth callback and the local credential file both only make sense
  relative to the machine actually running the command. This also means the daemon's own
  `Config`/`serve()` startup path is completely untouched by this ticket: nothing here changes
  what the daemon resolves, gates on, or exposes over HTTP.
- **Local, on-host persistence — `~/.config/sergeant/identity.json` by default
  (`commands::auth::identity_store`), 0600 on Unix.** This intentionally does *not* follow
  `docs/security/threat-model.md` §8's "never a raw secret in Sergeant's durable state" rule,
  because that rule is about the *daemon's* SQLite orchestration store, which this ticket never
  touches. A local CLI credential file is the established shape every other provider integration
  in this repo already documents for a human's own session — `claude`'s own `.credentials.json`
  under a `CLAUDE_CONFIG_DIR` (`docs/runbooks/sergeant-claude-subscription-auth.md`) is the closest
  existing precedent for "a per-identity directory holding live credential material on disk,
  protected by OS file permissions rather than a secret-reference indirection." `gh`/`aws`'s own
  config directories are the same shape outside this repo.
- **No SQLite schema, no `Principal`/`Connection`/`Grant` persistence, no authorization wiring.**
  Per ADR-0008 and the ticket's own non-goals (no per-task RBAC, no multi-user permission policy),
  this identity is not consulted by any dispatch/authorization path. "Available to later
  repository/tool configuration commands" (the ticket's own acceptance criterion) means exactly
  that a future host-local command can call `identity_store::load` the same way this one does —
  not that this ticket wires anything into the daemon.

## Consequences

- A human's Linear OAuth access token lives in a local file, readable by anything running as that
  same OS user — the same trust boundary every other local CLI credential file in this repo (and
  every provider CLI it documents) already accepts, not a new exposure this ticket introduces.
- Because neither `commands::auth` nor `linear::oauth` reads or writes a single
  `SERGEANT_LINEAR_*` (service-identity) name, the two identities are structurally, not just
  conventionally, disjoint — verified by `commands::auth::login::tests::
  build_identity_is_a_pure_function_of_its_arguments_only` and this module's own doc comments,
  rather than by mutating shared process env vars in a test (which would race against
  `commands::doctor::linear`'s own tests on those same names).
- Whoever wires a future "who configured this repo" provenance field reads
  `commands::auth::identity_store::load` directly — this ADR is the pointer for that follow-up, not
  a redesign trigger.
- Persisting `Principal`/`Connection`/`Grant` to SQLite (ADR-0008 §13's still-deferred item) is
  untouched by this ticket and remains exactly as deferred as before.
- UNF-391 is the daemon-side follow-up this ADR anticipated: `sgt` now attaches this ADR's own
  `CliIdentity::access_token` as `Authorization: Bearer` on normal daemon requests, and the daemon
  validates it server-side (`sergeant_core::linear::human_identity`) to resolve the real Linear user
  — still administrative identity for a narrow control surface (`/tools*`), not task authorization,
  and still structurally disjoint from the service/agent identity per this ADR's own decision. No
  `Principal`/`Connection`/`Grant` persistence was added; see `docs/repo-map.md`'s `linear/
  human_identity.rs` and `http/auth.rs` entries for what was actually built.
- UNF-407 is the follow-up that fixes the one part of this ADR's "client secret" decision that
  didn't survive contact with real distribution: `SERGEANT_LINEAR_OAUTH_CLIENT_SECRET` above reads
  as required, but a shared client secret cannot safely be handed to every human's laptop. See
  `docs/adr/0030-sgt-login-profile-aware-onboarding.md` for that decision — the client id/secret
  split it lands on, and the new profile-aware first-run flow built on top of it.
