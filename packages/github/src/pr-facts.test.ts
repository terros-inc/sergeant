import { expect, test, vi } from "vitest";
import { createGitHubPort } from "./github.ts";

const head = "a".repeat(40);
const repo = "o/r";
const pr = {
  number: 7,
  html_url: `https://github.com/${repo}/pull/7`,
  user: { login: "sergeant-worker[bot]" },
  body: "Fixes TECH-1",
  state: "open",
  draft: false,
  merged_at: null,
  mergeable: true,
  merge_commit_sha: null,
  head: { sha: head },
  base: { ref: "main", sha: "b".repeat(40) },
};

const read = (live: Record<string, unknown>) => {
  const fetch = async (input: string | URL | Request) => {
    const path = String(input);
    if (path.endsWith("/pulls/7")) return Response.json({ ...pr, ...live });
    if (path.includes("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
    if (path.endsWith("/status?per_page=100")) return Response.json({ state: "success", total_count: 0, statuses: [] });
    if (path.includes("/protection/")) return Response.json({ message: "Not Found" }, { status: 404 });
    if (/\/rules\/branches\/main\?|\/(reviews|comments|files)\?per_page=100&page=1$/.test(path)) return Response.json([]);
    throw new Error(`unexpected request: ${path}`);
  };
  return createGitHubPort({ token: async () => "test", repositories: { [repo]: { mergeMethod: "squash" } }, fetch }).readPullRequest(repo, 7);
};

// M7 reads mergeable_state (TECH-5013). A value GitHub adds later, or one it leaves out, must read as
// still computing, so M7 waits rather than merging or failing the poll that reads it.
test.each(["clean", "unstable", "behind", "blocked", "dirty", "draft", "has_hooks", "unknown"])("reads mergeable_state %s", async (state) => {
  expect(await read({ mergeable_state: state })).toMatchObject({ mergeable: true, mergeableState: state });
});

test.each([
  ["missing", {}],
  ["null", { mergeable_state: null }],
  ["one GitHub adds later", { mergeable_state: "queued" }],
])("reads a %s mergeable_state as unknown", async (_, live) => {
  expect((await read(live)).mergeableState).toBe("unknown");
});

// TECH-6165: submitting a review did not move the PR's `updated_at`, so the poll the review's webhook
// woke reused the feedback remembered from before it, and the review went unanswered. The webhook drops
// that memory, so the woken read rereads it at once, without waiting, and a read already under way when
// the webhook came does not put its older feedback back.
test("a webhook's review or comment is read though updated_at did not move, and an overtaken read is not remembered", async () => {
  let reviews: object[] = [];
  let reviewReads = 0;
  let hold: Promise<void> | undefined;
  const fetch = async (input: string | URL | Request) => {
    const path = String(input);
    if (path.endsWith("/pulls/7")) return Response.json({ ...pr, updated_at: "2026-10-16T03:00:00Z" });
    if (path.includes("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
    if (path.endsWith("/status?per_page=100")) return Response.json({ state: "success", total_count: 0, statuses: [] });
    if (path.includes("/protection/")) return Response.json({ message: "Not Found" }, { status: 404 });
    if (path.includes("/reviews?")) {
      reviewReads++;
      const listed = reviews;
      await hold;
      return Response.json(listed);
    }
    if (/\/rules\/branches\/main\?|\/(comments|files)\?per_page=100&page=1$/.test(path)) return Response.json([]);
    throw new Error(`unexpected request: ${path}`);
  };
  const port = createGitHubPort({ token: async () => "test", repositories: { [repo]: { mergeMethod: "squash" } }, fetch });
  const ids = async () => (await port.readPullRequest(repo, 7)).humanFeedback.map((f) => f.id);
  const review = { id: 41, user: { login: "captain", type: "User" }, state: "CHANGES_REQUESTED", body: "Rename the flag.", commit_id: head, submitted_at: "2026-10-16T03:07:00Z", html_url: `https://github.com/${repo}/pull/7#pullrequestreview-41` };

  expect(await ids()).toEqual([]);
  reviews = [review];
  // Nothing announced it, and `updated_at` is unchanged: the remembered feedback stands.
  expect(await ids()).toEqual([]);
  expect(reviewReads).toBe(1);

  // The webhook drops the memo (a repository named in another case too): the next read rereads.
  port.forgetFeedback?.("O/R", 7);
  const woken = Date.now();
  expect(await ids()).toEqual(["review:41"]);
  expect(reviewReads).toBe(2);
  // It does not wait for GitHub to catch up first (an earlier fix slept 5 seconds before a second read).
  expect(Date.now() - woken).toBeLessThan(1_000);
  // Read once, and remembered again.
  expect(await ids()).toEqual(["review:41"]);
  expect(reviewReads).toBe(2);

  // A read lists the reviews before a second review; its webhook comes while that read is still under way.
  port.forgetFeedback?.(repo, 7);
  let release = () => {};
  hold = new Promise((resolve) => (release = resolve));
  const overtaken = ids();
  await vi.waitFor(() => expect(reviewReads).toBe(3));
  reviews = [review, { ...review, id: 42, submitted_at: "2026-10-16T03:08:00Z" }];
  port.forgetFeedback?.(repo, 7);
  release();
  hold = undefined;
  expect(await overtaken).toEqual(["review:41"]);
  // It did not remember what it read: the next read rereads and finds the second review.
  expect(await ids()).toEqual(["review:41", "review:42"]);
  expect(reviewReads).toBe(4);
});

// TECH-6553: the tier comes from the map at the PR's own head, so a PR that edits the map, or a base
// that has one the head lacks, is judged by what would merge; a map GitHub fails to return is T3.
test("the PR's review tier is read from the tier map at its head", async () => {
  const tierAt = async (contents: (ref: string) => Response) => {
    const fetch = async (input: string | URL | Request) => {
      const path = String(input);
      const ref = /\/contents\/\.github\/review-tiers\.yml\?ref=(\w+)$/.exec(path)?.[1];
      if (ref) return contents(ref);
      if (path.endsWith("/pulls/7")) return Response.json(pr);
      if (path.includes("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (path.endsWith("/status?per_page=100")) return Response.json({ state: "success", total_count: 0, statuses: [] });
      if (path.includes("/protection/")) return Response.json({ message: "Not Found" }, { status: 404 });
      if (path.includes("/files?")) return Response.json([{ filename: "docs/a.md" }]);
      if (/\/rules\/branches\/main\?|\/(reviews|comments)\?per_page=100&page=1$/.test(path)) return Response.json([]);
      throw new Error(`unexpected request: ${path}`);
    };
    return (await createGitHubPort({ token: async () => "test", repositories: { [repo]: { mergeMethod: "squash" } }, fetch }).readPullRequest(repo, 7)).reviewTier;
  };
  const yaml = (text: string) => Response.json({ type: "file", encoding: "base64", content: Buffer.from(text).toString("base64") });
  const map = "humanTeam: reviewers\ntiers:\n  T0:\n    - docs/**\n";
  expect(await tierAt((ref) => (ref === head ? yaml(map) : Response.json({ message: "Not Found" }, { status: 404 })))).toEqual({
    tier: "T0",
    rule: "`docs/a.md` matches T0 pattern `docs/**`",
    humanTeam: "reviewers",
  });
  expect(await tierAt(() => Response.json({ message: "Not Found" }, { status: 404 }))).toMatchObject({ tier: "T3", rule: expect.stringContaining("no tier map") });
  expect(await tierAt(() => Response.json({ message: "Server Error" }, { status: 500 }))).toMatchObject({ tier: "T3", rule: expect.stringContaining("could not be read") });
});
