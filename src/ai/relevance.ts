import { createHash } from 'crypto';
import type { ChangeSession, DiffFile } from '../shared/types';
import { DIGEST_RENDER_OPTS, redactSecrets, renderFileDiff } from '../core/diff';
import { MAX_RELEVANCE, overviewDigestOverBudget, overviewDigestPlan } from './prompts';
import { isLoopbackUrl } from './providers';

/**
 * Relevance scoring with a "System 1" decision engine: a server exposing the Jev-style `POST /v1/systemone`
 * API (vej, jev-local, llama.cpp). Each changed file gets a 0-4 score for how central it is to the change, and the
 * overview gives important files a larger share of its diff budget. Scores only matter when the diff must be
 * trimmed to fit, so nothing is sent otherwise.
 */
export interface DecisionEngineConfig {
  /** Server origin, e.g. `http://127.0.0.1:8080`. Only loopback servers are used, so code stays on this machine. */
  baseUrl: string;
  /** Model to score with; empty for the server's default. */
  model: string;
  /** Give up after this long and fall back to the size-based budget. */
  timeoutMs: number;
}

export type Log = (level: 'info' | 'warn' | 'debug', message: string) => void;

/** Characters of a file's diff the engine sees: small models judge best on a short excerpt, and vej's default context is 2048 tokens. */
const EXCERPT_CHARS = 2400;
/** Characters of commit messages given as the change's intent. */
const INTENT_CHARS = 400;
/** Items per batch request (vej accepts up to 256). */
const BATCH_ITEMS = 64;
/** Files scored per change; the rest get the middle weight. */
const MAX_SCORED_FILES = 256;
/** Parallel single requests when the server has no batch endpoint. */
const SINGLE_CONCURRENCY = 4;
/** Bound on remembered scores. */
const MEMO_LIMIT = 5000;

const QUESTION = {
  relevance: {
    type: 'score',
    instructions:
      'A reviewer must understand what this code change does and why. Rate how important the diff of the file below is for that, given the change description.',
    criteria: {
      '0': 'Noise: generated code, lock or build output, formatting-only, or a mechanical rename or move',
      '1': 'Minor: a small tweak, typo, comment, or version bump',
      '2': 'Supporting: tests, docs, config, or wiring that follows from the main change',
      '3': 'Important: substantial logic that the change depends on',
      '4': 'Central: the core behaviour this change introduces or fixes',
    },
  },
} as const;

/** What one file's request says: the change's intent, then the file and an excerpt of its diff. */
export function relevanceState(s: ChangeSession, f: DiffFile): string {
  const intent = s.commits.length
    ? s.commits
        .slice(0, 5)
        .map((c) => redactSecrets(c.subject).text)
        .join('; ')
        .slice(0, INTENT_CHARS)
    : 'Uncommitted working-tree changes (no description).';
  return `Change: ${intent}\nFiles changed in total: ${s.files.length}\n\n${renderFileDiff(f, EXCERPT_CHARS, DIGEST_RENDER_OPTS)}`;
}

interface Answer {
  score?: unknown;
}

function scoreOf(body: unknown): number | undefined {
  const answer = (body as { answers?: { relevance?: Answer } } | undefined)?.answers?.relevance;
  const v = typeof answer?.score === 'number' ? answer.score : Number(answer?.score);
  return Number.isFinite(v) ? Math.min(MAX_RELEVANCE, Math.max(0, v)) : undefined;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class RelevanceScorer {
  private memo = new Map<string, number>();
  /** Set after a server answered 404 to the batch endpoint, per origin. */
  private noBatch = new Set<string>();

  constructor(
    private readonly config: () => DecisionEngineConfig | undefined,
    private readonly log: Log = () => undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Identifies the scores an overview was built with, for its cache key; undefined when scoring is off. */
  id(): string | undefined {
    const c = this.usableConfig(false);
    return c ? `systemone:${c.baseUrl}:${c.model}` : undefined;
  }

  private usableConfig(warn: boolean): DecisionEngineConfig | undefined {
    const c = this.config();
    if (!c) return undefined;
    if (!isLoopbackUrl(c.baseUrl)) {
      if (warn) this.log('warn', `Decision engine ignored: ${c.baseUrl} is not on this machine, and only local engines are supported so code is not sent elsewhere.`);
      return undefined;
    }
    return c;
  }

  /**
   * Relevance scores (path to 0-4) for the overview of `s`, or undefined when scoring is off, not needed (the diff
   * fits), or failed. Never throws, except when `signal` aborts.
   */
  async scoresFor(s: ChangeSession, maxChars: number, signal?: AbortSignal): Promise<{ scores: Map<string, number>; id: string } | undefined> {
    const c = this.usableConfig(true);
    const id = this.id();
    if (!c || !id) return undefined;
    if (!overviewDigestOverBudget(s, maxChars)) return undefined;
    const files = s.files.filter((f) => !f.excluded && !f.binary && f.hunks.length).slice(0, MAX_SCORED_FILES);
    if (files.length < 2) return undefined;

    const started = Date.now();
    const timeout = AbortSignal.timeout(c.timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const scores = new Map<string, number>();
    const todo: { f: DiffFile; state: string; key: string }[] = [];
    for (const f of files) {
      const state = relevanceState(s, f);
      const key = createHash('sha256').update(JSON.stringify([id, state])).digest('hex');
      const hit = this.memo.get(key);
      if (hit !== undefined) scores.set(f.path, hit);
      else todo.push({ f, state, key });
    }

    try {
      if (todo.length) {
        const got = await this.score(c, todo.map((t) => t.state), sig);
        todo.forEach((t, i) => {
          const v = got[i];
          if (v === undefined) return;
          scores.set(t.f.path, v);
          this.memo.delete(t.key);
          this.memo.set(t.key, v);
          if (this.memo.size > MEMO_LIMIT) this.memo.delete(this.memo.keys().next().value as string);
        });
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      const why = timeout.aborted ? `no answer within ${c.timeoutMs} ms` : (e as Error).message;
      this.log('warn', `Relevance scoring failed (${why}); the overview uses the size-based budget. Is the decision engine running at ${c.baseUrl}?`);
      return undefined;
    }
    if (!scores.size) return undefined;
    this.report(s, maxChars, scores, todo.length, Date.now() - started);
    return { scores, id };
  }

  /** Log the scores and how they change the overview's diff, for comparing against the size-based budget. */
  private report(s: ChangeSession, maxChars: number, scores: Map<string, number>, fetched: number, ms: number): void {
    const describe = (rel?: Map<string, number>) => {
      const p = overviewDigestPlan(s, maxChars, rel);
      let whole = 0;
      let trimmed = 0;
      let dropped = 0;
      p.budgets.forEach((b, i) => (b === 0 ? dropped++ : b >= p.full[i].length ? whole++ : trimmed++));
      return { p, text: `${whole} whole, ${trimmed} trimmed, ${dropped} left out` };
    };
    const before = describe();
    const after = describe(scores);
    this.log(
      'info',
      `Relevance: scored ${scores.size} files (${fetched} from the engine) in ${ms} ms. Overview diff: size-based ${before.text}; relevance-based ${after.text}.`,
    );
    after.p.files.forEach((f, i) => {
      const was = before.p.budgets[i];
      const now = after.p.budgets[i];
      const score = scores.get(f.path);
      this.log('debug', `  ${score === undefined ? '  -' : score.toFixed(2)}  ${String(was).padStart(6)} -> ${String(now).padStart(6)} of ${after.p.full[i].length} chars  ${f.path}`);
    });
  }

  /** Scores for each state, in order; undefined where the engine gave no usable score. */
  private async score(c: DecisionEngineConfig, states: string[], signal: AbortSignal): Promise<(number | undefined)[]> {
    const origin = c.baseUrl.replace(/\/+$/, '');
    if (!this.noBatch.has(origin)) {
      try {
        const out: (number | undefined)[] = [];
        for (let i = 0; i < states.length; i += BATCH_ITEMS) {
          out.push(...(await this.batch(c, origin, states.slice(i, i + BATCH_ITEMS), i, signal)));
        }
        return out;
      } catch (e) {
        if (!(e instanceof HttpError && (e.status === 404 || e.status === 405))) throw e;
        this.noBatch.add(origin);
        this.log('info', `${origin} has no batch endpoint; scoring files one request at a time.`);
      }
    }
    const out = new Array<number | undefined>(states.length);
    let next = 0;
    const worker = async () => {
      while (next < states.length) {
        const i = next++;
        out[i] = scoreOf(await this.post(`${origin}/v1/systemone`, { ...this.common(c), state: states[i] }, signal));
      }
    };
    await Promise.all(Array.from({ length: Math.min(SINGLE_CONCURRENCY, states.length) }, worker));
    return out;
  }

  private async batch(c: DecisionEngineConfig, origin: string, states: string[], offset: number, signal: AbortSignal): Promise<(number | undefined)[]> {
    const body = await this.post(
      `${origin}/v1/systemone/batch`,
      { ...this.common(c), items: states.map((state, i) => ({ id: String(offset + i), state })) },
      signal,
    );
    const results = (body as { results?: { id?: unknown }[] } | undefined)?.results;
    if (!Array.isArray(results)) throw new Error('unexpected batch response');
    const byId = new Map(results.map((r) => [String(r.id), scoreOf(r)]));
    return states.map((_, i) => byId.get(String(offset + i)));
  }

  private common(c: DecisionEngineConfig) {
    return { ...(c.model ? { model: c.model } : {}), questions: QUESTION };
  }

  private async post(url: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
      redirect: 'error',
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      throw new HttpError(res.status, `HTTP ${res.status}${text ? `: ${text}` : ''}`);
    }
    return res.json();
  }
}
