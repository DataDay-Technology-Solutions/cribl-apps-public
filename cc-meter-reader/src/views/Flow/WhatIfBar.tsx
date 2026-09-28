// src/views/Flow/WhatIfBar.tsx — the What-if on the Flow view (P1-I06 slice 2): one compact bar (≤ 120 px at 1440)
// above the SAME map, not the 440 px calculator, so turning it on ghosts the after-state where the member was looking.
// Stream and treatment pickers, the stream's saved per day before → after, the basis it stands on, and the way to the
// full calculator (/whatif, with this stream and treatment). The math lives in the receipt card (the stream's own
// figures, projected, and the basis line); the drop slider, the dry run and Apply for real stay on /whatif.

import { Link } from 'react-router-dom';
import { SelectField, type Key } from '@capra/core';
import { humanize } from '../../../core/humanize.ts';
import { TREATMENT_KEYS, type TreatmentKey, type WhatIfModel } from '../../components/WhatIf/useWhatIf.ts';
import { t, type CopyKey } from '../../copy/en.ts';
import { formatMoney } from '../../lib/format.ts';

export function WhatIfBar({ model, humanizeOverrides, calculatorHref }: { model: WhatIfModel; humanizeOverrides?: Record<string, string>; calculatorHref: string }) {
  const { streams, stream, estimate: e } = model;
  if (!stream) return null;
  const dup = new Set<string>();
  const seen = new Set<string>();
  for (const s of streams) {
    if (seen.has(s.flow.inputId)) dup.add(s.flow.inputId);
    seen.add(s.flow.inputId);
  }
  const streamItems = streams.map((s) => {
    const source = humanize(s.flow.inputId, humanizeOverrides) || s.flow.inputId;
    return { id: s.key, label: dup.has(s.flow.inputId) ? t('whatif.streamOption', { source, destination: humanize(s.flow.outputId, humanizeOverrides) }) : source };
  });
  const treatmentItems = TREATMENT_KEYS.map((k) => ({ id: k, label: t(`whatif.treatments.${k}` as CopyKey) }));
  const ok = e && e.ok ? e : null;
  const before = ok ? ok.current.savedPerDayM : 0;
  const after = ok ? ok.mid.savedPerDayM : 0;
  const delta = after - before;

  return (
    <section className="mr-whatifbar" aria-label={t('flow.whatIfBar.aria')} data-testid="whatif-bar">
      <div className="mr-whatifbar-field" data-testid="whatif-stream">
        <SelectField label={t('whatif.stream')} layout="horizontal" size="sm" items={streamItems} value={stream.key} onChange={(k: Key | null) => k !== null && model.setStream(String(k))} />
      </div>
      <div className="mr-whatifbar-field" data-testid="whatif-treatment">
        <SelectField
          label={t('whatif.treatment')}
          layout="horizontal"
          size="sm"
          items={treatmentItems}
          value={model.treatmentKey}
          onChange={(k: Key | null) => k !== null && model.setTreatment(String(k) as TreatmentKey)}
        />
      </div>
      {ok ? (
        <p className="mr-whatifbar-figures" data-testid="whatif-bar-figures">
          <span className="mr-whatifbar-label">{t('whatif.compare.savedDay')}</span>
          <span className="mr-num">{formatMoney(before)}</span>
          <span className="mr-whatifbar-arrow" aria-hidden="true">
            →
          </span>
          <span className="mr-num mr-whatifbar-after">{formatMoney(after)}</span>
          <span className={`mr-whatifbar-delta mr-num${delta > 0 ? ' is-up' : delta < 0 ? ' is-down' : ''}`}>{formatMoney(delta, { signed: true })}</span>
          <span className="mr-whatifbar-basis" data-testid="whatif-basis" data-basis={ok.basis}>
            {t(`whatif.basisLabel.${ok.basis}` as CopyKey)}
          </span>
        </p>
      ) : (
        <p className="mr-whatifbar-figures is-none" data-testid="whatif-bar-figures">
          {e && !e.ok && e.reason === 'no-traffic' ? t('flow.whatIfBar.noTraffic') : t('flow.whatIfBar.noEstimate')}
        </p>
      )}
      <Link className="mr-whatifbar-open" to={calculatorHref} data-testid="whatif-bar-open">
        {t('flow.whatIfBar.open')}
      </Link>
    </section>
  );
}
