# Sergeant agent guide

Sergeant 2 is the only implementation on `main`. All code lives in `v2/`; read
[`v2/AGENTS.md`](v2/AGENTS.md) before working there, and follow the design in
[`v2/docs/design/`](v2/docs/design/README.md).

- The design handoff and work tracking live in Linear, in the **Sergeant Control Plane** project
  (team UNF). Linear issues may be deleted once done, so a PR body must stand on its own.
- Sergeant 1 (Rust) is not on `main`; its final source is the tag `v1-final`. Never restore or
  depend on V1 code. `docs/adr/` holds Sergeant 1's decision records;
  `v2/docs/design/13-s1-supersession.md` says which still apply.
- CI is `.github/workflows/v2.yml`; it runs on changes under `v2/`.
- Expect other tasks to land in parallel. Rebase rather than merge, and never resolve a conflict
  by reverting a sibling's change.
