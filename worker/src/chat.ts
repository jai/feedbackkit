/** A chat as the apps draw it: the same shape as PRHub's Ask AI chat, so one chat view serves both. */
export interface ChatMessage {
  id: string;
  role: "you" | "agent";
  text: string;
  /** `path:line`, on a question about one line. Feedback never has one. */
  anchor: string | null;
}

export interface Chat {
  messages: ChatMessage[];
  isWorking: boolean;
  /** What the agent is doing right now, in a few words. */
  activity: string | null;
  /** Why it stopped short of an answer. */
  problem: string | null;
  costCents: number | null;
  model: string | null;
  effort: string | null;
}
