import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { ChangeSession, ChatTurn, DiffFile, FileDetail, Overview } from '../shared/types';
import { renderFileDiff } from '../core/diff';
import { diagnosticsDigest } from '../core/diagnostics';
import { describeImageMeta } from '../core/image';
import { extractJson } from '../core/json';
import {
  askMessages,
  cleanCommitMessage,
  commitMessageMessages,
  type CommitMessageStyle,
  FILE_DETAIL_JSON_SCHEMA,
  fileMessages,
  normalizeFileDetail,
  normalizeOverview,
  OVERVIEW_JSON_SCHEMA,
  overviewMessages,
  PROMPT_VERSION,
} from './prompts';
import { chat, ProviderConfig } from './providers';
import type { RelevanceScorer } from './relevance';

interface Opts {
  maxChars: number;
  language: string;
  force?: boolean;
  signal?: AbortSignal;
  onProgress?: (chars: number, partial?: Overview) => void;
}

/** Runs the LLM pipeline with a content-addressed on-disk cache. */
export class Analyzer {
  private pruned = false;
  private inFlightOverviews = new Map<string, { promise: Promise<{ overview: Overview; cached: boolean }>; listeners: Set<NonNullable<Opts['onProgress']>> }>();
  private inFlightCommitMessages = new Map<string, Promise<string>>();
  private inFlightFiles = new Map<string, { promise: Promise<FileDetail>; listeners: Set<NonNullable<Opts['onProgress']>> }>();

  private readonly onWrite?: () => void;

  /**
   * @param maxEntries cache files kept; the least recently used go first
   * @param maxAgeDays cache files unused for longer than this are removed
   */
  constructor(
    private readonly cacheDir: string,
    private readonly maxEntries = 2000,
    private readonly maxAgeDays = 30,
    onWrite?: () => void,
    private readonly relevance?: Pick<RelevanceScorer, 'id' | 'scoresFor'>,
  ) {
    this.onWrite = onWrite;
  }

  /**
   * The overview's cache key comes from the prompt without relevance scores plus the engine that scored it, so
   * `hasOverview` can answer without asking the engine (its scores are deterministic for the same input).
   */
  private overviewKey(s: ChangeSession, cfg: ProviderConfig, o: Pick<Opts, 'maxChars' | 'language'>, relevanceId?: string): string {
    return this.key('overview', cfg, o.language, JSON.stringify(overviewMessages(s, o.maxChars, o.language)), relevanceId ? `relevance:${relevanceId}` : '');
  }

  private key(kind: string, cfg: ProviderConfig, language: string, content: string, extra = ''): string {
    return createHash('sha256')
      .update(JSON.stringify([PROMPT_VERSION, kind, cfg.id, cfg.baseUrl, cfg.model, language, content, extra]))
      .digest('hex')
      .slice(0, 40);
  }

  private async exists(key: string): Promise<boolean> {
    try {
      await fs.access(path.join(this.cacheDir, key + '.json'));
      return true;
    } catch {
      return false;
    }
  }

  private async read<T>(key: string): Promise<T | undefined> {
    const file = path.join(this.cacheDir, key + '.json');
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8')) as T;
      const now = new Date();
      await fs.utimes(file, now, now).catch(() => undefined); // mark as recently used
      return value;
    } catch {
      return undefined;
    }
  }

  private async write(key: string, value: unknown): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      await fs.writeFile(path.join(this.cacheDir, key + '.json'), JSON.stringify(value));
      this.onWrite?.();
    } catch {
      /* cache is best-effort */
    }
    if (!this.pruned) {
      this.pruned = true; // once per session is enough to keep the cache bounded
      await this.prune().catch(() => undefined);
    }
  }

  /** Remove cache files beyond `maxEntries` (least recently used first) or older than `maxAgeDays`. */
  async prune(): Promise<void> {
    const names = (await fs.readdir(this.cacheDir)).filter((n) => n.endsWith('.json'));
    const entries = await Promise.all(
      names.map(async (n) => {
        const file = path.join(this.cacheDir, n);
        const stat = await fs.stat(file).catch(() => undefined);
        return { file, mtime: stat?.mtimeMs ?? 0 };
      }),
    );
    entries.sort((a, b) => b.mtime - a.mtime);
    const cutoff = Date.now() - this.maxAgeDays * 24 * 60 * 60 * 1000;
    const stale = entries.filter((e, i) => i >= this.maxEntries || e.mtime < cutoff);
    await Promise.all(stale.map((e) => fs.rm(e.file, { force: true })));
  }

  async clearCache(): Promise<void> {
    await fs.rm(this.cacheDir, { recursive: true, force: true });
    this.onWrite?.();
  }

  async hasOverview(s: ChangeSession, cfg: ProviderConfig, o: Pick<Opts, 'maxChars' | 'language'>): Promise<boolean> {
    const id = this.relevance?.id();
    if (id && (await this.exists(this.overviewKey(s, cfg, o, id)))) return true;
    return this.exists(this.overviewKey(s, cfg, o));
  }

  async hasFileDetail(f: DiffFile, _overview: Overview | undefined, cfg: ProviderConfig, o: Pick<Opts, 'maxChars' | 'language'>): Promise<boolean> {
    if (f.excluded || f.binary || !f.hunks.length) return true;
    return this.exists(this.fileKey(f, cfg, o));
  }

  async overview(s: ChangeSession, cfg: ProviderConfig, o: Opts): Promise<{ overview: Overview; cached: boolean }> {
    // The prompt holds everything the answer depends on (files, diff digest, commit messages), so it is the cache key.
    const id = this.relevance?.id();
    if (!o.force && id) {
      // Already explained, with relevance scores or before scoring was on: keep it rather than ask the engine.
      // Regenerate (force) rescores.
      for (const k of [this.overviewKey(s, cfg, o, id), this.overviewKey(s, cfg, o)]) {
        const hit = await this.read<Overview>(k);
        if (hit) return { overview: hit, cached: true };
      }
    }
    const rel = await this.relevance?.scoresFor(s, o.maxChars, o.signal);
    const messages = overviewMessages(s, o.maxChars, o.language, rel?.scores);
    const key = this.overviewKey(s, cfg, o, rel?.id);
    if (!o.force) {
      const hit = await this.read<Overview>(key);
      if (hit) return { overview: hit, cached: true };
      const existing = this.inFlightOverviews.get(key);
      if (existing) {
        if (o.onProgress) existing.listeners.add(o.onProgress);
        try {
          return await existing.promise;
        } finally {
          if (o.onProgress) existing.listeners.delete(o.onProgress);
        }
      }
    }
    const listeners = new Set<NonNullable<Opts['onProgress']>>();
    if (o.onProgress) listeners.add(o.onProgress);
    let lastParsedLength = 0;
    const promise = (async () => {
      const text = await chat(cfg, messages, {
        json: true,
        jsonSchema: OVERVIEW_JSON_SCHEMA,
        signal: o.signal,
        onDelta: (_d, t) => {
          if (!listeners.size) return;
          let partial: Overview | undefined;
          if (t.length - lastParsedLength >= 256) {
            lastParsedLength = t.length;
            try {
              const raw = extractJson<Record<string, unknown>>(t);
              if (typeof raw?.headline === 'string' && raw.headline.trim()) {
                partial = normalizeOverview(raw, s);
              }
            } catch {
              /* not enough JSON yet */
            }
          }
          for (const cb of listeners) cb(t.length, partial);
        },
      });
      const overview = normalizeOverview(extractJson(text), s);
      await this.write(key, overview);
      return { overview, cached: false };
    })();
    if (!o.force) {
      this.inFlightOverviews.set(key, { promise, listeners });
      promise.finally(() => {
        if (this.inFlightOverviews.get(key)?.promise === promise) this.inFlightOverviews.delete(key);
      }).catch(() => undefined);
    }
    return promise;
  }

  /**
   * Key on the file diff, language, and static diagnostics, so regenerating the overview does not invalidate
   * cached file explanations. `hasFileDetail` and `fileDetail` must share it so pre-warmed results are found.
   */
  private fileKey(f: DiffFile, cfg: ProviderConfig, o: Pick<Opts, 'maxChars' | 'language'>): string {
    return this.key('file', cfg, o.language, renderFileDiff(f, o.maxChars, true), diagnosticsDigest(f));
  }

  async fileDetail(s: ChangeSession, f: DiffFile, overview: Overview | undefined, cfg: ProviderConfig, o: Opts): Promise<FileDetail> {
    const key = this.fileKey(f, cfg, o);
    if (!o.force) {
      const hit = await this.read<FileDetail>(key);
      if (hit) return hit;
      const existing = this.inFlightFiles.get(key);
      if (existing) {
        if (o.onProgress) existing.listeners.add(o.onProgress);
        try {
          return await existing.promise;
        } finally {
          if (o.onProgress) existing.listeners.delete(o.onProgress);
        }
      }
    }
    if (f.excluded || f.binary || !f.hunks.length) {
      const narrative = f.image
        ? `Graphic file (${describeImageMeta(f.image.before, f.image.after)}) — see the visual preview below.`
        : f.binary
          ? 'Binary file — no textual diff.'
          : f.excluded
            ? `Not sent to the AI: ${f.excludedReason ?? 'excluded'}.`
            : 'No content changes (mode change or rename only).';
      return { path: f.path, narrative, hunks: [] };
    }
    const listeners = new Set<NonNullable<Opts['onProgress']>>();
    if (o.onProgress) listeners.add(o.onProgress);
    const promise = (async () => {
      const text = await chat(cfg, fileMessages(s, f, overview, o.maxChars, o.language), {
        json: true,
        jsonSchema: FILE_DETAIL_JSON_SCHEMA,
        signal: o.signal,
        onDelta: (_d, t) => {
          for (const cb of listeners) cb(t.length);
        },
      });
      const detail = normalizeFileDetail(extractJson(text), f);
      await this.write(key, detail);
      return detail;
    })();
    if (!o.force) {
      this.inFlightFiles.set(key, { promise, listeners });
      promise.finally(() => {
        if (this.inFlightFiles.get(key)?.promise === promise) this.inFlightFiles.delete(key);
      }).catch(() => undefined);
    }
    return promise;
  }

  /** Cache key of a commit message: the prompt holds the diff, so unchanged files give the same key. */
  commitMessageKey(s: ChangeSession, style: CommitMessageStyle, cfg: ProviderConfig, o: Pick<Opts, 'maxChars' | 'language'>): string {
    return this.key(`commit-${style}`, cfg, o.language, JSON.stringify(commitMessageMessages(s, style, o.maxChars, o.language)));
  }

  /** A commit message generated earlier for exactly this change, without asking the model. */
  async cachedCommitMessage(key: string): Promise<string | undefined> {
    return (await this.read<{ message?: string }>(key))?.message || undefined;
  }

  /** A commit message for the change, from the cache unless `force`; concurrent requests for the same change share one call. */
  async commitMessage(s: ChangeSession, style: CommitMessageStyle, cfg: ProviderConfig, o: Omit<Opts, 'onProgress'>): Promise<string> {
    const key = this.commitMessageKey(s, style, cfg, o);
    if (!o.force) {
      const hit = await this.cachedCommitMessage(key);
      if (hit) return hit;
      const existing = this.inFlightCommitMessages.get(key);
      if (existing) return existing;
    }
    const promise = (async () => {
      const text = await chat(cfg, commitMessageMessages(s, style, o.maxChars, o.language), { signal: o.signal });
      const message = cleanCommitMessage(text, style);
      if (!message) throw new Error('The AI returned an empty commit message.');
      await this.write(key, { message });
      return message;
    })();
    this.inFlightCommitMessages.set(key, promise);
    promise.finally(() => {
      if (this.inFlightCommitMessages.get(key) === promise) this.inFlightCommitMessages.delete(key);
    }).catch(() => undefined);
    return promise;
  }

  ask(
    s: ChangeSession,
    overview: Overview | undefined,
    file: DiffFile | undefined,
    history: ChatTurn[],
    question: string,
    cfg: ProviderConfig,
    o: Opts & { onDelta: (d: string) => void },
  ): Promise<string> {
    return chat(cfg, askMessages(s, overview, file, history, question, o.maxChars, o.language), {
      signal: o.signal,
      onDelta: (d) => o.onDelta(d),
    });
  }
}
