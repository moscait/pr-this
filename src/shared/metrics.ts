// Comparing code metrics before and after a change. Shared by the extension and the webview.

import type { DiffFile, FileMetrics, FileMetricsResult, FunctionMetrics } from './types';

/** McCabe's classic limit: functions above this are commonly flagged as hard to test and maintain. */
export const COMPLEXITY_THRESHOLD = 10;

export type FunctionChangeKind = 'added' | 'removed' | 'changed' | 'unchanged';

export interface FunctionChange {
  name: string;
  kind: FunctionChangeKind;
  before?: FunctionMetrics;
  after?: FunctionMetrics;
  /** After minus before complexity (a removed function counts as negative its complexity). */
  delta: number;
}

const sameShape = (a: FunctionMetrics, b: FunctionMetrics) =>
  a.complexity === b.complexity && a.nesting === b.nesting && a.params === b.params && a.lines === b.lines;

/**
 * Pair functions by name (overloads in order of appearance) and say how each changed. Sorted with the biggest
 * complexity changes first, then the most complex.
 */
export function functionChanges(r: FileMetricsResult): FunctionChange[] {
  const before = new Map<string, FunctionMetrics[]>();
  for (const f of r.before?.functions ?? []) before.set(f.name, [...(before.get(f.name) ?? []), f]);
  const out: FunctionChange[] = [];
  for (const a of r.after?.functions ?? []) {
    const b = before.get(a.name)?.shift();
    if (!b) out.push({ name: a.name, kind: 'added', after: a, delta: a.complexity });
    else out.push({ name: a.name, kind: sameShape(a, b) ? 'unchanged' : 'changed', before: b, after: a, delta: a.complexity - b.complexity });
  }
  for (const rest of before.values()) for (const b of rest) out.push({ name: b.name, kind: 'removed', before: b, delta: -b.complexity });
  return out.sort(
    (x, y) => Math.abs(y.delta) - Math.abs(x.delta) || (y.after?.complexity ?? 0) - (x.after?.complexity ?? 0) || x.name.localeCompare(y.name),
  );
}

const maxComplexity = (m?: FileMetrics) => (m?.functions.length ? Math.max(...m.functions.map((f) => f.complexity)) : 0);
const overLimit = (m?: FileMetrics) => (m?.functions ?? []).filter((f) => f.complexity > COMPLEXITY_THRESHOLD).length;

export interface MetricsTotals {
  files: number;
  complexityBefore: number;
  complexityAfter: number;
  codeBefore: number;
  codeAfter: number;
  /** Functions above `COMPLEXITY_THRESHOLD`, before and after. */
  overBefore: number;
  overAfter: number;
  maxAfter: number;
}

/** Totals over every file with ready metrics. */
export function metricsTotals(files: DiffFile[]): MetricsTotals {
  const t: MetricsTotals = { files: 0, complexityBefore: 0, complexityAfter: 0, codeBefore: 0, codeAfter: 0, overBefore: 0, overAfter: 0, maxAfter: 0 };
  for (const f of files) {
    const r = f.metricsStatus === 'ready' ? f.metrics : undefined;
    if (!r) continue;
    t.files++;
    t.complexityBefore += r.before?.complexity ?? 0;
    t.complexityAfter += r.after?.complexity ?? 0;
    t.codeBefore += r.before?.code ?? 0;
    t.codeAfter += r.after?.code ?? 0;
    t.overBefore += overLimit(r.before);
    t.overAfter += overLimit(r.after);
    t.maxAfter = Math.max(t.maxAfter, maxComplexity(r.after));
  }
  return t;
}

/** `+3`, `−2` or `±0`. */
export function signed(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0';
}
