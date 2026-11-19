/**
 * FeedbackKit's live adapter (agentchatkit docs/live-protocol.md, our ACP v2 profile; the package
 * `@jai/agentchat-live` does `/v2/acp`, the rooms, replay and broadcast). A chat is a session: the person's messages are
 * `user_message`s carrying their delivery status, the agent's are `agent_message`s, and the chat's state is a
 * `state_update` (`builderOnline` and the coding thread in its `extra`).
 *
 * The cursor is the chat's change counter (`chats.seq`); every item carries the seq of its latest change. The state is
 * worked out on each read: when it differs from the one last sent, one conditional update gives it the next seq, so
 * changes no write makes (a delivery stuck for 15 minutes, the builder going offline) still reach the stream on the
 * room's 15 s refresh. FeedbackKit never queues and asks nothing: no `answer`, and `force` changes nothing.
 */
import {
  type ContentBlock,
  type LiveAdapter,
  type LiveRead,
  refuse,
  type SessionUpdate,
  type StateUpdate,
} from "@jai/agentchat-live";
import {
  addMessage,
  changePending,
  type FeedbackChat,
  feedbackChat,
  type FeedbackStore,
  isVideo,
  type MessageStatus,
  parseFeedbackInput,
  senderStore,
} from "./feedback.ts";

/** Who follows a chat, from their FeedbackKit token. Travels to the room as JSON. */
export interface LiveWho {
  app: string;
  login: string;
  name: string | null;
}

export interface LiveDeps {
  db: D1Database;
  bucket: R2Bucket;
  /** The token's sender, or null. */
  verify(request: Request): Promise<LiveWho | null>;
  /** A prompt was kept: wake the runner. */
  sent(who: LiveWho, chat: string): Promise<void>;
  now?: () => number;
}

/** At most this many messages in a read from start: the newest. */
const RETAINED = 200;

interface ChatRow {
  seq: number;
  state: string | null;
  state_seq: number;
  sender_name: string | null;
}

interface MessageRow {
  id: string;
  at: number;
  text: string;
  images: number;
  status: MessageStatus;
  detail: string | null;
  client_ref: string | null;
  seq: number;
}

interface ImageRow {
  message: string;
  idx: number;
  media_type: string;
  size: number | null;
  duration_ms: number | null;
}

interface AgentRow {
  id: string;
  text: string;
  at: string | null;
  seq: number;
}

export function liveAdapter(deps: LiveDeps): LiveAdapter<LiveWho> {
  const now = deps.now ?? Date.now;
  const store = (who: LiveWho): FeedbackStore => senderStore(deps.db, deps.bucket, who.app, who.login, who.name);
  const chatOf = (who: LiveWho, chat: string) =>
    deps.db
      .prepare(
        "SELECT seq, state, state_seq, sender_name FROM chats WHERE id = ? AND app = ? AND login = ? AND kind = 'agent'",
      )
      .bind(chat, who.app, who.login.toLowerCase())
      .first<ChatRow>();

  /** The state as it stands, with the seq of its own latest change: a new one when it moved since the last sent. */
  async function settle(
    who: LiveWho,
    chat: string,
    row: ChatRow,
    view: FeedbackChat,
  ): Promise<{ row: ChatRow; state: StateUpdate }> {
    const state: StateUpdate = {
      sessionUpdate: "state_update",
      state: view.isWorking ? "running" : "idle",
      _meta: {
        agentchatkit: {
          activity: view.activity,
          problem: view.problem,
          // `ended` only when true, so a chat that never ended keeps the state it had.
          extra: {
            builderOnline: view.builderOnline,
            thread: view.thread,
            shipped: view.shipped,
            ...(view.ended ? { ended: true } : {}),
          },
        },
      },
    };
    const text = JSON.stringify(state);
    for (let attempt = 0; attempt < 3 && text !== row.state; attempt += 1) {
      // Only the read that sees the old state moves it: a read racing it finds the new one and moves nothing.
      const moved = await deps.db
        .prepare(
          "UPDATE chats SET seq = seq + 1, state = ?, state_seq = seq + 1 WHERE id = ? AND state IS ? RETURNING seq, state, state_seq, sender_name",
        )
        .bind(text, chat, row.state)
        .first<ChatRow>();
      row = moved ?? (await chatOf(who, chat)) ?? row;
    }
    return { row, state };
  }

  function userMessage(
    chat: string,
    row: MessageRow,
    images: ImageRow[],
    who: LiveWho,
    name: string | null,
  ): SessionUpdate {
    const content: ContentBlock[] = row.text ? [{ type: "text", text: row.text }] : [];
    let pictures = 0;
    let videos = 0;
    for (const image of images) {
      const uri = `/v2/feedback/${chat}/images/${row.id}/${image.idx}`;
      if (isVideo(image.media_type)) {
        videos += 1;
        content.push({
          type: "resource_link",
          name: `Video ${videos}`,
          mimeType: image.media_type,
          uri,
          ...(image.size !== null ? { size: image.size } : {}),
          ...(image.duration_ms !== null ? { _meta: { agentchatkit: { durationMs: image.duration_ms } } } : {}),
        });
      } else {
        pictures += 1;
        content.push({ type: "resource_link", name: `Screenshot ${pictures}`, mimeType: image.media_type, uri });
      }
    }
    return {
      sessionUpdate: "user_message",
      messageId: row.id,
      content,
      _meta: {
        agentchatkit: {
          at: new Date(row.at).toISOString(),
          sender: { login: who.login.toLowerCase(), name: name ?? who.name },
          status: row.status,
          ...(row.client_ref ? { clientRef: row.client_ref } : {}),
          detail: row.detail,
        },
      },
    };
  }

  function agentMessage(row: AgentRow): SessionUpdate {
    return {
      sessionUpdate: "agent_message",
      messageId: row.id,
      content: [{ type: "text", text: row.text }],
      _meta: { agentchatkit: { at: row.at } },
    };
  }

  return {
    async authorize(request, chat) {
      const who = await deps.verify(request);
      if (!who) {
        return refuse(401, "Sign in again.");
      }
      // Another person's chat, an issue chat or none: the same answer, so nobody learns which chats exist.
      return (await chatOf(who, chat)) ? who : refuse(404, "No such chat.");
    },

    async read(who, chat, cursor): Promise<LiveRead> {
      const after = cursor === null ? null : /^\d{1,15}$/.test(cursor) ? Number(cursor) : NaN;
      let row = await chatOf(who, chat);
      if (!row || Number.isNaN(after) || (after !== null && after > row.seq)) {
        return { expired: true };
      }
      const view = await feedbackChat(store(who), chat, now());
      if (!view) {
        return { expired: true };
      }
      const settled = await settle(who, chat, row, view);
      row = settled.row;
      const since = after ?? -1;
      const [mine, theirs, images] = await Promise.all([
        deps.db
          .prepare(
            "SELECT id, at, text, images, status, detail, client_ref, seq FROM messages WHERE chat = ? AND seq > ? ORDER BY seq DESC LIMIT ?",
          )
          .bind(chat, since, RETAINED)
          .all<MessageRow>(),
        deps.db
          .prepare("SELECT id, text, at, seq FROM agent_messages WHERE chat = ? AND seq > ? ORDER BY seq DESC LIMIT ?")
          .bind(chat, since, RETAINED)
          .all<AgentRow>(),
        deps.db
          .prepare(
            "SELECT i.message AS message, i.idx AS idx, i.media_type AS media_type, i.size AS size," +
              " i.duration_ms AS duration_ms FROM images i JOIN messages m ON m.id = i.message" +
              " WHERE m.chat = ? AND m.seq > ? ORDER BY i.idx",
          )
          .bind(chat, since)
          .all<ImageRow>(),
      ]);
      const items = [
        ...mine.results.map((one) => ({
          seq: one.seq,
          update: userMessage(
            chat,
            one,
            images.results.filter((image) => image.message === one.id),
            who,
            row!.sender_name,
          ),
        })),
        ...theirs.results.map((one) => ({ seq: one.seq, update: agentMessage(one) })),
      ].sort((a, b) => a.seq - b.seq);
      // From start: the newest RETAINED, oldest first. After a cursor: everything, and the state when it moved.
      const kept = after === null ? items.slice(-RETAINED) : items;
      if (after !== null && row.state_seq > after) {
        kept.push({ seq: row.state_seq, update: settled.state });
        kept.sort((a, b) => a.seq - b.seq);
      }
      return {
        cursor: String(row.seq),
        updates: kept.map(({ seq, update }) => ({ cursor: String(seq), update })),
        state: settled.state,
        question: null,
      };
    },

    async prompt(who, chat, body) {
      const mine = store(who);
      if (body.clientRef) {
        const known = await deps.db
          .prepare("SELECT id FROM messages WHERE chat = ? AND client_ref = ?")
          .bind(chat, body.clientRef)
          .first<string>("id");
        if (known) {
          return { messageId: known, repeat: true };
        }
      }
      const input = parseFeedbackInput({
        text: body.prompt
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n\n"),
        images: body.prompt
          .filter((block) => block.type === "image")
          .map((block) => ({ media_type: block.mimeType, data: block.data })),
      });
      if (!input) {
        return refuse(400, "That message can't be sent: words, or up to four JPEG or PNG screenshots.");
      }
      const kept = await addMessage(mine, chat, input, now(), body.clientRef);
      if (!kept) {
        return refuse(404, "No such chat.");
      }
      await deps.sent(who, chat);
      return { messageId: kept.message, repeat: false };
    },

    async edit(who, chat, messageId, body) {
      if (body.prompt === undefined) {
        // Only `force`: FeedbackKit never queues, so a message still pending goes as soon as the runner takes it.
        const pending = await deps.db
          .prepare("SELECT 1 FROM messages WHERE id = ? AND chat = ? AND status = 'pending'")
          .bind(messageId, chat)
          .first();
        return pending ? messageId : refuse(409, "That message has gone to the agent already.");
      }
      if (body.prompt.some((block) => block.type !== "text")) {
        return refuse(400, "Only a message's words can be changed.");
      }
      const text = body.prompt
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n\n")
        .trim();
      if (!text || text.length > 8_000) {
        return refuse(400, "A message is 1 to 8,000 characters.");
      }
      return (await changePending(store(who), chat, messageId, { text }))
        ? messageId
        : refuse(409, "That message has gone to the agent already.");
    },

    async remove(who, chat, messageId) {
      return (await changePending(store(who), chat, messageId, "remove"))
        ? messageId
        : refuse(409, "That message has gone to the agent already.");
    },
  };
}
