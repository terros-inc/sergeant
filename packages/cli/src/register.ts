import { type ApiError, type Provider, REVOKE, type WhoAmI } from "@terros/sergeant-contracts";

// What `sgt account register` tells a person around the provider's sign-in (TECH-5202): before it,
// why this Sergeant would refuse the account, so no credential is made for nothing; after a failed
// registration once one was made, what to do with that credential. Plain English, naming no config.

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

/**
 * After a sign-in made a credential that registering failed to keep: how to reuse or revoke it. A Codex
 * login has no copy left here to revoke: sgt deleted its own, and `sgt account remove` removes one
 * Sergeant stored and says what that leaves.
 * `refused`: the server refused it, before storing anything. Otherwise (unreachable, an unreadable
 * answer, the store failing) it may have been registered after all, and an account listed under the
 * name cannot say whether it is this one or the one it would have replaced. Registering under the
 * same name replaces it, so registering again is safe either way.
 */
export function strandedNotice(provider: Provider, name: string, refused: boolean): string {
  const again = `sgt account register ${provider} --name ${name}`;
  if (provider === "codex") {
    const relogin = `\`${again}\` signs in again`;
    return refused
      ? `${name} was not registered. sgt deleted its copy of the Codex login and Sergeant stored none, so no copy of it is left: ${relogin}.`
      : `sgt cannot tell whether ${name} was registered, and it deleted its copy of the Codex login. ` +
          `Once Sergeant answers, ${relogin} and replaces whatever ${name} holds; to not use it at all, \`sgt account remove ${name}\`.`;
  }
  const pipe = `copy it from above and pipe it in, on a Mac: \`pbpaste | ${again}\``;
  return refused
    ? `${name} was not registered. The token \`claude setup-token\` just made stays valid for a year and sgt kept no copy. ` +
        `To register it without making another, ${pipe}; otherwise revoke it. ${REVOKE.claude}`
    : `sgt cannot tell whether ${name} was registered. Once Sergeant answers, register the same token again: ${pipe}. ` +
        `Registering under ${name} replaces whatever it holds, so that is safe either way. To not use it at all, revoke it. ${REVOKE.claude}`;
}
