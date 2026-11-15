/**
 * FeedbackKit tokens (docs/api.md#tokens): how the app talks to FeedbackKit's Worker directly. The app's own Worker
 * signs its signed-in user in, as it does for every route, and issues a short-lived token for them: a JWT (HS256)
 * signed with that app's key, which FeedbackKit's Worker keeps too (`APP_KEYS`). No call between the two Workers.
 *
 * Claims: `iss` the app (its key in `APPS`), `sub` the sender's GitHub login, `name` how the app names them
 * (optional), `aud` "feedbackkit", `iat` and `exp` in Unix seconds, at most 15 minutes apart.
 */

export const AUDIENCE = "feedbackkit";
/** The longest a token may live. */
export const MAX_LIFETIME_SECONDS = 15 * 60;
/** Clocks may disagree this much. */
const LEEWAY_SECONDS = 60;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;

export interface TokenClaims {
  app: string;
  login: string;
  name: string | null;
}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    return null;
  }
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmac(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/**
 * A token for one sender, as an app's Worker issues it. FeedbackKit's Worker never issues one; this is the reference
 * an app's Worker follows (and the tests' way to make one).
 */
export async function issueToken(
  key: string, app: string, login: string, name: string | null, now: number, lifetimeSeconds = MAX_LIFETIME_SECONDS,
): Promise<string> {
  const iat = Math.floor(now / 1000);
  const header = base64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64url(encoder.encode(JSON.stringify({
    iss: app, sub: login, ...(name ? { name } : {}), aud: AUDIENCE, iat, exp: iat + lifetimeSeconds,
  })));
  const signature = await crypto.subtle.sign("HMAC", await hmac(key), encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

/** The token's sender when its app's key signed it and it is current; null otherwise. */
export async function verifyToken(token: string, keys: Record<string, string>, now: number): Promise<TokenClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [header, payload, signature] = parts;
  const head = parse(header);
  const claims = parse(payload);
  const sig = fromBase64url(signature);
  if (!head || head.alg !== "HS256" || !claims || !sig) {
    return null;
  }
  const { iss, sub, name, aud, iat, exp } = claims;
  const key = typeof iss === "string" && Object.hasOwn(keys, iss) ? keys[iss] : undefined;
  if (!key || typeof sub !== "string" || !LOGIN.test(sub) || aud !== AUDIENCE
    || typeof iat !== "number" || typeof exp !== "number") {
    return null;
  }
  const seconds = Math.floor(now / 1000);
  if (exp <= seconds || iat > seconds + LEEWAY_SECONDS || exp - iat > MAX_LIFETIME_SECONDS) {
    return null;
  }
  const valid = await crypto.subtle.verify("HMAC", await hmac(key), sig, encoder.encode(`${header}.${payload}`));
  if (!valid) {
    return null;
  }
  const named = typeof name === "string" && name.trim() && name.length <= 60 && !/[\r\n]/.test(name) ? name.trim() : null;
  return { app: iss as string, login: sub, name: named };
}

function parse(part: string): Record<string, unknown> | null {
  const bytes = fromBase64url(part);
  if (!bytes) {
    return null;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
