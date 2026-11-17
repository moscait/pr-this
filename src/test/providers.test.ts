import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { acceptsTemperature, ADAPTERS, chat, PROVIDERS, ProviderConfig, ProviderError, selectOllamaNumCtx, staysLocal } from '../ai/providers';
import { Analyzer } from '../ai/analyzer';
import { BackgroundQueue, rankFilesForPrewarm } from '../ai/prewarm';
import { OVERVIEW_JSON_SCHEMA } from '../ai/prompts';
import { extractJson } from '../core/json';
import { sameChange } from '../core/git';
import type { ChangeSession } from '../shared/types';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  redirect?: RequestRedirect;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub fetch with a queue of responses; records every request. */
function stubFetch(responses: (() => Response)[]): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)), redirect: init.redirect });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next();
  }) as typeof fetch;
  return calls;
}

const sse = (events: unknown[]) => () => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });
const badRequest = (message: string) => () => new Response(JSON.stringify({ error: { message } }), { status: 400 });
const openaiText = (t: string) => sse([{ choices: [{ delta: { content: t } }] }, '[DONE]']);
const anthropicText = (t: string, stop = 'end_turn', details?: unknown) =>
  sse([
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: t } },
    { type: 'message_delta', delta: { stop_reason: stop, stop_details: details ?? null } },
  ]);

const cfg = (id: ProviderConfig['id'], model: string): ProviderConfig => ({
  id,
  model,
  baseUrl: PROVIDERS[id].defaultBaseUrl,
  apiKey: 'k',
  temperature: 0.2,
  ollamaContextLength: 8192,
});
const msgs = [
  { role: 'system' as const, content: 'sys' },
  { role: 'user' as const, content: 'hi' },
];

test('acceptsTemperature knows which models reject sampling parameters', () => {
  assert.ok(acceptsTemperature('openai', 'gpt-4.1-mini'));
  assert.ok(!acceptsTemperature('openai', 'o3'));
  assert.ok(!acceptsTemperature('openai', 'gpt-5-mini'));
  assert.ok(acceptsTemperature('anthropic', 'claude-sonnet-4-5'));
  assert.ok(acceptsTemperature('anthropic', 'claude-3-7-sonnet-latest'));
  assert.ok(acceptsTemperature('anthropic', 'claude-haiku-4-5'));
  assert.ok(!acceptsTemperature('anthropic', 'claude-opus-4-7'));
  assert.ok(!acceptsTemperature('anthropic', 'claude-sonnet-5-5'));
  assert.ok(!acceptsTemperature('anthropic', 'claude-opus-5-5'));
  assert.ok(acceptsTemperature('ollama', 'qwen2.5-coder:7b'));
});

test('OpenAI reasoning models get no temperature', async () => {
  const calls = stubFetch([openaiText('ok')]);
  assert.equal(await chat(cfg('openai', 'o3'), msgs, { json: true }), 'ok');
  assert.ok(!('temperature' in calls[0].body));
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
});

test('a 400 naming temperature is retried without it', async () => {
  const calls = stubFetch([badRequest("Unsupported value: 'temperature' does not support 0.2 with this model."), openaiText('ok')]);
  assert.equal(await chat(cfg('openai', 'gpt-4.1-mini'), msgs), 'ok');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.temperature, 0.2);
  assert.ok(!('temperature' in calls[1].body));
});

test('an unrelated 400 is not retried', async () => {
  const calls = stubFetch([badRequest('Invalid model name')]);
  await assert.rejects(chat(cfg('openai', 'gpt-4.1-mini'), msgs), (e: unknown) => e instanceof ProviderError && e.status === 400);
  assert.equal(calls.length, 1);
});

test('current Claude models: no temperature, room for thinking, refusal fallback, thinking not shown', async () => {
  const calls = stubFetch([anthropicText('{"a":1}')]);
  assert.equal(await chat(cfg('anthropic', 'claude-sonnet-5-5'), msgs), '{"a":1}');
  const { body, headers } = calls[0];
  assert.ok(!('temperature' in body));
  assert.equal(body.max_tokens, 32000);
  assert.equal(body.fallbacks, 'default');
  assert.equal(headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(body.system, 'sys');
});

test('older Claude models keep temperature and get no fallback; max_tokens drops when rejected', async () => {
  const calls = stubFetch([badRequest('max_tokens: 32000 > 8192, which is the maximum allowed'), anthropicText('ok')]);
  assert.equal(await chat(cfg('anthropic', 'claude-3-5-haiku-latest'), msgs), 'ok');
  assert.equal(calls[0].body.temperature, 0.2);
  assert.ok(!('fallbacks' in calls[0].body) && !calls[0].headers['anthropic-beta']);
  assert.equal(calls[1].body.max_tokens, 8192);
});

test('an Anthropic refusal surfaces as an error', async () => {
  stubFetch([anthropicText('', 'refusal', { category: 'cyber', explanation: 'declined' })]);
  await assert.rejects(chat(cfg('anthropic', 'claude-sonnet-5-5'), msgs), /declined to explain this change \(declined\)/);
});

test('extractJson repairs output cut off inside a key', () => {
  assert.deepEqual(extractJson('{"headline":"x","keyChanges":["a"],"ri'), { headline: 'x', keyChanges: ['a'] });
  assert.deepEqual(extractJson('{"headline":"x","risk":{"level":"low","rea'), { headline: 'x', risk: { level: 'low' } });
  assert.deepEqual(extractJson('{"files":[{"path":"a.ts","summ'), { files: [{ path: 'a.ts' }] });
});

test('sameChange spots a moved branch and always refreshes the working tree', () => {
  const base: ChangeSession = {
    id: 'r', repoRoot: '/r', repoName: 'r', scope: { kind: 'range', base: 'main', head: 'feat' },
    title: '', subtitle: '', commits: [], files: [], additions: 0, deletions: 0, leftRef: 'aaa', rightRef: 'bbb',
  };
  assert.ok(sameChange(base, { ...base }));
  assert.ok(!sameChange(base, { ...base, rightRef: 'ccc' }));
  assert.ok(!sameChange(base, { ...base, leftRef: 'ddd' }));
  const working = { ...base, scope: { kind: 'working' as const }, rightRef: undefined };
  assert.ok(!sameChange(working, working));
});

test('Analyzer.prune keeps the newest entries and drops old ones', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-this-cache-'));
  try {
    const day = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 6; i++) {
      const file = path.join(dir, `k${i}.json`);
      await fs.writeFile(file, '{}');
      const t = new Date(Date.now() - i * 60_000 - (i === 5 ? 40 * day : 0));
      await fs.utimes(file, t, t);
    }
    await new Analyzer(dir, 3, 30).prune();
    assert.deepEqual((await fs.readdir(dir)).sort(), ['k0.json', 'k1.json', 'k2.json']);
    await new Analyzer(dir, 100, 30).prune();
    assert.equal((await fs.readdir(dir)).length, 3);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('reasoning effort reaches reasoning models only', async () => {
  const calls = stubFetch([openaiText('ok'), openaiText('ok'), anthropicText('ok'), anthropicText('ok'), openaiText('ok')]);
  await chat({ ...cfg('openai', 'gpt-5-mini'), reasoningEffort: 'low' }, msgs);
  await chat({ ...cfg('openai', 'gpt-4.1-mini'), reasoningEffort: 'low' }, msgs);
  await chat({ ...cfg('anthropic', 'claude-sonnet-5-5'), reasoningEffort: 'medium' }, msgs);
  await chat({ ...cfg('anthropic', 'claude-sonnet-4-5'), reasoningEffort: 'medium' }, msgs);
  await chat({ ...cfg('openaiCompatible', 'qwen3'), reasoningEffort: 'high' }, msgs);
  assert.equal(calls[0].body.reasoning_effort, 'low');
  assert.ok(!('reasoning_effort' in calls[1].body), 'gpt-4.1-mini is not a reasoning model');
  assert.deepEqual(calls[2].body.output_config, { effort: 'medium' });
  assert.ok(!('output_config' in calls[3].body), 'claude-sonnet-4-5 rejects effort');
  assert.ok(!('reasoning_effort' in calls[4].body), 'compatible servers get no OpenAI-specific parameters');
});

test('no effort setting sends no effort parameter', async () => {
  const calls = stubFetch([anthropicText('ok')]);
  await chat(cfg('anthropic', 'claude-opus-5-5'), msgs);
  assert.ok(!('output_config' in calls[0].body));
});

test('a 400 naming effort is retried without it', async () => {
  const calls = stubFetch([badRequest('output_config.effort: unsupported for this model'), anthropicText('ok')]);
  assert.equal(await chat({ ...cfg('anthropic', 'claude-sonnet-5-5'), reasoningEffort: 'low' }, msgs), 'ok');
  assert.ok('output_config' in calls[0].body && !('output_config' in calls[1].body));
});

test('Gemini defaults to the auto-updating Flash alias', () => {
  assert.equal(PROVIDERS.gemini.defaultModel, 'gemini-flash-latest');
});

test('staysLocal checks loopback address for every local provider', () => {
  assert.equal(staysLocal('ollama', 'http://gpu-box:11434'), false);
  assert.equal(staysLocal('ollama', ''), true);
  assert.equal(staysLocal('lmstudio', 'http://127.0.0.1:1234/v1'), true);
  assert.equal(staysLocal('openai', ''), false);
});

test('selectOllamaNumCtx picks the smallest tier that fits prompt + output up to configuredMax', () => {
  assert.equal(selectOllamaNumCtx(msgs, 32768, 4096), 8192);
  const medium = [{ role: 'user' as const, content: 'x'.repeat(24000) }];
  assert.equal(selectOllamaNumCtx(medium, 32768, 4096), 16384);
  const large = [{ role: 'user' as const, content: 'x'.repeat(60000) }];
  assert.equal(selectOllamaNumCtx(large, 32768, 4096), 32768);
  assert.equal(selectOllamaNumCtx(large, 16384, 4096), 16384, 'never exceeds configuredMax');
});

test('Ollama requests send think: false by default, keep_alive, num_predict on json, and tiered num_ctx', async () => {
  const ollamaOk = () => new Response(JSON.stringify({ message: { content: '{"ok":true}' } }) + '\n', { status: 200 });
  const calls = stubFetch([ollamaOk, ollamaOk]);
  const c = { ...cfg('ollama', 'granite4.2:8b'), ollamaContextLength: 32768 };
  await chat(c, msgs, { json: true });
  assert.equal(calls[0].body.think, false);
  assert.equal(calls[0].body.keep_alive, '30m');
  assert.deepEqual(calls[0].body.options, { temperature: 0.2, num_ctx: 8192, num_predict: 4096 });

  await chat({ ...c, reasoningEffort: 'high' }, msgs);
  assert.equal(calls[1].body.think, true);
});

test('Ollama retries without think if server returns 400 mentioning think', async () => {
  const ollamaOk = () => new Response(JSON.stringify({ message: { content: 'ok' } }) + '\n', { status: 200 });
  const calls = stubFetch([badRequest('unknown field "think"'), ollamaOk]);
  assert.equal(await chat(cfg('ollama', 'granite4.2:8b'), msgs), 'ok');
  assert.equal(calls.length, 2);
  assert.ok('think' in calls[0].body && !('think' in calls[1].body));
});

test('BackgroundQueue preempts in-flight background job during interactive work and retries it after', async () => {
  const q = new BackgroundQueue();
  const events: string[] = [];
  let bgResolve!: () => void;

  const done = new Promise<void>((resolve) => {
    q.enqueue({
      id: 'bg-1',
      run: (signal) =>
        new Promise<void>((res, rej) => {
          events.push('bg:start');
          bgResolve = () => {
            events.push('bg:done');
            res();
            resolve();
          };
          signal.addEventListener('abort', () => {
            events.push('bg:aborted');
            rej(new Error('aborted'));
          });
        }),
    });
  });

  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(events, ['bg:start']);

  await q.runInteractive(async () => {
    events.push('interactive:run');
    await new Promise((r) => setTimeout(r, 10));
  });

  await new Promise((r) => setTimeout(r, 10));
  bgResolve();
  await done;
  assert.deepEqual(events, ['bg:start', 'bg:aborted', 'interactive:run', 'bg:start', 'bg:done']);
});

test('rankFilesForPrewarm prioritizes reviewFocus severity and then change size', () => {
  const mkFile = (p: string, add: number, del: number, excluded = false) => ({
    path: p,
    status: 'modified' as const,
    additions: add,
    deletions: del,
    binary: false,
    excluded,
    hunks: [{ index: 1, header: '@@ -1,1 +1,1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [] }],
  });
  const s: ChangeSession = {
    id: 'c', repoRoot: '/r', repoName: 'r', scope: { kind: 'commit', sha: '123' },
    title: '', subtitle: '', commits: [], additions: 0, deletions: 0, leftRef: 'a',
    files: [
      mkFile('small.ts', 2, 1),
      mkFile('big.ts', 100, 50),
      mkFile('warn.ts', 5, 5),
      mkFile('risk.ts', 1, 1),
      mkFile('secret.env', 500, 0, true),
    ],
  };
  const ov = {
    headline: 'h', intent: 'i', summary: 's', changeType: 'fix',
    risk: { level: 'low' as const, reasons: [] }, keyChanges: [],
    reviewFocus: [
      { title: 'w', detail: '', path: 'warn.ts', severity: 'warn' as const },
      { title: 'r', detail: '', path: 'risk.ts', severity: 'risk' as const },
    ],
    components: [], flows: [], files: [],
  };
  assert.deepEqual(
    rankFilesForPrewarm(s, ov, 3).map((f) => f.path),
    ['risk.ts', 'warn.ts', 'big.ts'],
  );
});

test('Ollama passes jsonSchema in format and falls back to "json" if rejected with 400', async () => {
  const ollamaOk = () => new Response(JSON.stringify({ message: { content: '{"headline":"h"}' } }) + '\n', { status: 200 });
  const calls = stubFetch([badRequest('invalid format schema'), ollamaOk]);
  await chat(cfg('ollama', 'granite4.2:8b'), msgs, { json: true, jsonSchema: OVERVIEW_JSON_SCHEMA });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body.format, OVERVIEW_JSON_SCHEMA);
  assert.equal(calls[1].body.format, 'json');
});

test('Analyzer.overview emits streaming partial overviews via onProgress and throttles partial parsing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-this-stream-'));
  try {
    const fullJson = JSON.stringify({
      headline: 'Add streaming partial overview',
      intent: 'Show early results while streaming long responses from the model.',
      summary: 'Streams JSON chunks progressively. '.repeat(12),
      changeType: 'feature',
      risk: { level: 'low', reasons: [] },
      keyChanges: ['Stream partial JSON'],
      reviewFocus: [],
      components: [],
      flows: [],
      files: [],
    });
    // Split into many 10-char deltas so total deltas >> number of 256-char parse steps.
    const chunks: string[] = [];
    for (let i = 0; i < fullJson.length; i += 10) chunks.push(fullJson.slice(i, i + 10));
    const streamRes = () =>
      new Response(chunks.map((c) => JSON.stringify({ message: { content: c } }) + '\n').join(''), { status: 200 });
    stubFetch([streamRes]);
    let progressCalls = 0;
    const partials: string[] = [];
    const s: ChangeSession = {
      id: 'c', repoRoot: '/r', repoName: 'r', scope: { kind: 'commit', sha: '123' },
      title: 'fallback', subtitle: '', commits: [], additions: 1, deletions: 0, leftRef: 'a',
      files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0, binary: false, hunks: [] }],
    };
    const analyzer = new Analyzer(dir);
    const { overview } = await analyzer.overview(s, cfg('ollama', 'granite4.2:8b'), {
      maxChars: 10000,
      language: 'English',
      onProgress: (_chars, partial) => {
        progressCalls++;
        if (partial) partials.push(partial.headline);
      },
    });
    assert.equal(progressCalls, chunks.length);
    assert.ok(partials.length >= 1 && partials.length <= Math.floor(fullJson.length / 256) + 1);
    assert.ok(partials.length < chunks.length / 5, `expected throttled partials (${partials.length}) << deltas (${chunks.length})`);
    assert.ok(partials.includes('Add streaming partial overview'), 'partial headline emitted before stream completed');
    assert.equal(overview.headline, 'Add streaming partial overview');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ADAPTERS.buildRequest constructs expected URL, headers, and body per provider', () => {
  const ollamaReq = ADAPTERS.ollama.buildRequest(cfg('ollama', 'qwen2.5-coder:7b'), msgs, { json: true });
  assert.equal(ollamaReq.url, 'http://localhost:11434/api/chat');
  assert.equal(ollamaReq.body.model, 'qwen2.5-coder:7b');
  assert.equal(ollamaReq.body.format, 'json');

  const openaiReq = ADAPTERS.openai.buildRequest(cfg('openai', 'gpt-4.1-mini'), msgs, { json: true, maxTokens: 1024 });
  assert.equal(openaiReq.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(openaiReq.headers.authorization, 'Bearer k');
  assert.equal(openaiReq.body.max_completion_tokens, 1024);

  const anthropicReq = ADAPTERS.anthropic.buildRequest(cfg('anthropic', 'claude-sonnet-5-5'), msgs, {});
  assert.equal(anthropicReq.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(anthropicReq.headers['x-api-key'], 'k');
  assert.equal(anthropicReq.body.system, 'sys');

  const geminiReq = ADAPTERS.gemini.buildRequest(cfg('gemini', 'models/gemini-flash-latest'), msgs, { json: true });
  assert.equal(geminiReq.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:streamGenerateContent?alt=sse');
  assert.equal(geminiReq.headers['x-goog-api-key'], 'k');
  assert.deepEqual(geminiReq.body.systemInstruction, { parts: [{ text: 'sys' }] });
});

test('provider requests disable HTTP redirects to prevent custom API key header leakage', async () => {
  const calls = stubFetch([anthropicText('ok')]);
  await chat(cfg('anthropic', 'claude-sonnet-5-5'), msgs);
  assert.equal(calls[0].redirect, 'error');
});

test('BackgroundQueue and Analyzer share in-flight overview work when interactive key matches background job', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-this-dedup-'));
  try {
    let releaseFetch!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFetch = r;
    });
    const calls = stubFetch([
      () => {
        const stream = new ReadableStream({
          async start(controller) {
            await gate;
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content: '{"headline":"Shared run"}' } }) + '\n'));
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      },
    ]);

    const s: ChangeSession = {
      id: 'commit-1', repoRoot: '/r', repoName: 'r', scope: { kind: 'commit', sha: '123' },
      title: 't', subtitle: '', commits: [], additions: 1, deletions: 0, leftRef: 'a',
      files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0, binary: false, hunks: [] }],
    };
    const analyzer = new Analyzer(dir);
    const bg = new BackgroundQueue();
    const c = cfg('ollama', 'granite4.2:8b');
    const jobKey = `overview:${s.id}`;

    bg.enqueue({
      id: 'head:123',
      key: jobKey,
      run: async (signal) => {
        await analyzer.overview(s, c, { maxChars: 10000, language: 'English', signal });
      },
    });

    await new Promise((r) => setTimeout(r, 15));
    assert.equal(calls.length, 1, 'background job started fetch');

    const interactivePromise = bg.runInteractive(
      () => analyzer.overview(s, c, { maxChars: 10000, language: 'English' }),
      jobKey,
    );
    releaseFetch();
    const { overview } = await interactivePromise;
    assert.equal(overview.headline, 'Shared run');
    assert.equal(calls.length, 1, 'interactive call reused the in-flight background fetch');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
