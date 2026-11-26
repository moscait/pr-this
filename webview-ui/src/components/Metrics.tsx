import { motion, type Variants } from 'framer-motion';
import { useState, type Dispatch } from 'react';
import type { DiffFile, FunctionMetrics } from '../../../src/shared/types';
import { COMPLEXITY_THRESHOLD, functionChanges, metricsTotals, signed, type FunctionChange } from '../../../src/shared/metrics';
import type { Action, State } from '../state';
import { send } from '../vscode';
import { splitPath } from './common';

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** `12 → 15`, or a single number when a side is missing or unchanged. */
function span(before: number | undefined, after: number | undefined): string {
  if (before === undefined) return `${after ?? 0}`;
  if (after === undefined) return `${before} → none`;
  return before === after ? `${after}` : `${before} → ${after}`;
}

const trend = (delta: number) => (delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat');

/** Total-complexity pill for a file card; nothing until metrics are ready. */
export function MetricsBadge({ file }: { file: DiffFile }) {
  const r = file.metricsStatus === 'ready' ? file.metrics : undefined;
  if (!r || (!r.before && !r.after)) return null;
  const before = r.before?.complexity;
  const after = r.after?.complexity;
  const delta = (after ?? 0) - (before ?? 0);
  return (
    <span
      className={`metric-pill ${trend(delta)}`}
      title={`Cyclomatic complexity of the file: ${span(before, after)}${r.before && r.after ? ` (${signed(delta)})` : ''}`}
    >
      CC {span(before, after)}
    </span>
  );
}

/** The Intent-level summary of code metrics. Hidden when metrics are off for every language in the change. */
export function MetricsCard({ state, dispatch, variants }: { state: State; dispatch: Dispatch<Action>; variants?: Variants }) {
  const s = state.session!;
  const tracked = s.files.filter((f) => f.metricsStatus !== undefined);
  if (!tracked.length) return null;
  const t = metricsTotals(tracked);
  const pending = tracked.filter((f) => f.metricsStatus === 'pending');
  const unavailable = tracked.filter((f) => f.metricsStatus === 'unavailable');
  const notes = [...new Set(unavailable.map((f) => f.metricsNote).filter(Boolean))];
  const biggest = tracked
    .flatMap((f) => (f.metricsStatus === 'ready' && f.metrics ? functionChanges(f.metrics).map((c) => ({ f, c })) : []))
    .filter(({ c }) => c.delta > 0)
    .sort((a, b) => b.c.delta - a.c.delta || (b.c.after?.complexity ?? 0) - (a.c.after?.complexity ?? 0))
    .slice(0, 5);
  const delta = t.complexityAfter - t.complexityBefore;

  return (
    <motion.section className="card code-metrics" variants={variants}>
      <h2 className="card-title">Code metrics</h2>
      {t.files > 0 && (
        <dl className="metric-totals">
          <div>
            <dt>Complexity</dt>
            <dd>
              {span(t.complexityBefore, t.complexityAfter)} <span className={`metric-delta ${trend(delta)}`}>{signed(delta)}</span>
            </dd>
          </div>
          <div>
            <dt title={`Functions with cyclomatic complexity above ${COMPLEXITY_THRESHOLD}`}>Over {COMPLEXITY_THRESHOLD}</dt>
            <dd>
              {span(t.overBefore, t.overAfter)}{' '}
              <span className={`metric-delta ${trend(t.overAfter - t.overBefore)}`}>{signed(t.overAfter - t.overBefore)}</span>
            </dd>
          </div>
          <div>
            <dt>Code lines</dt>
            <dd>
              {span(t.codeBefore, t.codeAfter)} <span className="metric-delta flat">{signed(t.codeAfter - t.codeBefore)}</span>
            </dd>
          </div>
        </dl>
      )}
      {t.files > 0 && <p className="muted small">In {plural(t.files, 'measured file')}.</p>}
      {biggest.length > 0 && (
        <div className="focus-list">
          {biggest.map(({ f, c }) => (
            <button
              key={`${f.path}:${c.name}`}
              className={`focus-item sev-border-${(c.after?.complexity ?? 0) > COMPLEXITY_THRESHOLD ? 'risk' : 'warn'}`}
              onClick={() => dispatch({ type: 'zoom', level: 3, file: f.path })}
              title={f.path}
            >
              <span className="metric-delta up">{signed(c.delta)}</span>
              <div>
                <div className="focus-title mono">{c.name}</div>
                <div className="focus-detail">
                  {splitPath(f.path).name} · complexity {span(c.before?.complexity, c.after?.complexity)}
                  {c.kind === 'added' ? ' (new)' : ''}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
      {(pending.length > 0 || notes.length > 0) && (
        <ul className="sa-notes muted small">
          {pending.length > 0 && <li>{pending.find((f) => f.metricsNote)?.metricsNote ?? `Measuring ${plural(pending.length, 'file')}…`}</li>}
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </motion.section>
  );
}

function FunctionRow({ file, c }: { file: DiffFile; c: FunctionChange }) {
  const at: FunctionMetrics | undefined = c.after ?? c.before;
  const cell = (k: keyof Pick<FunctionMetrics, 'complexity' | 'nesting' | 'params' | 'lines'>) => {
    const b = c.before?.[k];
    const a = c.after?.[k];
    const d = (a ?? 0) - (b ?? 0);
    return (
      <td className={c.kind === 'changed' && d ? `changed ${trend(d)}` : ''}>
        {c.kind === 'added' ? a : c.kind === 'removed' ? b : span(b, a)}
      </td>
    );
  };
  const over = (c.after?.complexity ?? 0) > COMPLEXITY_THRESHOLD;
  return (
    <tr className={`fn-${c.kind}`}>
      <td className="fn-name">
        <button
          className="link mono"
          title={`Open at line ${at?.line}`}
          onClick={() => send({ type: 'openFile', path: file.path, line: at?.line, side: c.after ? 'new' : 'old' })}
        >
          {c.name}
        </button>
        {c.kind !== 'changed' && c.kind !== 'unchanged' && <span className={`fn-kind ${c.kind}`}>{c.kind}</span>}
        {over && (
          <span className="fn-kind over" title={`Cyclomatic complexity above ${COMPLEXITY_THRESHOLD}`}>
            complex
          </span>
        )}
      </td>
      {cell('complexity')}
      {cell('nesting')}
      {cell('params')}
      {cell('lines')}
    </tr>
  );
}

/** Per-function metrics for one file at the Lines level. */
export function FileMetricsPanel({ file }: { file: DiffFile }) {
  const [showAll, setShowAll] = useState(false);
  if (!file.metricsStatus) return null;
  if (file.metricsStatus !== 'ready' || !file.metrics) {
    return (
      <div className={`diag-status-note muted small ${file.metricsStatus === 'pending' ? 'pending' : 'stale'}`}>
        {file.metricsStatus === 'pending' ? (file.metricsNote ?? 'Measuring code metrics…') : `Code metrics unavailable: ${file.metricsNote ?? 'unknown error'}`}
      </div>
    );
  }
  const r = file.metrics;
  const changes = functionChanges(r);
  const moved = changes.filter((c) => c.kind !== 'unchanged');
  const shown = showAll ? changes : moved;
  const unchanged = changes.length - moved.length;
  return (
    <section className="card file-metrics">
      <h2 className="card-title">Code metrics</h2>
      <p className="metric-line small">
        Complexity <b>{span(r.before?.complexity, r.after?.complexity)}</b> · functions{' '}
        <b>{span(r.before?.functions.length, r.after?.functions.length)}</b> · code lines <b>{span(r.before?.code, r.after?.code)}</b> · comment lines{' '}
        <b>{span(r.before?.comments, r.after?.comments)}</b>
      </p>
      {(r.before?.syntaxErrors || r.after?.syntaxErrors) && (
        <p className="muted small">The parser found syntax errors in this file, so some numbers may be off.</p>
      )}
      {shown.length > 0 ? (
        <div className="fn-table-wrap">
          <table className="fn-table">
            <thead>
              <tr>
                <th>Function</th>
                <th title="Cyclomatic complexity">Complexity</th>
                <th title="Deepest nesting of control structures">Nesting</th>
                <th>Params</th>
                <th>Lines</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <FunctionRow key={`${c.kind}:${c.name}:${(c.after ?? c.before)?.line}`} file={file} c={c} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted small">No function's metrics changed.</p>
      )}
      {unchanged > 0 && (
        <button className="btn ghost small" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Hide unchanged functions' : `Show ${plural(unchanged, 'unchanged function')}`}
        </button>
      )}
    </section>
  );
}
