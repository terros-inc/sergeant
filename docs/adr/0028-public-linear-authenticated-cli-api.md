# ADR-0028: a second, narrow HTTPS listener for Linear-authenticated normal `sgt` commands

## Status

Accepted. Unit/integration-tested Rust (`crates/sergeant-daemon/src/http/mod.rs`'s
`public_router`, `crates/sergeant-daemon/tests/http_public_api.rs`) and validated (`terraform fmt`
+ `terraform validate -backend=false`, no AWS credentials or network calls) Terraform
(`deploy/terraform/public_api_ingress.tf`) only — no live listener bound, no real `terraform plan`/
`apply`, no DNS/Elastic IP/security-group change to the running Unforgotten installation. This
machine's crewmate worktrees inherit real ambient AWS credentials, so nothing here was run against
them; live verification happens separately, outside a sandboxed task worktree, with a
human/Firstmate driving it explicitly (same posture ADR-0027 documents for `sgt admin`).

**Corrected by UNF-612.** This ADR's "Consequences" section claimed `sgt status` already worked
through this router unchanged ("no CLI-side change was needed for this ticket at all"). That was
wrong: `commands/status.rs` also called `/drain/status` and `GET /health/linear`, neither ever
mounted on `public_router` by design (see this ADR's own "Decision" section), so `sgt status`
returned HTTP 404 for every Linear-authenticated human with no AWS credentials — confirmed
2026-09-29 against the Personal Sergeant installation. UNF-612 removed both dependencies; `sgt
status` now reports only Tasks/Runs/safety-breaker state (all already on this router), and drain/
lifecycle state stays at `sgt admin status`. The router itself needed no change — this was purely
a CLI-side regression against this ADR's own intent.

## Context

UNF-391 gave the daemon server-verified Linear auth (`AuthenticatedHumanIdentity`, an extractor
resolving a request's `Authorization: Bearer` Linear session) but wired it into exactly one route
family: `/tools*`. Every other route on `crates/sergeant-daemon/src/http/mod.rs`'s single `router`
— `/tasks*`, `/runs*`, `/reconcile`, `/safety/*`, `/drain*` — has no authentication at all, which
was fine as long as the only way to reach that router was the VPC/SSM-only bind address
(`SERGEANT_BIND_ADDR`, loopback by default) `docs/adr/0016` established. UNF-392 then gave
`sgt admin` an entirely separate, AWS/IAM+SSM transport for installation-lifecycle operations
(repo add/remove, installation config, deploy/restart/drain), deliberately never touching the
daemon's HTTP API at all.

UNF-396's own goal is narrower than "expose everything": let a human with a Linear session but no
AWS/SSM credentials run *normal* `sgt` commands (`status`, `task`, `run`, `reconcile`, `resume`,
`tool ...`) against a remote installation, while installation administration stays exactly where
UNF-392 put it. The complication, at the time this decision was made: `deploy/terraform/
webhook_ingress.tf` (UNF-262/UNF-327 — since removed by UNF-459, see "Consequences" below) already
opened a public HTTPS path to the daemon, but as a single Network Load Balancer TLS listener
forwarding *raw TCP* to one daemon port. That file's own comment claimed "every other route ...
stays completely unreachable from this ingress," which was accurate only because nothing on the
public internet could reach that port at all before UNF-396 — once *any* listener on that port is
reachable from the internet, every route the daemon's single `router` serves on it is reachable
too, since an NLB TLS listener does raw TCP forwarding, not path-based HTTP routing (the ALB
alternative that would enable that was already rejected in that file's own doc comment, for this
deployment's single-AZ-subnet reasons — reasoning that no longer applies now that UNF-459 replaced
the NLB with Caddy on the instance itself, but is preserved here since it's what motivated this
ADR's decision below). Adding Linear auth to `/tasks*`/`/runs*`/etc. on
the *existing* router alone would not have been enough on its own: `/drain*` needing to stay off
this surface entirely (per the ticket's explicit scope boundary) can't be expressed as "require
auth," because AWS/SSM-gated and Linear-authenticated are two different authorities — a Linear
session proves who the human is, never that they're authorized for AWS-gated installation
lifecycle operations, and the ticket's own simplification boundary rules out inventing a
Sergeant-side RBAC layer to bridge that gap.

## Decision

**A second `axum` router (`http::public_router`) mounted on a second bind address
(`Config::public_bind_addr`/`SERGEANT_PUBLIC_BIND_ADDR`, `None` by default — no change to any
existing deployment or test), reusing the exact same handlers the original `router` calls, with a
`route_layer` auth gate on the routes that don't already carry one.** Three points this rests on:

- **Structural exclusion, not policy exclusion, for `/drain*`.** `public_router` simply never
  routes to `drain::{request,status,cancel}` — there is no auth check to misconfigure or bypass,
  because there is no route at all. The same is true of `/webhooks/*` (kept on the original router
  only, still independently authenticated by provider signature — UNF-236/UNF-326 — never
  conflated with human auth per the ticket's own explicit rule) and `/health/linear` (an
  operational diagnostic, not a "normal command," kept off this surface to keep it narrow rather
  than because it's sensitive).
- **Reuse the extractor for the routes that need a new gate, don't duplicate its logic.**
  `/tasks*`/`/runs*`/`/reconcile`/`/safety/*` have no per-handler
  `AuthenticatedHumanIdentity` argument (unlike `/tools*`, UNF-391) — adding one would also gate
  them on the *original* router, breaking every existing unauthenticated-by-design internal/test
  caller of that router for no reason this ticket asks for. Instead, `http::auth::require_human_auth`
  is a `middleware::from_fn_with_state` wrapper that calls the exact same
  `AuthenticatedHumanIdentity::from_request_parts` the extractor uses and discards the result —
  one verification code path either way, applied via `route_layer` only on `public_router`'s copy
  of those routes. `/tools*` routes are mounted on `public_router` without this extra layer (they
  already self-authenticate per-handler); adding it too would silently double-verify every
  `/tools*` request against Linear.
- **An Elastic IP plus Caddy on the instance (UNF-459), not an AWS load balancer.**
  `deploy/terraform/public_api_ingress.tf` allocates an `aws_eip` associated with the existing
  instance (so `var.public_api_hostname`'s DNS record survives an instance replacement without a
  load balancer) and opens exactly one security-group rule (443, `0.0.0.0/0`, on the instance's own
  security group) — gated behind its own `enable_public_api_ingress` flag (default `false`),
  completely independent of `enable_webhook_ingress`/`webhook_ingress.tf`'s NLB. TLS termination is
  Caddy's own automatic HTTPS (ACME, TLS-ALPN-01 over 443 alone), running on the instance
  (`deploy/host/Caddyfile.tmpl`, wired into `deploy/host/install.sh`) and reverse-proxying only to
  `public_api.rs`'s narrow listener on loopback — never the full internal router. Chosen over an
  NLB (this file's first version) for cost: an Elastic IP is effectively free while attached to a
  running instance versus an NLB's ~$16-17/mo, and one low-traffic single-instance deployment gets
  nothing from AWS-managed TLS that Caddy doesn't already provide for free. `sgt admin` needed no
  Terraform change at all for the same reason `public_router` needs none for `/drain*`: UNF-392's
  SSM transport was never an HTTP route to begin with, and Caddy only ever proxies to
  `public_api.rs`'s own listener, so there is nothing on this ingress that could ever forward to
  `sgt admin` regardless of how this flag is set.

Rejected alternative: teaching `router`'s existing single port to apply Linear auth to
`/tasks*`/`/runs*`/`/reconcile`/`/safety/*` directly, and relying on auth alone (no route at all)
only for `/drain*`. This does work for "unauthenticated caller can't act," but conflates two
already-distinct concerns — "which network/port is this route mounted on" and "does this
particular request need a human identity" — onto one router, making the exclusion of `/drain*`
purely an auth-omission convention (easy to violate by accident on a future PR that adds a route)
rather than a structural fact a reviewer can see from the router's own route list. It would also
have required threading a real/fake `HumanIdentityVerifier` and bearer token through every existing
`http_tasks_query.rs`/`http_runs_query.rs`/`http_reconcile.rs`/`http_drain.rs` test that currently
calls `router(state_for(...))` unauthenticated, breaking dozens of passing tests for a change this
ticket doesn't actually require (those routes were never meant to be reachable outside the VPC/SSM
in the first place — only the *new* public listener needed the gate).

## Consequences

- A Linear-authenticated human with no AWS/SSM credentials can point a `sgt` installation profile
  (`~/.config/sergeant/config.toml`, UNF-390) at the new public hostname
  (`var.public_api_hostname`, default `sergeant.unforgotten.life` — UNF-459 fronts this with an
  Elastic IP and Caddy on the instance, on normal HTTPS/443, independent of any webhook ingress —
  see this ADR's "Decision" section — so this is the same URL every profile/onboarding example
  already used) and run `status`/`task`/`run`/`reconcile`/`resume`/`tool ...` — `sergeant-cli`'s
  `Client` already attaches the logged-in profile's bearer token to every request (UNF-391), so no
  CLI-side change was needed for this ticket at all.
  `/drain*`/`sgt admin` operations are unreachable through the new public listener regardless of
  auth state — there is no route there to reach.
- The original `bind_addr`/`router` pair is completely unchanged: every existing test, and any
  deployment that hasn't set `SERGEANT_PUBLIC_BIND_ADDR`, behaves exactly as before this ticket.
- **Not built (out of scope per the ticket's own simplification boundary)**: Sergeant API keys,
  a session mechanism distinct from the existing Linear OAuth credential, custom RBAC, or an
  AWS-authenticated path for ordinary (non-admin) commands. A Linear session is the only identity
  this surface ever asks for.
- **Real infrastructure apply is still a captain/firstmate action, not this ADR's.** Landing
  `public_api_ingress.tf` changes nothing about what a routine `terraform apply` provisions
  (`enable_public_api_ingress` defaults `false`) — same "code now, apply later, as its own
  deliberate step" split ADR-0027 already uses. UNF-459 also removed the sibling NLB-based webhook
  ingress design (`webhook_ingress.tf`) this ADR originally referenced, so there is now exactly one
  public-ingress architecture for the whole installation (Internet → Elastic IP → Caddy on :443 →
  explicitly allowed local Sergeant listeners) rather than two independently-gated ones — a future
  webhook receiver would be one more path-scoped Caddy route, not a second load balancer.
