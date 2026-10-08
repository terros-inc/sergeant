# Act on the answers

Part of the [/sarge routine](../SKILL.md). Paths such as `scripts/` and `references/` are relative to the skill's directory.

- **Always answer inside Sergeant's own question thread** (`save_comment parentId=<question comment id>`), even when the real decision lives in a separate comment. Sergeant waits on its own thread.
- Budget asks: **don't recommend "extend" by reflex.** First ask: *Why are we looping? How long and how many review rounds has it taken? What requirement is driving the complexity? Is there a simpler solution?* Check the review telemetry (rounds, and the trend in blocking findings) and the PR's net size. **Repeated blocking findings in the same area usually mean the design is wrong, not that the work is nearly done.** In that case, recommend stopping, simplifying the ticket, and redoing it from main.
- Reply `Extend.` under the budget question only when the work is genuinely converging.
- **Big open PR on a budget ask** (roughly +500 lines or many files): don't recommend extend; kick off our review of the open PR first and present its verdict with the ask.
- **"Converge or cut"** is shorthand for this rule: extend what's converging; stop and simplify what's looping. If away words say "converge or cut", budget asks may be answered overnight by this rule. Never present a budget ask without the check already done.
- Known quirk, until TECH-5059 lands (answer = fresh window, no turn limit): replying to a task that has been waiting a long time often triggers an immediate "budget exhausted" question, because its window kept running while it waited. Expect it, and include it in the next batch.
- Cancels: set the Linear state to Canceled, and close the task's PR if Sergeant doesn't.
- Merges on repos where humans merge (sales, and Sergeant PRs authored by the operator's account) are the operator's. Give the full PR URL.
- **Verify, don't assume, who merged.** Every round, list Sergeant-authored PRs merged in sales (and any other human-merge repo) and check `mergedBy` (terros-wiki is Sergeant-merge since 2026-10-07 under the KB auto-merge rule, so bot merges there are expected): a merge by `app/terros-sergeant` in a human-merge repo is an incident to raise first in the report.
  - **Historical incident (2026-10-05):** A Sergeant PR ([sales#16051](https://github.com/terros-inc/sales/pull/16051)) self-merged to staging in a human-merge repo before the `mergePolicy` enforcement was in place. Earlier PRs (#16050, #16038, #16039) went unnoticed. Until TECH-5244 is deployed, never answer a Sergeant question on a sales PR in a way that lets it merge.
- Never delegate, cancel or reprioritize other engineers' Tech tickets. Only Sergeant work.
- Log each recommendation, its confidence and the operator's choice in the calibration log.
