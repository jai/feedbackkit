import type { FeedbackChat, FeedbackImage, FeedbackInput, FeedbackMessage, FeedbackStore, FeedbackThread } from "./feedback.ts";
import { issueThreadList, newId, titleOf } from "./feedback.ts";

/**
 * Feedback as GitHub issues (docs/worker.md): for a sender an app does not let build, new feedback opens a public
 * issue on the app's repo, and each reply in the app is a comment on it. Replies on GitHub come back to the
 * app's chat. The person's chats are kept in D1 (kind `issue`); the screenshots are public in R2, as the issue is.
 */

/** What the app shows above a new chat, so nobody sends what they would not post in public. */
export function issuesNotice(repo: string): string {
  return `Your feedback opens a public issue on github.com/${repo}, with your GitHub name and screenshots. Replies `
    + "there show here.";
}

/** Marks the comments this Worker wrote for the person, so a chat read does not show them twice. */
const OURS = "<!-- prhub-feedback -->";
/** An issue's comments, read 100 to a page: at most this many pages. */
const MAX_COMMENT_PAGES = 10;
const IMAGE_NAME = /^[0-9a-f]{32}\.(jpg|png)$/;

interface StoredIssueChat {
  id: string;
  title: string;
  createdAt: number;
  issue: { number: number; url: string };
}

interface StoredMessage {
  id: string;
  text: string;
  images: number;
  at: number;
}

/** GitHub, as this needs it: open an issue, comment on it, read its comments. */
export interface IssuesApi {
  open(title: string, body: string): Promise<{ number: number; url: string }>;
  comment(issue: number, body: string): Promise<void>;
  comments(issue: number): Promise<Array<{ id: number; body: string; login: string; at: string }>>;
}

/** The public screenshots: kept once, at a name nobody can guess, and served to anyone with the link. */
export interface ImageStore {
  put(name: string, image: FeedbackImage): Promise<void>;
}

export interface IssueFeedback {
  /** The person's chats. */
  store: FeedbackStore;
  images: ImageStore;
  issues: IssuesApi;
  /** The sender's GitHub login, named in the issue. */
  login: string;
  /** Where the screenshots are served: the Worker's origin. */
  origin: string;
  /** The screenshots' path on that origin. */
  imagePath: string;
  repo: string;
  now(): number;
}

export function isImageName(name: string): boolean {
  return IMAGE_NAME.test(name);
}

export function gitHubIssues(repo: string, token: string, fetcher: typeof fetch = fetch): IssuesApi {
  const call = async (path: string, init?: RequestInit) => {
    const response = await fetcher(`https://api.github.com/repos/${repo}/issues${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "pr-viewer",
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub issues ${path || "/"}: ${response.status}`);
    }
    return response.json();
  };
  return {
    async open(title, body) {
      const issue = await call("", { method: "POST", body: JSON.stringify({ title, body }) }) as
        { number: number; html_url: string };
      return { number: issue.number, url: issue.html_url };
    },
    async comment(issue, body) {
      await call(`/${issue}/comments`, { method: "POST", body: JSON.stringify({ body }) });
    },
    async comments(issue) {
      const all: Array<{ id: number; body: string; login: string; at: string }> = [];
      for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
        const list = await call(`/${issue}/comments?per_page=100&page=${page}`) as
          Array<{ id: number; body: string | null; user: { login: string } | null; created_at: string }>;
        all.push(...list.map((one) => ({
          id: one.id, body: one.body ?? "", login: one.user?.login ?? "ghost", at: one.created_at,
        })));
        if (list.length < 100) {
          break;
        }
      }
      return all;
    },
  };
}

async function pictures(context: IssueFeedback, images: FeedbackImage[]): Promise<string[]> {
  return Promise.all(images.map(async (image, index) => {
    const name = `${crypto.randomUUID().replaceAll("-", "")}.${image.media_type === "image/png" ? "png" : "jpg"}`;
    await context.images.put(name, image);
    return `![Screenshot ${index + 1}](${context.origin}${context.imagePath}${name})`;
  }));
}

function issueBody(text: string, images: string[], login: string, build: string | null): string {
  const from = `From @${login} in PRHub${build ? ` (build ${build})` : ""}.`;
  return [text, ...images, "---", from].filter(Boolean).join("\n\n");
}

export async function issueThreads(store: FeedbackStore): Promise<FeedbackThread[]> {
  return issueThreadList(store);
}

async function issueChatOf(store: FeedbackStore, chat: string): Promise<StoredIssueChat | null> {
  const row = await store.db.prepare(
    "SELECT id, title, created_at, issue_number, issue_url FROM chats WHERE id = ? AND app = ? AND login = ? AND kind = 'issue'",
  ).bind(chat, store.app, store.login).first<{ id: string; title: string; created_at: number; issue_number: number; issue_url: string }>();
  return row ? { id: row.id, title: row.title, createdAt: row.created_at, issue: { number: row.issue_number, url: row.issue_url } } : null;
}

async function messagesOf(store: FeedbackStore, id: string): Promise<StoredMessage[]> {
  const { results } = await store.db.prepare("SELECT id, text, images, at FROM messages WHERE chat = ? ORDER BY at, id")
    .bind(id).all<StoredMessage>();
  return results;
}

function insertMessage(store: FeedbackStore, chat: string, message: StoredMessage): D1PreparedStatement {
  return store.db.prepare("INSERT INTO messages (id, chat, at, text, images, status) VALUES (?, ?, ?, ?, ?, NULL)")
    .bind(message.id, chat, message.at, message.text, message.images);
}

/** A new chat when `chat` is null: it opens the issue. Else a comment on the chat's issue. Null: no such chat. */
export async function addIssueFeedback(
  context: IssueFeedback, chat: string | null, input: FeedbackInput,
): Promise<string | null> {
  const stored = chat ? await issueChatOf(context.store, chat) : null;
  if (chat && !stored) {
    return null;
  }
  const images = await pictures(context, input.images);
  const now = context.now();
  const message = { id: newId("m"), text: input.text, images: input.images.length, at: now };
  if (stored) {
    const body = [OURS, `**@${context.login}:** ${input.text}`, ...images].join("\n\n");
    await context.issues.comment(stored.issue.number, body);
    await insertMessage(context.store, stored.id, message).run();
    return stored.id;
  }
  const id = newId("fb");
  const title = titleOf(input.text);
  const issue = await context.issues.open(title, issueBody(input.text, images, context.login, input.build));
  const { store } = context;
  await store.db.batch([
    store.db.prepare(
      "INSERT INTO chats (id, app, login, kind, title, created_at, sender_name, issue_number, issue_url)"
        + " VALUES (?, ?, ?, 'issue', ?, ?, ?, ?, ?)",
    ).bind(id, store.app, store.login, title, now, store.name ?? null, issue.number, issue.url),
    insertMessage(store, id, message),
  ]);
  return id;
}

/** The person's messages, the issue's link, and what others wrote on GitHub, in time order. Null: no such chat. */
export async function issueChat(context: IssueFeedback, chat: string): Promise<FeedbackChat | null> {
  const stored = await issueChatOf(context.store, chat);
  if (!stored) {
    return null;
  }
  const [mine, comments] = await Promise.all([
    messagesOf(context.store, stored.id), context.issues.comments(stored.issue.number).catch(() => []),
  ]);
  const first = mine[0]?.at ?? stored.createdAt;
  const entries: Array<{ at: number; message: FeedbackMessage }> = [
    ...mine.map((one) => ({
      at: one.at, message: { id: one.id, role: "you" as const, text: one.text, anchor: null, images: one.images },
    })),
    {
      at: first + 1,
      message: {
        id: `issue-${stored.issue.number}`, role: "agent" as const, anchor: null, images: 0,
        text: `Opened [issue #${stored.issue.number}](${stored.issue.url}). Replies there show here.`,
      },
    },
    ...comments.filter((one) => !one.body.startsWith(OURS)).map((one) => ({
      at: Date.parse(one.at),
      message: { id: `c${one.id}`, role: "agent" as const, text: `**@${one.login}:** ${one.body}`, anchor: null, images: 0 },
    })),
  ];
  entries.sort((a, b) => a.at - b.at);
  return {
    id: stored.id, messages: entries.map(({ message }) => message), isWorking: false, activity: null, problem: null,
    costCents: null, model: null, effort: null, builderOnline: true, thread: null, shipped: null,
  };
}
