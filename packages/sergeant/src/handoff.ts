import type { LinearPort, RefusedMerge } from "@terros/sergeant-contracts";

// TECH-4987: a merge GitHub refuses by repository policy (a code-owner review Sergeant cannot give,
// say) is not retried while nothing changes (M12). Sergeant says once, on the issue, that the PR is
// ready for a human to merge, and waits; a human merge is then a fact like any other.

/** Once per PR head: the comment's id is derived from this key, so a retry posts nothing new. */
export const handoffKey = (issueId: string, r: RefusedMerge) => `merge-handoff:${issueId}:${r.repo}#${r.number}:${r.headSha}`;

export function handoffComment(r: RefusedMerge): string {
  return [
    "**Ready for a human to merge**",
    "",
    `[${r.repo}#${r.number}](${r.url}) at head \`${r.headSha}\` is reviewed and its required checks are green, but GitHub refused Sergeant's merge: ${r.reason.trim()}`,
    "",
    "This repository needs a human to merge it. Sergeant won't try again unless the PR, its reviews, or this issue change.",
  ].join("\n");
}

/** Posts a refusal's comment, at most once however often it is retried; false if Linear failed. */
export async function postHandoff(issueId: string, r: RefusedMerge, linear: Pick<LinearPort, "postComment">, log: (line: string) => void): Promise<boolean> {
  return linear.postComment({ issueId, body: handoffComment(r), key: handoffKey(issueId, r) }).then(
    () => (log(`${r.repo}#${r.number}: posted that it is ready for a human to merge`), true),
    (e: Error) => (log(`${r.repo}#${r.number}: ready-for-human-merge comment not posted: ${e.message}`), false),
  );
}
