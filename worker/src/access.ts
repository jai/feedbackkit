/**
 * Dashboard authentication for private `/about/*` JSON feeds (`/about/threads.json`, `/about/inspect`).
 * Accepts either a Worker bearer token (`RUNNER_TOKEN` / `ADMIN_TOKEN`) or a cryptographically verified
 * Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`) when `CF_ACCESS_TEAM` and `CF_ACCESS_AUD` are set.
 */

import type { FeatureKitEnv } from "./featurekit.ts";

interface CachedCerts {
  fetchedAt: number;
  keys: Map<string, CryptoKey>;
}

const CERTS_TTL_MS = 10 * 60_000;
const certsCache = new Map<string, CachedCerts>();

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function decodeJsonPart<T>(part: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(part))) as T;
  } catch {
    return null;
  }
}

async function loadAccessKeys(team: string, forceRefresh: boolean): Promise<Map<string, CryptoKey>> {
  const cached = certsCache.get(team);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < CERTS_TTL_MS) {
    return cached.keys;
  }
  const url = `https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`access certs HTTP ${res.status}`);
  }
  const body = (await res.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid || jwk.kty !== "RSA") {
      continue;
    }
    try {
      const imported = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      keys.set(jwk.kid, imported);
    } catch {
      // Ignore keys we cannot import.
    }
  }
  certsCache.set(team, { fetchedAt: Date.now(), keys });
  return keys;
}

/** Verifies a Cloudflare Access RS256 JWT (`Cf-Access-Jwt-Assertion`) against the team's JWKS. */
export async function verifyCloudflareAccessJwt(
  jwt: string,
  team: string,
  aud: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const parts = jwt.trim().split(".");
  if (parts.length !== 3) {
    return false;
  }
  const [headerPart, payloadPart, sigPart] = parts;
  const header = decodeJsonPart<{ alg?: string; kid?: string }>(headerPart);
  const payload = decodeJsonPart<{ aud?: string | string[]; iss?: string; exp?: number; nbf?: number }>(payloadPart);
  if (!header || !payload || header.alg !== "RS256" || !header.kid) {
    return false;
  }
  const expectedIss = `https://${team}.cloudflareaccess.com`;
  if (payload.iss !== expectedIss) {
    return false;
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : typeof payload.aud === "string" ? [payload.aud] : [];
  if (!audiences.includes(aud)) {
    return false;
  }
  if (typeof payload.exp !== "number" || payload.exp <= nowSec) {
    return false;
  }
  if (typeof payload.nbf === "number" && payload.nbf > nowSec + 60) {
    return false;
  }

  let keys: Map<string, CryptoKey>;
  try {
    keys = await loadAccessKeys(team, false);
  } catch {
    return false;
  }
  let key = keys.get(header.kid);
  if (!key) {
    try {
      keys = await loadAccessKeys(team, true);
      key = keys.get(header.kid);
    } catch {
      return false;
    }
  }
  if (!key) {
    return false;
  }
  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  const signature = base64UrlToBytes(sigPart);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed);
}

/**
 * Authorizes a private `/about/*` data read via either a Bearer token (`RUNNER_TOKEN` / `ADMIN_TOKEN`)
 * or a valid Cloudflare Access JWT when `CF_ACCESS_TEAM` and `CF_ACCESS_AUD` are configured.
 */
export async function hasDashboardAuth(
  request: Request,
  env: FeatureKitEnv,
  hasBearerFn: (req: Request, secret?: string) => boolean,
): Promise<boolean> {
  if (hasBearerFn(request, env.RUNNER_TOKEN) || hasBearerFn(request, env.ADMIN_TOKEN)) {
    return true;
  }
  const team = env.CF_ACCESS_TEAM?.trim();
  const aud = env.CF_ACCESS_AUD?.trim();
  if (!team || !aud || team.startsWith("__") || aud.startsWith("__")) {
    return false;
  }
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) {
    return false;
  }
  return verifyCloudflareAccessJwt(jwt, team, aud);
}
