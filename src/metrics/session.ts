// Measures both sides of the changed files in a session, caching every result by the content's git blob hash.
// A given file content always gives the same metrics, so a result is computed once per machine and reused by every
// commit, branch comparison and (later) trend that contains that version of the file.

import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { isSecretPath } from '../core/diff';
import { EMPTY_TREE, git } from '../core/git';
import type { ChangeSession, DiffFile, FileMetrics, FileMetricsResult, MetricsLanguage } from '../shared/types';
import { MAX_MEASURE_BYTES, MetricsEngine, MetricsError } from './engine';
import { GRAMMARS, GrammarError, LANGUAGE_LABELS, languageOf, type GrammarId } from './grammars';
import { METRICS_VERSION } from './measure';

/** The id git gives this content as a blob: the same as `git hash-object`, without starting a process. */
export function gitBlobSha(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

const MEMORY_LIMIT = 2000;

/** Results on disk, one small JSON file per (rules version, grammar version, blob). Never invalidated: content is immutable. */
export class MetricsCache {
  private memory = new Map<string, FileMetrics>();

  constructor(private readonly dir: string) {}

  private file(grammar: GrammarId, sha: string): string {
    return path.join(this.dir, `v${METRICS_VERSION}`, `${grammar}-${GRAMMARS[grammar].version}`, sha.slice(0, 2), `${sha}.json`);
  }

  async get(grammar: GrammarId, sha: string): Promise<FileMetrics | undefined> {
    const key = `${grammar}:${sha}`;
    const hit = this.memory.get(key);
    if (hit) return hit;
    try {
      const m = JSON.parse(await fs.readFile(this.file(grammar, sha), 'utf8')) as FileMetrics;
      if (!Array.isArray(m?.functions) || typeof m.complexity !== 'number') return undefined;
      this.remember(key, m);
      return m;
    } catch {
      return undefined;
    }
  }

  async set(grammar: GrammarId, sha: string, m: FileMetrics): Promise<void> {
    this.remember(`${grammar}:${sha}`, m);
    const file = this.file(grammar, sha);
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(m));
      await fs.rename(tmp, file);
    } catch {
      /* the cache is an optimisation; measuring again later is fine */
    }
  }

  private remember(key: string, m: FileMetrics): void {
    this.memory.delete(key);
    this.memory.set(key, m);
    if (this.memory.size > MEMORY_LIMIT) this.memory.delete(this.memory.keys().next().value as string);
  }
}

/** True when metrics apply to the file: a text file in a language the user turned on, and not a secrets file. */
export function metricsApply(f: DiffFile, enabled: ReadonlySet<MetricsLanguage>): boolean {
  const lang = languageOf(f.path);
  return !!lang && enabled.has(lang.language) && !f.binary && !isSecretPath(f.path) && !(f.oldPath && isSecretPath(f.oldPath));
}

/** Blob ids of `paths` at `ref`, in one git call; paths missing at that ref are left out. */
async function blobsAt(root: string, ref: string, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!paths.length || ref === EMPTY_TREE) return out;
  const list = await git(root, ['--literal-pathspecs', 'ls-tree', '-z', ref, '--', ...paths]);
  for (const entry of list.split('\0')) {
    const m = /^\d+ blob ([0-9a-f]{40,64})\t(.*)$/s.exec(entry);
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

type Side = { sha: string; read: () => Promise<Buffer> } | { missing: true } | { error: string };

export interface MeasureOptions {
  enabled: ReadonlySet<MetricsLanguage>;
  /** Called whenever a file's `metrics`, `metricsStatus` or `metricsNote` changes. */
  onChange: (f: DiffFile) => void;
  signal?: AbortSignal;
}

export class SessionMetrics {
  constructor(
    private readonly engine: MetricsEngine,
    private readonly cache: MetricsCache,
  ) {}

  /** Measure the before and after sides of each file metrics apply to, updating the files in place. */
  async measure(session: ChangeSession, opts: MeasureOptions): Promise<void> {
    const files = session.files.filter((f) => metricsApply(f, opts.enabled));
    for (const f of session.files) {
      if (files.includes(f)) continue;
      if (f.metricsStatus) {
        f.metrics = f.metricsStatus = f.metricsNote = undefined;
        opts.onChange(f);
      }
    }
    if (!files.length) return;
    for (const f of files) {
      f.metricsStatus = 'pending';
      f.metricsNote = (await this.engine.grammars.cached(languageOf(f.path)!.grammar)) ? undefined : 'Downloading the parser…';
      opts.onChange(f);
    }

    const root = session.repoRoot;
    const beforePaths = files.filter((f) => f.status !== 'added').map((f) => f.oldPath ?? f.path);
    const afterPaths = files.filter((f) => f.status !== 'deleted').map((f) => f.path);
    let before: Map<string, string>;
    let after = new Map<string, string>();
    try {
      before = await blobsAt(root, session.leftRef, beforePaths);
      if (session.rightRef) after = await blobsAt(root, session.rightRef, afterPaths);
    } catch (e) {
      for (const f of files) this.fail(f, `Couldn't read the file versions from git: ${(e as Error).message}`, opts);
      return;
    }
    const fromGit = (sha: string): Side => ({ sha, read: () => readBlob(root, sha) });

    // A grammar that failed to download fails every file in its language the same way: try it once per run.
    const failedGrammars = new Map<GrammarId, string>();
    for (const f of files) {
      if (opts.signal?.aborted) return;
      const lang = languageOf(f.path)!;
      const failed = failedGrammars.get(lang.grammar);
      if (failed) {
        this.fail(f, failed, opts);
        continue;
      }
      const beforeSide: Side =
        f.status === 'added' ? { missing: true } : before.has(f.oldPath ?? f.path) ? fromGit(before.get(f.oldPath ?? f.path)!) : { missing: true };
      const afterSide: Side =
        f.status === 'deleted'
          ? { missing: true }
          : session.rightRef
            ? after.has(f.path)
              ? fromGit(after.get(f.path)!)
              : { missing: true }
            : await workingSide(root, f.path);
      try {
        const result: FileMetricsResult = { language: lang.language };
        for (const [key, side] of [['before', beforeSide], ['after', afterSide]] as const) {
          if ('error' in side) throw new MetricsError(side.error);
          if ('missing' in side) continue;
          let m = await this.cache.get(lang.grammar, side.sha);
          if (!m) {
            m = await this.engine.measure(f.path, (await side.read()).toString('utf8'));
            await this.cache.set(lang.grammar, side.sha, m);
          }
          result[key] = m;
        }
        f.metrics = result;
        f.metricsStatus = 'ready';
        f.metricsNote = undefined;
        opts.onChange(f);
      } catch (e) {
        const message =
          e instanceof GrammarError
            ? `${LANGUAGE_LABELS[lang.language]} parser unavailable: ${e.message}`
            : e instanceof MetricsError
              ? e.message
              : `Metrics failed: ${(e as Error).message}`;
        if (e instanceof GrammarError || !(e instanceof MetricsError)) failedGrammars.set(lang.grammar, message);
        this.fail(f, message, opts);
      }
    }
  }

  private fail(f: DiffFile, note: string, opts: MeasureOptions): void {
    f.metrics = undefined;
    f.metricsStatus = 'unavailable';
    f.metricsNote = note;
    opts.onChange(f);
  }
}

async function readBlob(root: string, sha: string): Promise<Buffer> {
  const size = Number((await git(root, ['cat-file', '-s', sha])).trim());
  if (size > MAX_MEASURE_BYTES) throw new MetricsError('The file is too large to measure (over 1 MB).');
  return Buffer.from(await git(root, ['cat-file', 'blob', sha]), 'utf8');
}

/** The working-tree side: the file on disk now. Symlinks are not followed. */
async function workingSide(root: string, rel: string): Promise<Side> {
  const full = path.join(root, rel);
  try {
    const st = await fs.lstat(full);
    if (st.isSymbolicLink() || !st.isFile()) return { missing: true };
    if (st.size > MAX_MEASURE_BYTES) return { error: 'The file is too large to measure (over 1 MB).' };
    const content = await fs.readFile(full);
    return { sha: gitBlobSha(content), read: async () => content };
  } catch {
    return { missing: true };
  }
}
