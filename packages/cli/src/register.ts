import { type ApiError, type Provider, REVOKE, type WhoAmI } from "@terros/sergeant-contracts";

// What `sgt account register` tells a person around the provider's sign-in (TECH-5202): before it,
// why this Sergeant would refuse the account, so no credential is made for nothing; after a failed
// registration once one was made, what to do with that credential. Plain English, naming no config.

const NAME: Record<Provider, string> = { claude: "Claude", codex: "Codex" };
/** What the person signs in to with each provider. */
const LOGIN: Record<Provider, string> = { claude: "Claude", codex: "ChatGPT" };

/**
 * TECH-5215: before any sign-in, whose Sergeant account the new one is registered under, so a
 * provider login under a different email is not mistaken for the wrong account.
 */
export function registeringFor(me: WhoAmI, provider: Provider, name: string): string {
  const who = me.user ? `${me.user.name} (${me.user.email}, via Linear)` : "a host operator";
  return `Signed in to Sergeant as ${who}. Registering a ${NAME[provider]} account for you as ${name}.`;
}

/** TECH-5215: the provider account just registered, by its own email when the credential carries one, never the Linear one. */
export function registeredLine(verb: "registered" | "replaced", name: string, provider: Provider, email: string | undefined, quota: string): string {
  return `${verb} ${name}: ${LOGIN[provider]} account${email ? ` ${email}` : ""}, ${quota}.`;
}

/**
 * The email of the login a credential belongs to, read locally, or undefined. A Codex auth.json's
 * `tokens.id_token` is a JWT whose payload names it; only the payload is decoded, the signature is not
 * checked, and nothing else of the credential is returned. A Claude setup token carries none.
 */
export function providerEmail(provider: Provider, credential: string): string | undefined {
  if (provider !== "codex") return undefined;
  try {
    const idToken: unknown = JSON.parse(credential)?.tokens?.id_token;
    if (typeof idToken !== "string") return undefined;
    const payload = idToken.split(".")[1];
    if (!payload) return undefined;
    const email: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))?.email;
    // Printed to a terminal: only a plain address, nothing that could carry control characters.
    return typeof email === "string" && email.length <= 254 && /^[!-~]+@[!-~]+$/.test(email) ? email : undefined;
  } catch {
    return undefined;
  }
}

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
 * After a sign-in made a credential that registering failed to keep: how to reuse or revoke it.
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
      ? `${name} was not registered. sgt deleted its copy of the Codex login, so it cannot be reused: ${relogin}. The login itself stays valid with OpenAI until you revoke it: ${REVOKE.codex}.`
      : `sgt cannot tell whether ${name} was registered, and it deleted its copy of the Codex login, so revoke that login: ${REVOKE.codex}. ` +
          `Then, once Sergeant answers, ${relogin} and replaces whatever ${name} holds.`;
  }
  const pipe = `copy it from above and pipe it in, on a Mac: \`pbpaste | ${again}\``;
  return refused
    ? `${name} was not registered. The token \`claude setup-token\` just made stays valid for a year and sgt kept no copy. ` +
        `To register it without making another, ${pipe}. Otherwise revoke it: ${REVOKE.claude}.`
    : `sgt cannot tell whether ${name} was registered. Once Sergeant answers, register the same token again: ${pipe}. ` +
        `Registering under ${name} replaces whatever it holds, so that is safe either way. To not use it at all, revoke it: ${REVOKE.claude}.`;
}
