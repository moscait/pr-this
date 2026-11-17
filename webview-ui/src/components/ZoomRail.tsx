import { motion } from 'framer-motion';
import { LEVELS, type Level } from '../state';

export function ZoomRail({ level, onChange }: { level: Level; onChange: (l: Level) => void }) {
  return (
    <div className="zoom-rail" role="tablist" aria-label="Zoom level">
      <button className="rail-step" onClick={() => onChange(Math.max(0, level - 1) as Level)} disabled={level === 0} title="Zoom out (−)">
        −
      </button>
      <div className="rail-track">
        {LEVELS.map((l) => (
          <button key={l.id} role="tab" aria-selected={level === l.id} className={`rail-stop ${level === l.id ? 'on' : ''} ${l.id < level ? 'past' : ''}`} onClick={() => onChange(l.id)} title={`${l.hint} (${l.id + 1})`}>
            {level === l.id && <motion.span layoutId="rail-pill" className="rail-pill" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
            <span className="rail-dot" style={{ transform: `scale(${0.55 + l.id * 0.15})` }} />
            <span className="rail-label">{l.label}</span>
          </button>
        ))}
      </div>
      <button className="rail-step" onClick={() => onChange(Math.min(3, level + 1) as Level)} disabled={level === 3} title="Zoom in (+)">
        +
      </button>
    </div>
  );
}
