// src/components/Shell/SweepSparkline.tsx — the last 60 minutes of sweeps as one row of thin bars (P2-W21):
// height = Leader calls (or duration), a failed sweep a full-height danger tick, the time before this tab
// started watching left blank with a faint hatch (it was not seen, so nothing is drawn there). SVG only.

import { useId } from 'react';
import { HISTORY_WINDOW_MS, type SweepEntry } from './sweepHistory.ts';

export interface SweepSparklineProps {
  entries: readonly SweepEntry[];
  now: number;
  /** when this tab started watching; the window before it is hatched */
  since: number;
  width: number;
  height: number;
  metric?: 'calls' | 'duration';
  /** accessible name; omitted → decorative (aria-hidden) */
  label?: string;
  className?: string;
}

export function SweepSparkline({ entries, now, since, width, height, metric = 'calls', label, className }: SweepSparklineProps) {
  const hatchId = useId();
  const start = now - HISTORY_WINDOW_MS;
  const x = (at: number) => Math.max(0, Math.min(width, ((at - start) / HISTORY_WINDOW_MS) * width));
  const value = (e: SweepEntry) => (metric === 'calls' ? e.calls : e.durationMs) ?? 0;
  const max = Math.max(1, ...entries.filter((e) => e.kind === 'ok').map(value));
  const bar = Math.max(1.5, Math.min(3, width / 120));
  const unseen = since > start ? x(since) : 0;
  return (
    <svg
      className={className ? `mr-spark ${className}` : 'mr-spark'}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-entries={entries.length}
    >
      <defs>
        <pattern id={hatchId} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="4" className="mr-spark-hatch" />
        </pattern>
      </defs>
      {unseen > 0 ? <rect x={0} y={0} width={unseen} height={height} fill={`url(#${hatchId})`} className="mr-spark-unseen" /> : null}
      <line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} className="mr-spark-base" />
      {entries.map((e) =>
        e.kind === 'failed' ? (
          <rect key={`f${e.at}`} x={x(e.at) - bar / 2} y={0} width={bar} height={height} className="mr-spark-fail" rx={bar / 2} />
        ) : (
          <rect
            key={`o${e.at}`}
            x={x(e.at) - bar / 2}
            y={height - Math.max(2, (value(e) / max) * (height - 1))}
            width={bar}
            height={Math.max(2, (value(e) / max) * (height - 1))}
            className={`mr-spark-bar${e.by === 'this-tab' ? ' mr-spark-bar--tab' : ''}`}
            rx={bar / 2}
          />
        ),
      )}
    </svg>
  );
}
