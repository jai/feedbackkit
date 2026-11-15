/**
 * Pushes from FeedbackKit's Worker (docs/api.md#pushes), straight to APNs with the team's key: one key pushes to
 * every app of the team, each to its own bundle id (`topic` in `APPS`). A visible push when an agent takes a chat (its
 * coding thread is found) or writes something new; a silent one when a message's delivery state changes. Only to the
 * sender's own devices; a device APNs says is gone is forgotten.
 */

export interface ApnsKey {
  keyId: string;
  teamId: string;
  /** The .p8's PEM text. */
  p8: string;
}

export interface Device {
  token: string;
  environment: "production" | "sandbox";
}

export interface Push {
  /** Visible: a title and body the phone shows. Silent: only the data, and the app refreshes. */
  alert: { title: string; body: string } | null;
  /** Under `feedbackkit` in the payload: the chat, the app and why. */
  data: { chat: string; app: string; kind: "taken" | "reply" | "status"; status?: string };
}

const HOSTS = { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" };
/** APNs takes a provider token for up to an hour; a new one every 50 minutes. */
const TOKEN_SECONDS = 50 * 60;
const BODY_MAX = 180;
/** What APNs answers for a device token that will never work again. */
const GONE = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

let cached: { key: string; token: string; at: number } | null = null;

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function signingKey(p8: string): Promise<CryptoKey> {
  const body = p8.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/** The ES256 provider token APNs wants, kept for 50 minutes. */
export async function providerToken(key: ApnsKey, now: number): Promise<string> {
  const id = `${key.teamId}/${key.keyId}`;
  const seconds = Math.floor(now / 1000);
  if (cached && cached.key === id && seconds - cached.at < TOKEN_SECONDS) {
    return cached.token;
  }
  const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${encode({ alg: "ES256", kid: key.keyId })}.${encode({ iss: key.teamId, iat: seconds })}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await signingKey(key.p8),
    new TextEncoder().encode(unsigned));
  const token = `${unsigned}.${base64url(new Uint8Array(signature))}`;
  cached = { key: id, token, at: seconds };
  return token;
}

/** The APNs payload: an alert grouped by chat, or only `content-available`; the data under `feedbackkit`. */
export function payload(push: Push): Record<string, unknown> {
  const aps = push.alert
    ? { alert: push.alert, sound: "default", "thread-id": push.data.chat, "mutable-content": 1 }
    : { "content-available": 1 };
  return { aps, feedbackkit: push.data };
}

export function clip(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > BODY_MAX ? `${line.slice(0, BODY_MAX - 1)}…` : line;
}

/**
 * Sends one push to each device; answers the tokens APNs says are gone. A failure is logged, never thrown: a push is
 * a nudge, and the chat itself is in D1.
 */
export async function sendPush(
  key: ApnsKey, topic: string, devices: Device[], push: Push, now: number, fetcher: typeof fetch = fetch,
): Promise<string[]> {
  if (devices.length === 0) {
    return [];
  }
  let token: string;
  try {
    token = await providerToken(key, now);
  } catch (error) {
    console.error("apns key unusable", error);
    return [];
  }
  const body = JSON.stringify(payload(push));
  const gone: string[] = [];
  await Promise.all(devices.map(async (device) => {
    try {
      const response = await fetcher(`${HOSTS[device.environment]}/3/device/${device.token}`, {
        method: "POST",
        headers: {
          authorization: `bearer ${token}`,
          "apns-topic": topic,
          "apns-push-type": push.alert ? "alert" : "background",
          "apns-priority": push.alert ? "10" : "5",
          "apns-collapse-id": `${push.data.chat}-${push.data.kind}`.slice(0, 64),
        },
        body,
      });
      if (!response.ok) {
        const reason = ((await response.json().catch(() => ({}))) as { reason?: string }).reason ?? "";
        if (response.status === 410 || GONE.has(reason)) {
          gone.push(device.token);
        }
        console.error(JSON.stringify({ event: "apns_refused", status: response.status, reason, kind: push.data.kind }));
      }
    } catch (error) {
      console.error("apns unreachable", error);
    }
  }));
  return gone;
}

/** What to tell the sender about a new agent side, against the one before: taken, a new reply, or nothing. */
export function agentPush(
  app: string, chat: string, title: string,
  before: { messages: Array<{ id: string }>; thread: unknown } | null,
  after: { messages: Array<{ id: string; text: string }>; thread: unknown },
): Push | null {
  const seen = new Set((before?.messages ?? []).map((one) => one.id));
  const fresh = after.messages.filter((one) => !seen.has(one.id));
  if (fresh.length > 0) {
    return { alert: { title, body: clip(fresh.at(-1)!.text) }, data: { chat, app, kind: "reply" } };
  }
  if (!before?.thread && after.thread) {
    return { alert: { title, body: "An agent has taken this and is starting." }, data: { chat, app, kind: "taken" } };
  }
  return null;
}

/**
 * Whether APNs takes the team key, per host: a push to a made-up device answers `BadDeviceToken` when the key is good,
 * `InvalidProviderToken` or `ExpiredProviderToken` when it is not. Nothing reaches a device.
 */
export async function checkKey(key: ApnsKey, topic: string, now: number, fetcher: typeof fetch = fetch) {
  const token = await providerToken(key, now);
  const answers: Record<string, { status: number; reason: string | null }> = {};
  for (const [name, host] of Object.entries(HOSTS)) {
    const response = await fetcher(`${host}/3/device/${"0".repeat(64)}`, {
      method: "POST",
      headers: { authorization: `bearer ${token}`, "apns-topic": topic, "apns-push-type": "background", "apns-priority": "5" },
      body: JSON.stringify({ aps: { "content-available": 1 } }),
    });
    answers[name] = { status: response.status, reason: ((await response.json().catch(() => ({}))) as { reason?: string }).reason ?? null };
  }
  return answers;
}
