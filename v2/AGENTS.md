# Sergeant 2 agent guide

- This is the isolated Sergeant 2 TypeScript workspace. Never import or depend on V1 (the Rust
  crates, SQLite, or the V1 runtime) outside `v2/`.
- Implementation follows `docs/design/`. Build its features only when a current ticket asks for them.
- Node LTS from `.nvmrc`; pnpm pinned via `packageManager` (`corepack enable`).
- Strict TypeScript, oxlint for linting, Vitest for tests, Turborepo for tasks.
- Packages live in `packages/*` and use the `@terros/` scope. Dependencies point one way, enforced
  by `turbo boundaries` through each package's `turbo.json` tag: `contracts` (Zod schemas, ports,
  the pure Gate) depends on no internal package; `adapter` packages (reasoning, linear, github,
  runner) depend only on contracts; the `app` package (`@terros/sergeant`) wires them, and nothing
  depends on it. Packages export their TypeScript source directly (`.ts` imports, no build step).
- Tests live next to the source they test as `*.test.ts`, never in a separate `test/` folder.

## Simplicity principle

Sergeant 2 is deliberately the smallest system that can supervise AI engineering work.

- Add deterministic machinery (persisted state, gates, leases, recovery, sync) only when a failure
  could cause material harm Sergeant must prevent: an unreviewed or red merge; production, admin,
  personal, or control-plane authority reaching a run; runaway time or concurrency; or a silently
  abandoned human decision.
- Otherwise prefer rereading authoritative state (Linear, GitHub, runners), another reasoning turn, a
  retry, or redoing some work. Occasional duplicated agent work is acceptable.
- Prefer boring, readable code and small interfaces. Don't port a Sergeant 1 abstraction merely
  because it exists, or build a future design-package feature before a current task needs it.
- Don't encode semantic judgment in code, and don't build phase/state machines or workflow engines.
- When unsure, ask "what happens if we lose it?". Detail: `docs/design/00-charter.md`.

## Implementation judgment

- Deliver the smallest coherent change that meets the ticket and fits the design in `docs/design/`.
  Don't add speculative infrastructure, abstractions, compatibility, or adjacent features.
- When uncertain, prefer the smallest reversible implementation.
- Make ordinary implementation decisions autonomously. Escalate only genuine product or architecture
  choices that the ticket and design do not settle, and continue any work they do not block.

## Testing

- Validate in proportion to the change and its risks. There is no blanket requirement that every
  change add a test, and there is no coverage target.
- Every nontrivial test should answer: "What realistic regression or subtle failure does this protect
  us from?" Focused tests are right at deterministic boundaries where a bug could cause material harm.
- Prefer high-value boundary and integration tests—and the real canary or integration path when it
  gives stronger confidence—over piles of tiny unit tests or mocks of mocks.
- Use TDD for genuinely complex algorithms or state logic, but first ask whether a simpler design can
  avoid that complexity. A large unit-test matrix is a reason to simplify the implementation.
- Don't test getters, constructors, trivial wrappers, obvious branches, schema wiring, implementation
  details, or other code solely for coverage. Reviewers may delete test code whose cost exceeds its
  protection. Documentation-only and mechanical changes may need no tests.
- During development, run the narrowest relevant test or package task. CI runs the full suite; don't
  run it repeatedly. Record checks actually observed and report anything the environment cannot verify.
- Tests run by CI must not call live services, require real credentials, or launch externally visible
  applications. Keep explicit local-process and deployed smoke tests outside the ordinary unit suite.

## Commands (from `v2/`)

```sh
pnpm install
pnpm exec turbo boundaries && pnpm exec turbo run lint typecheck test   # what CI runs
pnpm exec turbo run test --filter=@terros/sergeant-contracts             # one package
```
