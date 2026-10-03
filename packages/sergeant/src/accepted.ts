import { readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DelegatedIssue } from "@terros/sergeant-linear";

// TECH-5118: a task a human accepted as it is stays ended. Its loop sets `state.json` aside, so intake
// resumes it no more, and leaves `accepted.json` beside it, since the issue stays delegated: in Todo,
// intake would otherwise start it again as new work and ask the budget question again. The marker
// holds while the issue stays delegated and in Todo. A human re-triggers the task the way they would
// any issue, and the marker is cleared at the first intake that sees it: the issue moved out of Todo
// (to In Progress or Backlog, say) or no longer delegated or open, or `sgt task wake`. Back in Todo,
// it then starts a fresh task, as after a stop. A comment alone re-triggers nothing, since a "thanks"
// after the acceptance is not a request for more work.

const markerFile = (dir: string) => join(dir, "accepted.json");

/** Records that a human accepted the task in `dir` as it is; written before `state.json` is set aside. */
export const markAccepted = (dir: string, at: string) => writeFile(markerFile(dir), JSON.stringify({ at }));

/**
 * The tasks a human accepted whose issue is still delegated and in Todo, so intake starts none of them.
 * Every other acceptance is cleared: the human moved the issue or woke the task since.
 */
export async function heldAcceptances(
  stateDir: string,
  listed: DelegatedIssue[],
  woken: (ref: string) => boolean,
  log: (line: string) => void,
): Promise<Set<string>> {
  const held = new Set<string>();
  for (const ref of await readdir(join(stateDir, "tasks")).catch(() => [])) {
    const file = markerFile(join(stateDir, "tasks", ref));
    if (!(await stat(file).then(() => true, () => false))) continue;
    const issue = listed.find((i) => i.identifier === ref);
    if (issue?.state.type === "unstarted" && !woken(ref)) {
      held.add(ref);
      continue;
    }
    await rm(file, { force: true });
    const why = woken(ref) ? "the task was woken" : issue ? `the issue moved to ${issue.state.name}` : "the issue is no longer delegated and open";
    log(`${ref}: accepted as it is earlier; ${why}, so in Todo it starts a fresh task`);
  }
  return held;
}
