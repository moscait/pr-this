import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { commitSession, gitBuffer, MAX_UNTRACKED, MAX_UNTRACKED_BYTES, rangeSession, workingSession, workingTreeMatchesRef } from '../core/git';
import { fileTable, overviewMessages } from '../ai/prompts';
import type { ChangeSession, DiffFile } from '../shared/types';

let tmp: string;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-this-git-'));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A fresh repository with a fixed identity, so tests do not depend on the machine's git config. */
function repo(name: string): { dir: string; git: (...args: string[]) => string; write: (f: string, content: string | Buffer) => void } {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
      cwd: dir,
      encoding: 'utf8',
    });
  const write = (f: string, content: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), content);
  };
  git('init', '-q');
  return { dir, git, write };
}

const byPath = (s: ChangeSession) => new Map(s.files.map((f) => [f.path, f]));

test('commitSession: rename, binary, non-ASCII and spaced paths, missing final newline, secrets', async () => {
  const { dir, git, write } = repo('commit');
  write('old name.txt', 'a\nb\nc\n');
  write('café.md', 'x\n');
  write('k.txt', 'keep\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  git('mv', 'old name.txt', 'new name.txt');
  write('bin.dat', Buffer.from([0, 1, 2, 3]));
  write('café.md', 'x\ny\n');
  write('k.txt', 'no-eol');
  write('.env', 'SECRET=1\n');
  write('.env.example', 'SECRET=\n');
  git('add', '-A');
  git('commit', '-qm', 'second', '-m', 'body line');

  const s = await commitSession(dir, 'HEAD', []);
  assert.equal(s.title, 'second');
  assert.equal(s.commits[0].body, 'body line');
  const f = byPath(s);
  assert.deepEqual(
    [...f.keys()].sort(),
    ['.env', '.env.example', 'bin.dat', 'café.md', 'k.txt', 'new name.txt'],
  );
  assert.equal(f.get('new name.txt')!.status, 'renamed');
  assert.equal(f.get('new name.txt')!.oldPath, 'old name.txt');
  assert.ok(f.get('bin.dat')!.binary && f.get('bin.dat')!.excluded);
  assert.equal(f.get('café.md')!.additions, 1);
  const k = f.get('k.txt')!;
  assert.deepEqual([k.additions, k.deletions], [1, 1]);
  assert.ok(k.hunks[0].lines.some((l) => l.kind === 'meta'), 'keeps the "No newline at end of file" marker');
  assert.ok(f.get('.env')!.excluded);
  assert.ok(!f.get('.env.example')!.excluded);

  // The first commit diffs against the empty tree.
  const first = await commitSession(dir, 'HEAD~1', []);
  assert.ok(first.files.every((x) => x.status === 'added'));

  // Refs starting with '-' must be rejected rather than passed as git options.
  await assert.rejects(commitSession(dir, '--output=/tmp/x', []), /Unknown commit/);
});

test('rangeSession diffs from the merge base and lists only the branch commits', async () => {
  const { dir, git, write } = repo('range');
  write('a.txt', '1\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const mergeBase = git('rev-parse', 'HEAD').trim();
  git('checkout', '-qb', 'feature');
  write('feature.txt', 'f\n');
  git('add', '-A');
  git('commit', '-qm', 'feature 1');
  write('feature.txt', 'f\ng\n');
  git('commit', '-qam', 'feature 2');
  git('checkout', '-q', 'main');
  write('main-only.txt', 'm\n');
  git('add', '-A');
  git('commit', '-qm', 'main moves on');

  const s = await rangeSession(dir, 'main', 'feature', []);
  assert.equal(s.leftRef, mergeBase);
  assert.deepEqual(s.commits.map((c) => c.subject), ['feature 2', 'feature 1']);
  assert.deepEqual(s.files.map((f) => f.path), ['feature.txt'], "main's own changes are not part of the comparison");
  await assert.rejects(rangeSession(dir, 'main', 'no-such-branch', []), /Unknown ref/);
});

test('workingSession: staged, unstaged and untracked files; ignored files and large files', async () => {
  const { dir, git, write } = repo('working');
  write('.gitignore', 'ignored.log\n');
  write('staged.txt', 'a\n');
  write('unstaged.txt', 'a\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  write('staged.txt', 'a\nb\n');
  git('add', 'staged.txt');
  write('unstaged.txt', 'a\nc\n');
  write('new.txt', 'n\n');
  write('ignored.log', 'x\n');
  write('big.csv', 'x'.repeat(MAX_UNTRACKED_BYTES + 1));

  const s = await workingSession(dir, []);
  const f = byPath(s);
  assert.deepEqual([...f.keys()].sort(), ['big.csv', 'new.txt', 'staged.txt', 'unstaged.txt']);
  assert.equal(f.get('new.txt')!.status, 'added');
  const big = f.get('big.csv')!;
  assert.ok(big.excluded && big.hunks.length === 0);
  assert.match(big.excludedReason ?? '', /too large/);
  assert.deepEqual(s.notices, []);
});

test('workingSession caps untracked files and says so', async () => {
  const { dir, write } = repo('many');
  for (let i = 0; i < MAX_UNTRACKED + 5; i++) write(`u/f${String(i).padStart(3, '0')}.txt`, `${i}\n`);
  const s = await workingSession(dir, []); // no commits yet: diffs against the empty tree
  assert.equal(s.files.length, MAX_UNTRACKED);
  assert.equal(s.notices?.length, 1);
  assert.match(s.notices![0], new RegExp(`Only ${MAX_UNTRACKED} of ${MAX_UNTRACKED + 5} untracked files`));
});

test('gitBuffer returns raw binary Buffer from git show blob', async () => {
  const { dir, git, write } = repo('git-buffer');
  const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  write('test.png', payload);
  git('add', 'test.png');
  git('commit', '-qm', 'add png');
  const buf = await gitBuffer(dir, ['show', 'HEAD:test.png']);
  assert.ok(Buffer.isBuffer(buf));
  assert.deepEqual(buf, payload);
});

test('the file list in the overview prompt stays within its share of the budget', () => {
  const files: DiffFile[] = Array.from({ length: 5000 }, (_, i) => ({
    path: `packages/module-${i}/src/some/fairly/long/path/file-${i}.ts`,
    status: 'modified',
    additions: 2,
    deletions: 1,
    binary: false,
    hunks: [],
  }));
  const table = fileTable(files, 12000);
  assert.ok(table.length <= 12000, `table is ${table.length} chars`);
  assert.match(table, /… and \d+ more files \(\+\d+ -\d+\)$/);
  assert.equal(fileTable(files.slice(0, 3)), fileTable(files.slice(0, 3), 1e9));

  const session: ChangeSession = {
    id: 'x', repoRoot: '/r', repoName: 'r', scope: { kind: 'working' }, title: '', subtitle: '', commits: [],
    files, additions: 10000, deletions: 5000, leftRef: 'HEAD',
  };
  const [, user] = overviewMessages(session, 60000, 'English');
  assert.ok(user.content.length < 60000 + 2000, `prompt is ${user.content.length} chars`);
});

test('workingTreeMatchesRef finds files unchanged on disk since a commit', async () => {
  const r = repo('fresh');
  r.write('same.ts', 'a\n');
  r.write('edited.ts', 'b\n');
  r.write('gone.ts', 'c\n');
  r.write('glob[1].ts', 'd\n');
  r.write('*.ts', 'e\n');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'one');
  const sha = r.git('rev-parse', 'HEAD').trim();
  r.write('edited.ts', 'b changed\n');
  fs.rmSync(path.join(r.dir, 'gone.ts'));
  const paths = ['same.ts', 'edited.ts', 'gone.ts', 'glob[1].ts', '*.ts', 'never-committed.ts'];
  const same = await workingTreeMatchesRef(r.dir, sha, paths);
  assert.deepEqual([...same].sort(), ['*.ts', 'glob[1].ts', 'same.ts'], 'pathspec characters are taken literally');
});
