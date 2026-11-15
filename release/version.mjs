// The next version from Conventional Commits, and the release notes. Pure: release.mjs does the git and GitHub work.

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?: (?<subject>.+)$/;

/** One commit's message, read as a Conventional Commit; null when its first line is not one. */
export function parseCommit(message) {
  const [header, ...body] = message.trim().split('\n');
  const match = HEADER.exec(header.trim());
  if (!match) return null;
  const { type, scope, bang, subject } = match.groups;
  const breaking = Boolean(bang) || body.some((line) => /^BREAKING[ -]CHANGE: /.test(line));
  return { type, scope: scope || null, subject, breaking };
}

/** major, minor, patch or null (nothing to release). Before 1.0.0 a breaking change bumps the minor, as a feat does. */
export function bumpFor(commits, current) {
  const parsed = commits.map(parseCommit).filter(Boolean);
  const preOne = current.major === 0;
  if (parsed.some((c) => c.breaking)) return preOne ? 'minor' : 'major';
  if (parsed.some((c) => c.type === 'feat')) return 'minor';
  if (parsed.some((c) => c.type === 'fix' || c.type === 'perf')) return 'patch';
  return null;
}

/** What apps get from a release: the package. Commits touching nothing here (Demo/, runner/, worker/, docs) never
 * cut a version. */
export const PACKAGE_PATHS = ['Sources', 'Package.swift', 'Package.resolved'];

export function parseVersion(tag) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!match) throw new Error(`not a version: ${tag}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function nextVersion(tag, commits) {
  const current = parseVersion(tag);
  const bump = bumpFor(commits, current);
  if (!bump) return null;
  if (bump === 'major') return `v${current.major + 1}.0.0`;
  if (bump === 'minor') return `v${current.major}.${current.minor + 1}.0`;
  return `v${current.major}.${current.minor}.${current.patch + 1}`;
}

/** Markdown notes: breaking changes, features, fixes; other commit types are left out. */
export function releaseNotes(commits, { repo, from, to }) {
  const sections = [
    ['Breaking changes', (c) => c.breaking],
    ['Features', (c) => !c.breaking && c.type === 'feat'],
    ['Fixes', (c) => !c.breaking && (c.type === 'fix' || c.type === 'perf')],
  ];
  const parsed = commits.map((message) => parseCommit(message)).filter(Boolean);
  const out = [];
  for (const [title, test] of sections) {
    const lines = parsed.filter(test).map((c) => `- ${c.scope ? `**${c.scope}:** ` : ''}${c.subject}`);
    if (lines.length) out.push(`### ${title}\n\n${lines.join('\n')}`);
  }
  out.push(`**Changes:** https://github.com/${repo}/compare/${from}...${to}`);
  return out.join('\n\n') + '\n';
}
