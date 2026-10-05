// The one redaction every failure detail a run record stores goes through (TECH-5254): a record reaches
// `sgt run show`, logs and Linear comments, so it never holds a model credential a provider error quotes.
//
// The shapes, checked against Codex CLI 0.160.0's source (`codex-rs/login/src/token_data.rs`): an
// `auth.json`'s `access_token` and `id_token` are JWTs (`eyJ…`); its `refresh_token` is an opaque
// string, which ChatGPT issues as `rt.1.…` (an `rt_…` spelling is covered too). Since the refresh
// token's shape is the provider's to change, a value quoted under one of those field names is
// redacted whatever its shape. OpenAI API keys are `sk-…`, and their errors quote them masked
// (`sk-proj***abcd`). Redacting twice changes nothing.
const SECRETS: [RegExp, string][] = [
  [/((?:access|refresh|id)_token\\?["']?\s*[:=]\s*\\?["']?)[^\s"'\\,;&)}[\]]+/gi, "$1[redacted]"],
  [/\beyJ[\w-]*(?:\.[\w-]*)*/g, "[redacted JWT]"],
  [/\brt[._][\w.~+/=-]{8,}/g, "[redacted refresh token]"],
  [/\bsk-[\w*.-]+/g, "sk-[redacted]"],
];

/** `text` with every access token, refresh token and API key it quotes replaced. */
export const redactSecrets = (text: string) => SECRETS.reduce((t, [shape, replacement]) => t.replace(shape, replacement), text);
