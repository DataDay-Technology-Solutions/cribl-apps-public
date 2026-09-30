// r1 ui-9 (FINDINGS_R1 m4, #7/#15; seeded from AA/r1/skeptic-f15/zz-f15-repro.test.ts): DevNull's status agrees with
// itself. Once any price is saved a free output type (devnull, default, cribl_*) counts as $0 (D33, core/pricing.ts
// effectivePrices), and its row already reads "priced · Internal / free"; the other rows' "Without Cribl …" menus and
// the change summary read stored prices, so they said "DevNull (no price yet)" and "unpriced → $0.00". Both now derive
// from effectivePrices, like the row's badge.

import { describe, expect, it } from 'vitest';
import type { PricesDoc } from '../../core/types.ts';
import { buildRows, counterfactualOptions, type Destination } from '../../src/components/PriceTable/model.ts';
import { pendingChanges } from '../../src/components/PriceTable/receiptModel.ts';
import { initialDraft, editPrice } from '../../src/components/PriceTable/model.ts';

const T = Date.parse('2026-09-28T01:00:00Z');
const DESTS: Destination[] = [
  { groupId: 'default', outputId: 'devnull', type: 'devnull' },
  { groupId: 'default', outputId: 'mrd_analytics', type: 'webhook' },
  { groupId: 'default', outputId: 'mrd_siem_prod', type: 'splunk_hec' },
] as Destination[];
const PRICED: PricesDoc = {
  schemaVersion: 1,
  updatedAt: '2026-09-28T00:59:00Z',
  versions: [{ effectiveFrom: '2026-09-28T00:59:00Z', byOutputId: { 'default:mrd_siem_prod': { milliCentsPerGb: 225_000, preset: 'splunk_cloud' } } }],
} as PricesDoc;

describe('m4: a free destination reads free everywhere once any price is saved (D33)', () => {
  const rows = buildRows(DESTS, PRICED, T);
  const byId = (id: string) => rows.find((r) => r.outputId === id)!;

  it('the rows: DevNull free (priced at $0), Analytics unpriced', () => {
    expect(byId('devnull').unpriced).toBe(false);
    expect(byId('mrd_analytics').unpriced).toBe(true);
    expect(byId('mrd_siem_prod').unpriced).toBe(false);
  });

  it('"Without Cribl …" never says DevNull has no price; a truly unpriced destination still does', () => {
    const labels = counterfactualOptions(byId('mrd_siem_prod'), rows).map((o) => o.label);
    expect(labels).toContain('DevNull (free, $0)');
    expect(labels).not.toContain('DevNull (no price yet)');
    expect(labels).toContain('Analytics (no price yet)');
  });

  it('the change summary: typing 0 on DevNull reads "free → $0.00", never "unpriced → $0.00"', () => {
    const devnull = byId('devnull');
    const drafts = { [devnull.key]: editPrice(initialDraft(devnull), '0') };
    const changes = pendingChanges(rows, drafts, new Set([devnull.key]), () => '');
    expect(changes).toHaveLength(1);
    expect(changes[0].before).toBe('free');
    expect(changes[0].after).toBe('$0.00');
  });

  it('before any price is saved nothing is free yet (D33 needs a prices document): DevNull reads no price yet', () => {
    const empty = buildRows(DESTS, null, T);
    const labels = counterfactualOptions(empty.find((r) => r.outputId === 'mrd_siem_prod')!, empty).map((o) => o.label);
    expect(empty.find((r) => r.outputId === 'devnull')!.unpriced).toBe(true);
    expect(labels).toContain('DevNull (no price yet)');
  });
});
