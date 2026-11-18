import { motion, type Variants } from 'framer-motion';
import type { Dispatch } from 'react';
import type { Action, State } from '../state';
import { Markdown, inline } from './Markdown';
import { ErrorCard, Shimmer, Thinking, splitPath } from './common';
import { Icon, SeverityIcon } from './Icons';
import { send } from '../vscode';
import { StaticAnalysisCard } from './Diagnostics';

const stagger: Variants = { animate: { transition: { staggerChildren: 0.05 } } };
const rise: Variants = { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 260, damping: 26 } } };

const TYPE_LABEL: Record<string, string> = {
  feature: 'Feature',
  fix: 'Bug fix',
  refactor: 'Refactor',
  perf: 'Performance',
  test: 'Tests',
  docs: 'Docs',
  chore: 'Chore',
  build: 'Build',
  style: 'Style',
  security: 'Security',
  mixed: 'Mixed',
};

export function OverviewLevel({ state, dispatch }: { state: State; dispatch: Dispatch<Action> }) {
  const s = state.session!;
  const ov = state.overview;
  const o = ov.status === 'ready' ? ov.value : ov.status === 'loading' ? ov.partial : undefined;

  return (
    <motion.div className="level overview" variants={stagger} initial="initial" animate="animate">
      <motion.section className="hero" variants={rise}>
        <div className="hero-chips">
          {o && <span className={`chip type-${o.changeType}`}>{TYPE_LABEL[o.changeType] ?? o.changeType}</span>}
          {o && (
            <span className={`chip risk risk-${o.risk.level}`} title={o.risk.reasons.join('\n')}>
              <span className="risk-meter">
                {[0, 1, 2].map((i) => (
                  <i key={i} className={i <= ['low', 'medium', 'high'].indexOf(o.risk.level) ? 'on' : ''} />
                ))}
              </span>
              {o.risk.level} risk
            </span>
          )}
          {ov.status === 'ready' && ov.cached && <span className="chip subtle">cached</span>}
        </div>
        {o ? (
          <>
            <h1 className="headline">{o.headline}</h1>
            {o.intent && <p className="intent">{inline(o.intent)}</p>}
            {ov.status === 'loading' && (
              <Thinking label={`${state.provider?.label ?? 'AI'} is streaming the overview…`} chars={ov.chars} startedAt={ov.startedAt} />
            )}
          </>
        ) : ov.status === 'error' ? (
          <h1 className="headline muted-headline">{s.title}</h1>
        ) : (
          <>
            <h1 className="headline muted-headline">{s.title}</h1>
            <Thinking label={`${state.provider?.label ?? 'AI'} is reading ${s.files.length} file${s.files.length === 1 ? '' : 's'}…`} chars={ov.status === 'loading' ? ov.chars : 0} startedAt={ov.status === 'loading' ? ov.startedAt : undefined} />
          </>
        )}
        <div className="stats">
          <Stat value={s.files.length} label="files" />
          <Stat value={`+${s.additions}`} label="added" className="num-add" />
          <Stat value={`−${s.deletions}`} label="removed" className="num-del" />
          {s.commits.length > 1 && <Stat value={s.commits.length} label="commits" />}
          {o && <Stat value={o.components.length} label="components" />}
        </div>
      </motion.section>

      {ov.status === 'error' && <ErrorCard message={ov.message} onRetry={() => send({ type: 'regenerate' })} />}

      <div className="overview-grid">
        <motion.section className="card" variants={rise}>
          <h2 className="card-title">What changed</h2>
          {o && (o.summary || o.keyChanges.length > 0) ? (
            <>
              {o.summary && <Markdown text={o.summary} />}
              {o.keyChanges.length > 0 && (
                <ul className="key-changes">
                  {o.keyChanges.map((k, i) => (
                    <motion.li key={i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0, transition: { delay: 0.15 + i * 0.05 } }}>
                      {inline(k)}
                    </motion.li>
                  ))}
                </ul>
              )}
            </>
          ) : ov.status === 'loading' || ov.status === 'idle' ? (
            <Shimmer lines={5} widths={[100, 92, 97, 85, 55]} />
          ) : null}
        </motion.section>

        <div className="overview-side">
          <StaticAnalysisCard state={state} dispatch={dispatch} variants={rise} />
          <motion.section className="card" variants={rise}>
            <h2 className="card-title">Review focus</h2>
            {o && (ov.status === 'ready' || o.reviewFocus.length > 0) ? (
              o.reviewFocus.length ? (
                <div className="focus-list">
                  {o.reviewFocus.map((r, i) => (
                    <button
                      key={i}
                      className={`focus-item sev-border-${r.severity}`}
                      disabled={!r.path}
                      onClick={() => r.path && dispatch({ type: 'zoom', level: 3, file: r.path })}
                    >
                      <SeverityIcon severity={r.severity} />
                      <div>
                        <div className="focus-title">{inline(r.title)}</div>
                        {r.detail && <div className="focus-detail">{inline(r.detail)}</div>}
                        {r.path && <div className="focus-path">{splitPath(r.path).name}</div>}
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="muted">Nothing stands out — looks straightforward.</p>
              )
            ) : ov.status !== 'error' ? (
              <Shimmer lines={3} />
            ) : null}
          </motion.section>

          <motion.section className="card" variants={rise}>
            <h2 className="card-title">Touched areas</h2>
            {o && (ov.status === 'ready' || o.components.some((c) => c.id !== 'changes')) ? (
              <div className="area-chips">
                {o.components.map((c) => (
                  <button key={c.id} className={`area-chip cs-${c.status}`} onClick={() => dispatch({ type: 'zoom', level: 1, component: c.id })} title={c.description}>
                    <span className="dot" />
                    {c.name}
                    <span className="count">{c.files.length}</span>
                  </button>
                ))}
              </div>
            ) : ov.status !== 'error' ? (
              <Shimmer lines={2} widths={[80, 50]} />
            ) : null}
          </motion.section>

          {s.commits.length > 1 && (
            <motion.section className="card" variants={rise}>
              <h2 className="card-title">Commits</h2>
              <ol className="commit-list">
                {s.commits.slice(0, 12).map((c) => (
                  <li key={c.sha}>
                    <Icon.commit size={13} />
                    <code>{c.shortSha}</code>
                    <span className="commit-subject">{c.subject}</span>
                  </li>
                ))}
                {s.commits.length > 12 && <li className="muted">+ {s.commits.length - 12} more</li>}
              </ol>
            </motion.section>
          )}
        </div>
      </div>

      <motion.button className="zoom-hint" variants={rise} onClick={() => dispatch({ type: 'zoom', level: 1 })}>
        <Icon.zoomIn size={14} /> Zoom in to see the architecture <kbd>+</kbd>
      </motion.button>
    </motion.div>
  );
}

function Stat({ value, label, className }: { value: number | string; label: string; className?: string }) {
  return (
    <div className="stat">
      <span className={`stat-value ${className ?? ''}`}>{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
