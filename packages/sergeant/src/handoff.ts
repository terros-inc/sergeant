import type { LinearPort, RefusedMerge } from "@terros/sergeant-contracts";

// TECH-4987: a merge GitHub refuses by repository policy (a code-owner review Sergeant cannot give,
// say) is not retried while nothing changes (M12). Sergeant says once, on the issue, that the PR is
// ready for a human to merge, and waits; a human merge is then a fact like any other. A merge call
// that fails twice with nothing changed waits the same way (TECH-5077).

/** Once per PR head: the comment's id is derived from this key, so a retry posts nothing new. */
export const handoffKey = (issueId: string, r: RefusedMerge) => `merge-handoff:${issueId}:${r.repo}#${r.number}:${r.headSha}`;

export function handoffComment(r: RefusedMerge): string {
  const ready = `[${r.repo}#${r.number}](${r.url}) at head \`${r.headSha}\` is reviewed and its required checks are green`;
  // TECH-5244: a human-merge repository's head was never approved or merged; it was handed over.
  if (r.human) {
    const asked = r.human.requested.length > 0 ? `Review is requested from ${r.human.requested.join(", ")}.` : "GitHub shows nobody's review requested on it.";
    return [
      "**Ready for a human to merge**",
      "",
      `${ready}. This repository's merge policy is \`human\`, so Sergeant did not approve or merge it. ${asked}`,
      "",
      r.human.summary,
      "",
      "A human merges it. Sergeant acts on a review requesting changes or a comment on the PR, and finishes the task once it is merged.",
    ].join("\n");
  }
  if (r.humanFailure) {
    return [
      "**Human handoff needs manual help**",
      "",
      `${ready}, but Sergeant failed twice at the **${r.humanFailure}** step: ${r.reason.trim()}`,
      "",
      "The PR is ready for a human to take over the handoff by hand. Sergeant won't try again unless the PR, its reviews, or this issue change.",
    ].join("\n");
  }
  // TECH-5090: a merge call that failed twice with nothing changed is handed over too (TECH-5077); no
  // policy blocked it, so the comment must not say GitHub refused it or that the repository needs a human.
  const [why, who] = r.temporary
    ? [`, but Sergeant's merge failed twice with nothing changing in between: ${r.reason.trim()}`, "A human can merge it."]
    : [`, but GitHub refused Sergeant's merge: ${r.reason.trim()}`, "This repository needs a human to merge it."];
  return ["**Ready for a human to merge**", "", ready + why, "", `${who} Sergeant won't try again unless the PR, its reviews, or this issue change.`].join("\n");
}

/** Posts a refusal's comment, at most once however often it is retried; false if Linear failed. */
export async function postHandoff(issueId: string, r: RefusedMerge, linear: Pick<LinearPort, "postComment">, log: (line: string) => void): Promise<boolean> {
  const description = r.humanFailure ? "posted that its human handoff needs manual help" : "posted that it is ready for a human to merge";
  return linear.postComment({ issueId, body: handoffComment(r), key: handoffKey(issueId, r) }).then(
    () => (log(`${r.repo}#${r.number}: ${description}`), true),
    (e: Error) => (log(`${r.repo}#${r.number}: handoff comment not posted: ${e.message}`), false),
  );
}
