import type { ChangeSession, DiffFile, Overview, Severity } from '../shared/types';
import type { Analyzer } from './analyzer';
import type { ProviderConfig } from './providers';

export interface BackgroundJob {
  id: string;
  key?: string;
  run: (signal: AbortSignal) => Promise<void>;
}

/**
 * Single-flight background work queue that yields immediately to interactive user actions.
 * While `activeInteractive > 0`, any in-flight background job is aborted (unless its `key`
 * matches the interactive caller's `key`, in which case both share the in-flight request)
 * and placed back at the front of the queue so it resumes once all interactive work finishes.
 */
export class BackgroundQueue {
  private queue: BackgroundJob[] = [];
  private activeInteractive = 0;
  private currentJob?: BackgroundJob;
  private currentCtl?: AbortController;
  private pumping = false;
  private disposed = false;

  /** Run an interactive operation, preempting any in-flight background job (unless `key` matches) until it finishes. */
  async runInteractive<T>(fn: () => Promise<T>, key?: string): Promise<T> {
    this.activeInteractive++;
    if (this.currentCtl && (!key || this.currentJob?.key !== key)) {
      this.currentCtl.abort();
    }
    try {
      return await fn();
    } finally {
      this.activeInteractive = Math.max(0, this.activeInteractive - 1);
      if (this.activeInteractive === 0) {
        void this.pump();
      }
    }
  }

  /** Enqueue a background job (deduplicated by `id`). `front` places it ahead of existing jobs. */
  enqueue(job: BackgroundJob, front = false): void {
    if (this.disposed) return;
    if (this.currentJob?.id === job.id) return;
    this.queue = this.queue.filter((j) => j.id !== job.id);
    if (front) this.queue.unshift(job);
    else this.queue.push(job);
    void this.pump();
  }

  /** Cancel queued/in-flight jobs whose `id` starts with `prefix`. */
  cancelPrefix(prefix: string): void {
    this.queue = this.queue.filter((j) => !j.id.startsWith(prefix));
    if (this.currentJob?.id.startsWith(prefix)) {
      this.currentJob = undefined;
      this.currentCtl?.abort();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.queue = [];
    this.currentJob = undefined;
    this.currentCtl?.abort();
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.disposed) return;
    this.pumping = true;
    try {
      while (!this.disposed && this.activeInteractive === 0 && this.queue.length > 0) {
        const job = this.queue.shift()!;
        const ctl = new AbortController();
        this.currentJob = job;
        this.currentCtl = ctl;
        let preempted = false;
        try {
          await job.run(ctl.signal);
        } catch {
          if (ctl.signal.aborted && this.activeInteractive > 0 && this.currentJob === job) {
            preempted = true;
          }
          /* background failures are best-effort and never surface to the user */
        } finally {
          if (preempted && !this.disposed) {
            this.queue.unshift(job);
          }
          if (this.currentCtl === ctl) {
            this.currentCtl = undefined;
            this.currentJob = undefined;
          }
        }
      }
    } finally {
      this.pumping = false;
    }
  }
}

const SEVERITY_RANK: Record<Severity, number> = { risk: 3, warn: 2, info: 1 };

/**
 * Pick the top `limit` explainable files to pre-warm after an overview completes:
 * files called out in `overview.reviewFocus` come first (highest severity first),
 * followed by the largest changed files by additions + deletions.
 */
export function rankFilesForPrewarm(s: ChangeSession, overview: Overview, limit = 3): DiffFile[] {
  const explainable = s.files.filter((f) => !f.excluded && !f.binary && f.hunks.length > 0);
  const focusScore = new Map<string, number>();
  for (const rf of overview.reviewFocus) {
    if (!rf.path) continue;
    const rank = SEVERITY_RANK[rf.severity] ?? 1;
    focusScore.set(rf.path, Math.max(focusScore.get(rf.path) ?? 0, rank));
  }
  return [...explainable]
    .sort((a, b) => {
      const fa = focusScore.get(a.path) ?? 0;
      const fb = focusScore.get(b.path) ?? 0;
      if (fa !== fb) return fb - fa;
      return b.additions + b.deletions - (a.additions + a.deletions);
    })
    .slice(0, limit);
}

/** Enqueue background pre-warming jobs for the top files of a session after its overview is ready. */
export function prewarmSessionFiles(
  queue: BackgroundQueue,
  analyzer: Analyzer,
  session: ChangeSession,
  overview: Overview,
  getContext: () => Promise<{ cfg: ProviderConfig; maxChars: number; language: string } | undefined>,
  limit = 3,
  /** Settles the file's static analysis first, so the pre-warmed explanation has the cache key an interactive request will use. */
  prepare?: (file: DiffFile, signal: AbortSignal) => Promise<void>,
): void {
  const prefix = `file:${session.id}:`;
  queue.cancelPrefix(prefix);
  const targets = rankFilesForPrewarm(session, overview, limit);
  // Push in reverse with front=true so the highest-priority file runs first.
  for (const file of [...targets].reverse()) {
    const jobKey = `file:${session.id}:${file.path}`;
    queue.enqueue(
      {
        id: `${prefix}${file.path}`,
        key: jobKey,
        run: async (signal) => {
          const ctx = await getContext();
          if (!ctx || signal.aborted) return;
          await prepare?.(file, signal);
          if (signal.aborted) return;
          const cached = await analyzer.hasFileDetail(file, overview, ctx.cfg, { maxChars: ctx.maxChars, language: ctx.language });
          if (cached || signal.aborted) return;
          await analyzer.fileDetail(session, file, overview, ctx.cfg, {
            maxChars: ctx.maxChars,
            language: ctx.language,
            signal,
          });
        },
      },
      true,
    );
  }
}
