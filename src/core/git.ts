import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { ChangeSession, CommitInfo, DiffFile } from '../shared/types';
import { isSecretPath, markExcluded, parseDiff, redactFileSecrets, redactSecrets } from './diff';
import { buildImageSide, isImagePath, MAX_PREVIEW_IMAGE_BYTES } from './image';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** Maximum number of image files to inspect metadata for in a session. */
export const MAX_IMAGE_FILES = 100;
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

const DEFAULT_GIT_FLAGS = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'core.fsmonitor=false'];

interface RunGitOptions<T extends 'utf8' | 'buffer'> {
  encoding: T;
  okCodes?: number[];
  maxBuffer?: number;
}

function runGit(cwd: string, args: string[], options: RunGitOptions<'buffer'>): Promise<Buffer>;
function runGit(cwd: string, args: string[], options: RunGitOptions<'utf8'>): Promise<string>;
function runGit(
  cwd: string,
  args: string[],
  options: { encoding: 'utf8' | 'buffer'; okCodes?: number[]; maxBuffer?: number },
): Promise<string | Buffer> {
  const { encoding, okCodes = [], maxBuffer = 256 * 1024 * 1024 } = options;
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...DEFAULT_GIT_FLAGS, ...args],
      { cwd, encoding, maxBuffer, env: { ...process.env, GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' } },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException & { code?: number | string }).code;
          if (typeof code === 'number' && okCodes.includes(code)) return resolve(stdout);
          if (code === 'ENOENT') return reject(new Error('git executable not found on PATH.'));
          const errStr = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : (stderr || err.message);
          return reject(new Error(errStr.trim()));
        }
        resolve(stdout);
      },
    );
  });
}

export function git(cwd: string, args: string[], okCodes: number[] = []): Promise<string> {
  return runGit(cwd, args, { encoding: 'utf8', okCodes });
}

export function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  return runGit(cwd, args, { encoding: 'buffer', maxBuffer: MAX_PREVIEW_IMAGE_BYTES + 1024 * 1024 });
}

export interface ImageRefResult {
  buf?: Buffer;
  bytes?: number;
  unavailable?: 'too-large' | 'unreadable' | 'symlink';
}

export async function readImageRef(
  root: string,
  ref: string | undefined,
  relPath: string,
): Promise<ImageRefResult | undefined> {
  if (ref === EMPTY_TREE) return undefined;
  try {
    if (ref) {
      try {
        const sizeStr = (await git(root, ['cat-file', '-s', `${ref}:${relPath}`])).trim();
        const size = parseInt(sizeStr, 10);
        if (Number.isFinite(size) && size > MAX_PREVIEW_IMAGE_BYTES) {
          return { bytes: size, unavailable: 'too-large' };
        }
      } catch {
        /* cat-file may fail on non-blob refs; fall through to gitBuffer */
      }
      try {
        const buf = await gitBuffer(root, ['show', `${ref}:${relPath}`]);
        return { buf, bytes: buf.length };
      } catch {
        return { unavailable: 'unreadable' };
      }
    }
    const full = path.join(root, relPath);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink()) return { unavailable: 'symlink' };
    if (!stat.isFile()) return { unavailable: 'unreadable' };
    if (stat.size > MAX_PREVIEW_IMAGE_BYTES) {
      return { bytes: stat.size, unavailable: 'too-large' };
    }
    const buf = await fs.readFile(full);
    return { buf, bytes: buf.length };
  } catch {
    return { unavailable: 'unreadable' };
  }
}

async function populateImages(
  root: string,
  leftRef: string,
  rightRef: string | undefined,
  files: DiffFile[],
): Promise<string | undefined> {
  const candidates = files.filter(
    (f) =>
      !f.excluded &&
      !isSecretPath(f.path) &&
      !(f.oldPath && isSecretPath(f.oldPath)) &&
      (isImagePath(f.path) || (f.oldPath ? isImagePath(f.oldPath) : false)),
  );
  if (!candidates.length) return undefined;
  const imgFiles = candidates.slice(0, MAX_IMAGE_FILES);
  await mapLimit(imgFiles, 4, async (f) => {
    const oldP = f.oldPath ?? f.path;
    const [beforeRes, afterRes] = await Promise.all([
      f.status === 'added' ? Promise.resolve(undefined) : readImageRef(root, leftRef, oldP),
      f.status === 'deleted' ? Promise.resolve(undefined) : readImageRef(root, rightRef, f.path),
    ]);
    const before = beforeRes ? buildImageSide(beforeRes.buf, oldP, false, beforeRes.bytes, beforeRes.unavailable) : undefined;
    const after = afterRes ? buildImageSide(afterRes.buf, f.path, false, afterRes.bytes, afterRes.unavailable) : undefined;
    if (before || after) f.image = { before, after };
  });
  if (candidates.length > MAX_IMAGE_FILES) {
    return `Only ${MAX_IMAGE_FILES} of ${candidates.length} image files were analyzed. The remaining images were skipped.`;
  }
  return undefined;
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

async function finish(
  base: Omit<ChangeSession, 'files' | 'additions' | 'deletions' | 'repoName' | 'id'> & { id?: string },
  diffText: string,
  exclude: string[],
  sendSecretFiles: boolean,
  extraFiles: DiffFile[] = [],
  options?: { images?: boolean },
): Promise<ChangeSession> {
  const files = [...parseDiff(diffText), ...extraFiles];
  markExcluded(files, exclude, { sendSecretFiles });
  const notices = base.notices ? [...base.notices] : [];
  if (options?.images !== false) {
    const imageNotice = await populateImages(base.repoRoot, base.leftRef, base.rightRef, files);
    if (imageNotice) notices.push(imageNotice);
  }
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
      notices.push(`Redacted ${redacted} potential secret value${redacted === 1 ? '' : 's'} from diff lines before sending to the AI.`);
    }
  }
  return {
    ...base,
    ...(notices.length ? { notices } : {}),
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

/**
 * Paths whose file in the working tree has exactly the content they have at `ref`
 * (after git's clean filters, e.g. line-ending conversion). Missing or non-regular files never match.
 */
export async function workingTreeMatchesRef(root: string, ref: string, paths: string[]): Promise<Set<string>> {
  const matches = new Set<string>();
  const blobs = new Map<string, string>();
  for (let i = 0; i < paths.length; i += 200) {
    const chunk = paths.slice(i, i + 200);
    const out = await git(root, ['--literal-pathspecs', 'ls-tree', '-r', '-z', ref, '--', ...chunk]);
    for (const entry of out.split('\0')) {
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      const [, type, sha] = entry.slice(0, tab).split(' ');
      if (type === 'blob') blobs.set(entry.slice(tab + 1), sha);
    }
  }
  const candidates: string[] = [];
  for (const p of blobs.keys()) {
    const stat = await fs.lstat(path.join(root, p)).catch(() => undefined);
    if (stat?.isFile()) candidates.push(p);
  }
  for (let i = 0; i < candidates.length; i += 200) {
    const chunk = candidates.slice(i, i + 200);
    const hashes = (await git(root, ['hash-object', '--', ...chunk])).split('\n').filter(Boolean);
    chunk.forEach((p, j) => {
      if (hashes[j] && hashes[j] === blobs.get(p)) matches.add(p);
    });
  }
  return matches;
}

export async function commitSession(
  root: string,
  ref: string,
  exclude: string[],
  sendSecretFiles = false,
  options?: { images?: boolean },
): Promise<ChangeSession> {
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
    [],
    options,
  );
}

export async function rangeSession(
  root: string,
  base: string,
  head: string,
  exclude: string[],
  sendSecretFiles = false,
  options?: { images?: boolean },
): Promise<ChangeSession> {
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
    [],
    options,
  );
}

export async function workingSession(
  root: string,
  exclude: string[],
  sendSecretFiles = false,
  options?: { images?: boolean },
): Promise<ChangeSession> {
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
    options,
  );
}
