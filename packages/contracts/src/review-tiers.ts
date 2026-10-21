import { z } from "zod";
import { protectedCiFiles } from "./protected-ci.ts";

// TECH-6553: a repository's sensitivity tiers, T0 (trivial) to T4 (critical), from its tier map at the
// PR head (06 §6a). Classification fails closed: whatever Sergeant cannot read or does not understand
// is T3, a human handoff, never a lower tier.

export const ReviewTier = z.enum(["T0", "T1", "T2", "T3", "T4"]);
export type ReviewTier = z.infer<typeof ReviewTier>;

/** Where a repository keeps its tier map; a PR that changes it is T4, since the map is itself a control. */
export const TIER_MAP_PATH = ".github/review-tiers.yml";

/** A PR head's tier, the rule that set it, and the map's `humanTeam` when it has one. */
export const ReviewTierFacts = z.object({ tier: ReviewTier, rule: z.string().min(1), humanTeam: z.string().min(1).optional() });
export type ReviewTierFacts = z.infer<typeof ReviewTierFacts>;

/**
 * A path glob: `**` spans directories, `*` and `?` stay within one, and the pattern is matched against
 * the whole repository-relative path. Brace sets, character classes, negation, and a leading `/` are
 * refused rather than read literally: a T3 pattern that silently matched nothing would lower a tier.
 */
const Glob = z
  .string()
  .min(1)
  .refine((g) => !/[{}[\]!\\]/.test(g) && !g.startsWith("/"), "a pattern may use only `**`, `*` and `?`, and no leading `/`");

/** `.github/review-tiers.yml` once parsed: glob lists per tier. Unknown keys make it invalid (a typo must not drop a rule). */
export const TierMap = z.strictObject({
  humanTeam: z.string().min(1).optional(),
  tiers: z.strictObject(Object.fromEntries(ReviewTier.options.map((t) => [t, z.array(Glob).optional()])) as Record<ReviewTier, z.ZodOptional<z.ZodArray<typeof Glob>>>),
});
export type TierMap = z.infer<typeof TierMap>;

/** The map as the adapter read it at the PR head: absent (404), unreadable (any other failure), or the parsed document. */
export type TierMapRead = { kind: "absent" } | { kind: "unreadable"; reason: string } | { kind: "parsed"; document: unknown };

const order = (t: ReviewTier) => ReviewTier.options.indexOf(t);
export const tierAtLeast = (t: ReviewTier, floor: ReviewTier) => order(t) >= order(floor);

export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob.charAt(i);
    if (c === "*" && glob[i + 1] === "*") {
      // `**/` may match no directory at all, so `**/*.md` covers a root README.md.
      const slash = glob[i + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else source += c.replace(/[.+^$()|]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/**
 * The PR's tier from its changed files and the map at its head (TECH-6553): the highest tier any
 * changed file gets, a file matching several patterns taking the highest, an unlisted file T2. No map
 * is T3 throughout; an unreadable file list or an unreadable or invalid map is T3. A change to the map
 * is T4, and protected CI configuration (M15) is at least T3 whatever the map says. Ties keep the
 * first rule found, so the rule named is stable for the same input.
 */
export function classifyTier(changedFiles: string[] | undefined, read: TierMapRead): ReviewTierFacts {
  const found: { tier: ReviewTier; rule: string }[] = [];
  if (!changedFiles) found.push({ tier: "T3", rule: "the PR's changed files could not be read, so it fails closed" });
  const files = changedFiles ?? [];
  if (files.includes(TIER_MAP_PATH)) found.push({ tier: "T4", rule: `the PR changes the tier map \`${TIER_MAP_PATH}\`` });
  for (const file of changedFiles ? protectedCiFiles({ changedFiles }) : []) found.push({ tier: "T3", rule: `\`${file}\` is protected CI configuration (M15), at least T3` });

  let map: TierMap | undefined;
  if (read.kind === "absent") found.push({ tier: "T3", rule: `the repository has no tier map (\`${TIER_MAP_PATH}\`) at the PR head` });
  else if (read.kind === "unreadable") found.push({ tier: "T3", rule: `the tier map could not be read (${read.reason}), so it fails closed` });
  else {
    const parsed = TierMap.safeParse(read.document);
    if (parsed.success) map = parsed.data;
    else found.push({ tier: "T3", rule: `the tier map is invalid (${z.prettifyError(parsed.error).replace(/\s+/g, " ").trim()}), so it fails closed` });
  }

  if (map) {
    const patterns = ReviewTier.options.flatMap((tier) => (map.tiers[tier] ?? []).map((glob) => ({ tier, glob, re: globToRegExp(glob) })));
    for (const file of files) {
      const hits = patterns.filter((p) => p.re.test(file));
      const top = hits.reduce<(typeof hits)[number] | undefined>((a, b) => (!a || order(b.tier) > order(a.tier) ? b : a), undefined);
      found.push(top ? { tier: top.tier, rule: `\`${file}\` matches ${top.tier} pattern \`${top.glob}\`` } : { tier: "T2", rule: `\`${file}\` is not listed in the tier map, so it is T2` });
    }
    if (changedFiles?.length === 0) found.push({ tier: "T2", rule: "the PR changes no files; the default for unlisted paths is T2" });
  }

  const top = found.reduce((a, b) => (order(b.tier) > order(a.tier) ? b : a));
  return { ...top, ...(map?.humanTeam && { humanTeam: map.humanTeam }) };
}
