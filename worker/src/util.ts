export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** An app's key for one write: 1 to 100 characters, or none. A repeat answers as the first did. */
export function clientRefOf(input: unknown): string | null {
  const ref = (input as { client_ref?: unknown } | null)?.client_ref;
  return typeof ref === "string" && ref.length >= 1 && ref.length <= 100 ? ref : null;
}
