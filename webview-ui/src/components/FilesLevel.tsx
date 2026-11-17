import { AnimatePresence, motion } from 'framer-motion';
import { useMemo, useState, type Dispatch } from 'react';
import type { DiffFile } from '../../../src/shared/types';
import type { Action, State } from '../state';
import { DiffBar, FileName, StatusBadge } from './common';
import { Icon } from './Icons';
import { inline } from './Markdown';

type GroupBy = 'component' | 'folder' | 'none';

export function FilesLevel({ state, dispatch }: { state: State; dispatch: Dispatch<Action> }) {
  const s = state.session!;
  const o = state.overview.status === 'ready' ? state.overview.value : undefined;
  const loading = state.overview.status === 'loading' || state.overview.status === 'idle';
  const [query, setQuery] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('component');
  const filter = state.componentFilter;

  const summaryOf = useMemo(() => new Map(o?.files.map((f) => [f.path, f]) ?? []), [o]);
  const compName = (id?: string) => o?.components.find((c) => c.id === id)?.name ?? 'Other';

  const groups = useMemo(() => {
    const q = query.toLowerCase();
    const files = s.files.filter(
      (f) =>
        (!filter || summaryOf.get(f.path)?.component === filter) &&
        (!q || f.path.toLowerCase().includes(q) || summaryOf.get(f.path)?.summary.toLowerCase().includes(q)),
    );
    const mode: GroupBy = groupBy === 'component' && !o ? 'folder' : groupBy;
    if (mode === 'none') return [{ key: 'all', title: '', files, comp: undefined }];
    const map = new Map<string, DiffFile[]>();
    for (const f of files) {
      const k = mode === 'component' ? (summaryOf.get(f.path)?.component ?? 'other') : f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '/';
      map.set(k, [...(map.get(k) ?? []), f]);
    }
    const order = o?.components.map((c) => c.id) ?? [];
    return [...map.entries()]
      .sort((a, b) => (mode === 'component' ? order.indexOf(a[0]) - order.indexOf(b[0]) : a[0].localeCompare(b[0])))
      .map(([k, files]) => ({ key: k, title: mode === 'component' ? compName(k) : k, files, comp: mode === 'component' ? o?.components.find((c) => c.id === k) : undefined }));
  }, [s.files, query, groupBy, filter, o, summaryOf]);

  let idx = 0;
  return (
    <div className="level files">
      <div className="files-toolbar">
        <label className="search">
          <Icon.search size={13} />
          <input placeholder="Filter files or summaries…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="segmented" role="tablist">
          {(['component', 'folder', 'none'] as GroupBy[]).map((g) => (
            <button key={g} className={groupBy === g ? 'on' : ''} onClick={() => setGroupBy(g)} disabled={g === 'component' && !o}>
              {g === 'none' ? 'Flat' : g === 'component' ? 'Component' : 'Folder'}
            </button>
          ))}
        </div>
        <AnimatePresence>
          {filter && (
            <motion.button className="filter-chip" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} onClick={() => dispatch({ type: 'setComponentFilter' })}>
              {compName(filter)} <Icon.close size={11} />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {groups.map((g) => (
        <section key={g.key} className="file-group">
          {g.title && (
            <header className="group-head">
              {g.comp && <span className={`dot cs-${g.comp.status}`} />}
              <h3>{g.title}</h3>
              <span className="muted small">{g.files.length}</span>
              {g.comp?.description && <span className="group-desc">{inline(g.comp.description)}</span>}
            </header>
          )}
          <div className="file-grid">
            {g.files.map((f) => {
              const sum = summaryOf.get(f.path)?.summary;
              const i = idx++;
              return (
                <motion.button
                  key={f.path}
                  layout
                  className={`file-card st-border-${f.status}`}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.025, 0.4), type: 'spring', stiffness: 300, damping: 28 }}
                  onClick={() => dispatch({ type: 'zoom', level: 3, file: f.path })}
                >
                  <div className="file-card-head">
                    <StatusBadge status={f.status} />
                    <FileName file={f} />
                  </div>
                  <div className="file-card-summary">
                    {f.excluded ? (
                      <span className="muted">Not analysed: {f.excludedReason ?? (f.binary ? 'binary file' : 'excluded from AI')}</span>
                    ) : sum ? (
                      inline(sum)
                    ) : loading ? (
                      <span className="shimmer inline" />
                    ) : (
                      <span className="muted">Zoom in for details</span>
                    )}
                  </div>
                  <div className="file-card-foot">
                    <DiffBar add={f.additions} del={f.deletions} />
                    <span className="hunks muted small">
                      {f.hunks.length} hunk{f.hunks.length === 1 ? '' : 's'}
                    </span>
                    <span className="zoom-arrow">
                      <Icon.zoomIn size={13} />
                    </span>
                  </div>
                </motion.button>
              );
            })}
          </div>
        </section>
      ))}
      {!groups.some((g) => g.files.length) && <p className="muted center">No files match.</p>}
    </div>
  );
}
