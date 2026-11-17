import type { ReactNode } from 'react';

const P = ({ d, size = 16, className }: { d: ReactNode; size?: number; className?: string }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    {d}
  </svg>
);

export const Icon = {
  sparkle: (p: { size?: number }) => <P {...p} d={<path d="M8 1.5l1.6 4.2L14 7.5 9.6 9.3 8 13.5 6.4 9.3 2 7.5l4.4-1.8z" />} />,
  zoomIn: (p: { size?: number }) => <P {...p} d={<><circle cx="7" cy="7" r="4.5" /><path d="M14 14l-3.8-3.8M5 7h4M7 5v4" /></>} />,
  zoomOut: (p: { size?: number }) => <P {...p} d={<><circle cx="7" cy="7" r="4.5" /><path d="M14 14l-3.8-3.8M5 7h4" /></>} />,
  copy: (p: { size?: number }) => <P {...p} d={<><rect x="5" y="5" width="9" height="9" rx="1.5" /><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" /></>} />,
  refresh: (p: { size?: number }) => <P {...p} d={<path d="M13.5 8A5.5 5.5 0 1 1 11.6 3.8M13.5 2v3.5H10" />} />,
  diff: (p: { size?: number }) => <P {...p} d={<><path d="M4 2v8M1.5 5.5h5M10 14V6M8 10.5h4" /><path d="M3 14h3" /></>} />,
  file: (p: { size?: number }) => <P {...p} d={<><path d="M9 1.5H4A1.5 1.5 0 0 0 2.5 3v10A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5V6z" /><path d="M9 1.5V6h4.5" /></>} />,
  open: (p: { size?: number }) => <P {...p} d={<path d="M9 2.5h4.5V7M13.5 2.5L7 9M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />} />,
  play: (p: { size?: number }) => <P {...p} d={<path d="M4.5 2.5v11l9-5.5z" fill="currentColor" />} />,
  stop: (p: { size?: number }) => <P {...p} d={<rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />} />,
  close: (p: { size?: number }) => <P {...p} d={<path d="M4 4l8 8M12 4l-8 8" />} />,
  send: (p: { size?: number }) => <P {...p} d={<path d="M2 8l12-6-4.5 12-2-5z" />} />,
  warn: (p: { size?: number }) => <P {...p} d={<><path d="M8 1.8l6.5 12H1.5z" /><path d="M8 6.5v3M8 11.6v.1" /></>} />,
  info: (p: { size?: number }) => <P {...p} d={<><circle cx="8" cy="8" r="6.5" /><path d="M8 7.2V11M8 5v.1" /></>} />,
  risk: (p: { size?: number }) => <P {...p} d={<><path d="M8 1.5l5.5 2v4.2c0 3.2-2.3 5.7-5.5 6.8-3.2-1.1-5.5-3.6-5.5-6.8V3.5z" /><path d="M8 5.5v3.2M8 10.8v.1" /></>} />,
  chevron: (p: { size?: number }) => <P {...p} d={<path d="M6 3.5L10.5 8 6 12.5" />} />,
  gear: (p: { size?: number }) => <P {...p} d={<><circle cx="8" cy="8" r="2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></>} />,
  local: (p: { size?: number }) => <P {...p} d={<><rect x="2" y="3" width="12" height="8" rx="1.5" /><path d="M5.5 14h5M8 11v3" /></>} />,
  cloud: (p: { size?: number }) => <P {...p} d={<path d="M4.5 12.5a3 3 0 0 1-.4-6 4 4 0 0 1 7.7-.9A3.2 3.2 0 0 1 11.5 12.5z" />} />,
  commit: (p: { size?: number }) => <P {...p} d={<><circle cx="8" cy="8" r="2.5" /><path d="M1 8h4.5M10.5 8H15" /></>} />,
  search: (p: { size?: number }) => <P {...p} d={<><circle cx="7" cy="7" r="4.5" /><path d="M14 14l-3.8-3.8" /></>} />,
  layers: (p: { size?: number }) => <P {...p} d={<><path d="M8 2l6 3-6 3-6-3z" /><path d="M2 8l6 3 6-3M2 11l6 3 6-3" /></>} />,
};

export function SeverityIcon({ severity, size = 14 }: { severity: 'info' | 'warn' | 'risk'; size?: number }) {
  const I = severity === 'risk' ? Icon.risk : severity === 'warn' ? Icon.warn : Icon.info;
  return (
    <span className={`sev sev-${severity}`}>
      <I size={size} />
    </span>
  );
}
