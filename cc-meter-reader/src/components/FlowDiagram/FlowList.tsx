// src/components/FlowDiagram/FlowList.tsx — the Flow map on a phone (BEAUTY F9): a ranked list instead of
// a squeezed Sankey. One row per flow, largest would-have-paid first, the same long-tail folding as the
// map: source name and $/day on the first line, "→ pipeline → destination" under it, then a bar of the
// flow's would-have-paid (linear, against the largest) split into what is paid (its Source's hue, as on the map)
// and what the pipeline removed (the one hatched green). Like the map (P1-I01) the bar is dollars, so a cheap
// flow is already a short bar and nothing fades. A row is a toggle that pins the flow on the receipt card below.
// A flow with an open alert (P2-W16) keeps its own row, outlined dashed in the alert's tone, with the same words the
// map's plate carries ('−$25 / day since 5:01 PM · 2db02e5'; craft review, round 2: the phone lost the marker).

import { t } from '../../copy/en.ts';
import { formatMoney } from '../../lib/format.ts';
import type { FlowListRow } from './listRows.ts';
import { hueClass } from './sourceColors.ts';

export interface FlowListProps {
  rows: readonly FlowListRow[];
  groupId: string;
  selectedId: string | null;
  onSelect(id: string | null): void;
}

export function FlowList({ rows, groupId, selectedId, onSelect }: FlowListProps) {
  const perDay = t('units.perDay');
  return (
    <ol className="mr-flowlist" aria-label={t('flow.list.aria', { group: groupId })} data-testid="flow-list">
      {rows.map((r) => {
        const selected = r.id === selectedId;
        const cls = ['mr-flowlist-row'];
        if (!r.flow.folded) cls.push(hueClass(r.hue));
        if (r.flow.projected) cls.push('is-projected');
        if (r.flow.folded) cls.push('is-other');
        if (r.mark) cls.push('is-incident', `is-incident--${r.mark.tone}`);
        if (selected) cls.push('is-selected');
        return (
          <li key={r.id} className="mr-flowlist-item">
            <button
              type="button"
              className={cls.join(' ')}
              aria-pressed={selected}
              data-list-ribbon={r.id}
              data-hue={r.hue === undefined ? undefined : r.hue + 1}
              data-incident={r.mark?.tone}
              onClick={() => onSelect(selected ? null : r.id)}
            >
              <span className="mr-flowlist-head">
                <span className="mr-flowlist-name">{r.names[0]}</span>
                <span className="mr-flowlist-whp mr-num">
                  {formatMoney(r.flow.whpPerDayM)}
                  <span className="mr-flowlist-unit"> {perDay}</span>
                </span>
              </span>
              <span className="mr-flowlist-path">
                <span aria-hidden="true">→ </span>
                {r.names[1]}
                <span aria-hidden="true"> → </span>
                {r.names[2]}
              </span>
              {r.mark ? (
                <span className="mr-flowlist-incident mr-num" data-testid="flow-list-incident">
                  {r.mark.text}
                </span>
              ) : null}
              <span className="mr-flowlist-foot">
                <span className="mr-flowlist-track" aria-hidden="true">
                  <span className="mr-flowlist-bar" style={{ width: `${Math.max(2, Math.round(r.width * 1000) / 10)}%`, ['--mr-band-w' as string]: String(r.weight) }}>
                    <span className="mr-flowlist-bar-paid" style={{ flexGrow: 1 - r.savedShare }} />
                    <span className="mr-flowlist-bar-saved" style={{ flexGrow: r.savedShare }} />
                  </span>
                </span>
                <span className={`mr-flowlist-saved mr-num${r.flow.savedPerDayM > 0 ? '' : ' is-none'}`}>
                  {r.flow.savedPerDayM > 0 ? t('flow.list.saved', { amount: formatMoney(r.flow.savedPerDayM) }) : t('flow.list.nothingSaved')}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
