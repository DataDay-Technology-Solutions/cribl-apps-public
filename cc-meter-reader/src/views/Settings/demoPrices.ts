// src/views/Settings/demoPrices.ts — "Load demo prices" (demo build only; PRD 8.4, 9).
//
// Imported dynamically from a branch guarded by `import.meta.env.VITE_MR_BUILD === 'demo'`, so the release
// bundle never contains it. It FILLS the draft; "Save changes" stays the one write path.
// The rig's destinations are DevNull outputs named like real ones (demo/rig/destinations.json).

import type { PresetId } from '../../../core/types.ts';
import { RIG_OUTPUTS } from '../../../core/demo/rig-ids.ts';
import { presetDollars, type PriceDraft, type PriceRow } from '../../components/PriceTable/model.ts';

/** Each rig destination at its preset's typical price (core/presets.ts): Splunk Cloud $2.25, Datadog $1.80, S3 $0.023. */
const atPreset = (outputId: string, preset: PresetId) => ({ outputId, preset, price: presetDollars(preset) });

export const DEMO_PRICES: readonly { outputId: string; preset: PresetId; price: string }[] = [
  atPreset(RIG_OUTPUTS.siem, 'splunk_cloud'),
  atPreset(RIG_OUTPUTS.siemApps, 'splunk_cloud'),
  atPreset(RIG_OUTPUTS.analytics, 'datadog'),
  atPreset(RIG_OUTPUTS.archive, 's3'),
];

/** Drafts with the rig prices filled in for the rig's destinations (every other row untouched). */
export function demoPriceDrafts(rows: readonly PriceRow[], drafts: Record<string, PriceDraft>): Record<string, PriceDraft> {
  const next = { ...drafts };
  for (const demo of DEMO_PRICES) {
    for (const row of rows) {
      if (row.outputId !== demo.outputId) continue;
      const current = next[row.key];
      next[row.key] = {
        preset: demo.preset,
        price: demo.price,
        counterfactual: current?.counterfactual ?? 'same',
        committed: current?.committed ?? '',
      };
    }
  }
  return next;
}
