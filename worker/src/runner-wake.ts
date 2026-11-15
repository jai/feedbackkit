/**
 * The runner's long poll (docs/worker.md#the-runners-messages). One Durable Object, `RUNNER_WAKE` named "runner",
 * counts the messages sent to an agent. The runner holds `/runner/wait` open with the count it last saw; a new message
 * answers it at once, so the message reaches its coding thread in about a second rather than at the next 15 s poll.
 *
 * The count lives in memory only. When the object restarts, it starts again at a different number, so a runner that
 * was waiting wakes once for nothing: a harmless extra poll, never a missed message. The runner still polls every
 * 15 s as well.
 */

/** The longest a wait is held (the runner's WAIT_SECONDS). */
export const WAIT_MS = 25_000;

const NAME = "runner";

type Waiter = (seq: number) => void;

export class RunnerWake {
  private seq = Date.now();
  private waiters = new Set<Waiter>();

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/wake") {
      return Response.json({ seq: this.wake() });
    }
    const body = (await request.json().catch(() => null)) as { since?: unknown; ms?: unknown } | null;
    const since = typeof body?.since === "number" ? body.since : null;
    const ms = typeof body?.ms === "number" ? Math.max(0, Math.min(body.ms, WAIT_MS)) : WAIT_MS;
    return Response.json({ seq: await this.wait(since, ms) });
  }

  /** One more message: every wait answers now. */
  wake(): number {
    this.seq += 1;
    for (const waiter of this.waiters) {
      waiter(this.seq);
    }
    this.waiters.clear();
    return this.seq;
  }

  /** The count, at once when it is not `since`; else at the next wake or after `ms`. */
  wait(since: number | null, ms: number): Promise<number> {
    if (since !== this.seq || ms <= 0) {
      return Promise.resolve(this.seq);
    }
    return new Promise((resolve) => {
      const done: Waiter = (seq) => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(seq);
      };
      const timer = setTimeout(() => done(this.seq), ms);
      this.waiters.add(done);
    });
  }
}

/** The one runner-wake object. */
export function runnerWake(namespace: DurableObjectNamespace): DurableObjectStub {
  return namespace.get(namespace.idFromName(NAME));
}

/** Wakes the runner after a message was kept. A failure is logged, never answered: the message is safe in R2, and the
 * runner's 15 s poll finds it anyway. */
export async function wakeRunner(namespace: DurableObjectNamespace | undefined): Promise<void> {
  if (!namespace) {
    return;
  }
  try {
    await runnerWake(namespace).fetch("https://runner-wake/wake", { method: "POST" });
  } catch (error) {
    console.error("runner wake failed", error);
  }
}
