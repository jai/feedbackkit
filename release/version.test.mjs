import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextVersion, parseCommit, releaseNotes } from './version.mjs';

test('reads a Conventional Commit header and its breaking marks', () => {
  assert.deepEqual(parseCommit('feat(worker): add the trips app\n\nRefs jai/trips#232'), {
    type: 'feat', scope: 'worker', subject: 'add the trips app', breaking: false,
  });
  assert.equal(parseCommit('feat!: Feedback names').breaking, true);
  assert.equal(parseCommit('fix: x\n\nBREAKING CHANGE: y').breaking, true);
  assert.equal(parseCommit('Merge branch main'), null);
});

test('before 1.0.0 a feat or a breaking change bumps the minor, a fix the patch', () => {
  assert.equal(nextVersion('v0.2.0', ['feat(demo): a demo app', 'docs: readme']), 'v0.3.0');
  assert.equal(nextVersion('v0.2.0', ['feat!: rename']), 'v0.3.0');
  assert.equal(nextVersion('v0.2.3', ['fix: crash', 'chore: deps']), 'v0.2.4');
});

test('from 1.0.0 a breaking change bumps the major', () => {
  assert.equal(nextVersion('v1.4.2', ['refactor!: drop the old names']), 'v2.0.0');
  assert.equal(nextVersion('v1.4.2', ['feat: x']), 'v1.5.0');
});

test('nothing to release without a feat, fix or breaking change', () => {
  assert.equal(nextVersion('v0.2.0', ['docs: x', 'ci: y', 'test(demo): z']), null);
  assert.equal(nextVersion('v0.2.0', []), null);
});

test('notes list breaking changes, features and fixes, and the compare link', () => {
  const notes = releaseNotes(['feat(demo): a demo app', 'ci: e2e', 'fix: a crash', 'feat!: rename'], {
    repo: 'jai/feedbackkit', from: 'v0.2.0', to: 'v0.3.0',
  });
  assert.equal(notes, [
    '### Breaking changes\n\n- rename',
    '### Features\n\n- **demo:** a demo app',
    '### Fixes\n\n- a crash',
    '**Changes:** https://github.com/jai/feedbackkit/compare/v0.2.0...v0.3.0\n',
  ].join('\n\n'));
});

test('only the package cuts a version', async () => {
  const { PACKAGE_PATHS } = await import('./version.mjs');
  assert.deepEqual(PACKAGE_PATHS, ['Sources', 'Package.swift', 'Package.resolved']);
});
