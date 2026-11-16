/**
 * What a chat's feedback shipped (docs/api.md#shipped): the commits its agent landed on main, the pull requests it
 * opened, and the first release that carries each commit. The runner finds them (runner/README.md) and sends them with
 * the agent's side; the app shows them on the chat's row and in its header.
 */

/** A check's outcome: `pending` while any check runs, `failure` when any failed, else `success`; null: no checks. */
export type CiState = "pending" | "success" | "failure";

/** The first published GitHub Release whose tag contains the commit. */
export interface ShippedRelease {
  tag: string;
  name: string;
  url: string;
  prerelease: boolean;
}

export interface ShippedCommit {
  sha: string;
  title: string;
  /** ISO 8601, the commit's date; null when git gave none. */
  at: string | null;
  url: string;
  ci: CiState | null;
  /** None yet: on main, in no release. */
  release: ShippedRelease | null;
}

export interface ShippedPullRequest {
  number: number;
  title: string;
  url: string;
  state: "open" | "merged" | "closed";
  ci: CiState | null;
}

export interface Shipped {
  commits: ShippedCommit[];
  prs: ShippedPullRequest[];
}

export const MAX_SHIPPED_COMMITS = 20;
export const MAX_SHIPPED_PRS = 10;
const SHA = /^[0-9a-f]{40}$/;
const GITHUB = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/[\w./%-]+$/;
const CI = new Set(["pending", "success", "failure"]);
const PR_STATES = new Set(["open", "merged", "closed"]);

const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const ci = (value: unknown): value is CiState | null => value === null || (typeof value === "string" && CI.has(value));
const link = (value: unknown): value is string => text(value, 300) && GITHUB.test(value);

function release(value: unknown): ShippedRelease | null | undefined {
  if (value === null) {
    return null;
  }
  const { tag, name, url, prerelease } = (value ?? {}) as Record<string, unknown>;
  return text(tag, 100) && tag && text(name, 200) && link(url) && typeof prerelease === "boolean"
    ? { tag, name, url, prerelease }
    : undefined;
}

/** The runner's `shipped`; undefined when any part of it is not as above (the whole side is then refused). */
export function parseShipped(value: unknown): Shipped | undefined {
  const { commits, prs } = (value ?? {}) as Record<string, unknown>;
  if (
    !Array.isArray(commits) ||
    commits.length > MAX_SHIPPED_COMMITS ||
    !Array.isArray(prs) ||
    prs.length > MAX_SHIPPED_PRS
  ) {
    return undefined;
  }
  const shipped: Shipped = { commits: [], prs: [] };
  for (const item of commits) {
    const { sha, title, at, url, ci: state, release: carried } = (item ?? {}) as Record<string, unknown>;
    const kept = release(carried);
    if (
      typeof sha !== "string" ||
      !SHA.test(sha) ||
      !text(title, 300) ||
      !link(url) ||
      !ci(state) ||
      kept === undefined ||
      (at !== null && (typeof at !== "string" || Number.isNaN(Date.parse(at))))
    ) {
      return undefined;
    }
    shipped.commits.push({ sha, title, at: at as string | null, url, ci: state, release: kept });
  }
  for (const item of prs) {
    const { number, title, url, state, ci: checks } = (item ?? {}) as Record<string, unknown>;
    if (
      !Number.isInteger(number) ||
      (number as number) < 1 ||
      !text(title, 300) ||
      !link(url) ||
      typeof state !== "string" ||
      !PR_STATES.has(state) ||
      !ci(checks)
    ) {
      return undefined;
    }
    shipped.prs.push({ number: number as number, title, url, state: state as ShippedPullRequest["state"], ci: checks });
  }
  return shipped;
}
