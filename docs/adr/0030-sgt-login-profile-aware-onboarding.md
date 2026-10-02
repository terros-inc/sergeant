# ADR-0030: `sgt login` becomes profile-aware; the Linear OAuth client secret becomes optional

## Status

Accepted (UNF-407).

## Context

UNF-390 added named Sergeant installation profiles (`crate::profile`,
`~/.config/sergeant/config.toml`) and made a human's Linear CLI session profile-scoped
(`commands::auth::identity_store::profile_path`). UNF-407 is the first-run experience that model
was missing: on a clean install with no profiles configured, `sgt login` went straight for Linear
OAuth configuration and failed with a bare `SERGEANT_LINEAR_OAUTH_CLIENT_ID is not set` — the wrong
abstraction, since `sgt` doesn't yet know *which Sergeant installation* a human is even
authenticating to.

Fixing that surfaced a second, load-bearing problem in ADR-0024's own design: `sgt login`'s token
exchange (`sergeant_core::linear::oauth::flow::exchange_code_for_token`) sent both
`SERGEANT_LINEAR_OAUTH_CLIENT_ID` and `SERGEANT_LINEAR_OAUTH_CLIENT_SECRET` to Linear's token
endpoint. ADR-0024 treated the client secret as ordinary CLI-host configuration a human sets
locally — but a *shared* client secret cannot safely be distributed to every human's laptop; doing
so defeats the entire point of it being a secret. This ticket does not introduce a server-side
OAuth broker to work around that (no new daemon authentication endpoint, no daemon ever handling a
user's authorization code or returning bearer/refresh tokens) — Linear's OAuth implementation
already supports PKCE with an optional client secret, so the fix is to stop requiring the secret at
all for the normal path.

## Decision

- **Client id is public, daemon-served installation configuration; client secret is optional,
  local-only, and never required.** `sergeant_core::linear::oauth::flow::TokenExchangeRequest.
  client_secret` is now `Option<&str>`, omitted entirely from the token-exchange form when absent
  (never sent as an empty string) — PKCE's `code_verifier` is sufficient for Linear to authorize a
  public client. `sergeant-daemon`'s `Config::linear_oauth_client_id`
  (`SERGEANT_LINEAR_OAUTH_CLIENT_ID`, installation-host env var) is served over a new,
  deliberately unauthenticated `GET /login-config` (`http::login_config`) — an OAuth client id is
  not a secret, the same way an OAuth provider's own public client-metadata endpoint isn't. This
  route is mounted on both `http::router` and `http::public_router`, alongside `/health`, and
  structurally bypasses `http::auth::AuthenticatedHumanIdentity` (a human with no session yet is
  exactly who needs to discover how to start one) — it returns only the client id and display-only
  Linear workspace id/name, resolved from the same `whoami` call
  `linear_instance::resolve_and_log_installation_workspace` already made for UNF-401's workspace
  scoping (`InstallationWorkspace`, one struct, one call, no drift between the two uses).
  `sergeant-cli`'s `commands::auth::config::resolve` still accepts a local
  `SERGEANT_LINEAR_OAUTH_CLIENT_ID`/`SERGEANT_LINEAR_OAUTH_CLIENT_SECRET` override — development
  against an installation with no client id configured yet, or a custom/self-hosted setup — but
  neither is required for the normal path.
- **`sgt login` resolves a profile before it resolves anything OAuth-shaped.**
  `commands::auth::login::onboarding::determine_situation` reads `config.toml` directly (not
  `crate::profile::resolve`, which collapses "no profiles at all" and "profiles exist but none is
  default" into the same pre-UNF-390 legacy-compatibility case) so the three states the ticket
  actually cares about are distinguishable: an explicit `--profile`/configured default resolves
  straight through; no profiles at all offers the guided interactive setup
  (`onboarding::offer_interactive_setup`); multiple profiles with no default prompts which
  installation to use (`onboarding::prompt_select_profile`) rather than guessing. Both declined
  paths print the real `sgt profile add <name> --endpoint <url>` / `sgt profile use <name>` syntax,
  never an invented parallel command.
- **The interactive setup reuses `sgt profile add`'s own logic, not a parallel implementation.**
  `commands::profile::add::add_profile` is the pure(-ish) core UNF-390's `sgt profile add` already
  used internally, now also called directly by `login::onboarding` — one profile-creation code
  path, not two. The connectivity check the ticket's UX asks for ("Checking Sergeant
  installation... ✓ Connected ✓ Linear workspace: ...") is the same `GET /login-config` fetch that
  supplies the OAuth client id, not a second network round trip.
- **No new profile/config concept, no second store.** Everything above composes UNF-390's existing
  `config.toml`/profile model and UNF-359/UNF-391's existing identity-file/human-auth machinery;
  this ticket adds one new daemon route and one new CLI onboarding flow on top, per its own
  "simplification boundary."

## Consequences

- A normal human never sets `SERGEANT_LINEAR_OAUTH_CLIENT_ID` or any Linear OAuth secret on their
  own laptop — `sgt login` alone (on a clean install) is enough, guided by the printed prompts.
- `GET /login-config` is a new pre-authentication discovery surface on both listeners. It is
  strictly non-secret by construction (client id, workspace id/name only — see
  `http::login_config`'s own tests asserting no credential-shaped field ever appears in its
  response), so it does not expand `docs/security/threat-model.md`'s trust boundary the way a
  genuinely authenticated route would.
- `sergeant_core::linear::model::LinearViewer` gained `organization_name: Option<String>` (from
  `VIEWER_QUERY`'s `organization { id name }`) purely for this display purpose — `None` rather than
  a mapping error when a response omits it, since nothing authorization-relevant depends on it the
  way `organization_id` is.
- A client secret is still accepted (`SERGEANT_LINEAR_OAUTH_CLIENT_SECRET`/`_SECRET_ID`) for a
  genuinely separate server-side/service flow or local development compatibility — this ADR does
  not remove that escape hatch, it only removes the requirement.
