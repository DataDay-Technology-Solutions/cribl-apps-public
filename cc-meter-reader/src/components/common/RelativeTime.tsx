// src/components/common/RelativeTime.tsx — "12 s ago" that stays true: re-renders from the shared
// one-second ticker (src/lib/ticker.ts), with the absolute time in the tooltip.

import { formatDateTime, formatRelative, toMs } from '../../lib/format.ts';
import { useNow } from '../../lib/ticker.ts';
import { t } from '../../copy/en.ts';

export interface RelativeTimeProps {
  /** ISO string or epoch ms. Absent → em dash. */
  at: string | number | undefined | null;
  /** Wraps the relative phrase, e.g. `(ago) => t('status.updatedAgo', { ago })`. */
  render?: (ago: string) => string;
  /** IANA zone for the tooltip. */
  timeZone?: string;
  className?: string;
}

export function RelativeTime({ at, render, timeZone, className }: RelativeTimeProps) {
  const now = useNow();
  const ms = toMs(at);
  if (!Number.isFinite(ms)) return <span className={className}>{t('common.dash')}</span>;
  // Clock skew between the Leader and this browser must never show "in the future".
  const ago = formatRelative(Math.min(ms, now), now);
  return (
    <time className={className} dateTime={new Date(ms).toISOString()} title={formatDateTime(ms, timeZone)}>
      {render ? render(ago) : ago}
    </time>
  );
}
