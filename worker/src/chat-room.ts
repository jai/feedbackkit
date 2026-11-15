/**
 * Live mode (docs/api.md#live): while a chat is open in the app, the app holds a WebSocket to that chat's room, one
 * Durable Object per chat (`CHAT_ROOMS`, named by the chat id). The room sends the chat as it stands on connect, and
 * again each time the Worker says it changed: a message kept, claimed, delivered or failed, or the agent's side. The
 * sockets hibernate between changes, so an open chat costs nothing while nothing happens. Closed chats rely on pushes.
 */
import { type FeedbackChat, feedbackChat, senderStore } from "./feedback.ts";

/** What a room needs of the Worker's bindings. */
export interface RoomEnv {
  DB: D1Database;
  FEEDBACK: R2Bucket;
}

/** Whose chat a socket watches. */
interface Watching {
  app: string;
  login: string;
  chat: string;
}

/** What the app gets on the socket. A `ping` text frame gets `pong` without waking the room. */
export interface LiveFrame {
  type: "chat";
  chat: FeedbackChat;
}

export class ChatRoom {
  private readonly state: DurableObjectState;
  private readonly env: RoomEnv;

  constructor(state: DurableObjectState, env: RoomEnv) {
    this.state = state;
    this.env = env;
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const watching = watchingOf(request);
    if (!watching) {
      return new Response("who?\n", { status: 400 });
    }
    if (pathname === "/connect") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("a WebSocket upgrade, please\n", { status: 426 });
      }
      const [client, server] = Object.values(new WebSocketPair());
      this.state.acceptWebSocket(server);
      server.serializeAttachment(watching);
      const frame = await this.frame(watching);
      if (frame) {
        server.send(frame);
      }
      return new Response(null, { status: 101, webSocket: client });
    }
    if (pathname === "/changed") {
      return Response.json({ sent: await this.broadcast(watching) });
    }
    return new Response("not found\n", { status: 404 });
  }

  /** The chat to every socket in the room; how many got it. No socket: no read at all. */
  async broadcast(watching: Watching): Promise<number> {
    const sockets = this.state.getWebSockets();
    if (sockets.length === 0) {
      return 0;
    }
    const frame = await this.frame(watching);
    if (!frame) {
      return 0;
    }
    let sent = 0;
    for (const socket of sockets) {
      try {
        socket.send(frame);
        sent += 1;
      } catch {
        // A socket closing as we send: its close handler tidies it.
      }
    }
    return sent;
  }

  private async frame({ app, login, chat }: Watching): Promise<string | null> {
    const view = await feedbackChat(senderStore(this.env.DB, this.env.FEEDBACK, app, login), chat, Date.now());
    return view ? JSON.stringify({ type: "chat", chat: view } satisfies LiveFrame) : null;
  }

  webSocketMessage(): void {
    // The app only listens; its pings are answered without waking the room.
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason);
  }
}

function watchingOf(request: Request): Watching | null {
  const app = request.headers.get("X-FeedbackKit-App");
  const login = request.headers.get("X-FeedbackKit-Login");
  const chat = request.headers.get("X-FeedbackKit-Chat");
  return app && login && chat ? { app, login, chat } : null;
}

function headers({ app, login, chat }: Watching): Record<string, string> {
  return { "X-FeedbackKit-App": app, "X-FeedbackKit-Login": login.toLowerCase(), "X-FeedbackKit-Chat": chat };
}

/** The chat's room: the app's socket goes on to it. */
export function connectRoom(namespace: DurableObjectNamespace, watching: Watching, request: Request): Promise<Response> {
  return namespace.get(namespace.idFromName(watching.chat)).fetch("https://chat-room/connect", {
    headers: { ...headers(watching), Upgrade: request.headers.get("Upgrade") ?? "" },
  });
}

/** Tells the chat's room it changed. A failure is logged, never answered: the app's next read shows it anyway. */
export async function chatChanged(namespace: DurableObjectNamespace | undefined, watching: Watching): Promise<void> {
  if (!namespace) {
    return;
  }
  try {
    await namespace.get(namespace.idFromName(watching.chat)).fetch("https://chat-room/changed", {
      method: "POST", headers: headers(watching),
    });
  } catch (error) {
    console.error("chat room not told", error);
  }
}
