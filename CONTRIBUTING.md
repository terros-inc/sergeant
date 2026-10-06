# Contributing to Sergeant

Thanks for your interest in contributing. This document covers the normal branch/PR contribution
flow. For the project's working rules, see [`AGENTS.md`](AGENTS.md).

## Getting the code

Fork the repository (or create a branch directly, if you have write access), then clone it and
create a topic branch for your change:

```bash
git clone <your-fork-or-this-repo-url>
cd sergeant
git checkout -b my-change
```

## Building and testing locally

Sergeant is a TypeScript workspace. It requires Node.js 24 (`.nvmrc`) and pnpm, pinned via
`packageManager` (`corepack enable`). From the repository root, run the same checks CI runs:

```bash
pnpm install
pnpm exec turbo boundaries
pnpm exec turbo run lint typecheck test
```

While iterating, scope checks to the package you're touching (for example
`pnpm exec turbo run test --filter=@terros/sergeant-contracts`) rather than running the full suite
on every edit.

## Repository layout

Packages live in `packages/*` under the `@terros/` scope; [`AGENTS.md`](AGENTS.md) explains the
one-way dependencies between them, and [`docs/design/`](docs/design/README.md) the architecture.

| Package | What it is |
|---|---|
| `packages/contracts` (`@terros/sergeant-contracts`) | Zod schemas for the conversation, Situation Report, run reports, proposed actions, and PR facts; the ports adapters implement; the pure merge Gate |
| `packages/reasoning` (`@terros/sergeant-reasoning`) | One fresh-context reasoning turn through the local `claude` CLI: Situation Report in, validated proposed actions out |
| `packages/linear`, `packages/github` (`@terros/sergeant-linear`, `-github`) | Live Linear and GitHub adapters, and GitHub App installation tokens for the control-plane and worker Apps |
| `packages/runner` (`@terros/sergeant-runner`) | The primary worker and fresh-context reviewer runs ([`packages/runner/README.md`](packages/runner/README.md)) |
| `packages/sergeant` (`@terros/sergeant`) | The app: executes proposed actions through the Gate against the ports; the per-task loop; and `serve`, the long-running service with its client API ([`deploy/README.md`](deploy/README.md)) |
| `packages/cli` (`@terros/sergeant-cli`) | `sgt`, a thin client of that API ([`docs/sgt.md`](docs/sgt.md)) |
| `packages/mcp` (`@terros/sergeant-mcp`) | `sgt-mcp`, a read-only MCP server over stdio, another thin client of that API |

The root `package.json` also has shortcuts: `pnpm lint` (oxlint), `pnpm typecheck` (strict `tsc`), and
`pnpm test` (Vitest), each through Turborepo. The manual live commands (`live-check`, `canary`,
`serve`) never run from tests or CI; they are described in [`deploy/README.md`](deploy/README.md)
under Reference.

## Opening a pull request

1. Push your branch and open a pull request against `main`.
2. Describe what changed and why; link any related issue if one exists.
3. Make sure CI is green — `.github/workflows/v2.yml` runs the checks above on every pull
   request.
4. Respond to review feedback with additional commits on the same branch; there's no need to
   force-push or squash until a maintainer asks for it.

## Code of conduct

Be respectful and constructive. There's no separate code-of-conduct document yet; standard
open-source etiquette applies.
