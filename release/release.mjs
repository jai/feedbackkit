// The hourly release (.github/workflows/release.yml). Releases the newest commit on main whose `ci` run passed, when
// the commits since the last tag hold a feat, fix or breaking change (version.mjs), and no release went out in the
// last hour. Publishes the tag and GitHub Release through the API. If the newest finished `ci` run is red, nothing.
// `node release/release.mjs --dry-run` prints what it would release without publishing.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { nextVersion, releaseNotes } from './version.mjs';

const repo = process.env.GITHUB_REPOSITORY ?? 'jai/feedbackkit';
const token = process.env.GITHUB_TOKEN;
const dryRun = process.argv.includes('--dry-run');
const HOUR = 3600;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

async function github(path, init = {}) {
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

function say(line) {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

/** The newest commit since `tag` whose push `ci` run finished: its SHA if it passed, null if it failed or none did. */
async function greenHead(tag) {
  for (const sha of git('rev-list', '--first-parent', `${tag}..HEAD`).split('\n').filter(Boolean)) {
    const { workflow_runs: runs } = await github(`/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push`);
    const finished = runs.filter((run) => run.status === 'completed');
    if (!finished.length) continue;
    if (finished[0].conclusion === 'success') return sha;
    say(`ci on ${sha.slice(0, 7)} is ${finished[0].conclusion}: ${finished[0].html_url}. Nothing released.`);
    return null;
  }
  say(`No finished green ci run since ${tag}. Nothing released.`);
  return null;
}

const tag = git('tag', '--merged', 'HEAD', '--list', 'v*', '--sort=-v:refname').split('\n')[0];
if (!tag) throw new Error('no v* tag on main');
const age = Math.floor(Date.now() / 1000) - Number(git('for-each-ref', '--format=%(creatordate:unix)', `refs/tags/${tag}`));
if (age < HOUR) {
  say(`${tag} went out ${Math.round(age / 60)} minutes ago; at most one release an hour. Nothing released.`);
  process.exit(0);
}

const sha = await greenHead(tag);
if (!sha) process.exit(0);
const messages = git('log', '--format=%B%x00', `${tag}..${sha}`).split('\0').map((m) => m.trim()).filter(Boolean);
const version = nextVersion(tag, messages);
if (!version) {
  say(`No feat, fix or breaking change since ${tag}. Nothing released.`);
  process.exit(0);
}

const body = releaseNotes(messages, { repo, from: tag, to: version });
if (dryRun) {
  say(`Would release ${version} at ${sha.slice(0, 7)}:\n\n${body}`);
  process.exit(0);
}
const release = await github('/releases', {
  method: 'POST',
  body: JSON.stringify({ tag_name: version, target_commitish: sha, name: version, body }),
});
say(`Released [${version}](${release.html_url}) at ${sha.slice(0, 7)}.`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nurl=${release.html_url}\n`);
