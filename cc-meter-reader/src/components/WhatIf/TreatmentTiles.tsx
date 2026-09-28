// src/components/WhatIf/TreatmentTiles.tsx — the treatment as Capra RadioTiles (P2-W23): each pack says what it
// saves (its documented range, or that none is published), what it does in one line, and how much of this
// workspace already runs it ("Runs on 1 stream here · 33%"). A pack that is not written for the stream's source is
// a disabled tile that says why (P1-F13); the custom drop fits every stream.

import type { ChangeEvent } from 'react';
import { RadioGroup, RadioTile } from '@capra/core';
import { DOCUMENTED, TREATMENT_FITS, isPackTreatment } from '../../../core/whatif.ts';
import { t, tn, type CopyKey } from '../../copy/en.ts';
import { formatPct } from '../../lib/format.ts';
import { TREATMENT_KEYS, type TreatmentKey, type WhatIfModel } from './useWhatIf.ts';

/** "30%–35% documented", "No published number", "Your drop: 20%". */
function rangeText(k: TreatmentKey, dropPct: number): string {
  if (!isPackTreatment(k)) return t('whatif.tiles.range.custom', { pct: formatPct(dropPct / 100) });
  const doc = DOCUMENTED[k];
  if (!doc) return t('whatif.tiles.range.none');
  const lo = formatPct(doc.min);
  const hi = formatPct(doc.max);
  return t('whatif.tiles.range.documented', { range: lo === hi ? lo : t('whatif.range', { low: lo, high: hi }) });
}

/** The tile's last line: why it does not fit, or how much of this workspace runs it. */
function footText(k: TreatmentKey, model: WhatIfModel): string | null {
  if (!isPackTreatment(k)) return null;
  const info = model.tiles[k];
  if (!info.applicable) return t('whatif.tiles.notFit', { fits: t(`whatif.fits.${TREATMENT_FITS[k]}` as CopyKey) });
  if (info.runsOn === 0) return t('whatif.tiles.notYet');
  return info.similarRatio !== undefined ? tn('whatif.tiles.runs', info.runsOn, { pct: formatPct(info.similarRatio) }) : tn('whatif.tiles.runsNoPct', info.runsOn);
}

export function TreatmentTiles({ model }: { model: WhatIfModel }) {
  return (
    <div className="mr-whatif-tiles" data-testid="whatif-treatment">
      <RadioGroup name="mr-whatif-treatment" value={model.treatmentKey} onChange={(e: ChangeEvent<HTMLInputElement>) => model.setTreatment(e.target.value as TreatmentKey)} layout="horizontal">
        <legend className="mr-whatif-field-label mr-whatif-tiles-legend">{t('whatif.treatment')}</legend>
        <div className="mr-whatif-tiles-grid">
          {TREATMENT_KEYS.map((k) => {
            const applicable = model.tiles[k]?.applicable ?? true;
            const foot = footText(k, model);
            return (
              <RadioTile
                key={k}
                value={k}
                disabled={!applicable}
                data-treatment={k}
                data-applicable={applicable ? 'true' : 'false'}
                description={
                  <span className="mr-whatif-tile-body">
                    <span className="mr-whatif-tile-range mr-num" data-testid={`whatif-tile-range-${k}`}>
                      {rangeText(k, model.dropPct)}
                    </span>
                    <span className="mr-whatif-tile-desc">{t(`whatif.tiles.desc.${k}` as CopyKey)}</span>
                    {foot ? (
                      <span className={`mr-whatif-tile-foot${applicable ? '' : ' mr-whatif-tile-foot--why'}`} data-testid={`whatif-tile-foot-${k}`}>
                        {foot}
                      </span>
                    ) : null}
                  </span>
                }
              >
                {t(`whatif.treatments.${k}` as CopyKey)}
              </RadioTile>
            );
          })}
        </div>
      </RadioGroup>
    </div>
  );
}
