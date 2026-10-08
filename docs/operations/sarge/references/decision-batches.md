# Decisions: batches

Part of the [/sarge routine](../SKILL.md). Paths such as `scripts/` and `references/` are relative to the skill's directory.

- A batch is **about 4 items total**, mixing returned review findings and ticket decisions, so it always feels short. Rank fresh at the start of each batch; don't re-rank mid-batch. Whatever doesn't fit waits for the next batch.
- **Rank:** what unblocks the most work first (a PR other PRs are stacked on, a High/Urgent task), then priority, then age.
- **Group** tickets that share one root decision into a single item (e.g. several PRs stacked on the same unmerged PR, or several budget asks).
- Each item: the ticket, its **Linear and GitHub links**, where it stands in 1–3 lines, letter-labeled options (A1, A2, ...), **a recommendation**, and **"Confidence you'll agree: High/Medium/Low"** plus what would change it.
- **Label options with letters continuing across messages**: A1, A2, A3 in the first batch, then B1, B2 in the second batch, C1, C2, C3 in the third, and so on. This makes it easy to refer back to earlier decisions.
- Present the batch as a compact table. The operator answers in one line (e.g. `A1 yes · A2 A3 · A3 wait · A4 hold`).
- **Fill the batch from the Backlog when Sergeant has nothing to ask.** If no in-progress question, budget ask or PR review finding is waiting on the operator, use the rest of the batch on open Backlog/priority questions: an item whose only blocker is a decision ("decide first", a price table, an enforcement point, a confirmation), a Backlog item that may now have clear requirements (promote to Todo with a rubric priority), or a priority that looks wrong under the rubric. Each one framed so the answer turns it into Todo work or a cancel. Never end a round with "nothing to decide" while such items exist.
- At the end of a batch, offer the next one or stop.
