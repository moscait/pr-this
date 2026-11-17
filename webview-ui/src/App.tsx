import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { HostMessage } from '../../src/shared/types';
import { initialState, reducer, LEVELS, type Level, type State } from './state';
import { persisted, send } from './vscode';
import { ZoomRail } from './components/ZoomRail';
import { OverviewLevel } from './components/OverviewLevel';
import { ArchitectureLevel } from './components/ArchitectureLevel';
import { FilesLevel } from './components/FilesLevel';
import { LinesLevel } from './components/LinesLevel';
import { AskBar } from './components/AskBar';
import { Icon } from './components/Icons';
import { splitPath } from './components/common';

const variants = {
  enter: (dir: number) => ({ opacity: 0, scale: dir > 0 ? 0.92 : 1.08, filter: 'blur(6px)' }),
  center: { opacity: 1, scale: 1, filter: 'blur(0px)' },
  exit: (dir: number) => ({ opacity: 0, scale: dir > 0 ? 1.08 : 0.92, filter: 'blur(6px)' }),
};

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState, (s): State => {
    const saved = persisted.getState<{ level?: Level; selectedFile?: string }>();
    return { ...s, level: saved?.level ?? 0, selectedFile: saved?.selectedFile };
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const onMsg = (e: MessageEvent<HostMessage>) => dispatch(e.data);
    window.addEventListener('message', onMsg);
    send({ type: 'ready' });
    const timer = setTimeout(() => {
      if (!stateRef.current.session) {
        send({ type: 'ready' });
      }
    }, 500);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
    };
  }, []);

  useEffect(() => {
    persisted.setState({ level: state.level, selectedFile: state.selectedFile });
  }, [state.level, state.selectedFile]);

  const zoom = useCallback((level: Level) => dispatch({ type: 'zoom', level: Math.max(0, Math.min(3, level)) as Level }), []);

  // Keyboard: +/- zoom, 1-4 jump, Esc out, j/k next/prev file in Lines.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
      const s = stateRef.current;
      if (e.key === '+' || e.key === '=') zoom((s.level + 1) as Level);
      else if (e.key === '-' || e.key === '_') zoom((s.level - 1) as Level);
      else if (e.key === 'Escape' && s.level > 0) zoom((s.level - 1) as Level);
      else if (/^[1-4]$/.test(e.key)) zoom((Number(e.key) - 1) as Level);
      else if ((e.key === 'j' || e.key === 'k') && s.session) {
        const files = s.session.files;
        const i = files.findIndex((f) => f.path === s.selectedFile);
        const next = files[Math.max(0, Math.min(files.length - 1, i + (e.key === 'j' ? 1 : -1)))];
        if (next) dispatch(s.level === 3 ? { type: 'selectFile', path: next.path } : { type: 'zoom', level: 3, file: next.path });
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  // Pinch / Ctrl+wheel zoom between levels.
  useEffect(() => {
    let acc = 0;
    let lock = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (Date.now() < lock) return;
      acc += e.deltaY;
      if (Math.abs(acc) > 40) {
        zoom((stateRef.current.level + (acc < 0 ? 1 : -1)) as Level);
        acc = 0;
        lock = Date.now() + 450;
      }
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, [zoom]);

  const s = state.session;
  if (!s) {
    return (
      <div className="boot">
        <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 2.4, ease: 'linear' }}>
          <Icon.sparkle size={26} />
        </motion.div>
        <span style={{ marginTop: '12px', fontSize: '12px', color: 'var(--muted)' }}>Loading change lens…</span>
      </div>
    );
  }

  const o = state.overview.status === 'ready' ? state.overview.value : undefined;
  const compName = o?.components.find((c) => c.id === state.componentFilter)?.name;
  const p = state.provider;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-title">
          <div className="repo">
            <span className={`scope scope-${s.scope.kind}`}>{s.scope.kind === 'working' ? 'Working tree' : s.scope.kind === 'range' ? 'Compare' : 'Commit'}</span>
            <span className="repo-name">{s.repoName}</span>
          </div>
          <div className="subtitle" title={s.subtitle}>
            {s.subtitle}
          </div>
        </div>
        <ZoomRail level={state.level} onChange={zoom} />
        <div className="topbar-actions">
          {p && (
            <button className="provider-chip" onClick={() => send({ type: 'configureProvider' })} title="Change AI provider">
              {p.local ? <Icon.local size={13} /> : <Icon.cloud size={13} />}
              <span>{p.label}</span>
              <span className="provider-model">{p.model}</span>
            </button>
          )}
          <button className="icon-btn" title="Copy summary as Markdown (for PR descriptions)" disabled={!o} onClick={() => send({ type: 'copyMarkdown' })}>
            <Icon.copy size={14} />
          </button>
          <button className="icon-btn" title="Regenerate explanation" disabled={state.overview.status === 'loading'} onClick={() => send({ type: 'regenerate' })}>
            <Icon.refresh size={14} />
          </button>
        </div>
      </header>

      <div className="crumbs">
        {LEVELS.slice(0, state.level + 1).map((l, i) => (
          <span key={l.id} className="crumb-wrap">
            {i > 0 && <Icon.chevron size={10} />}
            <button className={`crumb ${i === state.level ? 'current' : ''}`} onClick={() => zoom(l.id)}>
              {l.id === 0 ? (o?.headline ?? s.title) : l.label}
            </button>
          </span>
        ))}
        {state.level >= 2 && compName && (
          <span className="crumb-wrap">
            <Icon.chevron size={10} />
            <span className="crumb tag">{compName}</span>
          </span>
        )}
        {state.level === 3 && state.selectedFile && (
          <span className="crumb-wrap">
            <Icon.chevron size={10} />
            <span className="crumb current">{splitPath(state.selectedFile).name}</span>
          </span>
        )}
      </div>

      <main className="stage">
        <AnimatePresence mode="popLayout" custom={state.direction} initial={false}>
          <motion.div
            key={state.level}
            className="stage-inner"
            custom={state.direction}
            variants={variants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            {state.level === 0 && <OverviewLevel state={state} dispatch={dispatch} />}
            {state.level === 1 && <ArchitectureLevel state={state} dispatch={dispatch} />}
            {state.level === 2 && <FilesLevel state={state} dispatch={dispatch} />}
            {state.level === 3 && <LinesLevel state={state} dispatch={dispatch} />}
          </motion.div>
        </AnimatePresence>
      </main>

      <AskBar state={state} dispatch={dispatch} />
    </div>
  );
}
