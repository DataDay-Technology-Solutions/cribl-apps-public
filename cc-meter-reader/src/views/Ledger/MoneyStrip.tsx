// src/views/Ledger/MoneyStrip.tsx — the three figures over the table (P2-W17): would have paid, paid and saved per
// day for the listed flows, at metric size, exactly the table's totals() — so a filter moves them too. On a phone it
// replaces the "6 flows · saving $279 / day" line. The saved tile carries the only 24-hour delta the snapshot can
// state honestly: the workspace's savings ratio now against its 5-minute bucket at the same time yesterday (every
// flow, so only when nothing is filtered), in points.

import { footMoney } from '../../../core/format.ts';
import { t, tn } from '../../copy/en.ts';
import { Money } from '../../components/common/Figures.tsx';
import { formatPct } from '../../lib/format.ts';
import type { Totals } from '../../components/LedgerTable/index.ts';

export interface MoneyStripProps {
  totals: Totals;
  /** "6 flows" / "3 of 17 flows" (phones: the toolbar's count is hidden there) */
  countText: string;
  /** the workspace ratio's 24 h change, shown only when every flow is listed */
  dayDelta?: number;
  /** the Receipt's custom range in words (P2-W14): the tiles are that window's sums, not rates */
  windowWords?: string;
}

function deltaText(delta: number): string {
  const points = Math.floor(Math.abs(delta) * 100 + 0.5);
  if (points === 0) return t('ledger.strip.deltaLevel');
  const n = tn('units.points', points, { n: points });
  return delta > 0 ? t('ledger.strip.deltaUp', { points: n }) : t('ledger.strip.deltaDown', { points: n });
}

export function MoneyStrip({ totals, countText, dayDelta, windowWords }: MoneyStripProps) {
  const inWindow = windowWords !== undefined && totals.window !== undefined;
  const m = inWindow && totals.window ? totals.window : { whpM: totals.whpPerDayM, paidM: totals.paidPerDayM, savedM: totals.savedPerDayM };
  // The three figures add up to the dollar (core/format.ts footMoney), exactly as the Total row, the Flow card and the
  // Receipt print them; the shares stay on the exact figures.
  const shown = footMoney(m);
  const share = (v: number) => (m.whpM > 0 ? t('ledger.strip.shareCaption', { pct: formatPct(v / m.whpM) }) : '');
  const tiles = [
    { key: 'whp', label: t('ledger.strip.whp'), value: shown.whpM, exact: m.whpM, tone: 'whp' as const, caption: t('ledger.strip.whpCaption') },
    { key: 'paid', label: t('ledger.strip.paid'), value: shown.paidM, exact: m.paidM, tone: 'paid' as const, caption: share(m.paidM) },
    {
      key: 'saved',
      label: t('ledger.strip.saved'),
      value: shown.savedM,
      exact: m.savedM,
      tone: 'saved' as const,
      caption: [share(m.savedM), !inWindow && dayDelta !== undefined ? deltaText(dayDelta) : ''].filter(Boolean).join(' · '),
    },
  ];
  return (
    <section className="mr-ledger-strip mr-panel" aria-label={t('ledger.strip.label')} data-testid="ledger-strip" data-window={inWindow ? 'true' : undefined}>
      <p className="mr-ledger-strip-basis">
        <span className="mr-ledger-strip-count mr-num">{countText} · </span>
        {inWindow ? t('ledger.window.stripBasis', { words: windowWords ?? '' }) : t('ledger.strip.basis')}
      </p>
      <dl className="mr-ledger-strip-tiles">
        {tiles.map((tile) => (
          <div key={tile.key} className={`mr-ledger-tile mr-ledger-tile--${tile.key}`} data-tile={tile.key}>
            <dt className="mr-ledger-tile-label">{tile.label}</dt>
            <dd className="mr-ledger-tile-figure" data-value={tile.exact}>
              <Money value={tile.value} tone={tile.tone} per={inWindow ? undefined : 'day'} />
            </dd>
            {tile.caption ? (
              <dd className="mr-ledger-tile-caption" data-delta={tile.key === 'saved' && !inWindow && dayDelta !== undefined ? 'true' : undefined}>
                {tile.caption}
              </dd>
            ) : null}
          </div>
        ))}
      </dl>
    </section>
  );
}
