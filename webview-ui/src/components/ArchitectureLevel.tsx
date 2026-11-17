import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState, type Dispatch } from 'react';
import type { Action, State } from '../state';
import { layoutGraph, NODE_H, NODE_W } from '../layout';
import { ErrorCard, Shimmer, StatusBadge, Thinking, splitPath } from './common';
import { Icon } from './Icons';
import { send } from '../vscode';
import { inline } from './Markdown';

const KIND_GLYPH: Record<string, string> = {
  ui: '◧',
  api: '⇄',
  service: '⚙',
  data: '⛁',
  db: '⛁',
  config: '⚑',
  test: '✓',
  infra: '☁',
  lib: '◇',
  external: '⬡',
  docs: '¶',
  build: '⚒',
};

export function ArchitectureLevel({ state, dispatch }: { state: State; dispatch: Dispatch<Action> }) {
  const ov = state.overview;
  const o = ov.status === 'ready' ? ov.value : undefined;
  const layout = useMemo(() => (o ? layoutGraph(o.components, o.flows) : undefined), [o]);
  const [hover, setHover] = useState<string>();
  const [step, setStep] = useState<number>(-1);
  const playing = step >= 0;
  const selected = state.componentFilter;

  useEffect(() => {
    if (!playing || !o) return;
    const t = setTimeout(() => setStep((s) => (s + 1 >= o.flows.length ? -1 : s + 1)), 1900);
    return () => clearTimeout(t);
  }, [step, playing, o]);

  if (!o || !layout) {
    return (
      <div className="level arch">
        {ov.status === 'error' ? (
          <ErrorCard message={ov.message} onRetry={() => send({ type: 'regenerate' })} />
        ) : (
          <div className="arch-loading">
            <Thinking label="Mapping components and data flow…" chars={ov.status === 'loading' ? ov.chars : 0} startedAt={ov.status === 'loading' ? ov.startedAt : undefined} />
            <div className="ghost-graph">
              {[0, 1, 2].map((i) => (
                <motion.div key={i} className="ghost-node" animate={{ opacity: [0.25, 0.6, 0.25] }} transition={{ repeat: Infinity, duration: 1.8, delay: i * 0.25 }} />
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  const focus = hover ?? selected;
  const activeFlow = playing ? o.flows[step] : undefined;
  const linked = (id: string) => !focus || id === focus || o.flows.some((f) => (f.from === focus && f.to === id) || (f.to === focus && f.from === id));
  const comp = o.components.find((c) => c.id === (selected ?? hover));
  const nameOf = (id: string) => o.components.find((c) => c.id === id)?.name ?? id;

  return (
    <div className="level arch">
      <div className="arch-toolbar">
        <div className="legend">
          {(['added', 'modified', 'removed', 'context'] as const).map((s) => (
            <span key={s} className={`legend-item cs-${s}`}>
              <span className="dot" /> {s === 'context' ? 'unchanged' : s}
            </span>
          ))}
        </div>
        {o.flows.length > 0 && (
          <button className={`btn ${playing ? '' : 'primary'}`} onClick={() => setStep(playing ? -1 : 0)}>
            {playing ? <Icon.stop size={12} /> : <Icon.play size={12} />}
            {playing ? 'Stop' : 'Play flow'}
          </button>
        )}
      </div>

      <div className="arch-body">
        <div className="diagram-scroll">
          <svg className="diagram" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`}>
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className="arrow-head" />
              </marker>
              <marker id="arrow-active" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className="arrow-head active" />
              </marker>
            </defs>

            {layout.edges.map((e, i) => {
              const isActive = activeFlow === e.flow;
              const dim = (focus && !(e.flow.from === focus || e.flow.to === focus)) || (playing && !isActive);
              return (
                <g key={i} className={`edge ${isActive ? 'active' : ''} ${dim ? 'dim' : ''}`}>
                  <motion.path
                    d={e.d}
                    className="edge-base"
                    markerEnd={isActive ? 'url(#arrow-active)' : 'url(#arrow)'}
                    initial={{ pathLength: 0, opacity: 0 }}
                    animate={{ pathLength: 1, opacity: 1 }}
                    transition={{ duration: 0.7, delay: 0.25 + i * 0.08, ease: 'easeInOut' }}
                  />
                  <path d={e.d} className="edge-flow" />
                  {isActive && (
                    <circle r={5} className="edge-pulse">
                      <animateMotion dur="1.2s" repeatCount="indefinite" path={e.d} />
                    </circle>
                  )}
                  <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6 + i * 0.08 }}>
                    <EdgeLabel x={e.mid.x} y={e.mid.y} order={e.flow.order} label={e.flow.label} active={isActive} />
                  </motion.g>
                </g>
              );
            })}

            {o.components.map((c, i) => {
              const p = layout.nodes.get(c.id);
              if (!p) return null;
              const isSel = c.id === selected;
              const inFlow = activeFlow && (activeFlow.from === c.id || activeFlow.to === c.id);
              return (
                <motion.g
                  key={c.id}
                  initial={{ opacity: 0, y: 12, scale: 0.94 }}
                  animate={{ opacity: linked(c.id) || inFlow ? 1 : 0.32, y: 0, scale: 1 }}
                  transition={{ type: 'spring', stiffness: 240, damping: 24, delay: p.layer * 0.07 + i * 0.02 }}
                  style={{ transformOrigin: `${p.x + NODE_W / 2}px ${p.y + NODE_H / 2}px` }}
                >
                  <foreignObject x={p.x} y={p.y} width={NODE_W} height={NODE_H}>
                    <button
                      className={`node cs-${c.status} ${isSel ? 'selected' : ''} ${inFlow ? 'in-flow' : ''}`}
                      onMouseEnter={() => setHover(c.id)}
                      onMouseLeave={() => setHover(undefined)}
                      onClick={() => dispatch({ type: 'setComponentFilter', id: isSel ? undefined : c.id })}
                      onDoubleClick={() => dispatch({ type: 'zoom', level: 2, component: c.id })}
                      title="Click to inspect · double-click to zoom into its files"
                    >
                      <span className="node-glyph">{KIND_GLYPH[c.kind.toLowerCase()] ?? '◆'}</span>
                      <span className="node-text">
                        <span className="node-name">{c.name}</span>
                        <span className="node-meta">
                          {c.kind} · {c.files.length} file{c.files.length === 1 ? '' : 's'}
                        </span>
                      </span>
                      <span className="node-status">{c.status === 'context' ? '' : c.status}</span>
                    </button>
                  </foreignObject>
                </motion.g>
              );
            })}
          </svg>
        </div>

        <AnimatePresence mode="wait">
          {comp ? (
            <motion.aside key={comp.id} className="inspector card" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 16 }} transition={{ duration: 0.18 }}>
              <div className={`inspector-head cs-${comp.status}`}>
                <span className="dot" />
                <h3>{comp.name}</h3>
              </div>
              <p className="inspector-desc">{inline(comp.description || 'No description.')}</p>
              <div className="inspector-flows">
                {o.flows
                  .filter((f) => f.from === comp.id || f.to === comp.id)
                  .map((f, i) => (
                    <div key={i} className="mini-flow">
                      <span className="flow-order">{f.order}</span>
                      {f.from === comp.id ? (
                        <>
                          <Icon.chevron size={11} /> {f.label} → <b>{nameOf(f.to)}</b>
                        </>
                      ) : (
                        <>
                          <b>{nameOf(f.from)}</b> → {f.label}
                        </>
                      )}
                    </div>
                  ))}
              </div>
              <div className="inspector-files">
                {comp.files.map((p) => {
                  const f = state.session!.files.find((x) => x.path === p);
                  return (
                    <button key={p} className="inspector-file" onClick={() => dispatch({ type: 'zoom', level: 3, file: p })}>
                      {f && <StatusBadge status={f.status} />}
                      <span className="fn-name">{splitPath(p).name}</span>
                      <span className="fn-dir">{splitPath(p).dir}</span>
                    </button>
                  );
                })}
              </div>
              <button className="btn primary block" onClick={() => dispatch({ type: 'zoom', level: 2, component: comp.id })}>
                <Icon.zoomIn size={13} /> Zoom into {comp.files.length} file{comp.files.length === 1 ? '' : 's'}
              </button>
            </motion.aside>
          ) : (
            <motion.aside key="hint" className="inspector card hint" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <Icon.layers size={22} />
              <p>Hover or click a component to inspect it. Double-click to zoom into its files.</p>
              {o.flows.length > 0 && <p className="muted">Press <b>Play flow</b> to walk through the interaction step by step.</p>}
            </motion.aside>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {activeFlow && (
          <motion.div key={step} className="flow-caption" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
            <span className="flow-order big">{activeFlow.order}</span>
            <b>{nameOf(activeFlow.from)}</b>
            <span className="muted">{activeFlow.label}</span>
            <Icon.chevron size={12} />
            <b>{nameOf(activeFlow.to)}</b>
            <span className="flow-progress">
              {step + 1} / {o.flows.length}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {!o.flows.length && o.components.length > 1 && <p className="muted center small">The model found no cross-component interactions for this change.</p>}
      {ov.status !== 'ready' && <Shimmer lines={1} />}
    </div>
  );
}

function EdgeLabel({ x, y, order, label, active }: { x: number; y: number; order: number; label: string; active: boolean }) {
  const text = label.length > 28 ? label.slice(0, 27) + '…' : label;
  const w = Math.max(40, text.length * 6.4 + 34);
  return (
    <g className={`edge-label ${active ? 'active' : ''}`} transform={`translate(${x - w / 2}, ${y - 11})`}>
      <rect width={w} height={22} rx={11} />
      <circle cx={11} cy={11} r={8} className="edge-label-num" />
      <text x={11} y={15} textAnchor="middle" className="edge-label-num-text">
        {order}
      </text>
      <text x={24} y={15} className="edge-label-text">
        {text}
      </text>
    </g>
  );
}
