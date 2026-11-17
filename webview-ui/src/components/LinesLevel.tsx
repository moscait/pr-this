import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState, type Dispatch } from 'react';
import type { DiffFile, DiffHunk, HunkNote } from '../../../src/shared/types';
import type { Action, State } from '../state';
import { DiffBar, ErrorCard, FileName, Shimmer, StatusBadge, Thinking, splitPath } from './common';
import { Icon, SeverityIcon } from './Icons';
import { Markdown, inline } from './Markdown';
import { send } from '../vscode';

const MAX_LINES_PER_HUNK = 400;

export function LinesLevel({ state, dispatch }: { state: State; dispatch: Dispatch<Action> }) {
  const s = state.session!;
  const file = s.files.find((f) => f.path === state.selectedFile) ?? s.files[0];
  const detail = file ? state.files[file.path] : undefined;
  const o = state.overview.status === 'ready' ? state.overview.value : undefined;
  const [notes, setNotes] = useState(true);
  const navRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  // Request a deep-dive the first time a file is shown (wait for the overview so it has context).
  useEffect(() => {
    if (!file || detail) return;
    if (state.overview.status === 'loading') return;
    send({ type: 'explainFile', path: file.path });
  }, [file?.path, detail, state.overview.status]);

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
    navRef.current?.querySelector('.nav-item.on')?.scrollIntoView({ block: 'nearest' });
  }, [file?.path]);

  if (!file) return null;
  const d = detail?.status === 'ready' ? detail.value : undefined;
  const noteFor = (h: DiffHunk) => d?.hunks.find((n) => n.index === h.index);
  const summary = o?.files.find((f) => f.path === file.path)?.summary;

  return (
    <div className="level lines">
      <nav className="file-nav" ref={navRef}>
        {s.files.map((f) => {
          const st = state.files[f.path];
          return (
            <button key={f.path} className={`nav-item ${f.path === file.path ? 'on' : ''}`} onClick={() => dispatch({ type: 'selectFile', path: f.path })} title={f.path}>
              <StatusBadge status={f.status} />
              <span className="nav-name">{splitPath(f.path).name}</span>
              {st?.status === 'loading' && <span className="nav-spinner" />}
              {st?.status === 'ready' && st.value.hunks.some((h) => h.concern) && <span className="nav-flag" title="Has review notes" />}
            </button>
          );
        })}
        <div className="nav-hint muted small">
          <kbd>j</kbd>/<kbd>k</kbd> next / prev
        </div>
      </nav>

      <div className="lines-main" ref={mainRef}>
        <AnimatePresence mode="wait">
          <motion.div key={file.path} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.16 }}>
            <header className="file-head">
              <div className="file-head-title">
                <StatusBadge status={file.status} />
                <FileName file={file} />
                <DiffBar add={file.additions} del={file.deletions} />
              </div>
              <div className="file-head-actions">
                <button className={`btn ghost ${notes ? 'on' : ''}`} onClick={() => setNotes(!notes)} title="Toggle AI notes">
                  <Icon.sparkle size={13} /> Notes
                </button>
                <button className="btn ghost" onClick={() => send({ type: 'openDiff', path: file.path })} title="Open in VS Code diff editor">
                  <Icon.diff size={13} /> Diff
                </button>
                {file.status !== 'deleted' && (
                  <button className="btn ghost" onClick={() => send({ type: 'openFile', path: file.path })} title="Open file">
                    <Icon.open size={13} /> Open
                  </button>
                )}
              </div>
            </header>
            {file.oldPath && <div className="rename-note muted small">Renamed from {file.oldPath}</div>}

            <section className="narrative card">
              {d ? (
                <>
                  <Markdown text={d.narrative || summary || ''} />
                  <button className="icon-btn regen" title="Regenerate" onClick={() => send({ type: 'explainFile', path: file.path, force: true })}>
                    <Icon.refresh size={12} />
                  </button>
                </>
              ) : detail?.status === 'error' ? (
                <ErrorCard message={detail.message} onRetry={() => send({ type: 'explainFile', path: file.path, force: true })} />
              ) : (
                <>
                  {summary && <p className="muted">{inline(summary)}</p>}
                  <Thinking label={state.overview.status === 'loading' ? 'Waiting for the overview…' : 'Explaining this file hunk by hunk…'} chars={detail?.status === 'loading' ? detail.chars : 0} startedAt={detail?.status === 'loading' ? detail.startedAt : state.overview.status === 'loading' ? state.overview.startedAt : undefined} />
                  <Shimmer lines={2} widths={[95, 70]} />
                </>
              )}
            </section>

            {file.binary && <p className="muted center">Binary file — no textual diff.</p>}
            {!file.binary && !file.hunks.length && <p className="muted center">{file.excludedReason ? `Not shown: ${file.excludedReason}.` : 'No content changes.'}</p>}

            {file.hunks.map((h) => (
              <Hunk key={h.index} file={file} hunk={h} note={noteFor(h)} showNote={notes} pending={!d && detail?.status !== 'error'} />
            ))}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function Hunk({ file, hunk, note, showNote, pending }: { file: DiffFile; hunk: DiffHunk; note?: HunkNote; showNote: boolean; pending: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const lines = expanded ? hunk.lines : hunk.lines.slice(0, MAX_LINES_PER_HUNK);
  return (
    <section className="hunk">
      <AnimatePresence initial={false}>
        {showNote && (note || pending) && (
          <motion.div
            className={`hunk-note ${note ? `sev-border-${note.severity}` : ''}`}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
          >
            {note ? (
              <div className="hunk-note-inner">
                <div className="hunk-note-title">
                  <span className="hunk-index">{hunk.index}</span>
                  {note.title || 'Change'}
                </div>
                <div className="hunk-note-body">{inline(note.explanation)}</div>
                {note.concern && (
                  <div className={`concern sev-${note.severity === 'info' ? 'warn' : note.severity}`}>
                    <SeverityIcon severity={note.severity === 'info' ? 'warn' : note.severity} size={13} />
                    <span>{inline(note.concern)}</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="hunk-note-inner">
                <Shimmer lines={1} widths={[60]} />
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      <div className="code">
        <div className="hunk-header">
          <span>{hunk.header.replace(/@@ ?(.*)$/, '@@')}</span>
          {hunk.section && <span className="hunk-section">{hunk.section}</span>}
        </div>
        <table>
          <tbody>
            {lines.map((l, i) => (
              <tr
                key={i}
                className={`ln ln-${l.kind}`}
                onDoubleClick={() =>
                  send({
                    type: 'openFile',
                    path: file.path,
                    line: l.kind === 'del' ? l.oldLine : l.newLine,
                    side: l.kind === 'del' ? 'old' : 'new',
                  })
                }
              >
                <td className="ln-num">{l.oldLine ?? ''}</td>
                <td className="ln-num">{l.newLine ?? ''}</td>
                <td className="ln-sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : l.kind === 'meta' ? '' : ''}</td>
                <td className="ln-text">{l.kind === 'meta' ? <i>{l.text}</i> : l.text || ' '}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!expanded && hunk.lines.length > MAX_LINES_PER_HUNK && (
          <button className="btn ghost block" onClick={() => setExpanded(true)}>
            Show {hunk.lines.length - MAX_LINES_PER_HUNK} more lines
          </button>
        )}
      </div>
    </section>
  );
}
