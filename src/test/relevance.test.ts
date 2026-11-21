import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChangeSession, DiffFile } from '../shared/types';
import { buildDiffDigest, planDiffDigest } from '../core/diff';
import { overviewMessages, relevanceWeight } from '../ai/prompts';
import { RelevanceScorer, type DecisionEngineConfig } from '../ai/relevance';

function bigFile(path: string, lines: number): DiffFile {
  return {
    path,
    status: 'modified',
    additions: lines,
    deletions: 0,
    binary: false,
    hunks: [
      {
        index: 1,
        header: `@@ -1,0 +1,${lines} @@`,
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: lines,
        lines: Array.from({ length: lines }, (_, i) => ({ kind: 'add' as const, text: `const line${i} = computeSomething(${i}); // ${path}`, newLine: i + 1 })),
      },
    ],
  };
}

function session(files: DiffFile[]): ChangeSession {
  return {
    id: 's', repoRoot: '/r', repoName: 'r', scope: { kind: 'commit', sha: 'abc' }, title: 't', subtitle: 's',
    commits: [{ sha: 'abc', shortSha: 'abc', author: 'a', email: 'e', date: '', subject: 'Add retry to the uploader', body: '' }],
    files, additions: 0, deletions: 0, leftRef: 'abc^',
  } as ChangeSession;
}

const engine: DecisionEngineConfig = { baseUrl: 'http://127.0.0.1:8080', model: 'llama-3.2-1b', timeoutMs: 5000 };

test('planDiffDigest without weights matches the size-based budget and gives weighted files more', () => {
  const files = [bigFile('a.ts', 200), bigFile('b.ts', 200), bigFile('c.ts', 200)];
  const plain = planDiffDigest(files, 9000);
  const even = planDiffDigest(files, 9000, [1, 1, 1]);
  assert.deepEqual(plain.budgets, even.budgets);
  assert.equal(buildDiffDigest(files, 9000), buildDiffDigest(files, 9000, [1, 1, 1]));

  const weighted = planDiffDigest(files, 9000, [16, 1, 1]);
  assert.ok(weighted.budgets[0] > plain.budgets[0]);
  assert.ok(weighted.budgets[1] < plain.budgets[1]);
  assert.ok(buildDiffDigest(files, 9000, [16, 1, 1]).length <= 9000);
});

test('planDiffDigest leaves out low-weight files before starving important ones', () => {
  const files = Array.from({ length: 30 }, (_, i) => bigFile(`f${i}.ts`, 100));
  const weights = files.map((_, i) => (i === 29 ? 16 : i === 0 ? 4 : 1));
  const plan = planDiffDigest(files, 3000, weights);
  assert.ok(plan.budgets.some((b) => b === 0), 'some files are left out');
  assert.ok(plan.budgets[29] >= Math.max(...plan.budgets), 'the most important file gets the largest share');
  assert.ok(plan.budgets[0] > 0, 'the next most important file is kept');
  assert.ok(buildDiffDigest(files, 3000, weights).includes('left out to fit'));
  assert.ok(buildDiffDigest(files, 3000, weights).length <= 3000);
});

test('relevanceWeight doubles per step and treats unknown scores as the middle', () => {
  assert.equal(relevanceWeight(0), 1);
  assert.equal(relevanceWeight(4), 16);
  assert.equal(relevanceWeight(9), 16);
  assert.equal(relevanceWeight(undefined), 4);
  assert.equal(relevanceWeight(NaN), 4);
});

function batchServer(scores: Record<string, number>, calls: { url: string; body: Record<string, unknown> }[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { items: { id: string; state: string }[] };
    calls.push({ url, body });
    const results = body.items.map((it) => {
      const file = Object.keys(scores).find((p) => it.state.includes(p))!;
      return { id: it.id, model: 'm', answers: { relevance: { type: 'score', choice: '', score: scores[file], probabilities: {}, confidence: 1 } }, usage: { input_tokens: 1, output_tokens: 0 } };
    });
    return new Response(JSON.stringify({ model: 'm', results, total_tokens: 1, latency_ms: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
}

test('RelevanceScorer scores files in one batch only when the diff must be trimmed, and remembers scores', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const scorer = new RelevanceScorer(() => engine, undefined, batchServer({ 'core.ts': 4, 'docs.md': 0.5 }, calls));
  const small = session([bigFile('core.ts', 3), bigFile('docs.md', 3)]);
  assert.equal(await scorer.scoresFor(small, 60000), undefined);
  assert.equal(calls.length, 0, 'nothing is sent when the diff fits');

  const s = session([bigFile('core.ts', 300), bigFile('docs.md', 300)]);
  const got = await scorer.scoresFor(s, 8000);
  assert.deepEqual([...got!.scores], [['core.ts', 4], ['docs.md', 0.5]]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8080/v1/systemone/batch');
  assert.equal(calls[0].body.model, 'llama-3.2-1b');
  assert.equal((calls[0].body.questions as { relevance: { type: string } }).relevance.type, 'score');
  for (const item of calls[0].body.items as { state: string }[]) {
    assert.ok(item.state.includes('Add retry to the uploader'));
    assert.ok(item.state.length < 3000, 'excerpts stay small');
  }

  await scorer.scoresFor(s, 8000);
  assert.equal(calls.length, 1, 'scores are remembered');

  const weighted = overviewMessages(s, 8000, 'English', got!.scores)[1].content;
  const plain = overviewMessages(s, 8000, 'English')[1].content;
  const count = (text: string, file: string) => text.split(`// ${file}`).length;
  assert.ok(count(weighted, 'core.ts') > count(plain, 'core.ts'));
  assert.ok(count(weighted, 'docs.md') < count(plain, 'docs.md'));
});

test('RelevanceScorer falls back to single requests without a batch endpoint', async () => {
  const urls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    urls.push(url);
    if (url.endsWith('/batch')) return new Response('not found', { status: 404 });
    const { state } = JSON.parse(String(init.body)) as { state: string };
    const score = state.includes('core.ts') ? 3.5 : 1;
    return new Response(JSON.stringify({ model: 'm', answers: { relevance: { type: 'score', score } }, usage: {} }), { status: 200 });
  }) as unknown as typeof fetch;
  const scorer = new RelevanceScorer(() => engine, undefined, fetchImpl);
  const got = await scorer.scoresFor(session([bigFile('core.ts', 300), bigFile('util.ts', 300)]), 8000);
  assert.deepEqual(Object.fromEntries(got!.scores), { 'core.ts': 3.5, 'util.ts': 1 });
  assert.equal(urls.filter((u) => u.endsWith('/v1/systemone')).length, 2);
});

test('RelevanceScorer falls back to the size-based budget when the engine fails, and refuses remote engines', async () => {
  const logs: string[] = [];
  const s = session([bigFile('core.ts', 300), bigFile('util.ts', 300)]);
  const down = new RelevanceScorer(() => engine, (_l, m) => logs.push(m), (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch);
  assert.equal(await down.scoresFor(s, 8000), undefined);
  assert.match(logs.join('\n'), /Relevance scoring failed \(fetch failed\)/);

  let called = false;
  const remote = new RelevanceScorer(() => ({ ...engine, baseUrl: 'https://jev.example.com' }), (_l, m) => logs.push(m), (async () => {
    called = true;
    return new Response('{}');
  }) as unknown as typeof fetch);
  assert.equal(remote.id(), undefined);
  assert.equal(await remote.scoresFor(s, 8000), undefined);
  assert.equal(called, false);
  assert.match(logs.join('\n'), /not on this machine/);

  const off = new RelevanceScorer(() => undefined);
  assert.equal(await off.scoresFor(s, 8000), undefined);
});

test('Analyzer finds an overview made with relevance scores without asking the engine again', async () => {
  const fs = await import('fs/promises');
  const os = await import('os');
  const path = await import('path');
  const { Analyzer } = await import('../ai/analyzer');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-this-rel-'));
  const realFetch = globalThis.fetch;
  try {
    const overview = JSON.stringify({ headline: 'h', intent: 'i', summary: 's', changeType: 'feature', risk: { level: 'low', reasons: [] }, keyChanges: [], reviewFocus: [], components: [], flows: [] });
    let prompt = '';
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      prompt = String(init.body);
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: overview } }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
    }) as unknown as typeof fetch;
    const cfg = { id: 'openaiCompatible' as const, baseUrl: 'http://localhost:8000/v1', model: 'm', temperature: 0.2, ollamaContextLength: 8192 };
    const opts = { maxChars: 8000, language: 'English' };
    let scored = 0;
    const relevance = {
      id: () => 'systemone:test',
      scoresFor: async () => {
        scored++;
        return { scores: new Map([['core.ts', 4], ['docs.md', 0]]), id: 'systemone:test' };
      },
    };
    const analyzer = new Analyzer(dir, 100, 30, undefined, relevance);
    const s = session([bigFile('core.ts', 300), bigFile('docs.md', 300)]);
    assert.equal(await analyzer.hasOverview(s, cfg, opts), false);
    const first = await analyzer.overview(s, cfg, opts);
    assert.equal(first.cached, false);
    assert.equal(scored, 1);
    assert.ok(prompt.split('// core.ts').length > prompt.split('// docs.md').length, 'the prompt favours the relevant file');
    assert.equal(await analyzer.hasOverview(s, cfg, opts), true);
    assert.equal((await analyzer.overview(s, cfg, opts)).cached, true);
    assert.equal(scored, 1, 'a cached overview does not ask the engine');
  } finally {
    globalThis.fetch = realFetch;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
