// src/views/Flow/whatIfBasis.ts — the What-if bar's words for the projected stream (the receipt card's math line). Its own
// module so WhatIfBar.tsx exports only its component (React Fast Refresh; oxlint react/only-export-components).

import type { EstimateOk } from '../../../core/whatif.ts';
import type { WhatIfModel } from '../../components/WhatIf/useWhatIf.ts';
import { t, type CopyKey } from '../../copy/en.ts';
import { formatPct } from '../../lib/format.ts';

/** "33%" or "30–35%": the byte reduction the projection applies. */
function ratioText(e: EstimateOk): string {
  return typeof e.ratio === 'number' ? formatPct(e.ratio) : t('whatif.range', { low: formatPct(e.ratio.min), high: formatPct(e.ratio.max) });
}

/** The receipt card's math line for the projected stream: the basis and the reduction it applies. */
export function whatIfBasisLine(model: WhatIfModel): string | undefined {
  const e = model.estimate;
  if (!e || !e.ok) return undefined;
  return t('flow.whatIfBar.basisLine', { basis: t(`whatif.basisLabel.${e.basis}` as CopyKey), pct: ratioText(e) });
}
