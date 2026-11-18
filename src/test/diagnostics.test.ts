import { strict as assert } from 'assert';
import test from 'node:test';
import { filterDiffDiagnostics, type RawDiagnostic } from '../core/diagnostics';
import type { DiffFile } from '../shared/types';

function makeFile(overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path: 'src/app.ts',
    status: 'modified',
    additions: 3,
    deletions: 1,
    binary: false,
    hunks: [
      {
        index: 1,
        header: '@@ -10,3 +10,5 @@',
        oldStart: 10,
        oldLines: 3,
        newStart: 10,
        newLines: 5,
        lines: [
          { kind: 'ctx', text: 'function init() {', oldLine: 10, newLine: 10 },
          { kind: 'del', text: '  const oldVal = 1;', oldLine: 11 },
          { kind: 'add', text: '  const newVal = "hello";', newLine: 11 },
          { kind: 'add', text: '  const extra = 42;', newLine: 12 },
          { kind: 'add', text: '  return newVal + extra;', newLine: 13 },
          { kind: 'ctx', text: '}', oldLine: 12, newLine: 14 },
        ],
      },
    ],
    ...overrides,
  };
}

test('filterDiffDiagnostics filters out diagnostics outside modified lines', () => {
  const file = makeFile();
  const raw: RawDiagnostic[] = [
    // Line 5 in file (0-based line 4) - untouched context/outside hunk
    {
      message: 'Unused variable x',
      severity: 1, // warning
      range: { start: { line: 4, character: 2 }, end: { line: 4, character: 3 } },
      source: 'eslint',
      code: 'no-unused-vars',
    },
    // Line 11 in file (0-based line 10) - modified (added) line
    {
      message: 'Type string is not assignable to type number',
      severity: 0, // error
      range: { start: { line: 10, character: 8 }, end: { line: 10, character: 14 } },
      source: 'ts',
      code: 2322,
    },
    // Line 25 in file (0-based line 24) - untouched code
    {
      message: 'Missing return type',
      severity: 1,
      range: { start: { line: 24, character: 0 }, end: { line: 24, character: 1 } },
      source: 'ts',
      code: 7050,
    },
  ];

  const filtered = filterDiffDiagnostics(file, raw);
  assert.equal(filtered.length, 1);
  assert.deepEqual(filtered[0], {
    line: 11,
    endLine: undefined,
    message: 'Type string is not assignable to type number',
    severity: 'error',
    source: 'ts',
    code: 2322,
  });
});

test('filterDiffDiagnostics handles multi-line diagnostic ranges spanning modified lines', () => {
  const file = makeFile();
  const raw: RawDiagnostic[] = [
    // Range lines 9 to 12 (0-based 8 to 11) - spans line 11 which is modified
    {
      message: 'Overload signature mismatch',
      severity: 0,
      range: { start: { line: 8, character: 0 }, end: { line: 11, character: 10 } },
      source: 'ts',
      code: { value: 'TS2345' },
    },
  ];

  const filtered = filterDiffDiagnostics(file, raw);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].line, 9);
  assert.equal(filtered[0].endLine, 12);
  assert.equal(filtered[0].severity, 'error');
  assert.equal(filtered[0].code, 'TS2345');
});

test('filterDiffDiagnostics skips deleted files and binary files', () => {
  const deletedFile = makeFile({ status: 'deleted' });
  const binaryFile = makeFile({ binary: true });
  const raw: RawDiagnostic[] = [
    {
      message: 'Some error',
      severity: 0,
      range: { start: { line: 10, character: 0 }, end: { line: 10, character: 1 } },
    },
  ];

  assert.equal(filterDiffDiagnostics(deletedFile, raw).length, 0);
  assert.equal(filterDiffDiagnostics(binaryFile, raw).length, 0);
});

test('filterDiffDiagnostics sorts by line ascending and severity (error first)', () => {
  const file = makeFile();
  const raw: RawDiagnostic[] = [
    {
      message: 'Warning on line 12',
      severity: 1,
      range: { start: { line: 11, character: 0 }, end: { line: 11, character: 1 } },
    },
    {
      message: 'Error on line 12',
      severity: 0,
      range: { start: { line: 11, character: 2 }, end: { line: 11, character: 5 } },
    },
    {
      message: 'Error on line 11',
      severity: 0,
      range: { start: { line: 10, character: 0 }, end: { line: 10, character: 1 } },
    },
  ];

  const filtered = filterDiffDiagnostics(file, raw);
  assert.equal(filtered.length, 3);
  assert.equal(filtered[0].line, 11);
  assert.equal(filtered[0].severity, 'error');
  assert.equal(filtered[1].line, 12);
  assert.equal(filtered[1].severity, 'error');
  assert.equal(filtered[2].line, 12);
  assert.equal(filtered[2].severity, 'warning');
});

test('fileMessages and askMessages include static code analysis diagnostics when present', async () => {
  const { fileMessages, askMessages } = await import('../ai/prompts');
  const file = makeFile({
    diagnostics: [
      {
        line: 11,
        message: 'Type string is not assignable to type number',
        severity: 'error',
        source: 'ts',
        code: 2322,
      },
    ],
  });
  const session = {
    id: 's',
    repoRoot: '/r',
    repoName: 'r',
    scope: { kind: 'working' as const },
    title: 't',
    subtitle: 's',
    commits: [],
    files: [file],
    additions: 3,
    deletions: 1,
    leftRef: 'HEAD',
  };

  const msgs = fileMessages(session, file, undefined, 10000, 'English');
  const promptText = msgs.map((m) => m.content).join('\n');
  assert.match(promptText, /<untrusted_diagnostics>/);
  assert.match(promptText, /Line 11 \(ERROR\): \[ts\] \(2322\) Type string is not assignable to type number/);

  const ask = askMessages(session, undefined, file, [], 'Is there a type error?', 10000, 'English');
  const askText = ask.map((m) => m.content).join('\n');
  assert.match(askText, /<untrusted_diagnostics>/);
  assert.match(askText, /Line 11 \(ERROR\): Type string is not assignable to type number/);
});

test('diagnostics that do not match the diff are neither sent to the AI nor part of the cache key', async () => {
  const { fileMessages } = await import('../ai/prompts');
  const { diagnosticsDigest, usableDiagnostics } = await import('../core/diagnostics');
  const diagnostics = [{ line: 11, message: 'Unused variable', severity: 'warning' as const }];
  const session = {
    id: 's', repoRoot: '/r', repoName: 'r', scope: { kind: 'commit' as const, sha: 'abc' },
    title: 't', subtitle: 's', commits: [], files: [], additions: 3, deletions: 1, leftRef: 'p', rightRef: 'abc',
  };
  for (const status of ['stale', 'unsaved', 'pending'] as const) {
    const file = makeFile({ diagnostics, diagnosticsStatus: status });
    assert.deepEqual(usableDiagnostics(file), []);
    assert.equal(diagnosticsDigest(file), '');
    const text = fileMessages(session, file, undefined, 10000, 'English').map((m) => m.content).join('\n');
    assert.doesNotMatch(text, /untrusted_diagnostics/, `${status} diagnostics are not sent`);
  }
  const ready = makeFile({ diagnostics, diagnosticsStatus: 'ready' });
  assert.equal(diagnosticsDigest(ready), '11:warning:Unused variable');
  assert.equal(diagnosticsDigest(makeFile({ diagnostics })), '11:warning:Unused variable', 'files built before statuses existed still count');
});

test('credential-shaped strings in diagnostic messages are redacted before reaching the AI', async () => {
  const { fileMessages } = await import('../ai/prompts');
  const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  const file = makeFile({ diagnostics: [{ line: 11, message: `Unknown word "${key}"`, severity: 'info', source: 'cSpell' }], diagnosticsStatus: 'ready' });
  const session = {
    id: 's', repoRoot: '/r', repoName: 'r', scope: { kind: 'working' as const },
    title: 't', subtitle: 's', commits: [], files: [file], additions: 3, deletions: 1, leftRef: 'HEAD',
  };
  const text = fileMessages(session, file, undefined, 10000, 'English').map((m) => m.content).join('\n');
  assert.ok(!text.includes(key));
  assert.match(text, /Unknown word "\[REDACTED\]"/);
});

test('a pre-warmed file explanation is found again when diagnostics match, and not when they differ', async () => {
  const fs = await import('fs/promises');
  const os = await import('os');
  const path = await import('path');
  const { Analyzer } = await import('../ai/analyzer');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-this-key-'));
  const realFetch = globalThis.fetch;
  try {
    const detail = JSON.stringify({ narrative: 'n', hunks: [] });
    globalThis.fetch = (async () =>
      new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: detail } }] })}\n\ndata: [DONE]\n\n`, { status: 200 })) as typeof fetch;
    const cfg = { id: 'openaiCompatible' as const, baseUrl: 'http://localhost:8000/v1', model: 'm', temperature: 0.2, ollamaContextLength: 8192 };
    const opts = { maxChars: 10000, language: 'English' };
    const diagnostics = [{ line: 11, message: 'Unused variable', severity: 'warning' as const }];
    const session = {
      id: 's', repoRoot: '/r', repoName: 'r', scope: { kind: 'working' as const },
      title: 't', subtitle: 's', commits: [], files: [], additions: 3, deletions: 1, leftRef: 'HEAD',
    };
    const analyzer = new Analyzer(dir);
    await analyzer.fileDetail(session, makeFile({ diagnostics, diagnosticsStatus: 'ready' }), undefined, cfg, opts);
    assert.equal(await analyzer.hasFileDetail(makeFile({ diagnostics, diagnosticsStatus: 'ready' }), undefined, cfg, opts), true);
    assert.equal(await analyzer.hasFileDetail(makeFile({ diagnostics: [], diagnosticsStatus: 'ready' }), undefined, cfg, opts), false);
  } finally {
    globalThis.fetch = realFetch;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('background pre-warming settles static analysis before checking the cache', async () => {
  const { BackgroundQueue, prewarmSessionFiles } = await import('../ai/prewarm');
  const file = makeFile();
  const session = {
    id: 's', repoRoot: '/r', repoName: 'r', scope: { kind: 'working' as const },
    title: 't', subtitle: 's', commits: [], files: [file], additions: 3, deletions: 1, leftRef: 'HEAD',
  };
  const seen: string[] = [];
  const analyzer = {
    hasFileDetail: async (f: DiffFile) => {
      seen.push(`has:${f.diagnosticsStatus}`);
      return false;
    },
    fileDetail: async (_s: unknown, f: DiffFile) => {
      seen.push(`run:${f.diagnosticsStatus}`);
      return { path: f.path, narrative: '', hunks: [] };
    },
  };
  const overview = { headline: '', intent: '', summary: '', changeType: 'fix', risk: { level: 'low' as const, reasons: [] }, keyChanges: [], reviewFocus: [], components: [], flows: [], files: [] };
  const queue = new BackgroundQueue();
  const cfg = { id: 'ollama' as const, baseUrl: '', model: 'm', temperature: 0.2, ollamaContextLength: 8192 };
  await new Promise<void>((resolve) => {
    prewarmSessionFiles(
      queue,
      analyzer as never,
      session,
      overview,
      async () => ({ cfg, maxChars: 10000, language: 'English' }),
      1,
      async (f) => {
        seen.push('prepare');
        f.diagnostics = [];
        f.diagnosticsStatus = 'ready';
      },
    );
    const t = setInterval(() => {
      if (seen.length >= 3) {
        clearInterval(t);
        resolve();
      }
    }, 5);
  });
  queue.dispose();
  assert.deepEqual(seen, ['prepare', 'has:ready', 'run:ready']);
});
