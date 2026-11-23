import type { Chat, ChatMessage } from "./chat.ts";
import { parseShipped, type Shipped } from "./shipped.ts";

/**
 * Feedback on the app, from the app (docs/api.md). The Worker only keeps it: each message waits here until
 * the owner's runner takes it, starts or tells a coding agent on the owner's Mac, and brings the agent's words back.
 * Nothing here calls a model. The runner reaches out to the Worker; the Worker never reaches the runner.
 */

const MAX_TEXT = 8_000;
/** Screenshots on one message: how many, and each one's size decoded. The app sends JPEGs of at most 1568 px. */
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 1_500_000;
/** What an image may be, and the base64 its bytes start with, so a mislabelled file is refused. */
const IMAGE_STARTS = { "image/jpeg": "/9j/", "image/png": "iVBORw0KGgo" } as const;
type ImageType = keyof typeof IMAGE_STARTS;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** Videos on one message, what they may be, and each one's size: they go up first (`newUpload`, `putUpload`). */
export const MAX_VIDEOS = 2;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const VIDEO_TYPES = ["video/mp4", "video/quicktime"] as const;
/** Pictures and videos together, as the app's tray holds them. */
const MAX_ATTACHMENTS = 4;
/** A day's videos at most: one longer is refused. */
const MAX_VIDEO_MS = 86_400_000;
/** Uploads a sender may hold that no message took yet; ones a day old are dropped as a new one is asked for. */
const MAX_OPEN_UPLOADS = 10;
const UPLOAD_STALE_MS = 86_400_000;
const UPLOAD_ID = /^up_[0-9a-f]{16}$/;
const UPLOAD_URI = /^\/v2\/feedback\/uploads\/(up_[0-9a-f]{16})$/;
const CHAT_ID = /^fb_[0-9a-f]{16}$/;
const MESSAGE_ID = /^m_[0-9a-f]{16}$/;
/** The runner says it is alive on every poll; quieter than this, the builder is offline. */
const RUNNER_FRESH_MS = 90_000;
/** A claimed message the runner never reported on: it stopped mid-delivery, and the message is not sent again. */
const DELIVERY_STUCK_MS = 15 * 60_000;
const MAX_AGENT_MESSAGES = 500;
const MAX_AGENT_TEXT = 20_000;

/** Under each sender's R2 prefix: a message's screenshots, as `{media_type, data}` JSON. */
export const imageKey = (prefix: string, chat: string, message: string, index: number) =>
  `${prefix}feedback/chats/${chat}/img/${message}/${index}.json`;

/** Under each sender's R2 prefix: an uploaded video's bytes, as they came. */
export const uploadKey = (prefix: string, upload: string) => `${prefix}feedback/uploads/${upload}`;

/** Where an upload's bytes go (`PUT`) and the `uri` a message's `videos` name it by: one path. */
export const uploadPath = (upload: string) => `/v2/feedback/uploads/${upload}`;

export interface FeedbackThread {
  id: string;
  title: string;
  createdAt: string;
  /** The chat's coding thread, once the runner has found it; issue chats have none. */
  thread?: AgentSide["thread"];
  /** Where an agent chat stands, for its row: issue chats have none. */
  agent?: ThreadAgentState;
  /** What the chat's feedback shipped, for the row's accessories; null until the runner found any. */
  shipped?: Shipped | null;
  /** The runner tidied the agent's chat away: a reply can't reach it, so the chat is read-only. */
  ended?: true;
}

/**
 * An agent chat's state on the list: working (with what at), waiting on the sender, or idle. `queued`, while working:
 * a message waits for the runner or the agent's next turn (an older app shows it as working). `asks`, while it needs
 * you: the agent asked the sender a question and has no answer yet, whatever it shipped and even while it works on.
 */
export interface ThreadAgentState {
  state: "working" | "needs_you" | "idle";
  activity: string | null;
  queued?: true;
  asks?: true;
}

/**
 * Needs you, with `asks`, while a question of the agent's has no answer: the sender sent nothing since the runner said
 * so. Else working while the agent says so; queued while a message of the sender's waits for the runner or has not
 * reached the agent's last look; needs you when the agent spoke last and stopped; else idle.
 */
export function threadAgentState(
  agent: AgentSide | null,
  lastSentAt: number | null,
  lastAgentAt: number | null,
  waiting: boolean,
): ThreadAgentState {
  const unseen = lastSentAt !== null && (agent?.updatedAt ?? 0) < lastSentAt;
  if (agent?.asks && !waiting && !unseen) {
    return { state: "needs_you", activity: null, asks: true };
  }
  if (agent?.isWorking) {
    return { state: "working", activity: agent.activity ?? "Working" };
  }
  if (waiting || unseen) {
    return { state: "working", activity: null, queued: true };
  }
  if (lastAgentAt !== null && (lastSentAt === null || lastAgentAt >= lastSentAt)) {
    return { state: "needs_you", activity: null };
  }
  return { state: "idle", activity: null };
}

export interface FeedbackImage {
  media_type: ImageType;
  /** The bytes in base64. */
  data: string;
}

/** A video on a message: an upload of the sender's, put and not yet taken, and how long it runs when the app said. */
export interface FeedbackVideo {
  upload: string;
  duration_ms: number | null;
}

export interface FeedbackInput {
  text: string;
  /** The app's build, so the agent knows what Jai was looking at. */
  build: string | null;
  images: FeedbackImage[];
  /** After the pictures; absent from callers before videos. */
  videos?: FeedbackVideo[];
}

export type MessageStatus = "pending" | "delivering" | "delivered" | "failed" | "removed";

/** One of Jai's messages, as kept. Only the app's POST writes a new one; only the runner's claim and result change it. */
export interface StoredMessage {
  id: string;
  /** Epoch ms when the Worker took it: orders the chat and the queue. */
  at: number;
  text: string;
  build: string | null;
  /** Its pictures and videos. */
  images: number;
  /** How many of `images` are videos. */
  videos: number;
  /** The chat's first message starts the agent; every other one is told to it. */
  first: boolean;
  status: MessageStatus;
  /** When the runner claimed it. */
  claimedAt: number | null;
  /** Why it was not delivered. */
  detail: string | null;
}

/** The agent's side of a chat, written only by the runner. */
export interface AgentSide {
  messages: Array<{ id: string; text: string; at: string | null }>;
  isWorking: boolean;
  activity: string | null;
  /** Where the agent runs, as the runner names it: its Agents thread, so the app can link the two. */
  thread: { host: string; id: string } | null;
  updatedAt: number;
  /** What the chat's feedback shipped (shipped.ts); absent until the runner found any. */
  shipped?: Shipped | null;
  /** The runner tidied the agent's chat away, or it is gone: a reply can't reach it. */
  ended?: true;
  /** The agent's last word asks the sender a question; a message of the sender's after `updatedAt` answers it. */
  asks?: true;
}

/**
 * A message of the chat, with how many screenshots Jai sent on it. `images` counts its videos too, so an app from before
 * videos still says the message carries something; `videos` says how many of them are videos.
 */
export interface FeedbackMessage extends ChatMessage {
  images: number;
  videos?: number;
  /** The sender's persisted delivery state; absent on messages from the agent. */
  status?: MessageStatus;
}

export interface FeedbackChat extends Chat {
  messages: FeedbackMessage[];
  id: string;
  /** Whether the runner is taking work and the Mac it starts agents on answers. Without it a message waits here. */
  builderOnline: boolean;
  thread: AgentSide["thread"];
  /** What the chat's feedback shipped (docs/api.md#shipped); null until the runner found any. */
  shipped: Shipped | null;
  /** The agent's chat was tidied away: a reply can't reach it, so the chat is read-only. */
  ended: boolean;
}

/** What a runner poll answers: Jai's messages it has not taken, oldest first. */
export interface RunnerWork {
  chat: string;
  message: string;
  first: boolean;
  at: number;
  /** How the sender's app names them ("Jai"); null: by their login. */
  name: string | null;
}

/** R2, as this needs it for screenshots and videos. */
export interface ImageBucket {
  put(
    key: string,
    value: string | ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{ json<T>(): Promise<T>; body: ReadableStream | string | Uint8Array; size: number } | null>;
  delete(keys: string | string[]): Promise<unknown>;
}

/**
 * One sender's corner of FeedbackKit's store (docs/worker.md#storage): their chats in D1, their screenshots in R2
 * under `prefix`. `name` is how their app names them, when it does.
 */
export interface FeedbackStore {
  db: D1Database;
  bucket: ImageBucket;
  app: string;
  /** Lower-case. */
  login: string;
  prefix: string;
  name?: string | null;
}

export function senderStore(
  db: D1Database,
  bucket: ImageBucket,
  app: string,
  login: string,
  name: string | null = null,
): FeedbackStore {
  const lower = login.toLowerCase();
  return { db, bucket, app, login: lower, prefix: `apps/${app}/users/${lower}/`, name };
}

interface ChatRow {
  id: string;
  title: string;
  created_at: number;
  agent: string | null;
  thread_host: string | null;
  thread_id: string | null;
  sender_name: string | null;
}

interface MessageRow {
  id: string;
  at: number;
  text: string;
  build: string | null;
  images: number;
  videos?: number;
  first: number;
  status: MessageStatus | null;
  claimed_at: number | null;
  detail: string | null;
}

function stored(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    at: row.at,
    text: row.text,
    build: row.build,
    images: row.images,
    videos: row.videos ?? 0,
    first: row.first === 1,
    status: row.status ?? "delivered",
    claimedAt: row.claimed_at,
    detail: row.detail,
  };
}

/** The sender's chat of this kind; null when it is not theirs or not there. */
async function chatRow(store: FeedbackStore, chat: string, kind: "agent" | "issue" = "agent"): Promise<ChatRow | null> {
  if (!CHAT_ID.test(chat)) {
    return null;
  }
  return store.db
    .prepare(
      "SELECT id, title, created_at, agent, thread_host, thread_id, sender_name FROM chats" +
        " WHERE id = ? AND app = ? AND login = ? AND kind = ?",
    )
    .bind(chat, store.app, store.login, kind)
    .first<ChatRow>();
}

/** The chat a send with this `client_ref` key made, if one did. */
export async function chatOfRef(store: FeedbackStore, key: string): Promise<string | null> {
  return store.db
    .prepare("SELECT chat FROM refs WHERE app = ? AND login = ? AND key = ?")
    .bind(store.app, store.login, key)
    .first<string>("chat");
}

export async function keepRef(store: FeedbackStore, key: string, chat: string): Promise<void> {
  await store.db
    .prepare("INSERT OR IGNORE INTO refs (app, login, key, chat) VALUES (?, ?, ?, ?)")
    .bind(store.app, store.login, key, chat)
    .run();
}

export function isFeedbackId(id: string): boolean {
  return CHAT_ID.test(id);
}

export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Words, screenshots, videos or any of them; `null` for anything the agent should not get. */
export function parseFeedbackInput(body: unknown): FeedbackInput | null {
  const { text, build, images, videos } = (body ?? {}) as {
    text?: unknown;
    build?: unknown;
    images?: unknown;
    videos?: unknown;
  };
  const pictures = parseImages(images);
  const films = parseVideos(videos);
  if (
    typeof text !== "string" ||
    text.length > MAX_TEXT ||
    pictures === null ||
    films === null ||
    pictures.length + films.length > MAX_ATTACHMENTS ||
    (!text.trim() && !pictures.length && !films.length)
  ) {
    return null;
  }
  return {
    text: text.trim(),
    build: typeof build === "string" && /^[\w.-]{1,20}$/.test(build) ? build : null,
    images: pictures,
    videos: films,
  };
}

/** `[{uri, mimeType, size, duration_ms?}]`, each naming an upload by the `uri` its ticket gave. */
function parseVideos(value: unknown): FeedbackVideo[] | null {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_VIDEOS) {
    return null;
  }
  const videos: FeedbackVideo[] = [];
  for (const item of value) {
    const { uri, duration_ms: duration } = (item ?? {}) as { uri?: unknown; duration_ms?: unknown };
    const upload = typeof uri === "string" ? UPLOAD_URI.exec(uri)?.[1] : undefined;
    if (
      !upload ||
      videos.some((video) => video.upload === upload) ||
      (duration !== undefined &&
        duration !== null &&
        (typeof duration !== "number" || !Number.isInteger(duration) || duration < 0 || duration > MAX_VIDEO_MS))
    ) {
      return null;
    }
    videos.push({ upload, duration_ms: typeof duration === "number" ? duration : null });
  }
  return videos;
}

function parseImages(value: unknown): FeedbackImage[] | null {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_IMAGES) {
    return null;
  }
  const images: FeedbackImage[] = [];
  for (const item of value) {
    const { media_type: type, data } = (item ?? {}) as { media_type?: unknown; data?: unknown };
    if (
      typeof type !== "string" ||
      !(type in IMAGE_STARTS) ||
      typeof data !== "string" ||
      data.length % 4 !== 0 ||
      data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
      !BASE64.test(data) ||
      !data.startsWith(IMAGE_STARTS[type as ImageType])
    ) {
      return null;
    }
    images.push({ media_type: type as ImageType, data });
  }
  return images;
}

export function titleOf(text: string, untitled = "Screenshot"): string {
  if (!text.trim()) {
    return untitled;
  }
  const line = text.split("\n")[0].trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

async function threads(store: FeedbackStore, kind: "agent" | "issue" = "agent"): Promise<FeedbackThread[]> {
  const { results } = await store.db
    .prepare(
      "SELECT id, title, created_at, thread_host, thread_id, agent," +
        // A message that failed waits for nothing: it never makes the row Queued.
        " (SELECT max(at) FROM messages WHERE chat = chats.id AND (status IS NULL OR status NOT IN ('removed', 'failed')))" +
        " AS last_sent_at," +
        " (SELECT count(*) FROM messages WHERE chat = chats.id AND status IN ('pending', 'delivering')) AS waiting," +
        " (SELECT max(at) FROM agent_messages WHERE chat = chats.id) AS last_agent_at" +
        " FROM chats WHERE app = ? AND login = ? AND kind = ? ORDER BY created_at DESC",
    )
    .bind(store.app, store.login, kind)
    .all<ChatRow & { last_sent_at: number | null; waiting: number; last_agent_at: string | null }>();
  return results.map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: new Date(row.created_at).toISOString(),
    ...(kind === "agent" ? agentRow(row) : {}),
  }));
}

function agentRow(
  row: ChatRow & { last_sent_at: number | null; waiting: number; last_agent_at: string | null },
): Pick<FeedbackThread, "thread" | "shipped" | "agent" | "ended"> {
  const side = row.agent ? (JSON.parse(row.agent) as AgentSide) : null;
  return {
    thread: row.thread_host && row.thread_id ? { host: row.thread_host, id: row.thread_id } : null,
    shipped: side?.shipped ?? null,
    agent: threadAgentState(
      side,
      row.last_sent_at,
      row.last_agent_at ? Date.parse(row.last_agent_at) : null,
      row.waiting > 0,
    ),
    ...(side?.ended ? { ended: true as const } : {}),
  };
}

/** An issue sender's chats, newest first. */
export async function issueThreadList(store: FeedbackStore): Promise<FeedbackThread[]> {
  return threads(store, "issue");
}

/** The runner's last poll, as it left it: when, whether its Mac's Orca answered, and why not. */
interface RunnerBeat {
  at: number;
  orca: boolean;
  detail?: string | null;
}

/** Whether the builder is taking work, and why not: the runner's last poll and what it said about its Mac. */
export interface BuilderStatus {
  online: boolean;
  /** When the runner last polled, ISO 8601; null when it never has. */
  lastPollAt: string | null;
  /** Why it is offline, in a few words; null when it is online. */
  detail: string | null;
}

export function builderStatusOf(beat: RunnerBeat | null, now: number): BuilderStatus {
  if (!beat) {
    return { online: false, lastPollAt: null, detail: "The runner has never polled." };
  }
  const fresh = now - beat.at < RUNNER_FRESH_MS;
  const online = fresh && beat.orca;
  const detail = online
    ? null
    : !fresh
      ? `The runner has not polled for ${Math.round((now - beat.at) / 1000)} s.`
      : beat.detail || "The runner's Mac did not answer.";
  return { online, lastPollAt: new Date(beat.at).toISOString(), detail };
}

async function builderStatus(store: FeedbackStore, now: number): Promise<BuilderStatus> {
  const beat = await store.db
    .prepare("SELECT at, orca, detail FROM runner_beat WHERE id = 1")
    .first<{ at: number; orca: number; detail: string | null }>();
  return builderStatusOf(beat ? { at: beat.at, orca: beat.orca === 1, detail: beat.detail } : null, now);
}

async function builderOnline(store: FeedbackStore, now: number): Promise<boolean> {
  return (await builderStatus(store, now)).online;
}

export async function feedbackList(store: FeedbackStore, now: number) {
  const [list, status] = await Promise.all([threads(store), builderStatus(store, now)]);
  return { threads: list, builderOnline: status.online, builderStatus: status };
}

/** The one log line a list read leaves (`feedback_list_served`): what the app was told about the builder, and why. */
export function listServedLog(status: BuilderStatus, threadCount: number, now: number): string {
  const age = status.lastPollAt === null ? null : Math.round((now - Date.parse(status.lastPollAt)) / 1000);
  return JSON.stringify({
    event: "feedback_list_served",
    builderOnline: status.online,
    runnerPollAgeSeconds: age,
    detail: status.detail,
    threads: threadCount,
  });
}

async function messagesOf(store: FeedbackStore, chat: string): Promise<StoredMessage[]> {
  const { results } = await store.db
    .prepare(
      "SELECT id, at, text, build, images, first, status, claimed_at, detail," +
        " (SELECT count(*) FROM images i WHERE i.message = messages.id AND i.media_type LIKE 'video/%') AS videos" +
        " FROM messages WHERE chat = ? AND status IS NOT 'removed' ORDER BY at, id",
    )
    .bind(chat)
    .all<MessageRow>();
  return results.map(stored);
}

/** What the chat says of a message the runner took and never reported on. */
function effectiveStatus(message: StoredMessage, now: number): { status: MessageStatus; detail: string | null } {
  if (message.status === "delivering" && message.claimedAt !== null && now - message.claimedAt > DELIVERY_STUCK_MS) {
    return {
      status: "failed",
      detail: "The builder stopped while passing this on. Check the chat before sending again.",
    };
  }
  return { status: message.status, detail: message.detail };
}

/** Null for a chat that does not exist. */
export async function feedbackChat(store: FeedbackStore, chat: string, now: number): Promise<FeedbackChat | null> {
  const row = await chatRow(store, chat);
  if (!row) {
    return null;
  }
  const [mine, online] = await Promise.all([messagesOf(store, chat), builderOnline(store, now)]);
  return chatView(chat, mine, row.agent ? (JSON.parse(row.agent) as AgentSide) : null, online, now);
}

/**
 * Jai's messages and the agent's, in time order; working from a send until the agent's turn is over. An agent that asks
 * a question and works on is still working here: only the list's row says it needs the sender.
 */
export function chatView(
  id: string,
  mine: StoredMessage[],
  agent: AgentSide | null,
  online: boolean,
  now: number,
): FeedbackChat {
  const entries: Array<{ at: number; message: FeedbackMessage }> = mine.map((message) => ({
    at: message.at,
    message: {
      id: message.id,
      role: "you",
      text: message.text,
      anchor: null,
      images: message.images,
      ...(message.videos ? { videos: message.videos } : {}),
      status: message.status,
    },
  }));
  for (const message of agent?.messages ?? []) {
    entries.push({
      at: message.at ? Date.parse(message.at) : now,
      message: { id: message.id, role: "agent", text: message.text, anchor: null, images: 0 },
    });
  }
  entries.sort((a, b) => a.at - b.at);
  const statuses = mine.map((message) => ({ message, ...effectiveStatus(message, now) }));
  const waiting = statuses.some(({ status }) => status === "pending" || status === "delivering");
  // Delivered after the runner last looked: the agent's turn has started, whatever the last look said.
  const unseen = statuses.some(({ message, status }) => status === "delivered" && (agent?.updatedAt ?? 0) < message.at);
  const last = statuses.at(-1);
  const problem = last?.status === "failed" ? (last.detail ?? "This message could not be passed on.") : null;
  const isWorking = problem === null && (waiting || unseen || (agent?.isWorking ?? false));
  // Only a chat's first message starts its agent; a later one goes to the same agent, so it says so.
  const startsAgent = statuses.some(
    ({ message, status }) => message.first && (status === "pending" || status === "delivering"),
  );
  const activity = !isWorking
    ? null
    : waiting
      ? online
        ? startsAgent
          ? "Starting"
          : "Passing your message to the agent"
        : null
      : (agent?.activity ?? "Working");
  return {
    id,
    messages: entries.map(({ message }) => message),
    isWorking,
    activity,
    problem,
    costCents: null,
    model: null,
    effort: null,
    builderOnline: online,
    thread: agent?.thread ?? null,
    shipped: agent?.shipped ?? null,
    ended: agent?.ended === true,
  };
}

/**
 * A message from the sender: a new chat when `chat` is null, else the next in that chat. Null: no such chat. The
 * screenshots go to R2 first, then the chat and the message to D1 in one transaction: once this answers, the message
 * is kept (one checkmark).
 */
export async function addFeedback(
  store: FeedbackStore,
  chat: string | null,
  input: FeedbackInput,
  now: number,
): Promise<string | null> {
  return (await addMessage(store, chat, input, now))?.chat ?? null;
}

/** As `addFeedback`, answering the message's id too; `clientRef` is the app's own id for it (the live protocol's). */
export async function addMessage(
  store: FeedbackStore,
  chat: string | null,
  input: FeedbackInput,
  now: number,
  clientRef: string | null = null,
): Promise<{ chat: string; message: string } | null> {
  if (chat && !(await chatRow(store, chat))) {
    return null;
  }
  const videos = await readyUploads(store, input.videos ?? []);
  if (videos === null) {
    throw new Error("a video is not the sender's ready upload");
  }
  const id = chat ?? newId("fb");
  const message = newId("m");
  const keys = input.images.map((_, index) => imageKey(store.prefix, id, message, index));
  await Promise.all(input.images.map((image, index) => store.bucket.put(keys[index], JSON.stringify(image))));
  const writes: D1PreparedStatement[] = [];
  if (chat === null) {
    writes.push(
      store.db
        .prepare(
          "INSERT INTO chats (id, app, login, kind, title, created_at, sender_name) VALUES (?, ?, ?, 'agent', ?, ?, ?)",
        )
        .bind(
          id,
          store.app,
          store.login,
          titleOf(input.text, !input.images.length && videos.length ? "Video" : "Screenshot"),
          now,
          store.name ?? null,
        ),
    );
  } else if (store.name) {
    writes.push(store.db.prepare("UPDATE chats SET sender_name = ? WHERE id = ?").bind(store.name, id));
  }
  writes.push(bump(store.db, id));
  writes.push(
    store.db
      .prepare(
        "INSERT INTO messages (id, chat, at, text, build, images, first, status, seq, client_ref)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', (SELECT seq FROM chats WHERE id = ?), ?)",
      )
      .bind(
        message,
        id,
        now,
        input.text,
        input.build,
        input.images.length + videos.length,
        chat === null ? 1 : 0,
        id,
        clientRef,
      ),
  );
  input.images.forEach((image, index) =>
    writes.push(
      store.db
        .prepare("INSERT INTO images (message, idx, r2_key, media_type) VALUES (?, ?, ?, ?)")
        .bind(message, index, keys[index], image.media_type),
    ),
  );
  videos.forEach((video, index) =>
    writes.push(
      store.db
        .prepare("INSERT INTO images (message, idx, r2_key, media_type, size, duration_ms) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(message, input.images.length + index, video.r2_key, video.media_type, video.size, video.duration_ms),
      store.db
        .prepare("UPDATE uploads SET message = ? WHERE id = ? AND app = ? AND login = ? AND message IS NULL")
        .bind(message, video.id, store.app, store.login),
    ),
  );
  await store.db.batch(writes);
  return { chat: id, message };
}

/**
 * The person's change to a message the runner has not claimed: new words, or taking it back (`removed`). False when it
 * is not theirs, not there, or no longer `pending`.
 */
export async function changePending(
  store: FeedbackStore,
  chat: string,
  message: string,
  change: { text: string } | "remove",
): Promise<boolean> {
  if (!MESSAGE_ID.test(message) || !(await chatRow(store, chat))) {
    return false;
  }
  const [, changed] = await store.db.batch([
    bump(store.db, chat, { message, status: "pending" }),
    change === "remove"
      ? store.db
          .prepare(
            "UPDATE messages SET status = 'removed', seq = (SELECT seq FROM chats WHERE id = ?)" +
              " WHERE id = ? AND chat = ? AND status = 'pending'",
          )
          .bind(chat, message, chat)
      : store.db
          .prepare(
            "UPDATE messages SET text = ?, seq = (SELECT seq FROM chats WHERE id = ?)" +
              " WHERE id = ? AND chat = ? AND status = 'pending'",
          )
          .bind(change.text, chat, message, chat),
  ]);
  return changed.meta.changes === 1;
}

// --- Videos ----------------------------------------------------------------------------------------------------------

/** An upload's ticket, as the live protocol's `_agentchatkit/upload` answers one: where to `PUT`, and the `uri`. */
export interface UploadTicket {
  uploadUrl: string;
  uri: string;
  headers: Record<string, string>;
}

interface UploadRow {
  id: string;
  media_type: string;
  size: number;
  put_at: number | null;
  r2_key: string;
  message: string | null;
}

/**
 * Room for one of the sender's videos (`POST /v2/feedback/uploads {name, mimeType, size}`): a ticket, or the status
 * that refuses it: `413` larger than 50 MB, `415` not MP4 or QuickTime, `429` too many not yet sent, `400` no size.
 * Uploads a day old that no message took go first, bytes and all.
 */
export async function newUpload(
  store: FeedbackStore,
  body: unknown,
  now: number,
): Promise<UploadTicket | { status: 400 | 413 | 415 | 429; error: string }> {
  const { mimeType, size } = (body ?? {}) as { mimeType?: unknown; size?: unknown };
  if (typeof size !== "number" || !Number.isInteger(size) || size < 1) {
    return { status: 400, error: "An upload needs its size in bytes." };
  }
  if (size > MAX_VIDEO_BYTES) {
    return { status: 413, error: "A video can be at most 50 MB." };
  }
  const type = typeof mimeType === "string" ? mimeType.toLowerCase() : "";
  if (!(VIDEO_TYPES as readonly string[]).includes(type)) {
    return { status: 415, error: "Only MP4 and QuickTime videos can be sent." };
  }
  const { results: stale } = await store.db
    .prepare("SELECT id, r2_key FROM uploads WHERE app = ? AND login = ? AND message IS NULL AND created_at < ?")
    .bind(store.app, store.login, now - UPLOAD_STALE_MS)
    .all<{ id: string; r2_key: string }>();
  if (stale.length) {
    await store.bucket.delete(stale.map((row) => row.r2_key));
    await store.db.batch(stale.map((row) => store.db.prepare("DELETE FROM uploads WHERE id = ?").bind(row.id)));
  }
  const open = await store.db
    .prepare("SELECT count(*) AS n FROM uploads WHERE app = ? AND login = ? AND message IS NULL")
    .bind(store.app, store.login)
    .first<number>("n");
  if ((open ?? 0) >= MAX_OPEN_UPLOADS) {
    return { status: 429, error: "Too many videos waiting to be sent. Send or remove some first." };
  }
  const id = newId("up");
  await store.db
    .prepare("INSERT INTO uploads (id, app, login, media_type, size, created_at, r2_key) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, store.app, store.login, type, size, now, uploadKey(store.prefix, id))
    .run();
  return { uploadUrl: uploadPath(id), uri: uploadPath(id), headers: { "Content-Type": type } };
}

/**
 * An upload's bytes (`PUT /v2/feedback/uploads/{id}`), kept raw in R2 with their type. Again is fine until a message
 * takes it. `404`: not the sender's upload, or no such one; `409`: a message has it; `413`: more bytes than it asked
 * room for; `400`: no bytes.
 */
export async function putUpload(
  store: FeedbackStore,
  upload: string,
  bytes: ArrayBuffer,
  now: number,
): Promise<200 | 400 | 404 | 409 | 413> {
  const row = UPLOAD_ID.test(upload)
    ? await store.db
        .prepare(
          "SELECT id, media_type, size, put_at, r2_key, message FROM uploads WHERE id = ? AND app = ? AND login = ?",
        )
        .bind(upload, store.app, store.login)
        .first<UploadRow>()
    : null;
  if (!row) {
    return 404;
  }
  if (row.message !== null) {
    return 409;
  }
  if (!bytes.byteLength) {
    return 400;
  }
  if (bytes.byteLength > row.size) {
    return 413;
  }
  await store.bucket.put(row.r2_key, bytes, { httpMetadata: { contentType: row.media_type } });
  await store.db
    .prepare("UPDATE uploads SET put_at = ?, size = ? WHERE id = ? AND message IS NULL")
    .bind(now, bytes.byteLength, row.id)
    .run();
  return 200;
}

/** The declared size of one of the sender's uploads still open for its bytes; null for any other. */
export async function uploadRoom(store: FeedbackStore, upload: string): Promise<number | null> {
  if (!UPLOAD_ID.test(upload)) {
    return null;
  }
  return store.db
    .prepare("SELECT size FROM uploads WHERE id = ? AND app = ? AND login = ? AND message IS NULL")
    .bind(upload, store.app, store.login)
    .first<number>("size");
}

/** Each video's upload, when every one is the sender's, put, and taken by no message; null otherwise. */
async function readyUploads(
  store: FeedbackStore,
  videos: FeedbackVideo[],
): Promise<Array<UploadRow & { duration_ms: number | null }> | null> {
  const rows: Array<UploadRow & { duration_ms: number | null }> = [];
  for (const video of videos) {
    const row = await store.db
      .prepare(
        "SELECT id, media_type, size, put_at, r2_key, message FROM uploads" +
          " WHERE id = ? AND app = ? AND login = ? AND put_at IS NOT NULL AND message IS NULL",
      )
      .bind(video.upload, store.app, store.login)
      .first<UploadRow>();
    if (!row) {
      return null;
    }
    rows.push({ ...row, duration_ms: video.duration_ms });
  }
  return rows;
}

/** Whether a message may carry these videos: each the sender's upload, put, and not on another message. */
export async function videosReady(store: FeedbackStore, input: FeedbackInput): Promise<boolean> {
  return (await readyUploads(store, input.videos ?? [])) !== null;
}

// --- The runner ------------------------------------------------------------------------------------------------------

/** The runner's beat: it is alive, and whether its Mac's Orca answers. */
export async function runnerBeat(
  db: D1Database,
  orca: boolean,
  now: number,
  detail: string | null = null,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO runner_beat (id, at, orca, detail) VALUES (1, ?, ?, ?)" +
        " ON CONFLICT (id) DO UPDATE SET at = excluded.at, orca = excluded.orca, detail = excluded.detail",
    )
    .bind(now, orca ? 1 : 0, orca ? null : (detail?.slice(0, 200) ?? null))
    .run();
}

/** A poll for one sender: the runner is alive (and whether its Mac answers), and the messages it has not taken. */
export async function runnerPoll(
  store: FeedbackStore,
  orca: boolean,
  now: number,
  detail: string | null = null,
): Promise<RunnerWork[]> {
  await runnerBeat(store.db, orca, now, detail);
  return pendingWork(store);
}

export async function pendingWork(store: FeedbackStore): Promise<RunnerWork[]> {
  const { results } = await store.db
    .prepare(
      "SELECT m.chat AS chat, m.id AS message, m.first AS first, m.at AS at, c.sender_name AS name" +
        " FROM messages m JOIN chats c ON c.id = m.chat" +
        " WHERE m.status = 'pending' AND c.app = ? AND c.login = ? AND c.kind = 'agent' ORDER BY m.at, m.id",
    )
    .bind(store.app, store.login)
    .all<{ chat: string; message: string; first: number; at: number; name: string | null }>();
  return results.map((row) => ({
    chat: row.chat,
    message: row.message,
    first: row.first === 1,
    at: row.at,
    name: row.name,
  }));
}

async function findMessage(store: FeedbackStore, chat: string, id: string): Promise<StoredMessage | null> {
  if (!MESSAGE_ID.test(id) || !(await chatRow(store, chat))) {
    return null;
  }
  const row = await store.db
    .prepare(
      "SELECT id, at, text, build, images, first, status, claimed_at, detail FROM messages WHERE id = ? AND chat = ?",
    )
    .bind(id, chat)
    .first<MessageRow>();
  return row ? stored(row) : null;
}

/** A video on a claimed message: the runner fetches its bytes with `POST /runner/media` and its `index`. */
export interface ClaimedVideo {
  index: number;
  media_type: string;
  size: number | null;
  duration_ms: number | null;
}

export type ClaimAnswer =
  | {
      ok: true;
      text: string;
      build: string | null;
      first: boolean;
      images: FeedbackImage[];
      videos: ClaimedVideo[];
      title: string;
    }
  | { ok: false; status: 404 | 409 };

/** Pending → delivering, once: a second claim, or one racing it, is refused. Answers what the agent is to be told. */
export async function runnerClaim(store: FeedbackStore, chat: string, id: string, now: number): Promise<ClaimAnswer> {
  const found = await findMessage(store, chat, id);
  if (!found) {
    return { ok: false, status: 404 };
  }
  const [, claimed] = await store.db.batch([
    bump(store.db, chat, { message: id, status: "pending" }),
    store.db
      .prepare(
        "UPDATE messages SET status = 'delivering', claimed_at = ?, seq = (SELECT seq FROM chats WHERE id = ?)" +
          " WHERE id = ? AND chat = ? AND status = 'pending'",
      )
      .bind(now, chat, id, chat),
  ]);
  if (!claimed.meta.changes) {
    return { ok: false, status: 409 };
  }
  const { results } = await store.db
    .prepare("SELECT idx, r2_key, media_type, size, duration_ms FROM images WHERE message = ? ORDER BY idx")
    .bind(id)
    .all<{ idx: number; r2_key: string; media_type: string; size: number | null; duration_ms: number | null }>();
  // The pictures inline, as before; a video's bytes are too many for JSON, so it is only named.
  const pictures = results.filter((row) => !isVideo(row.media_type));
  const images = await Promise.all(
    pictures.map(async ({ r2_key }) => (await (await store.bucket.get(r2_key))?.json<FeedbackImage>()) ?? undefined),
  );
  const title = (await chatRow(store, chat))?.title ?? titleOf(found.text);
  return {
    ok: true,
    text: found.text,
    build: found.build,
    first: found.first,
    images: images.filter((image) => image !== undefined),
    videos: results
      .filter((row) => isVideo(row.media_type))
      .map((row) => ({ index: row.idx, media_type: row.media_type, size: row.size, duration_ms: row.duration_ms })),
    title,
  };
}

/** Delivering → delivered or failed. */
export async function runnerResult(
  store: FeedbackStore,
  chat: string,
  id: string,
  delivered: boolean,
  detail: string | null,
): Promise<404 | 409 | 200> {
  if (!(await findMessage(store, chat, id))) {
    return 404;
  }
  const [, done] = await store.db.batch([
    bump(store.db, chat, { message: id, status: "delivering" }),
    store.db
      .prepare(
        "UPDATE messages SET status = ?, detail = ?, seq = (SELECT seq FROM chats WHERE id = ?)" +
          " WHERE id = ? AND chat = ? AND status = 'delivering'",
      )
      .bind(delivered ? "delivered" : "failed", delivered ? null : detail, chat, id, chat),
  ]);
  return done.meta.changes ? 200 : 409;
}

/** The runner's look at the agent: its messages so far, whether it is working, and where it runs. */
export function parseAgentSide(body: unknown, now: number): AgentSide | null {
  const { messages, isWorking, activity, thread, shipped, ended, asks } = (body ?? {}) as Record<string, unknown>;
  const landed = shipped === undefined || shipped === null ? null : parseShipped(shipped);
  if (landed === undefined) {
    return null;
  }
  if (
    !Array.isArray(messages) ||
    messages.length > MAX_AGENT_MESSAGES ||
    typeof isWorking !== "boolean" ||
    (ended !== undefined && typeof ended !== "boolean") ||
    (asks !== undefined && typeof asks !== "boolean") ||
    (activity !== null && (typeof activity !== "string" || activity.length > 80))
  ) {
    return null;
  }
  const parsed: AgentSide["messages"] = [];
  for (const item of messages) {
    const { id, text, at } = (item ?? {}) as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      id.length < 1 ||
      id.length > 200 ||
      typeof text !== "string" ||
      text.length > MAX_AGENT_TEXT ||
      (at !== null && (typeof at !== "string" || Number.isNaN(Date.parse(at))))
    ) {
      return null;
    }
    parsed.push({ id, text, at: at as string | null });
  }
  const place = thread as { host?: unknown; id?: unknown } | null | undefined;
  const where =
    place &&
    typeof place.host === "string" &&
    typeof place.id === "string" &&
    place.host.length <= 100 &&
    place.id.length <= 200
      ? { host: place.host, id: place.id }
      : null;
  return {
    messages: parsed,
    isWorking,
    activity: activity as string | null,
    thread: where,
    updatedAt: now,
    ...(landed ? { shipped: landed } : {}),
    ...(ended === true ? { ended: true as const } : {}),
    ...(asks === true ? { asks: true as const } : {}),
  };
}

export const isVideo = (mediaType: string) => mediaType.startsWith("video/");

/**
 * One of the sender's screenshots or videos: its bytes and type; null when the chat, message or attachment is not
 * theirs. A video comes as R2 streams it, never through base64.
 */
export async function messageImage(
  store: FeedbackStore,
  chat: string,
  message: string,
  index: number,
): Promise<{ bytes: Uint8Array | ReadableStream | string; mediaType: string; size?: number } | null> {
  if (!MESSAGE_ID.test(message) || !Number.isInteger(index) || index < 0 || !(await chatRow(store, chat))) {
    return null;
  }
  const row = await store.db
    .prepare(
      "SELECT i.r2_key AS r2_key, i.media_type AS media_type FROM images i JOIN messages m ON m.id = i.message" +
        " WHERE i.message = ? AND m.chat = ? AND i.idx = ?",
    )
    .bind(message, chat, index)
    .first<{ r2_key: string; media_type: string }>();
  const object = row ? await store.bucket.get(row.r2_key) : null;
  if (!row || !object) {
    return null;
  }
  if (isVideo(row.media_type)) {
    return { bytes: object.body, mediaType: row.media_type, size: object.size };
  }
  const image = await object.json<FeedbackImage>();
  return { bytes: Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0)), mediaType: image.media_type };
}

/** A chat's title and its agent side as it stands, before the runner replaces the side. */
export async function chatSide(
  store: FeedbackStore,
  chat: string,
): Promise<{ title: string; agent: AgentSide | null } | null> {
  const row = await chatRow(store, chat);
  return row ? { title: row.title, agent: row.agent ? (JSON.parse(row.agent) as AgentSide) : null } : null;
}

/**
 * One of the sender's chats removed with all it keeps: its messages and their screenshots' and videos' rows, the
 * agent's words, and the send receipts that name it. Answers the screenshots' and videos' R2 keys, for the caller to
 * remove; null when the chat is not the sender's.
 */
export async function deleteChat(store: FeedbackStore, chat: string): Promise<string[] | null> {
  if (!(await chatRow(store, chat))) {
    return null;
  }
  const { results } = await store.db
    .prepare("SELECT i.r2_key AS r2_key FROM images i JOIN messages m ON m.id = i.message WHERE m.chat = ?")
    .bind(chat)
    .all<{ r2_key: string }>();
  await store.db.batch([
    store.db.prepare("DELETE FROM uploads WHERE message IN (SELECT id FROM messages WHERE chat = ?)").bind(chat),
    store.db.prepare("DELETE FROM images WHERE message IN (SELECT id FROM messages WHERE chat = ?)").bind(chat),
    store.db.prepare("DELETE FROM messages WHERE chat = ?").bind(chat),
    store.db.prepare("DELETE FROM agent_messages WHERE chat = ?").bind(chat),
    store.db.prepare("DELETE FROM refs WHERE app = ? AND login = ? AND chat = ?").bind(store.app, store.login, chat),
    store.db.prepare("DELETE FROM chats WHERE id = ? AND app = ? AND login = ?").bind(chat, store.app, store.login),
  ]);
  return results.map((row) => row.r2_key);
}

export async function runnerAgent(store: FeedbackStore, chat: string, agent: AgentSide): Promise<404 | 200> {
  const before = await chatSide(store, chat);
  if (!before) {
    return 404;
  }
  const { results } = await store.db
    .prepare("SELECT id, text, at FROM agent_messages WHERE chat = ?")
    .bind(chat)
    .all<{ id: string; text: string; at: string | null }>();
  const held = new Map(results.map((row) => [row.id, row]));
  // Each new or changed message takes its own seq; the chat's state takes the last, when anything moved.
  const changed = agent.messages.filter((one) => {
    const known = held.get(one.id);
    return !known || known.text !== one.text || known.at !== one.at;
  });
  const was = before.agent;
  const stateMoved =
    !was ||
    was.isWorking !== agent.isWorking ||
    was.activity !== agent.activity ||
    (was.asks ?? false) !== (agent.asks ?? false) ||
    was.thread?.host !== agent.thread?.host ||
    was.thread?.id !== agent.thread?.id ||
    JSON.stringify(was.shipped ?? null) !== JSON.stringify(agent.shipped ?? null);
  const steps = changed.length + (changed.length || stateMoved ? 1 : 0);
  const writes: D1PreparedStatement[] = [];
  if (steps) {
    writes.push(store.db.prepare("UPDATE chats SET seq = seq + ? WHERE id = ?").bind(steps, chat));
    changed.forEach((one, index) =>
      writes.push(
        store.db
          .prepare(
            "INSERT INTO agent_messages (chat, id, seq, text, at) VALUES (?, ?, (SELECT seq FROM chats WHERE id = ?) - ?, ?, ?)" +
              " ON CONFLICT (chat, id) DO UPDATE SET seq = excluded.seq, text = excluded.text, at = excluded.at",
          )
          .bind(chat, one.id, chat, steps - 1 - index, one.text, one.at),
      ),
    );
  }
  writes.push(
    store.db
      .prepare(
        "UPDATE chats SET agent = ?, thread_host = ?, thread_id = ? WHERE id = ? AND app = ? AND login = ? AND kind = 'agent'",
      )
      .bind(JSON.stringify(agent), agent.thread?.host ?? null, agent.thread?.id ?? null, chat, store.app, store.login),
  );
  await store.db.batch(writes);
  return 200;
}

/**
 * Moves the chat's change counter on by one, the seq the change it goes with takes. With `only`, it moves only while
 * that message still has that status, so a claim or result that loses its race moves nothing.
 */
function bump(db: D1Database, chat: string, only?: { message: string; status: MessageStatus }): D1PreparedStatement {
  return only
    ? db
        .prepare(
          "UPDATE chats SET seq = seq + 1 WHERE id = ? AND EXISTS (SELECT 1 FROM messages WHERE id = ? AND chat = ? AND status = ?)",
        )
        .bind(chat, only.message, chat, only.status)
    : db.prepare("UPDATE chats SET seq = seq + 1 WHERE id = ?").bind(chat);
}
