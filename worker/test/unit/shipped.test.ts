import assert from "node:assert/strict";
import { test } from "node:test";
import { parseShipped, type Shipped } from "../../src/shipped.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

const SHIPPED: Shipped = {
  commits: [
    {
      sha: SHA,
      title: "Bigger clock",
      at: "2026-11-15T10:00:00Z",
      url: `https://github.com/acme/pager/commit/${SHA}`,
      ci: "success",
      release: {
        tag: "v1.2.0",
        name: "v1.2.0",
        url: "https://github.com/acme/pager/releases/tag/v1.2.0",
        prerelease: false,
      },
    },
  ],
  prs: [{ number: 7, title: "Bigger clock", url: "https://github.com/acme/pager/pull/7", state: "merged", ci: null }],
};

test("shipped is checked part by part: commits, pull requests, releases and links to GitHub", () => {
  assert.deepEqual(parseShipped(SHIPPED), SHIPPED);
  assert.deepEqual(parseShipped({ commits: [], prs: [] }), { commits: [], prs: [] });
  const commit = SHIPPED.commits[0];
  for (const bad of [
    { commits: "no", prs: [] },
    { commits: [{ ...commit, sha: "abc" }], prs: [] },
    { commits: [{ ...commit, url: "https://example.com/x" }], prs: [] },
    { commits: [{ ...commit, ci: "green" }], prs: [] },
    { commits: [{ ...commit, at: "soon" }], prs: [] },
    { commits: [{ ...commit, release: { tag: "", name: "x", url: commit.url, prerelease: false } }], prs: [] },
    { commits: Array(21).fill(commit), prs: [] },
    { commits: [], prs: [{ ...SHIPPED.prs[0], state: "draft" }] },
    { commits: [], prs: [{ ...SHIPPED.prs[0], number: 0 }] },
  ]) {
    assert.equal(parseShipped(bad), undefined, JSON.stringify(bad).slice(0, 80));
  }
});
