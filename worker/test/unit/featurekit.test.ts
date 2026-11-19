import assert from "node:assert/strict";
import { test } from "node:test";
import { parseApps, roleOf } from "../../src/featurekit.ts";

const APPS = JSON.stringify({
  prhub: { repo: "acme/app", owners: ["Octocat"], builders: ["hubot"], issues: true },
  pager: { repo: "acme/pager", owners: ["octocat"] },
});

test("each app says who builds: owners ship, builders open a PR, everyone else files an issue", () => {
  const apps = parseApps(APPS);
  assert.equal(roleOf(apps.prhub, "octocat"), "owner");
  assert.equal(roleOf(apps.prhub, "HUBOT"), "builder");
  assert.equal(roleOf(apps.prhub, "someone"), "issue");
  assert.equal(roleOf(apps.pager, "someone"), null);
});
