import { AnimatePresence, motion } from 'framer-motion';
import { Fragment, useEffect, useRef, useState, type Dispatch } from 'react';
import type { DiffFile, DiffHunk, HunkNote, ImageDiff, ImageSide } from '../../../src/shared/types';
import { formatBytes, MAX_PREVIEW_IMAGE_BYTES } from '../../../src/shared/format';
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

  // Request image preview on demand when an image file is displayed without loaded pixels.
  useEffect(() => {
    if (!file || !file.image) return;
    if (state.images[file.path]) return;
    send({ type: 'loadImage', path: file.path });
  }, [file?.path, file?.image, state.images]);

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
          const hasError = f.diagnostics?.some((d) => d.severity === 'error');
          const hasWarn = f.diagnostics?.some((d) => d.severity === 'warning');
          return (
            <button key={f.path} className={`nav-item ${f.path === file.path ? 'on' : ''}`} onClick={() => dispatch({ type: 'selectFile', path: f.path })} title={f.path}>
              <StatusBadge status={f.status} />
              <span className="nav-name">{splitPath(f.path).name}</span>
              {f.diagnostics && f.diagnostics.length > 0 && (
                <span
                  className={`nav-diag ${hasError ? 'error' : hasWarn ? 'warning' : 'info'}`}
                  title={`${f.diagnostics.length} diagnostic${f.diagnostics.length === 1 ? '' : 's'} on modified lines`}
                />
              )}
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
                {file.diagnostics && file.diagnostics.length > 0 && (
                  <div
                    className="file-diagnostics-badge"
                    title={`${file.diagnostics.length} diagnostic${file.diagnostics.length === 1 ? '' : 's'} on modified lines`}
                  >
                    {file.diagnostics.filter((d) => d.severity === 'error').length > 0 && (
                      <span className="diag-pill error">
                        <SeverityIcon severity="risk" size={11} /> {file.diagnostics.filter((d) => d.severity === 'error').length}
                      </span>
                    )}
                    {file.diagnostics.filter((d) => d.severity === 'warning').length > 0 && (
                      <span className="diag-pill warning">
                        <SeverityIcon severity="warn" size={11} /> {file.diagnostics.filter((d) => d.severity === 'warning').length}
                      </span>
                    )}
                    {file.diagnostics.filter((d) => d.severity !== 'error' && d.severity !== 'warning').length > 0 && (
                      <span className="diag-pill info">
                        <SeverityIcon severity="info" size={11} /> {file.diagnostics.filter((d) => d.severity !== 'error' && d.severity !== 'warning').length}
                      </span>
                    )}
                  </div>
                )}
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

            {file.image && <ImagePreviewCard image={state.images[file.path] ?? file.image} />}
            {file.binary && !file.image && <p className="muted center">Binary file — no textual diff.</p>}
            {!file.binary && !file.hunks.length && !file.image && <p className="muted center">{file.excludedReason ? `Not shown: ${file.excludedReason}.` : 'No content changes.'}</p>}

            {file.hunks.map((h) => (
              <Hunk key={h.index} file={file} hunk={h} note={noteFor(h)} showNote={notes} pending={!d && detail?.status !== 'error'} />
            ))}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function ImageSideBox({ label, side, tone }: { label: string; side: ImageSide; tone: 'del' | 'add' }) {
  const fmt = side.mime.replace('image/', '').replace('+xml', '').toUpperCase();
  const dims = side.width && side.height ? `${side.width} × ${side.height} px` : undefined;
  const reason =
    side.unavailable === 'too-large'
      ? `Too large to preview (${formatBytes(side.bytes)} > ${formatBytes(MAX_PREVIEW_IMAGE_BYTES)})`
      : side.unavailable === 'symlink'
      ? 'Preview unavailable (symbolic link)'
      : side.unavailable === 'unreadable'
      ? 'Preview unavailable (unreadable)'
      : 'Preview unavailable';

  return (
    <div className={`img-pane img-pane-${tone}`}>
      <div className="img-pane-head">
        <span className={`img-badge img-badge-${tone}`}>{label}</span>
        <span className="img-meta">
          {fmt}
          {dims ? ` · ${dims}` : ''} · {formatBytes(side.bytes)}
        </span>
      </div>
      <div className="img-stage">
        {side.dataUri ? <img src={side.dataUri} alt={`${label} preview`} /> : <span className="muted small">{reason}</span>}
      </div>
    </div>
  );
}

function ImagePreviewCard({ image }: { image: ImageDiff }) {
  const before = image.before;
  const after = image.after;
  if (!before && !after) return null;
  const delta = before && after ? after.bytes - before.bytes : undefined;
  return (
    <section className="img-diff card">
      <div className="img-diff-header">
        <span className="card-title" style={{ margin: 0 }}>
          Visual preview
        </span>
        {delta !== undefined && (
          <span className={`img-delta ${delta > 0 ? 'num-add' : delta < 0 ? 'num-del' : 'muted'}`}>
            {delta > 0 ? `+${formatBytes(delta)}` : delta < 0 ? `−${formatBytes(Math.abs(delta))}` : '0 B'} ({before && before.bytes > 0 ? `${Math.round((delta / before.bytes) * 100)}%` : '0%'})
          </span>
        )}
      </div>
      <div className={`img-diff-grid ${before && after ? 'two-col' : 'one-col'}`}>
        {before && <ImageSideBox label="Before" side={before} tone="del" />}
        {after && <ImageSideBox label="After" side={after} tone="add" />}
      </div>
    </section>
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
            {lines.map((l, i) => {
              const lineDiags =
                l.kind === 'add' && typeof l.newLine === 'number'
                  ? file.diagnostics?.filter((d) => d.line === l.newLine)
                  : undefined;
              return (
                <Fragment key={i}>
                  <tr
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
                  {lineDiags?.map((d, di) => (
                    <tr key={`diag-${i}-${di}`} className={`ln-diag-row ln-diag-${d.severity}`}>
                      <td className="ln-num"></td>
                      <td className="ln-num">{d.line}</td>
                      <td className="ln-sign">
                        <SeverityIcon severity={d.severity === 'error' ? 'risk' : d.severity === 'warning' ? 'warn' : 'info'} size={12} />
                      </td>
                      <td className="ln-text ln-diag-msg">
                        {d.source && <span className="diag-source">[{d.source}] </span>}
                        {d.code !== undefined && <span className="diag-code">({String(d.code)}) </span>}
                        <span className="diag-text">{d.message}</span>
                      </td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
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
