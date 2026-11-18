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
