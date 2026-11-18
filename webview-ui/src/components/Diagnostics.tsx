import { motion, type Variants } from 'framer-motion';
import type { Dispatch } from 'react';
import type { DiffDiagnostic, DiffFile } from '../../../src/shared/types';
import type { Action, State } from '../state';
import { splitPath } from './common';
import { SeverityIcon } from './Icons';

export interface DiagnosticCounts {
  error: number;
  warning: number;
  info: number;
}

export function countDiagnostics(diags: DiffDiagnostic[] | undefined): DiagnosticCounts {
  const c = { error: 0, warning: 0, info: 0 };
  for (const d of diags ?? []) {
    if (d.severity === 'error') c.error++;
    else if (d.severity === 'warning') c.warning++;
    else c.info++;
  }
  return c;
}

/** Diagnostics a file shows: only settled ones that match the diff. */
export function shownDiagnostics(f: DiffFile): DiffDiagnostic[] {
  return f.diagnosticsStatus === 'ready' ? (f.diagnostics ?? []) : [];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function describeCounts(c: DiagnosticCounts): string {
  const parts = [c.error && plural(c.error, 'error'), c.warning && plural(c.warning, 'warning'), c.info && `${c.info} info`].filter(Boolean);
  return parts.length ? parts.join(', ') : 'no problems';
}

/** Error / warning / info pills; renders nothing when there are no problems. */
export function DiagnosticPills({ diagnostics, title }: { diagnostics: DiffDiagnostic[]; title?: string }) {
  const c = countDiagnostics(diagnostics);
  if (!diagnostics.length) return null;
  return (
    <span className="file-diagnostics-badge" title={title ?? `Static analysis on changed lines: ${describeCounts(c)}`}>
      {c.error > 0 && (
        <span className="diag-pill error">
          <SeverityIcon severity="risk" size={11} /> {c.error}
        </span>
      )}
      {c.warning > 0 && (
        <span className="diag-pill warning">
          <SeverityIcon severity="warn" size={11} /> {c.warning}
        </span>
      )}
      {c.info > 0 && (
        <span className="diag-pill info">
          <SeverityIcon severity="info" size={11} /> {c.info}
        </span>
      )}
    </span>
  );
}

/** Why a file shows no static analysis, or that it is still running. */
export function statusText(f: DiffFile): string | undefined {
  switch (f.diagnosticsStatus) {
    case 'pending':
      return 'Static analysis running…';
    case 'stale':
      return 'Static analysis not shown: this file has changed on disk since this version, so problems would point at the wrong lines. For uncommitted changes, refresh the Lens to see the latest.';
    case 'unsaved':
      return 'Static analysis not shown: this file has unsaved edits. Save it to see problems on these changes.';
    default:
      return undefined;
  }
}

/** The Intent-level summary of static analysis across the change. Hidden when analysis is off or nothing applies. */
export function StaticAnalysisCard({ state, dispatch, variants }: { state: State; dispatch: Dispatch<Action>; variants?: Variants }) {
  const s = state.session!;
  const tracked = s.files.filter((f) => f.diagnosticsStatus !== undefined);
  if (!tracked.length) return null;

  const ready = tracked.filter((f) => f.diagnosticsStatus === 'ready');
  const pending = tracked.filter((f) => f.diagnosticsStatus === 'pending').length;
  const stale = tracked.filter((f) => f.diagnosticsStatus === 'stale').length;
  const unsaved = tracked.filter((f) => f.diagnosticsStatus === 'unsaved').length;
  const all = ready.flatMap((f) => f.diagnostics ?? []);
  const total = countDiagnostics(all);
  const withProblems = ready
    .filter((f) => f.diagnostics?.length)
    .map((f) => ({ f, c: countDiagnostics(f.diagnostics) }))
    .sort((a, b) => b.c.error - a.c.error || b.c.warning - a.c.warning || b.c.info - a.c.info);

  return (
    <motion.section className="card static-analysis" variants={variants}>
      <h2 className="card-title">Static analysis</h2>
      {ready.length > 0 && (
        <p className="sa-summary">
          {all.length ? (
            <>
              <DiagnosticPills diagnostics={all} /> on changed lines in {plural(withProblems.length, 'file')}
            </>
          ) : (
            <span className="muted">No problems reported on changed lines in {plural(ready.length, 'analysed file')}.</span>
          )}
        </p>
      )}
      {withProblems.length > 0 && (
        <div className="focus-list">
          {withProblems.slice(0, 6).map(({ f, c }) => (
            <button
              key={f.path}
              className={`focus-item sev-border-${c.error ? 'risk' : c.warning ? 'warn' : 'info'}`}
              onClick={() => dispatch({ type: 'zoom', level: 3, file: f.path })}
              title={f.path}
            >
              <SeverityIcon severity={c.error ? 'risk' : c.warning ? 'warn' : 'info'} />
              <div>
                <div className="focus-title">{splitPath(f.path).name}</div>
                <div className="focus-detail">{describeCounts(c)}</div>
              </div>
            </button>
          ))}
          {withProblems.length > 6 && <p className="muted small">+ {withProblems.length - 6} more files with problems (see Files)</p>}
        </div>
      )}
      {(pending > 0 || stale > 0 || unsaved > 0) && (
        <ul className="sa-notes muted small">
          {pending > 0 && <li>Analysing {plural(pending, 'file')}…</li>}
          {stale > 0 && <li>{plural(stale, 'file')} not shown: changed on disk since this version.</li>}
          {unsaved > 0 && <li>{plural(unsaved, 'file')} not shown: unsaved edits.</li>}
        </ul>
      )}
      {total.error + total.warning + total.info === 0 && ready.length === 0 && pending === 0 && (
        <p className="muted small">No results for this version of the files.</p>
      )}
    </motion.section>
  );
}
