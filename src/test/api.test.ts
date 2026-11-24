import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cleanContext, MAX_CONTEXT_CHARS } from '../api';
import { exactRepoRoot, fileAtCommit, rangeSession, sameChange } from '../core/git';
import { overviewMessages } from '../ai/prompts';

let tmp: string;
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-this-api-')));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });

/** An "upstream" repository with two commits on main. */
function upstream(name: string): { dir: string; first: string; second: string } {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  gitIn(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-qm', 'first');
  const first = gitIn(dir, 'rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 2;\n');
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib', 'b.ts'), 'export const b = 1;\n');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-qm', 'second');
  return { dir, first, second: gitIn(dir, 'rev-parse', 'HEAD').trim() };
}

test('exactRepoRoot accepts only the absolute top folder of a repository', async () => {
  const { dir } = upstream('roots');
  assert.equal(await exactRepoRoot(dir), dir);
  assert.equal(await exactRepoRoot(path.join(dir, 'lib')), undefined, 'a folder inside the repository');
  assert.equal(await exactRepoRoot(path.relative(process.cwd(), dir)), undefined, 'a relative path');
  assert.equal(await exactRepoRoot(path.join(tmp, 'missing')), undefined);
  const plain = path.join(tmp, 'plain');
  fs.mkdirSync(plain);
  assert.equal(await exactRepoRoot(plain), undefined, 'not a repository');
  const link = path.join(tmp, 'roots-link');
  fs.symlinkSync(dir, link);
  assert.equal(await exactRepoRoot(link), dir, 'symlinks resolve to the real path');
  assert.equal(await exactRepoRoot(undefined as unknown as string), undefined);
});

test('rangeSession and fileAtCommit work on a blobless clone with no checkout', async () => {
  const up = upstream('remote');
  const clone = path.join(tmp, 'clone');
  gitIn(tmp, '-c', 'uploadpack.allowFilter=true', 'clone', '-q', '--filter=blob:none', '--no-checkout', `file://${up.dir}`, clone);
  assert.ok(!fs.existsSync(path.join(clone, 'a.ts')), 'nothing is checked out');

  const root = await exactRepoRoot(clone);
  assert.equal(root, clone);
  const s = await rangeSession(clone, up.first, 'origin/main', []);
  assert.deepEqual(s.files.map((f) => f.path).sort(), ['a.ts', 'lib/b.ts']);
  assert.deepEqual(s.commits.map((c) => c.subject), ['second']);

  assert.equal(await fileAtCommit(clone, up.first, 'a.ts'), 'export const a = 1;\n');
  assert.equal(await fileAtCommit(clone, up.second, 'lib/b.ts'), 'export const b = 1;\n');
  await assert.rejects(fileAtCommit(clone, 'HEAD', 'a.ts'), /Not a commit SHA/);
  await assert.rejects(fileAtCommit(clone, `--output=${path.join(tmp, 'x')}`, 'a.ts'), /Not a commit SHA/);
});

test('context reaches the prompt as redacted untrusted data and distinguishes sessions', async () => {
  const up = upstream('ctx');
  const s = await rangeSession(up.dir, up.first, 'HEAD', []);
  const token = `${['gh', 'p_'].join('')}${'a'.repeat(36)}`;
  const withCtx = { ...s, context: `AB#42 Raise the limit\nRepro token: ${token}` };
  const user = overviewMessages(withCtx, 20000, 'English')[1].content;
  assert.match(user, /<untrusted_context>\nAB#42 Raise the limit/);
  assert.ok(!user.includes(token), 'credentials in the context are redacted');
  assert.doesNotMatch(overviewMessages(s, 20000, 'English')[1].content, /untrusted_context/);
  assert.ok(!sameChange(s, withCtx), 'a new context is a different review');
  assert.ok(sameChange(withCtx, { ...withCtx }));
});

test('cleanContext trims, caps, and ignores non-strings', () => {
  assert.equal(cleanContext('  hi  '), 'hi');
  assert.equal(cleanContext('   '), undefined);
  assert.equal(cleanContext(42), undefined);
  assert.equal(cleanContext(undefined), undefined);
  assert.equal(cleanContext('x'.repeat(MAX_CONTEXT_CHARS + 50))!.length, MAX_CONTEXT_CHARS);
});
