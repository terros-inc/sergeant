# Sergeant

<img src="docs/assets/sergeant-logo.png" alt="Sergeant logo" width="160" />

Sergeant supervises AI engineering work. A Linear issue delegated to Sergeant becomes merged code
or a clear question back on the issue, without a human driving each step: Sergeant's reasoning
reads the issue, GitHub, and run state; briefs one primary worker to do the engineering; starts a
separate fresh-context reviewer when the change warrants it; asks a human only for genuine
judgment; and merges through a deterministic Gate.

This is Sergeant 2. It lives in [`v2/`](v2/), a TypeScript workspace (pnpm, Turborepo, oxlint,
Vitest), and is currently a walking skeleton that implements only what a ticket has asked for.

- [`v2/README.md`](v2/README.md) — packages, commands, and the manual live check and canary loop.
- [`v2/AGENTS.md`](v2/AGENTS.md) — the guide for agents and contributors working in `v2/`.
- [`v2/docs/design/`](v2/docs/design/README.md) — the Sergeant 2 architecture.
- [`docs/adr/`](docs/adr/) — architectural decision records from Sergeant 1; the V2 design
  (`v2/docs/design/13-s1-supersession.md`) says which it keeps, changes, or abandons.

## Sergeant 1

Sergeant 1, the Rust implementation, has been removed from `main`. Its final source is the annotated
tag `v1-final` (`git switch --detach v1-final`), and its last installable release is
`v0.1.0+aad6046`. Its code, deploy tooling, runbooks, and documentation all live there.

## License

Sergeant is open source, licensed under the [Apache License 2.0](LICENSE).

Copyright 2026 Terros Inc.

## Support

For contributions, see [CONTRIBUTING.md](CONTRIBUTING.md). To report a security vulnerability, see
[SECURITY.md](SECURITY.md).
