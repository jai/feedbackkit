/**
 * The move from R2 to D1 (docs/worker.md#storage): every sender's chats, messages, delivery states, agent sides,
 * screenshots' places, receipts, issue chats and issue opens, read from the R2 keys the Worker wrote before D1 and
 * written to D1. R2 is only read: it stays as the backup.
 *
 * It can run any number of times. A chat, screenshot or receipt already in D1 is kept. A message's status only moves
 * forward (pending, delivering, then delivered or failed), and an agent side only replaces an older one, so a second
 * run picks up what changed in R2 since the first and never undoes what the runner has done in D1 since.
 */
import type { AgentSide, FeedbackImage, FeedbackThread, StoredMessage } from "./feedback.ts";
import { titleOf } from "./feedback.ts";

const SENDER = /^apps\/([a-z][a-z0-9-]{0,39})\/users\/([a-z0-9-]{1,39})\/(.*)$/;
const AGENT_MESSAGE = /^feedback\/chats\/(fb_[0-9a-f]{16})\/m\/\d+-(m_[0-9a-f]{16})\.json$/;
const AGENT_IMAGE = /^feedback\/chats\/(fb_[0-9a-f]{16})\/img\/(m_[0-9a-f]{16})\/(\d+)\.json$/;
const AGENT_SIDE = /^feedback\/chats\/(fb_[0-9a-f]{16})\/agent\.json$/;
const ISSUE_CHAT = /^feedback\/issues\/(fb_[0-9a-f]{16})\/chat\.json$/;
const ISSUE_MESSAGE = /^feedback\/issues\/(fb_[0-9a-f]{16})\/m\/\d+-(m_[0-9a-f]{16})\.json$/;
const AGENT_REF = /^refs\/([0-9a-f]{64})\.json$/;
const ISSUE_REF = /^feedback\/refs\/(.{1,200})\.json$/;
const CHATS_LIST = "feedback/chats.json";
const BEAT = "feedback/runner.json";
const QUOTA = "feedback/issue-quota.json";
const PENDING = "feedback/pending/";

/** How far along a status is: a status only ever moves to a higher one. */
const RANK =
  "CASE {s} WHEN 'pending' THEN 0 WHEN 'delivering' THEN 1 WHEN 'delivered' THEN 2 WHEN 'failed' THEN 2 ELSE -1 END";
const rank = (column: string) => RANK.replace("{s}", column);

export interface SenderCounts {
  chats: number;
  issueChats: number;
  messages: number;
  statuses: Record<string, number>;
  images: number;
  refs: number;
  withThread: number;
}

export interface MigrationReport {
  /** Keys read, and those left alone because nothing in D1 holds them (with why). */
  keys: number;
  skipped: Array<{ key: string; why: string }>;
  r2: Record<string, SenderCounts>;
  d1: Record<string, SenderCounts>;
}

interface IssueChatObject {
  id: string;
  title: string;
  createdAt: string;
  issue: { number: number; url: string };
}

function empty(): SenderCounts {
  return { chats: 0, issueChats: 0, messages: 0, statuses: {}, images: 0, refs: 0, withThread: 0 };
}

async function allKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

async function read<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  return object ? await object.json<T>() : null;
}

export async function migrate(bucket: R2Bucket, db: D1Database): Promise<MigrationReport> {
  const keys = (await allKeys(bucket, "apps/")).sort();
  const report: MigrationReport = { keys: keys.length, skipped: [], r2: {}, d1: {} };
  const bySender = new Map<string, { app: string; login: string; rest: string[] }>();
  for (const key of keys) {
    const match = SENDER.exec(key);
    if (!match) {
      report.skipped.push({ key, why: "not under apps/<app>/users/<login>/" });
      continue;
    }
    const [, app, login, rest] = match;
    const id = `${app}/${login}`;
    if (!bySender.has(id)) {
      bySender.set(id, { app, login, rest: [] });
    }
    bySender.get(id)!.rest.push(rest);
  }
  for (const [id, { app, login, rest }] of bySender) {
    report.r2[id] = await migrateSender(bucket, db, app, login, rest, report);
    report.d1[id] = await d1Counts(db, app, login);
  }
  return report;
}

async function migrateSender(
  bucket: R2Bucket,
  db: D1Database,
  app: string,
  login: string,
  rest: string[],
  report: MigrationReport,
): Promise<SenderCounts> {
  const prefix = `apps/${app}/users/${login}/`;
  const counts = empty();
  const listed = (await read<FeedbackThread[]>(bucket, `${prefix}${CHATS_LIST}`)) ?? [];
  const titles = new Map(listed.map((thread) => [thread.id, thread]));
  // Agent chats: every chat with a message, titled from the list (else its first message).
  const messages = new Map<string, Array<{ key: string; id: string }>>();
  for (const key of rest) {
    const found = AGENT_MESSAGE.exec(key);
    if (found) {
      messages.set(found[1], [...(messages.get(found[1]) ?? []), { key, id: found[2] }]);
    }
  }
  for (const [chat, keys] of messages) {
    const stored = (await Promise.all(keys.map(({ key }) => read<StoredMessage>(bucket, `${prefix}${key}`))))
      .filter((one): one is StoredMessage => one !== null)
      .sort((a, b) => a.at - b.at);
    const first = stored[0];
    const listedChat = titles.get(chat);
    await db
      .prepare("INSERT OR IGNORE INTO chats (id, app, login, kind, title, created_at) VALUES (?, ?, ?, 'agent', ?, ?)")
      .bind(
        chat,
        app,
        login,
        listedChat?.title ?? titleOf(first?.text ?? ""),
        listedChat ? Date.parse(listedChat.createdAt) : (first?.at ?? 0),
      )
      .run();
    counts.chats += 1;
    await db.batch(
      stored.map((message) =>
        db
          .prepare(
            "INSERT INTO messages (id, chat, at, text, build, images, first, status, claimed_at, detail)" +
              " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET status = excluded.status," +
              " claimed_at = excluded.claimed_at, detail = excluded.detail" +
              ` WHERE ${rank("excluded.status")} > ${rank("messages.status")}`,
          )
          .bind(
            message.id,
            chat,
            message.at,
            message.text,
            message.build,
            message.images,
            message.first ? 1 : 0,
            message.status,
            message.claimedAt,
            message.detail,
          ),
      ),
    );
    for (const message of stored) {
      counts.messages += 1;
      counts.statuses[message.status] = (counts.statuses[message.status] ?? 0) + 1;
    }
  }
  for (const thread of listed) {
    if (!messages.has(thread.id)) {
      report.skipped.push({ key: `${prefix}${CHATS_LIST} ${thread.id}`, why: "listed, but no message under it" });
    }
  }
  for (const key of rest) {
    const image = AGENT_IMAGE.exec(key);
    if (image) {
      const [, chat, message, index] = image;
      if (!messages.has(chat)) {
        report.skipped.push({ key: `${prefix}${key}`, why: "a screenshot of a chat with no message" });
        continue;
      }
      counts.images += 1;
      const known = await db
        .prepare("SELECT 1 FROM images WHERE message = ? AND idx = ?")
        .bind(message, Number(index))
        .first();
      if (!known) {
        const body = await read<FeedbackImage>(bucket, `${prefix}${key}`);
        await db
          .prepare("INSERT OR IGNORE INTO images (message, idx, r2_key, media_type) VALUES (?, ?, ?, ?)")
          .bind(message, Number(index), `${prefix}${key}`, body?.media_type ?? "image/jpeg")
          .run();
      }
      continue;
    }
    const side = AGENT_SIDE.exec(key);
    if (side) {
      const agent = await read<AgentSide>(bucket, `${prefix}${key}`);
      if (agent) {
        if (agent.thread) {
          counts.withThread += 1;
        }
        await db
          .prepare(
            "UPDATE chats SET agent = ?, thread_host = ?, thread_id = ? WHERE id = ? AND app = ? AND login = ?" +
              " AND (agent IS NULL OR json_extract(agent, '$.updatedAt') < ?)",
          )
          .bind(
            JSON.stringify(agent),
            agent.thread?.host ?? null,
            agent.thread?.id ?? null,
            side[1],
            app,
            login,
            agent.updatedAt,
          )
          .run();
      }
      continue;
    }
    const ref = AGENT_REF.exec(key) ?? ISSUE_REF.exec(key);
    if (ref) {
      const chat = (await read<{ chat: string }>(bucket, `${prefix}${key}`))?.chat;
      if (chat) {
        counts.refs += 1;
        await db
          .prepare("INSERT OR IGNORE INTO refs (app, login, key, chat) VALUES (?, ?, ?, ?)")
          .bind(app, login, ref[1], chat)
          .run();
      }
      continue;
    }
    const issue = ISSUE_CHAT.exec(key);
    if (issue) {
      const chat = await read<IssueChatObject>(bucket, `${prefix}${key}`);
      if (chat) {
        counts.issueChats += 1;
        await db
          .prepare(
            "INSERT OR IGNORE INTO chats (id, app, login, kind, title, created_at, issue_number, issue_url)" +
              " VALUES (?, ?, ?, 'issue', ?, ?, ?, ?)",
          )
          .bind(chat.id, app, login, chat.title, Date.parse(chat.createdAt), chat.issue.number, chat.issue.url)
          .run();
      }
      continue;
    }
    if (key === QUOTA) {
      const opens = (await read<number[]>(bucket, `${prefix}${key}`)) ?? [];
      const known = await db
        .prepare("SELECT count(*) AS n FROM issue_opens WHERE app = ? AND login = ?")
        .bind(app, login)
        .first<number>("n");
      if (!known && opens.length) {
        await db.batch(
          opens.map((at) =>
            db.prepare("INSERT INTO issue_opens (app, login, at) VALUES (?, ?, ?)").bind(app, login, at),
          ),
        );
      }
      continue;
    }
    if (key === BEAT) {
      const beat = await read<{ at: number; orca: boolean; detail?: string | null }>(bucket, `${prefix}${key}`);
      if (beat) {
        await db
          .prepare(
            "INSERT INTO runner_beat (id, at, orca, detail) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET" +
              " at = excluded.at, orca = excluded.orca, detail = excluded.detail WHERE excluded.at > runner_beat.at",
          )
          .bind(beat.at, beat.orca ? 1 : 0, beat.detail ?? null)
          .run();
      }
      continue;
    }
    // A pending marker is only the old queue's index: each message's own status says the same.
    if (!AGENT_MESSAGE.test(key) && !ISSUE_MESSAGE.test(key) && key !== CHATS_LIST && !key.startsWith(PENDING)) {
      report.skipped.push({ key: `${prefix}${key}`, why: "not a kind the Worker serves" });
    }
  }
  // Issue messages last: their chats are in by now.
  for (const key of rest) {
    const found = ISSUE_MESSAGE.exec(key);
    if (found) {
      const message = await read<{ id: string; text: string; images: number; at: number }>(bucket, `${prefix}${key}`);
      if (message) {
        counts.messages += 1;
        await db
          .prepare("INSERT OR IGNORE INTO messages (id, chat, at, text, images, status) VALUES (?, ?, ?, ?, ?, NULL)")
          .bind(message.id, found[1], message.at, message.text, message.images)
          .run();
      }
    }
  }
  return counts;
}

/** The same counts, read back from D1. */
export async function d1Counts(db: D1Database, app: string, login: string): Promise<SenderCounts> {
  const counts = empty();
  const chats = await db
    .prepare(
      "SELECT kind, count(*) AS n, count(thread_id) AS threads FROM chats WHERE app = ? AND login = ? GROUP BY kind",
    )
    .bind(app, login)
    .all<{ kind: string; n: number; threads: number }>();
  for (const row of chats.results) {
    if (row.kind === "agent") {
      counts.chats = row.n;
      counts.withThread = row.threads;
    } else {
      counts.issueChats = row.n;
    }
  }
  const statuses = await db
    .prepare(
      "SELECT coalesce(m.status, 'issue') AS status, count(*) AS n, sum(m.images) AS images FROM messages m" +
        " JOIN chats c ON c.id = m.chat WHERE c.app = ? AND c.login = ? GROUP BY m.status",
    )
    .bind(app, login)
    .all<{ status: string; n: number; images: number }>();
  for (const row of statuses.results) {
    counts.messages += row.n;
    if (row.status !== "issue") {
      counts.statuses[row.status] = row.n;
    }
  }
  counts.images =
    (await db
      .prepare(
        "SELECT count(*) AS n FROM images i JOIN messages m ON m.id = i.message JOIN chats c ON c.id = m.chat" +
          " WHERE c.app = ? AND c.login = ? AND c.kind = 'agent'",
      )
      .bind(app, login)
      .first<number>("n")) ?? 0;
  counts.refs =
    (await db
      .prepare("SELECT count(*) AS n FROM refs WHERE app = ? AND login = ?")
      .bind(app, login)
      .first<number>("n")) ?? 0;
  return counts;
}
