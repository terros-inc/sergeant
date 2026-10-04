import type { ApiError, Provider, WhoAmI } from "@terros/sergeant-contracts";

// What `sgt account register` tells a person around the provider's sign-in (TECH-5202): before it,
// why this Sergeant would refuse the account, so no credential is made for nothing; after a refusal
// that came once one was made, what to do with that credential. Plain English, naming no config.

const NAME: Record<Provider, string> = { claude: "Claude", codex: "Codex" };

/** Why the server would refuse `provider` from this caller, or undefined when it takes it. */
export function registrationRefusal(me: WhoAmI, provider: Provider): { code: ApiError["error"]["code"]; message: string } | undefined {
  if (!me.user) return { code: "forbidden", message: "an account is registered by its own person: sign in with `sgt login`" };
  const ask = `Ask an approver${me.approvers.length ? ` (${me.approvers.join(" or ")})` : ""}`;
  const { providers } = me.registration;
  if (providers.length === 0) return { code: "bad_request", message: `This Sergeant isn't set up for account registration yet. ${ask} to enable it.` };
  if (!providers.includes(provider)) {
    const takes = providers.map((p) => NAME[p]).join(" and ");
    return { code: "bad_request", message: `This Sergeant doesn't run ${NAME[provider]} accounts, only ${takes}. ${ask} if you need ${NAME[provider]}.` };
  }
  return undefined;
}

/** After a sign-in made a credential that registering then failed to keep: where it is, and how to reuse or revoke it. */
export function strandedNotice(provider: Provider, name: string): string {
  if (provider === "codex") return "The Codex login sgt made was not registered and is kept nowhere (sgt deleted it), so there is nothing to reuse or revoke.";
  const command = `sgt account register claude --name ${name}`;
  return (
    "The token `claude setup-token` just made was not registered, and sgt kept no copy; it stays valid for a year. " +
    `To register it without making another, copy it from above and pipe it in, on a Mac: \`pbpaste | ${command}\`. ` +
    "Otherwise revoke it: in your claude.ai settings, revoke the token `claude setup-token` made (the Claude Code section lists them)."
  );
}
