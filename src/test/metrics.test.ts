import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GRAMMARS, GrammarError, GrammarStore, languageOf } from '../metrics/grammars';
import { MetricsEngine, MetricsError } from '../metrics/engine';
import type { FileMetrics } from '../shared/types';

// Grammars are downloaded once per machine into a temp folder shared by test runs, through the same checksum checks
// the extension uses.
const grammarDir = path.join(os.tmpdir(), 'pr-this-test-grammars');
const runtimeWasm = path.join(process.cwd(), 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm');
const engine = new MetricsEngine(runtimeWasm, new GrammarStore(grammarDir));

const fns = (m: FileMetrics) => m.functions.map((f) => [f.name, f.complexity, f.nesting, f.params]);

test('languageOf maps extensions and skips declaration files', () => {
  assert.equal(languageOf('a/B.java')?.grammar, 'java');
  assert.equal(languageOf('x.MJS')?.language, 'javascript');
  assert.equal(languageOf('x.tsx')?.grammar, 'tsx');
  assert.equal(languageOf('x.mts')?.grammar, 'typescript');
  assert.equal(languageOf('Program.cs')?.grammar, 'c_sharp');
  assert.equal(languageOf('types.d.ts'), undefined);
  assert.equal(languageOf('README.md'), undefined);
});

test('JavaScript: complexity, nesting, params and names', async () => {
  const m = await engine.measure(
    'a.js',
    `// header comment
function f(a, b) {
  if (a && b || c) {
    while (x) {}
  } else if (b) {
    return a ? 1 : 2;
  }
  const g = (x) => x ?? 1;
  switch (a) { case 1: break; case 2: break; default: }
  try {} catch (e) {}
  for (const k of ks) {}
  return 0;
}
class C {
  m(p, q = 1, ...r) { /* c */ return p; }
}
const h = function () {};
module.exports = { f };
`,
  );
  assert.deepEqual(fns(m), [
    ['f', 11, 2, 2],
    ['g', 2, 0, 1],
    ['C.m', 1, 0, 3],
    ['h', 1, 0, 0],
  ]);
  assert.equal(m.functions[0].line, 2);
  assert.equal(m.functions[0].lines, 12);
  assert.equal(m.complexity, 15);
  assert.equal(m.syntaxErrors, false);
});

test('TypeScript and TSX: classes, abstract members and arrow functions', async () => {
  const ts = await engine.measure(
    'a.ts',
    `interface I { m(a: number): void; }
export abstract class S<T> {
  abstract go(): void;
  run(a: number, b?: string): number {
    for (let i = 0; i < a; i++) { if (b) { return i; } }
    return 0;
  }
}
export const k = async <T,>(x: T): Promise<T> => x;
`,
  );
  assert.deepEqual(fns(ts), [
    ['S.run', 3, 2, 2],
    ['k', 1, 0, 1],
  ]);
  const tsx = await engine.measure('C.tsx', 'export const C = (p: P) => <div>{p.a ? 1 : 2}</div>;\n');
  assert.deepEqual(fns(tsx), [['C', 2, 0, 1]]);
});

test('Java: methods and constructors; lambdas count toward their method; abstract methods are skipped', async () => {
  const m = await engine.measure(
    'A.java',
    `package a;
/** Doc */
public class A {
  private int v;
  public A() { this.v = 0; }
  int f(int a, int b) {
    if (a > 0 && b > 0) {
      for (int i = 0; i < a; i++) { b++; }
    } else if (b < 0) {
      return a > 1 ? 1 : 2;
    }
    switch (a) { case 1: break; case 2: break; default: break; }
    try { g(); } catch (RuntimeException e) { }
    Runnable r = () -> { if (v > 0) {} };
    return b;
  }
  abstract static class B { abstract void x(); void y() {} }
  interface I { void z(); }
}
`,
  );
  assert.deepEqual(fns(m), [
    ['A.A', 1, 0, 0],
    ['A.f', 10, 2, 2],
    ['A.B.y', 1, 0, 0],
  ]);
  assert.equal(m.comments, 1);
});

test('C#: accessors, switch sections and expressions, local functions; auto-properties are skipped', async () => {
  const m = await engine.measure(
    'A.cs',
    `namespace N;
// comment
public class A {
  public int P { get; set; }
  public int Q { get { return x > 0 ? 1 : 0; } }
  public A(int x) { }
  int F(int a, string b) {
    if (a > 0 && b != null) {
      foreach (var c in b) { }
    }
    var y = b ?? "";
    switch (a) { case 1: case 2: break; default: break; }
    var z = a switch { 1 => "one", 2 => "two", _ => "many" };
    int Local(int q) => q;
    return a;
  }
}
`,
  );
  assert.deepEqual(fns(m), [
    ['A.Q.get', 2, 0, 0],
    ['A.A', 1, 0, 1],
    ['A.F', 9, 2, 2],
    ['A.Local', 1, 0, 1],
  ]);
});

test('line counts: blank, comment-only, mixed and non-ASCII lines', async () => {
  const m = await engine.measure('a.js', '// a\nconst a = 1; /* b */\n\n/* multi\n   line */\nconst é = "ü"; // c\n');
  assert.equal(m.lines, 6);
  assert.equal(m.comments, 5);
  assert.equal(m.code, 2);
});

test('syntax errors are flagged, not thrown; unsupported and oversized files are refused', async () => {
  const m = await engine.measure('a.js', 'function f( {\n');
  assert.equal(m.syntaxErrors, true);
  await assert.rejects(engine.measure('a.py', 'x = 1\n'), MetricsError);
  await assert.rejects(engine.measure('a.js', 'x'.repeat(1024 * 1024 + 1)), MetricsError);
});

test('GrammarStore: refuses downloads that fail the checksum and re-downloads a damaged cached file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-this-grammar-store-'));
  try {
    const src = GRAMMARS.java;
    let calls = 0;
    const wrong = (async () => {
      calls++;
      return new Response(new Uint8Array(src.bytes));
    }) as typeof fetch;
    await assert.rejects(new GrammarStore(dir, wrong).load('java'), GrammarError);
    assert.equal(fs.existsSync(path.join(dir, src.file)), false);

    // A good copy (from the shared test cache) is served from disk with no download.
    const good = await new GrammarStore(grammarDir).load('java');
    fs.writeFileSync(path.join(dir, src.file), good);
    calls = 0;
    assert.equal((await new GrammarStore(dir, wrong).load('java')).length, src.bytes);
    assert.equal(calls, 0);

    // A damaged cached copy is not used; it is downloaded again (and here the download is refused).
    fs.writeFileSync(path.join(dir, src.file), 'tampered');
    await assert.rejects(new GrammarStore(dir, wrong).load('java'), GrammarError);
    assert.equal(calls, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Measuring sessions

import { execFileSync } from 'child_process';
import { commitSession, workingSession } from '../core/git';
import { gitBlobSha, MetricsCache, SessionMetrics } from '../metrics/session';
import { functionChanges, metricsTotals } from '../shared/metrics';
import type { ChangeSession, DiffFile, MetricsLanguage } from '../shared/types';

function repo(): { dir: string; git: (...args: string[]) => string; write: (f: string, content: string) => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-this-metrics-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
      cwd: dir,
      encoding: 'utf8',
    });
  const write = (f: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), content);
  };
  git('init', '-q');
  return { dir, git, write };
}

async function measured(session: ChangeSession, enabled: MetricsLanguage[], metrics: SessionMetrics) {
  const changes: string[] = [];
  await metrics.measure(session, { enabled: new Set(enabled), onChange: (f) => changes.push(`${f.path}:${f.metricsStatus}`) });
  return { byPath: new Map(session.files.map((f) => [f.path, f] as [string, DiffFile])), changes };
}

test('gitBlobSha matches git hash-object', () => {
  const { dir, git, write } = repo();
  try {
    write('x.txt', 'héllo\n');
    assert.equal(gitBlobSha(fs.readFileSync(path.join(dir, 'x.txt'))), git('hash-object', 'x.txt').trim());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionMetrics: both sides of a commit, renames, additions, deletions, languages left off, and the cache', async () => {
  const { dir, git, write } = repo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-this-metrics-cache-'));
  try {
    write('src/calc.ts', 'export function f(a: number) {\n  return a;\n}\n');
    write('src/old.ts', 'export function g() {\n  return 1;\n}\n');
    write('Gone.java', 'class Gone { void x() {} }\n');
    write('legacy.js', 'function l() {}\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'one');
    write('src/calc.ts', 'export function f(a: number) {\n  if (a > 0 && a < 9) {\n    return a;\n  }\n  return 0;\n}\nexport const h = () => 1;\n');
    git('mv', 'src/old.ts', 'src/renamed.ts');
    git('rm', '-q', 'Gone.java');
    write('New.java', 'class New { int y(int a) { return a > 0 ? 1 : 0; } }\n');
    write('legacy.js', 'function l(a) { return a || 1; }\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'two');

    let parses = 0;
    const counting = new MetricsEngine(runtimeWasm, new GrammarStore(grammarDir));
    const measure = counting.measure.bind(counting);
    counting.measure = (p, s) => {
      parses++;
      return measure(p, s);
    };
    const metrics = new SessionMetrics(counting, new MetricsCache(cacheDir));

    const session = await commitSession(dir, 'HEAD', []);
    const { byPath, changes } = await measured(session, ['typescript', 'java'], metrics);

    const calc = byPath.get('src/calc.ts')!;
    assert.equal(calc.metricsStatus, 'ready');
    assert.equal(calc.metrics?.before?.complexity, 1);
    assert.equal(calc.metrics?.after?.complexity, 4);
    assert.deepEqual(
      functionChanges(calc.metrics!).map((c) => [c.name, c.kind, c.delta]),
      [
        ['f', 'changed', 2],
        ['h', 'added', 1],
      ],
    );
    // A pure rename: the before side is read from the old path, and the content is the same on both sides.
    const renamed = byPath.get('src/renamed.ts')!;
    assert.equal(renamed.oldPath, 'src/old.ts');
    assert.equal(renamed.metricsStatus, 'ready');
    assert.equal(renamed.metrics?.before?.functions[0].name, 'g');
    assert.deepEqual(renamed.metrics?.before, renamed.metrics?.after);
    assert.equal(byPath.get('New.java')!.metrics?.before, undefined);
    assert.equal(byPath.get('New.java')!.metrics?.after?.complexity, 2);
    assert.equal(byPath.get('Gone.java')!.metrics?.after, undefined);
    assert.equal(byPath.get('Gone.java')!.metrics?.before?.functions[0].name, 'Gone.x');
    // JavaScript was not turned on.
    assert.equal(byPath.get('legacy.js')!.metricsStatus, undefined);
    assert.ok(changes.includes('src/calc.ts:pending') && changes.includes('src/calc.ts:ready'));

    const t = metricsTotals(session.files);
    assert.equal(t.complexityAfter - t.complexityBefore, 3 + 2 - 1);

    // Measuring again reuses results: from memory, then from disk with a fresh cache.
    const first = parses;
    assert.ok(first > 0);
    await measured(await commitSession(dir, 'HEAD', []), ['typescript', 'java'], metrics);
    await measured(await commitSession(dir, 'HEAD', []), ['typescript', 'java'], new SessionMetrics(counting, new MetricsCache(cacheDir)));
    assert.equal(parses, first);

    // Turning a language off clears its files' metrics on the next run.
    const again = await commitSession(dir, 'HEAD', []);
    await measured(again, ['typescript', 'java'], metrics);
    const { byPath: off } = await measured(again, ['typescript'], metrics);
    assert.equal(off.get('New.java')!.metricsStatus, undefined);
    assert.equal(off.get('src/calc.ts')!.metricsStatus, 'ready');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('SessionMetrics: uncommitted changes measure the file on disk against HEAD', async () => {
  const { dir, git, write } = repo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-this-metrics-cache-'));
  try {
    write('Svc.cs', 'class Svc { int A(int x) { return x; } }\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'one');
    write('Svc.cs', 'class Svc { int A(int x) { if (x > 0) { return x; } return x ?? 0; } }\n');
    const session = await workingSession(dir, []);
    const { byPath } = await measured(session, ['csharp'], new SessionMetrics(engine, new MetricsCache(cacheDir)));
    const f = byPath.get('Svc.cs')!;
    assert.equal(f.metricsStatus, 'ready');
    assert.deepEqual([f.metrics?.before?.complexity, f.metrics?.after?.complexity], [1, 3]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('SessionMetrics: a parser that cannot be downloaded marks its files unavailable once, with a reason', async () => {
  const { dir, git, write } = repo();
  const grammars = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-this-no-grammars-'));
  try {
    write('A.java', 'class A {}\n');
    write('B.java', 'class B {}\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'one');
    let downloads = 0;
    const offline = (async () => {
      downloads++;
      throw new Error('getaddrinfo ENOTFOUND github.com');
    }) as typeof fetch;
    const metrics = new SessionMetrics(new MetricsEngine(runtimeWasm, new GrammarStore(grammars, offline)), new MetricsCache(grammars));
    const { byPath } = await measured(await commitSession(dir, 'HEAD', []), ['java'], metrics);
    for (const p of ['A.java', 'B.java']) {
      assert.equal(byPath.get(p)!.metricsStatus, 'unavailable');
      assert.match(byPath.get(p)!.metricsNote ?? '', /Java parser unavailable: .*network/);
    }
    assert.equal(downloads, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(grammars, { recursive: true, force: true });
  }
});
