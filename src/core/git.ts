import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { ChangeSession, CommitInfo, DiffFile } from '../shared/types';
import { markExcluded, parseDiff, redactFileSecrets, redactSecrets } from './diff';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** Untracked files read for a working-tree session; the rest are named in a notice. */
export const MAX_UNTRACKED = 200;
/** Untracked files larger than this are listed but not read. */
export const MAX_UNTRACKED_BYTES = 512 * 1024;
/** Git processes run at once to diff untracked files. */
const UNTRACKED_CONCURRENCY = 8;

/** Map with at most `limit` promises in flight, keeping the order of `items`. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function git(cwd: string, args: string[], okCodes: number[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'core.fsmonitor=false', ...args],
      { cwd, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' } },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException & { code?: number | string }).code;
          if (typeof code === 'number' && okCodes.includes(code)) return resolve(stdout);
          if (code === 'ENOENT') return reject(new Error('git executable not found on PATH.'));
          return reject(new Error((stderr || err.message).trim()));
        }
        resolve(stdout);
      },
    );
  });
}

export async function findRepoRoot(dir: string): Promise<string | undefined> {
  try {
    return (await git(dir, ['rev-parse', '--show-toplevel'])).trim() || undefined;
  } catch {
    return undefined;
  }
}

const LOG_FORMAT = '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e';

function parseLog(out: string): CommitInfo[] {
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r.trim())
    .map((r) => {
      const [sha, shortSha, author, email, date, subject, body] = r.split('\x1f');
      return { sha, shortSha, author, email, date, subject, body: (body ?? '').trim() };
    });
}

export async function listCommits(root: string, count: number, range?: string): Promise<CommitInfo[]> {
  try {
    const args = ['log', LOG_FORMAT, `-n${count}`];
    if (range) args.push(range);
    return parseLog(await git(root, args));
  } catch {
    return []; // no commits yet
  }
}

export async function listRefs(root: string): Promise<{ name: string; kind: 'local' | 'remote' | 'tag'; current: boolean }[]> {
  const out = await git(root, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname)%1f%(HEAD)',
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [ref, head] = l.split('\x1f');
      const kind = ref.startsWith('refs/heads/') ? 'local' : ref.startsWith('refs/remotes/') ? 'remote' : 'tag';
      const name = ref.replace(/^refs\/(heads|remotes|tags)\//, '');
      return { name, kind: kind as 'local' | 'remote' | 'tag', current: head === '*' };
    })
    .filter((r) => !r.name.endsWith('/HEAD'));
}

export async function defaultBaseBranch(root: string): Promise<string | undefined> {
  try {
    const r = (await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
    if (r) return r;
  } catch {
    /* ignore */
  }
  const refs = await listRefs(root).catch(() => []);
  for (const cand of ['main', 'master', 'develop', 'origin/main', 'origin/master']) {
    if (refs.some((r) => r.name === cand)) return cand;
  }
  return undefined;
}

export async function countWorkingChanges(root: string): Promise<number> {
  try {
    const out = await git(root, ['status', '--porcelain', '-unormal']);
    return out.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function resolve(root: string, ref: string): Promise<string | undefined> {
  if (!ref || ref.startsWith('-')) return undefined;
  try {
    return (await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])).trim() || undefined;
  } catch {
    return undefined;
  }
}

function diffArgs(...refs: string[]): string[] {
  return ['diff', '-M', '--no-ext-diff', '--no-textconv', '--no-color', '-U3', ...refs];
}

function finish(
  base: Omit<ChangeSession, 'files' | 'additions' | 'deletions' | 'repoName' | 'id'> & { id?: string },
  diffText: string,
  exclude: string[],
  sendSecretFiles: boolean,
  extraFiles: DiffFile[] = [],
): ChangeSession {
  const files = [...parseDiff(diffText), ...extraFiles];
  markExcluded(files, exclude, { sendSecretFiles });
  const notices = base.notices ? [...base.notices] : undefined;
  if (!sendSecretFiles) {
    // Count potential secrets for the user notice without mutating `files` in place,
    // so the local Lines UI matches the real file while `renderFileDiff` redacts AI prompts.
    let redacted = redactFileSecrets(files, false);
    for (const c of base.commits) {
      const s = redactSecrets(c.subject);
      const b = c.body ? redactSecrets(c.body) : { text: '', count: 0 };
      redacted += s.count + b.count;
    }
    if (redacted > 0) {
      const msg = `Redacted ${redacted} potential secret value${redacted === 1 ? '' : 's'} from diff lines before sending to the AI.`;
      if (notices) notices.push(msg);
      else base = { ...base, notices: [msg] };
    }
  }
  return {
    ...base,
    ...(notices ? { notices } : {}),
    id: base.id ?? `${base.repoRoot}::${JSON.stringify(base.scope)}`,
    repoName: path.basename(base.repoRoot),
    files,
    additions: files.reduce((a, f) => a + f.additions, 0),
    deletions: files.reduce((a, f) => a + f.deletions, 0),
  };
}

/**
 * Whether two sessions with the same id show the same diff. A range session is keyed by ref
 * names, so a branch that moved yields the same id with different commits; the working tree
 * can change at any time.
 */
export function sameChange(a: ChangeSession, b: ChangeSession): boolean {
  return a.scope.kind !== 'working' && a.leftRef === b.leftRef && a.rightRef === b.rightRef;
}

export async function commitSession(root: string, ref: string, exclude: string[], sendSecretFiles = false): Promise<ChangeSession> {
  const sha = await resolve(root, ref);
  if (!sha) throw new Error(`Unknown commit: ${ref}`);
  const [commit] = parseLog(await git(root, ['show', '-s', LOG_FORMAT, sha]));
  const parent = (await resolve(root, `${sha}^`)) ?? EMPTY_TREE;
  const diff = await git(root, diffArgs(parent, sha));
  return finish(
    {
      repoRoot: root,
      scope: { kind: 'commit', sha },
      title: commit.subject,
      subtitle: `${commit.shortSha} · ${commit.author} · ${new Date(commit.date).toLocaleString()}`,
      commits: [commit],
      leftRef: parent,
      rightRef: sha,
    },
    diff,
    exclude,
    sendSecretFiles,
  );
}

export async function rangeSession(root: string, base: string, head: string, exclude: string[], sendSecretFiles = false): Promise<ChangeSession> {
  const headSha = await resolve(root, head);
  const baseSha = await resolve(root, base);
  if (!headSha) throw new Error(`Unknown ref: ${head}`);
  if (!baseSha) throw new Error(`Unknown ref: ${base}`);
  let mergeBase = baseSha;
  try {
    mergeBase = (await git(root, ['merge-base', baseSha, headSha])).trim() || baseSha;
  } catch {
    /* unrelated histories: fall back to a direct diff */
  }
  const [diff, commits] = await Promise.all([
    git(root, diffArgs(mergeBase, headSha)),
    listCommits(root, 500, `${mergeBase}..${headSha}`),
  ]);
  return finish(
    {
      repoRoot: root,
      scope: { kind: 'range', base, head },
      title: `${head} ← compared to ${base}`,
      subtitle: `${commits.length} commit${commits.length === 1 ? '' : 's'} · merge-base ${mergeBase.slice(0, 7)}`,
      commits,
      leftRef: mergeBase,
      rightRef: headSha,
    },
    diff,
    exclude,
    sendSecretFiles,
  );
}

export async function workingSession(root: string, exclude: string[], sendSecretFiles = false): Promise<ChangeSession> {
  const head = (await resolve(root, 'HEAD')) ?? EMPTY_TREE;
  let diff = await git(root, diffArgs(head));
  const notices: string[] = [];

  const allUntracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  const untracked = allUntracked.slice(0, MAX_UNTRACKED);
  if (allUntracked.length > untracked.length) {
    notices.push(
      `Only ${untracked.length} of ${allUntracked.length} untracked files are included. Add the others to .gitignore, or commit them, to see them.`,
    );
  }
  // Large untracked files (logs, datasets, build output) are listed without being read.
  const tooLarge: DiffFile[] = [];
  const extra = await mapLimit(untracked, UNTRACKED_CONCURRENCY, async (f) => {
    const stat = await fs.lstat(path.join(root, f)).catch(() => undefined);
    if (stat?.isFile() && stat.size > MAX_UNTRACKED_BYTES) {
      tooLarge.push({
        path: f,
        status: 'added',
        additions: 0,
        deletions: 0,
        binary: false,
        hunks: [],
        excluded: true,
        excludedReason: `untracked file too large to read (${Math.round(stat.size / 1024)} KB)`,
      });
      return '';
    }
    return git(root, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--', '/dev/null', f], [1]).catch(() => '');
  });
  const extraDiff = extra.filter(Boolean).join('\n');
  if (extraDiff) diff += '\n' + extraDiff;

  return finish(
    {
      repoRoot: root,
      scope: { kind: 'working' },
      title: 'Uncommitted changes',
      subtitle: `Working tree vs ${head === EMPTY_TREE ? 'empty repository' : head.slice(0, 7)}`,
      commits: [],
      leftRef: head,
      rightRef: undefined,
      notices,
    },
    diff,
    exclude,
    sendSecretFiles,
    tooLarge,
  );
}
