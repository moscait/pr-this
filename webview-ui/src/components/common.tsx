import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import type { DiffFile, FileStatus } from '../../../src/shared/types';
import { Icon } from './Icons';
import { send } from '../vscode';

export function StatusBadge({ status }: { status: FileStatus | string }) {
  const letter = { added: 'A', modified: 'M', deleted: 'D', removed: 'D', renamed: 'R', copied: 'C', context: '·' }[status] ?? 'M';
  return (
    <span className={`status-badge st-${status}`} title={status}>
      {letter}
    </span>
  );
}

/** GitHub-style 5-block +/- bar. */
export function DiffBar({ add, del, blocks = 5 }: { add: number; del: number; blocks?: number }) {
  const total = add + del;
  const g = total ? Math.round((add / total) * blocks) : 0;
  const r = total ? Math.min(blocks - g, Math.round((del / total) * blocks)) : 0;
  return (
    <span className="diffbar" aria-label={`${add} additions, ${del} deletions`}>
      <span className="num-add">+{add}</span>
      <span className="num-del">−{del}</span>
      <span className="blocks">
        {Array.from({ length: blocks }, (_, i) => (
          <i key={i} className={i < g ? 'b-add' : i < g + r ? 'b-del' : 'b-neutral'} />
        ))}
      </span>
    </span>
  );
}

export function splitPath(p: string): { dir: string; name: string } {
  const i = p.lastIndexOf('/');
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}

export function FileName({ file }: { file: Pick<DiffFile, 'path' | 'oldPath'> }) {
  const { dir, name } = splitPath(file.path);
  return (
    <span className="filename" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
      <span className="fn-name">{name}</span>
      <span className="fn-dir">{dir}</span>
    </span>
  );
}

export function Shimmer({ lines = 3, widths }: { lines?: number; widths?: number[] }) {
  return (
    <div className="shimmer-group">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="shimmer" style={{ width: `${widths?.[i] ?? (i === lines - 1 ? 60 : 100)}%` }} />
      ))}
    </div>
  );
}

/** Seconds without output before explaining that the model is still reading the prompt. */
const SLOW_HINT_AFTER_S = 15;

export function Thinking({ label, chars, startedAt }: { label: string; chars?: number; startedAt?: number }) {
  const elapsed = useElapsed(startedAt);
  return (
    <div className="thinking-wrap">
      <div className="thinking">
        <span className="orb">
          <motion.span animate={{ scale: [1, 1.5, 1], opacity: [0.7, 0.15, 0.7] }} transition={{ repeat: Infinity, duration: 1.6 }} />
          <Icon.sparkle size={12} />
        </span>
        <span>{label}</span>
        {elapsed !== undefined && elapsed >= 1 ? <span className="thinking-count">{formatElapsed(elapsed)}</span> : null}
        {chars ? <span className="thinking-count">{formatCount(chars)} chars</span> : null}
      </div>
      {!chars && elapsed !== undefined && elapsed >= SLOW_HINT_AFTER_S ? (
        <div className="thinking-hint">Still reading the diff — local models can take a few minutes on large changes before the first words appear.</div>
      ) : null}
    </div>
  );
}

/** Whole seconds since `startedAt`, re-rendering once a second; undefined when there is no start time. */
function useElapsed(startedAt?: number): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  return startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : undefined;
}

export function formatElapsed(s: number): string {
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

export function ErrorCard({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <motion.div className="error-card" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
      <Icon.warn size={18} />
      <div className="error-body">
        <div className="error-msg">{message}</div>
        <div className="error-actions">
          {onRetry && (
            <button className="btn" onClick={onRetry}>
              <Icon.refresh size={13} /> Retry
            </button>
          )}
          <button className="btn ghost" onClick={() => send({ type: 'configureProvider' })}>
            <Icon.gear size={13} /> Configure AI provider
          </button>
        </div>
      </div>
    </motion.div>
  );
}

export function formatCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
