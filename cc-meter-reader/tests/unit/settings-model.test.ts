// Settings view models: Prices (SPEC 5, 6, 8), Budgets / Cribl cost / Alerts (SPEC 5, 8, 9.2), section routing
// (SPEC 13), and "Where to send alerts" (SPEC 5, 12, 12.5, 12.6, 17).

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { defaultSettings } from '../../core/settings.ts';
import { appendPriceVersion, effectivePrices, emptyPrices } from '../../core/pricing.ts';
import type { InventoryDoc, NotificationEndpoint, PricesDoc, Settings, Snapshot } from '../../core/types.ts';
import {
  applyPreset,
  buildRows,
  collectChanges,
  counterfactualKey,
  counterfactualOptions,
  draftToEntry,
  fillSuggested,
  initialDraft,
  initialDrafts,
  isDirty,
  isListedOutput,
  listDestinations,
  parseCounterfactualKey,
  presetDollars,
  presetInfo,
  presetNoteLine,
  presetOptionGroups,
  presetOptions,
  pricePlaceholder,
  rowCounts,
  rowNoteLine,
  editPrice,
  isCustomDraft,
  CUSTOM_PRESET,
  suggestableCount,
  usdPerGb,
  validateDraft,
} from '../../src/components/PriceTable/model.ts';
import { PRESETS } from '../../core/presets.ts';
import {
  applyEndpoints,
  draftFromEndpoint,
  draftToEndpoint,
  draftsFromSettings,
  endpointDirtyCount,
  endpointsDirty,
  newEndpointDraft,
} from '../../src/components/EndpointEditor/model.ts';
import { WEBHOOK_NOT_STORED_MESSAGE } from '../../core/settings.ts';
import {
  alertsDraftFrom,
  applyAlerts,
  applyBudgets,
  applyCost,
  budgetDraftFrom,
  budgetPace,
  centsToDollarText,
  costDraftFrom,
  costPreview,
  memoryKeyForAlpha,
  parseDollarsToCents,
  parseNumber,
  resolveSection,
  sectionHref,
  SECTION_ORDER,
  type SectionId,
} from '../../src/views/Settings/model.ts';
import { demoPriceDrafts, DEMO_PRICES } from '../../src/views/Settings/demoPrices.ts';
import { weeklyView } from '../../src/views/Settings/weekly.ts';
import { targetTypeLabel } from '../../src/components/EndpointEditor/copy.ts';

const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const DEFAULTS: Settings = defaultSettings(NOW_ISO, 'UTC');

function inventory(outputs: { id: string; type: string; disabled?: boolean }[], group = 'default', extra: Record<string, { id: string; type: string }[]> = {}): InventoryDoc {
  const byGroup: InventoryDoc['byGroup'] = { [group]: { inputs: [], outputs, pipelines: [], routes: [] } };
  for (const [g, outs] of Object.entries(extra)) byGroup[g] = { inputs: [], outputs: outs, pipelines: [], routes: [] };
  return { schemaVersion: 1, updatedAt: NOW_ISO, hash: 'h', byGroup };
}

const RIG = inventory([
  { id: 'mrd_siem_prod', type: 'devnull' },
  { id: 'mrd_analytics', type: 'devnull' },
  { id: 'mrd_archive_s3', type: 'devnull' },
  { id: 'default', type: 'default' },
  { id: 'splunk_hec_out', type: 'splunk_hec' },
  { id: 'old', type: 's3', disabled: true },
]);

// ─── Prices ──────────────────────────────────────────────────────────────────

describe('listDestinations', () => {
  it('lists enabled destinations the snapshot counts, never the `default` forwarder or disabled outputs', () => {
    const dests = listDestinations(RIG, null, false);
    expect(dests.map((d) => d.outputId)).toEqual(['mrd_analytics', 'mrd_archive_s3', 'mrd_siem_prod', 'splunk_hec_out']);
    expect(dests.every((d) => d.groupId === 'default')).toBe(true);
  });

  it('adds snapshot destinations the inventory missed, sorted by group then id', () => {
    const snapshot = { destinations: [{ groupId: 'edge', outputId: 'lake', type: 'cribl_lake' }] } as unknown as Snapshot;
    const dests = listDestinations(RIG, snapshot, false);
    expect(dests.at(-1)).toEqual({ groupId: 'edge', outputId: 'lake', type: 'cribl_lake' });
  });

  it('works from the snapshot alone (sample data) and from nothing', () => {
    const snapshot = { destinations: [{ groupId: 'default', outputId: 'a', type: 's3' }] } as unknown as Snapshot;
    expect(listDestinations(null, snapshot, false)).toHaveLength(1);
    expect(listDestinations(null, null, false)).toEqual([]);
  });

  it('hides internal output types unless opted in', () => {
    expect(isListedOutput({ type: 'default' }, true)).toBe(false);
    expect(isListedOutput({ type: 'devnull', disabled: true }, true)).toBe(false);
    expect(isListedOutput({ type: 'splunk_hec' }, false)).toBe(true);
  });
});

describe('buildRows', () => {
  it('humanizes names, auto-suggests presets and marks everything unpriced before a save', () => {
    const rows = buildRows(listDestinations(RIG, null, false), null, NOW);
    const siem = rows.find((r) => r.outputId === 'mrd_siem_prod')!;
    expect(siem.name).toBe('SIEM (prod)');
    expect(siem.key).toBe('default:mrd_siem_prod');
    // A DevNull called siem-prod stands in for a SIEM (P0-04): never 'Internal / free'.
    expect(siem.suggestedPreset).toBe('splunk_cloud');
    expect(rows.find((r) => r.outputId === 'splunk_hec_out')!.suggestedPreset).toBe('splunk_cloud');
    expect(rows.every((r) => r.unpriced && r.stored === undefined)).toBe(true);
    expect(rowCounts(rows)).toEqual({ total: 4, unpriced: 4 });
  });

  it('uses settings.humanize overrides', () => {
    const rows = buildRows([{ groupId: 'default', outputId: 'splunk_hec_out', type: 'splunk_hec' }], null, NOW, { splunk_hec_out: 'Prod Splunk' });
    expect(rows[0].name).toBe('Prod Splunk');
  });

  it('reads the entry in force now; a $0 fallback on a paid type stays unpriced, a $0 devnull is priced', () => {
    const prices = appendPriceVersion(emptyPrices(NOW_ISO), {
      'default:mrd_siem_prod': { milliCentsPerGb: 0, preset: 'internal' },
      'default:splunk_hec_out': { milliCentsPerGb: 0, preset: 'internal' },
    }, NOW - 1000);
    const rows = buildRows(listDestinations(RIG, null, false), prices, NOW);
    expect(rows.find((r) => r.outputId === 'mrd_siem_prod')!.unpriced).toBe(false);
    expect(rows.find((r) => r.outputId === 'splunk_hec_out')!.unpriced).toBe(true);
  });
});

// P0-04: the demo rig's destinations are DevNull outputs whose descriptions name their preset; the emulator
// serves the same objects (testdata/gen.ts, demo/rig/destinations.json).
const RIG_DESCRIBED = inventory([
  { id: 'devnull', type: 'devnull' },
  ...(
    [
      ['mrd_siem_prod', 'SIEM', 'splunk_cloud'],
      ['mrd_analytics', 'observability/analytics', 'datadog'],
      ['mrd_archive_s3', 'S3 archive', 's3'],
    ] as const
  ).map(([id, what, preset]) => ({
    id,
    type: 'devnull',
    description: `[meter-reader-demo] Simulated ${what} destination (DevNull). Priced with the ${preset} preset in Meter Reader.`,
  })),
]);

describe('suggested prices on a DevNull rig (P0-04)', () => {
  const rows = buildRows(listDestinations(RIG_DESCRIBED, null, false), null, NOW);
  const by = (id: string) => rows.find((r) => r.outputId === id)!;

  it('carries the description and suggests the preset it names; the plain devnull stays Internal / free', () => {
    expect(by('mrd_siem_prod').description).toMatch(/splunk_cloud preset/);
    expect(rows.map((r) => [r.outputId, r.suggestedPreset])).toEqual([
      ['devnull', 'internal'],
      ['mrd_analytics', 'datadog'],
      ['mrd_archive_s3', 's3'],
      ['mrd_siem_prod', 'splunk_cloud'],
    ]);
    // Snapshot-only destinations carry no description and list exactly as before.
    expect(listDestinations(null, { destinations: [{ groupId: 'g', outputId: 'o', type: 's3' }] } as unknown as Snapshot, false)).toEqual([{ groupId: 'g', outputId: 'o', type: 's3' }]);
  });

  it('"Use suggested prices" fills siem-prod, analytics and archive-s3 with non-zero sourced presets and never counts a $0 fill', () => {
    const drafts = initialDrafts(rows);
    expect(suggestableCount(rows, drafts)).toBe(3);
    const { drafts: next, filled } = fillSuggested(rows, drafts);
    expect(filled.sort()).toEqual(['default:mrd_analytics', 'default:mrd_archive_s3', 'default:mrd_siem_prod']);
    expect(next['default:mrd_siem_prod']).toMatchObject({ preset: 'splunk_cloud', price: '2.25' });
    expect(next['default:mrd_analytics']).toMatchObject({ preset: 'datadog', price: '1.80' });
    expect(next['default:mrd_archive_s3']).toMatchObject({ preset: 's3', price: '0.023' });
    expect(next['default:devnull'].price).toBe('');
    for (const key of filled) expect(draftToEntry(next[key])!.milliCentsPerGb, key).toBeGreaterThan(0);
    expect(suggestableCount(rows, next)).toBe(0);
    // A row the member switched to a $0 preset is not filled either.
    const zero = { ...drafts, 'default:mrd_siem_prod': { ...drafts['default:mrd_siem_prod'], preset: 'internal' as const } };
    expect(fillSuggested(rows, zero).filled).not.toContain('default:mrd_siem_prod');
  });

  it('the price placeholder is the suggested value, or a dash when the preset suggests nothing ("0.00" read as a price)', () => {
    expect(pricePlaceholder('splunk_cloud')).toBe('2.25');
    expect(pricePlaceholder('s3')).toBe('0.023');
    expect(pricePlaceholder('internal')).toBe('—');
  });

  it('once any price is saved, an unpriced DevNull that stands in for a paid destination stays unpriced; the plain devnull is free', () => {
    const prices = appendPriceVersion(emptyPrices(NOW_ISO), { 'default:mrd_siem_prod': { milliCentsPerGb: 225_000, preset: 'splunk_cloud' } }, NOW - 1000);
    const priced = buildRows(listDestinations(RIG_DESCRIBED, null, false), prices, NOW);
    expect(priced.filter((r) => r.unpriced).map((r) => r.outputId)).toEqual(['mrd_analytics', 'mrd_archive_s3']);
    expect(rowCounts(priced)).toEqual({ total: 4, unpriced: 2 });
    // The same rule the snapshot (and so the Receipt's unpriced banner) applies, given the output itself.
    const analytics = RIG_DESCRIBED.byGroup.default.outputs.find((o) => o.id === 'mrd_analytics')!;
    expect(effectivePrices(prices, 'default', 'mrd_analytics', NOW, analytics).unpriced).toBe(true);
    expect(effectivePrices(prices, 'default', 'devnull', NOW, { id: 'devnull', type: 'devnull' }).unpriced).toBe(false);
    // Called with the type alone (the sweep, older callers) nothing changes.
    expect(effectivePrices(prices, 'default', 'mrd_analytics', NOW, 'devnull').unpriced).toBe(false);
    // An explicit $0 on a DevNull is still a price: Internal / free saved on purpose.
    const zero = appendPriceVersion(prices, { 'default:mrd_analytics': { milliCentsPerGb: 0, preset: 'internal' } }, NOW - 500);
    expect(effectivePrices(zero, 'default', 'mrd_analytics', NOW, analytics).unpriced).toBe(false);
  });
});

describe('price drafts', () => {
  const rows = buildRows(listDestinations(RIG, null, false), null, NOW);
  const siem = rows.find((r) => r.outputId === 'mrd_siem_prod')!;
  const hec = rows.find((r) => r.outputId === 'splunk_hec_out')!;

  it('a suggestion is not a price: unpriced rows start empty with the suggested preset', () => {
    expect(initialDraft(hec)).toEqual({ preset: 'splunk_cloud', price: '', counterfactual: 'same', committed: '' });
    expect(isDirty(hec, initialDraft(hec))).toBe(false);
    expect(draftToEntry(initialDraft(hec))).toBeNull();
    expect(collectChanges(rows, initialDrafts(rows)).dirty).toEqual([]);
  });

  it('the picker names each preset with its typical price and range (SPEC 6: a starting point, labelled)', () => {
    const opts = presetOptions();
    expect(opts).toHaveLength(PRESETS.length);
    expect(opts[0]).toEqual({
      id: 'splunk_cloud',
      label: 'Splunk Cloud · typical $2.25 / GB · range $1.47–$4.85',
      name: 'Splunk Cloud',
      caption: 'typical $2.25 / GB · range $1.47–$4.85',
      free: false,
    });
    expect(presetNoteLine('splunk_cloud')).toBe('$2.25 typical · $1.47–$4.85');
    expect(presetNoteLine('internal')).toBe('No destination charge');
    expect(opts.find((o) => o.id === 'datadog')?.label).toBe('Datadog Logs · typical $1.80 / GB · range $0.95–$3.85');
    expect(opts.find((o) => o.id === 'azure_blob')?.label).toBe('Azure Blob · typical $0.018 / GB · range $0.0169–$0.0208');
    expect(opts.find((o) => o.id === 'internal')).toMatchObject({ label: 'Internal / free · No destination charge', caption: 'No destination charge', free: true });
    for (const p of PRESETS) expect(presetInfo(p.id).typical, p.id).toBe(p.milliCentsPerGb === 0 ? '$0' : `$${presetDollars(p.id)}`);
    const info = presetInfo('sentinel');
    expect(info).toMatchObject({ label: 'Microsoft Sentinel', typical: '$2.50', low: '$2.05', high: '$5.59', confidence: 'published', free: false });
    expect(info.basis).toMatch(/commitment tier/i);
    expect(info.sources.length).toBeGreaterThan(0);
    expect(presetInfo('internal')).toMatchObject({ free: true, low: '$0.00', high: '$0.00' });
  });

  it('P0-20: the picker is a name over a caption, vendors under "Typical list prices", then Custom price and Internal / free last', () => {
    const groups = presetOptionGroups();
    expect(groups.map((g) => [g.id, g.label])).toEqual([
      ['listed', 'Typical list prices'],
      ['other', 'Other'],
    ]);
    expect(groups[0].options.map((o) => o.id)).toEqual(PRESETS.filter((p) => p.milliCentsPerGb > 0).map((p) => p.id));
    expect(groups[1].options.map((o) => o.id)).toEqual(['custom', 'internal']);
    expect(groups[1].options[0]).toMatchObject({ name: 'Custom price', caption: 'Your contract rate, not a list price', label: 'Custom price · Your contract rate, not a list price' });
    for (const o of groups.flatMap((g) => g.options)) {
      // What assistive tech reads (name, a hidden " · ", caption) is the option's label, and every price says " / GB".
      expect(o.label, o.id).toBe(`${o.name} · ${o.caption}`);
      expect(o.caption, o.id).not.toMatch(/\$[\d.]+\/GB/);
      if (!o.free && o.id !== 'custom') expect(o.caption, o.id).toMatch(/^typical \$[\d.]+ \/ GB · range \$[\d.]+–\$[\d.]+$/);
    }
  });

  it('formats range endpoints with two to four decimals', () => {
    expect([1.1, 3, 0.0169, 0.021, 4.85, 0.05, 0].map(usdPerGb)).toEqual(['$1.10', '$3.00', '$0.0169', '$0.021', '$4.85', '$0.05', '$0.00']);
  });

  it('picking a preset fills its typical value', () => {
    expect(presetDollars('splunk_cloud')).toBe('2.25');
    expect(presetDollars('s3')).toBe('0.023');
    expect(applyPreset(initialDraft(siem), 'datadog')).toMatchObject({ preset: 'datadog', price: '1.80' });
  });

  it('"Use suggested prices" fills only empty, never-priced rows', () => {
    const drafts = initialDrafts(rows);
    drafts[siem.key] = { ...drafts[siem.key], price: '9' };
    expect(suggestableCount(rows, drafts)).toBe(3);
    const { drafts: next, filled } = fillSuggested(rows, drafts);
    expect(filled).not.toContain(siem.key);
    expect(next[siem.key].price).toBe('9');
    expect(next[hec.key].price).toBe('2.25');
    expect(suggestableCount(rows, next)).toBe(0);
  });

  it('SPEC 17 inline errors; invalid input never produces an entry', () => {
    const bad = { ...initialDraft(siem), price: 'abc' };
    expect(validateDraft(siem, bad).price).toBe("Enter a number, 0 or more.");
    expect(validateDraft(siem, { ...bad, price: '-1' }).price).toMatch(/0 or more/);
    expect(validateDraft(siem, { ...bad, price: '0.0234' }).price).toBe("At most 3 decimals.");
    expect(validateDraft(siem, { ...bad, price: '1', committed: 'x' }).committed).toBe("Couldn't save: committed price must be 0 or more.");
    const changes = collectChanges(rows, { ...initialDrafts(rows), [siem.key]: bad });
    expect(changes.dirty).toEqual([siem.key]);
    expect(Object.keys(changes.entries)).toEqual([]);
    expect(changes.errors[siem.key].price).toBeDefined();
  });

  it('accepts $0.023, $2.50, 1,234.5 and writes millicents keyed group:output', () => {
    const drafts = initialDrafts(rows);
    drafts[siem.key] = { preset: 'splunk_cloud', price: '$2.50', counterfactual: 'same', committed: '2.1' };
    drafts[hec.key] = { preset: 'splunk_cloud', price: '0.023', counterfactual: `other:mrd_siem_prod`, committed: '' };
    const { entries, errors, dirty } = collectChanges(rows, drafts);
    expect(errors).toEqual({});
    expect(dirty.sort()).toEqual([hec.key, siem.key].sort());
    expect(entries['default:mrd_siem_prod']).toEqual({ milliCentsPerGb: 250_000, preset: 'splunk_cloud', counterfactual: { kind: 'same' }, committedMilliCentsPerGb: 210_000 });
    expect(entries['default:splunk_hec_out']).toEqual({ milliCentsPerGb: 2_300, preset: 'splunk_cloud', counterfactual: { kind: 'other', outputId: 'mrd_siem_prod' } });
    expect(draftToEntry({ ...drafts[siem.key], price: '1,234.5', committed: '' })?.milliCentsPerGb).toBe(123_450_000);
  });

  it('saves only changed rows; a stored price cannot be emptied', () => {
    const prices = appendPriceVersion(emptyPrices(NOW_ISO), { 'default:mrd_siem_prod': { milliCentsPerGb: 250_000, preset: 'splunk_cloud' } }, NOW - 60_000);
    const priced = buildRows(listDestinations(RIG, null, false), prices, NOW);
    const row = priced.find((r) => r.outputId === 'mrd_siem_prod')!;
    const drafts = initialDrafts(priced);
    expect(drafts[row.key]).toMatchObject({ price: '2.50', preset: 'splunk_cloud', counterfactual: 'same' });
    expect(isDirty(row, drafts[row.key])).toBe(false);
    expect(collectChanges(priced, drafts).dirty).toEqual([]);

    const emptied = collectChanges(priced, { ...drafts, [row.key]: { ...drafts[row.key], price: '' } });
    expect(emptied.errors[row.key].price).toMatch(/0 or more/);
    const changed = collectChanges(priced, { ...drafts, [row.key]: { ...drafts[row.key], counterfactual: 'none' } });
    expect(changed.entries[row.key].counterfactual).toEqual({ kind: 'none' });
  });

  it('a saved version makes the destination priced for the Receipt (effectivePrices)', () => {
    const drafts = initialDrafts(rows);
    drafts[hec.key] = applyPreset(drafts[hec.key], 'splunk_cloud');
    const doc = appendPriceVersion(emptyPrices(NOW_ISO), collectChanges(rows, drafts).entries, NOW);
    const eff = effectivePrices(doc, 'default', 'splunk_hec_out', NOW + 1, 'splunk_hec');
    expect(eff).toMatchObject({ paidMcPerGb: 225_000, whpMcPerGb: 225_000, unpriced: false });
  });

  it('P0-19: every visible field on an unpriced row changes the dirty count or shows an inline error', () => {
    const base = initialDrafts(rows);
    const dirtyAfter = (draft: typeof base[string]) => collectChanges(rows, { ...base, [hec.key]: draft });
    expect(dirtyAfter(base[hec.key]).dirty).toEqual([]);

    // Preset: picking one fills its typical price, a change.
    expect(dirtyAfter(applyPreset(base[hec.key], 'datadog'))).toMatchObject({ dirty: [hec.key], errors: {} });
    // $ / GB: valid is a change that saves; junk is a change with an inline error.
    expect(dirtyAfter({ ...base[hec.key], price: '1.80' })).toMatchObject({ dirty: [hec.key], errors: {} });
    expect(dirtyAfter({ ...base[hec.key], price: 'junk' }).errors[hec.key].price).toBe("Enter a number, 0 or more.");
    // Without Cribl this data would go to: a change, and the price field says what it needs (never a silent no-op).
    for (const counterfactual of ['none', 'other:mrd_siem_prod']) {
      const r = dirtyAfter({ ...base[hec.key], counterfactual });
      expect(r.dirty, counterfactual).toEqual([hec.key]);
      expect(r.errors[hec.key].price, counterfactual).toBe("Couldn't save: enter a price.");
      expect(r.entries).toEqual({});
    }
    // Once priced, the counterfactual saves with it.
    expect(dirtyAfter({ ...base[hec.key], counterfactual: 'none', price: '2' }).entries[hec.key]).toMatchObject({ milliCentsPerGb: 200_000, counterfactual: { kind: 'none' } });
  });

  it('P0-19: a committed rate has no field in 1.0, but a stored one survives a price change and junk is still an error', () => {
    const prices = appendPriceVersion(emptyPrices(NOW_ISO), { 'default:splunk_hec_out': { milliCentsPerGb: 225_000, preset: 'splunk_cloud', committedMilliCentsPerGb: 160_000 } }, NOW - 60_000);
    const priced = buildRows(listDestinations(RIG, null, false), prices, NOW);
    const row = priced.find((r) => r.outputId === 'splunk_hec_out')!;
    const drafts = initialDrafts(priced);
    expect(drafts[row.key].committed).toBe('1.60');
    const next = collectChanges(priced, { ...drafts, [row.key]: { ...drafts[row.key], price: '2.10' } });
    expect(next.entries[row.key]).toMatchObject({ milliCentsPerGb: 210_000, committedMilliCentsPerGb: 160_000 });
    // A committed value on a never-priced row (an import, never typed in 1.0) is a change that needs a price.
    const imported = collectChanges(rows, { ...initialDrafts(rows), [hec.key]: { ...initialDraft(hec), committed: '1.5' } });
    expect(imported.dirty).toEqual([hec.key]);
    expect(imported.errors[hec.key].price).toBe("Couldn't save: enter a price.");
    expect(validateDraft(hec, { ...initialDraft(hec), price: '1', committed: 'x' }).committed).toMatch(/committed price must be 0 or more/);
  });

  it('an "other" counterfactual to a destination no longer listed falls back to "same"', () => {
    const drafts = initialDrafts(rows);
    drafts[hec.key] = { preset: 'splunk_cloud', price: '1', counterfactual: 'other:gone', committed: '' };
    expect(collectChanges(rows, drafts).entries[hec.key].counterfactual).toEqual({ kind: 'same' });
  });

  it('parses every typed dollar amount to the same millicents core/format does (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 0, max: 999 }), (whole, frac) => {
        const text = `${whole}.${String(frac).padStart(3, '0')}`;
        const entry = draftToEntry({ preset: 'internal', price: text, counterfactual: 'same', committed: '' });
        expect(entry?.milliCentsPerGb).toBe(whole * 100_000 + frac * 100);
      }),
    );
  });
});

describe('custom price (P1-G01)', () => {
  const inv = inventory([
    { id: 'devnull', type: 'devnull' },
    { id: 'splunk_hec_out', type: 'splunk_hec' },
    { id: 'relay', type: 'webhook' },
  ]);
  const rows = buildRows(listDestinations(inv, null, false), null, NOW);
  const by = (id: string) => rows.find((r) => r.outputId === id)!;
  const hec = by('splunk_hec_out');
  const free = by('devnull');

  it('a contract rate typed on a vendor preset keeps the vendor and reads "Custom price · typical $2.25"', () => {
    const typed = editPrice(initialDraft(hec), '1.80');
    expect(typed).toMatchObject({ preset: 'splunk_cloud', price: '1.80' });
    expect(isCustomDraft(typed)).toBe(true);
    expect(rowNoteLine(typed)).toBe('Custom price · typical $2.25');
    expect(draftToEntry(typed)).toEqual({ milliCentsPerGb: 180_000, preset: 'splunk_cloud', counterfactual: { kind: 'same' } });
    // The preset's own value, empty or half-typed text is not custom: the note stays the preset's range.
    for (const price of ['2.25', '2.250', '', 'abc']) {
      const d = editPrice(initialDraft(hec), price);
      expect(isCustomDraft(d), price).toBe(false);
      expect(rowNoteLine(d), price).toBe('$2.25 typical · $1.47–$4.85');
    }
  });

  it('a rate above $0 on Internal / free moves the picker to Custom price and saves no preset', () => {
    expect(initialDraft(free).preset).toBe('internal');
    expect(rowNoteLine(initialDraft(free))).toBe('No destination charge');
    const typed = editPrice(initialDraft(free), '1.80');
    expect(typed.preset).toBe(CUSTOM_PRESET);
    expect(rowNoteLine(typed)).toBe('Not a list price');
    expect(draftToEntry(typed)).toEqual({ milliCentsPerGb: 180_000, counterfactual: { kind: 'same' } });
    // $0 is still free.
    expect(editPrice(initialDraft(free), '0').preset).toBe('internal');
    expect(editPrice(initialDraft(free), '0.00').preset).toBe('internal');
  });

  it('Custom price can be picked: it keeps the typed rate, offers no placeholder and is never "suggested"', () => {
    const picked = applyPreset({ ...initialDraft(hec), price: '1.6' }, CUSTOM_PRESET);
    expect(picked).toMatchObject({ preset: 'custom', price: '1.6' });
    expect(applyPreset(initialDraft(hec), CUSTOM_PRESET).price).toBe('');
    expect(pricePlaceholder(CUSTOM_PRESET)).toBe('—');
    const drafts = { ...initialDrafts(rows), [hec.key]: applyPreset(initialDraft(hec), CUSTOM_PRESET) };
    expect(fillSuggested(rows, drafts).filled).not.toContain(hec.key);
    // Picking a vendor again fills its typical value.
    expect(applyPreset(picked, 'datadog')).toMatchObject({ preset: 'datadog', price: '1.80' });
  });

  it('a paid type nothing matched starts on Custom price, never "Internal / free · No destination charge"', () => {
    expect(by('relay').suggestedPreset).toBe('internal');
    expect(initialDraft(by('relay'))).toMatchObject({ preset: 'custom', price: '' });
    expect(rowNoteLine(initialDraft(by('relay')))).toBe('Not a list price');
    // A demo-rig DevNull that names nothing is not a free sink either.
    const tagged = buildRows([{ groupId: 'default', outputId: 'mrd_thing', type: 'devnull', description: '[meter-reader-demo] rig object' }], null, NOW)[0];
    expect(initialDraft(tagged).preset).toBe('custom');
  });

  it('a stored price with no preset reads back as Custom price, unchanged until edited', () => {
    const prices = appendPriceVersion(emptyPrices(NOW_ISO), { 'default:relay': { milliCentsPerGb: 120_000 } }, NOW - 60_000);
    const priced = buildRows(listDestinations(inv, null, false), prices, NOW);
    const relay = priced.find((r) => r.outputId === 'relay')!;
    const d = initialDraft(relay);
    expect(d).toMatchObject({ preset: 'custom', price: '1.20' });
    expect(isDirty(relay, d)).toBe(false);
    expect(isDirty(relay, editPrice(d, '1.25'))).toBe(true);
    expect(relay.unpriced).toBe(false);
  });
});

describe('counterfactual keys and options', () => {
  it('round-trips', () => {
    for (const cf of [{ kind: 'same' }, { kind: 'none' }, { kind: 'other', outputId: 'x' }] as const) {
      expect(parseCounterfactualKey(counterfactualKey(cf))).toEqual(cf);
    }
    expect(counterfactualKey(undefined)).toBe('same');
    expect(parseCounterfactualKey('other:')).toEqual({ kind: 'same' });
  });

  it('offers this destination, every other destination in the SAME group, and nowhere', () => {
    const inv = inventory([{ id: 'a', type: 's3' }, { id: 'b', type: 'splunk_hec' }], 'default', { edge: [{ id: 'c', type: 'datadog' }] });
    const rows = buildRows(listDestinations(inv, null, false), null, NOW);
    const opts = counterfactualOptions(rows.find((r) => r.outputId === 'a')!, rows);
    expect(opts.map((o) => o.id)).toEqual(['same', 'other:b', 'none']);
    expect(opts[0].label).toBe('This destination');
    expect(opts.at(-1)!.label).toBe('Nowhere (archive-only data)');
  });
});

describe('demo prices (demo build helper)', () => {
  it('fills the rig destinations with the demo presets and leaves others alone', () => {
    // The full rig: siem-prod, the payments API's own SIEM destination (D21), analytics and the archive.
    const rig = inventory([
      { id: 'mrd_siem_prod', type: 'devnull' },
      { id: 'mrd_siem_apps', type: 'devnull' },
      { id: 'mrd_analytics', type: 'devnull' },
      { id: 'mrd_archive_s3', type: 'devnull' },
      { id: 'splunk_hec_out', type: 'splunk_hec' },
    ]);
    const rows = buildRows(listDestinations(rig, null, false), null, NOW);
    const drafts = demoPriceDrafts(rows, initialDrafts(rows));
    expect(drafts['default:mrd_siem_prod']).toMatchObject({ preset: 'splunk_cloud', price: '2.25' });
    // D21: the payments API's own SIEM destination is priced like siem-prod.
    expect(drafts['default:mrd_siem_apps']).toMatchObject({ preset: 'splunk_cloud', price: '2.25' });
    expect(drafts['default:mrd_analytics']).toMatchObject({ preset: 'datadog', price: '1.80' });
    expect(drafts['default:mrd_archive_s3']).toMatchObject({ preset: 's3', price: '0.023' });
    expect(drafts['default:splunk_hec_out'].price).toBe('');
    expect(DEMO_PRICES).toHaveLength(4);
    const { entries } = collectChanges(rows, drafts);
    expect(entries['default:mrd_archive_s3'].milliCentsPerGb).toBe(2_300);
  });
});

// ─── Sections and routes ─────────────────────────────────────────────────────

describe('section routing', () => {
  const release: SectionId[] = SECTION_ORDER.filter((s) => s !== 'demo');
  const q = (s: string) => new URLSearchParams(s);

  it('reads the path segment or ?section=, defaulting to Prices', () => {
    expect(resolveSection('/settings', q(''), release)).toBe('prices');
    expect(resolveSection('/settings/prices', q(''), release)).toBe('prices');
    expect(resolveSection('/settings/notifications', q(''), release)).toBe('notifications');
    expect(resolveSection('/settings', q('section=alerts'), release)).toBe('alerts');
    expect(resolveSection('/settings/', q('section=runtime'), release)).toBe('runtime');
    expect(resolveSection('/settings', q('section=bogus'), release)).toBe('prices');
  });

  it('never resolves Demo where it is not available (release build)', () => {
    expect(resolveSection('/settings/demo', q(''), release)).toBe('prices');
    expect(resolveSection('/settings', q('section=demo'), release)).toBe('prices');
    expect(resolveSection('/settings/demo', q(''), SECTION_ORDER)).toBe('demo');
  });

  it('builds hrefs on the routes SPEC 13 defines and keeps the sticky params', () => {
    expect(sectionHref('prices', q('group=default&period=mtd&object=x'))).toBe('/settings/prices?group=default&period=mtd');
    expect(sectionHref('notifications', q(''))).toBe('/settings/notifications');
    expect(sectionHref('budgets', q('group=g'))).toBe('/settings?group=g&section=budgets');
    expect(sectionHref('runtime', q(''))).toBe('/settings?section=runtime');
  });
});

// ─── Budgets, cost, parsing ──────────────────────────────────────────────────

describe('parsing helpers', () => {
  it('dollars to cents', () => {
    expect(parseDollarsToCents('', 'budget')).toEqual({ ok: true, cents: undefined });
    expect(parseDollarsToCents('$12,000', 'budget')).toEqual({ ok: true, cents: 1_200_000 });
    expect(parseDollarsToCents('40.5', 'budget')).toEqual({ ok: true, cents: 4_050 });
    expect(parseDollarsToCents('-5', 'budget')).toEqual({ ok: false, error: "Couldn't save: budget must be 0 or more." });
    expect(parseDollarsToCents('1.2345', 'budget')).toEqual({ ok: false, error: "Couldn't save: budget can have at most 3 decimal places." });
  });

  it('cents to dollar text', () => {
    expect(centsToDollarText(1_200_000)).toBe('12000');
    expect(centsToDollarText(4_050)).toBe('40.50');
    expect(centsToDollarText(undefined)).toBe('');
  });

  it('plain numbers', () => {
    expect(parseNumber('15')).toBe(15);
    expect(parseNumber(' 2.5 ')).toBe(2.5);
    expect(parseNumber('.5')).toBe(0.5);
    for (const bad of ['', '-1', '1e3', 'abc', '5 min', '1,000']) expect(parseNumber(bad)).toBeUndefined();
  });
});

describe('budgets', () => {
  it('sets, clears and validates per destination without touching other budgets', () => {
    const current: Settings = { ...DEFAULTS, budgets: { keep: { centsPerMonth: 100 }, siem: { centsPerMonth: 5 } } };
    const draft = budgetDraftFrom(current, ['siem', 'new']);
    expect(draft).toEqual({ siem: '0.05', new: '' });
    const { next, errors } = applyBudgets(current, { siem: '', new: '1,500' });
    expect(errors).toEqual({});
    expect(next.budgets).toEqual({ keep: { centsPerMonth: 100 }, new: { centsPerMonth: 150_000 } });
    const bad = applyBudgets(current, { siem: 'lots' });
    expect(bad.errors['budgets.siem']).toBe("Couldn't save: budget must be 0 or more.");
  });

  it('projects the month like the detector and grades it against warn / alert', () => {
    const th = { budgetWarnPct: 90, budgetAlertPct: 100 };
    const tz = 'UTC';
    // Sep 26 12:00 UTC: 25.5 days of a 30-day month elapsed.
    const elapsedMin = 25.5 * 1440;
    const mtdPaidM = 100_000 * 25.5; // $1 a day so far
    const pace = budgetPace({ mtdPaidM }, 3_000, NOW, tz, th)!; // $30 budget
    expect(pace.projectedM).toBe(Math.round((mtdPaidM / elapsedMin) * 30 * 1440));
    expect(pace.ratio).toBeCloseTo(1, 5);
    expect(pace.level).toBe('alert');
    expect(budgetPace({ mtdPaidM }, 3_200, NOW, tz, th)!.level).toBe('warn');
    expect(budgetPace({ mtdPaidM }, 10_000, NOW, tz, th)!.level).toBe('ok');
    expect(budgetPace({ mtdPaidM }, undefined, NOW, tz, th)).toMatchObject({ level: 'none' });
    expect(budgetPace({ mtdPaidM: 0 }, 3_000, NOW, tz, th)).toBeUndefined();
    expect(budgetPace(undefined, 3_000, NOW, tz, th)).toBeUndefined();
  });
});

describe('Cribl cost', () => {
  it('sets and clears the optional monthly cost', () => {
    expect(costDraftFrom({ ...DEFAULTS, criblCostCentsPerMonth: 400_000 })).toBe('4000');
    expect(applyCost(DEFAULTS, '4,000').next.criblCostCentsPerMonth).toBe(400_000);
    const cleared = applyCost({ ...DEFAULTS, criblCostCentsPerMonth: 1 }, ' ');
    expect('criblCostCentsPerMonth' in cleared.next).toBe(false);
    expect(applyCost(DEFAULTS, 'x').errors.criblCostCentsPerMonth).toBe("Couldn't save: Cribl cost must be 0 or more.");
  });

  it('previews SPEC 8 net and payback for the month to date', () => {
    // Day 26 of 30 in UTC; $3,000/month → $2,600 so far.
    const p = costPreview({ mtdM: 1_040_000_000 / 100 }, 300_000, NOW, 'UTC')!;
    expect(p.proratedM).toBe(260_000_000);
    expect(p.netM).toBe(10_400_000 - 260_000_000);
    expect(p.paybackX).toBeCloseTo(10_400_000 / 260_000_000, 10);
    expect(costPreview({ mtdM: 5 }, 0, NOW, 'UTC')).toMatchObject({ proratedM: 0, netM: 5 });
    expect(costPreview({ mtdM: 5 }, 0, NOW, 'UTC')!.paybackX).toBeUndefined();
    expect(costPreview(undefined, 100, NOW, 'UTC')).toBeUndefined();
    expect(costPreview({ mtdM: 5 }, undefined, NOW, 'UTC')).toBeUndefined();
  });

  it("with the snapshot's span, prorates to the minutes metered this month, as the Receipt's net does", () => {
    // $3,000/month is $3,000 × 12 ÷ 525,600 a minute (core/net.ts). Collecting since Sep 25 6:00 PM UTC, sweep at noon
    // Sep 26: 18 hours of Cribl against 18 hours of savings — not SPEC 8's 26 days.
    const since = Date.parse('2026-09-25T18:00:00.000Z');
    const perMinute = (300_000 * 1000 * 12) / 525_600;
    const p = costPreview({ mtdM: 10_400_000 }, 300_000, NOW, 'UTC', { sweepAtMs: NOW, collectingSinceMs: since })!;
    expect(p.minutes).toBe(18 * 60);
    expect(p.proratedM).toBe(Math.round(perMinute * 18 * 60));
    expect(p.netM).toBe(10_400_000 - p.proratedM);
    expect(p.paybackX).toBeCloseTo(10_400_000 / (perMinute * 18 * 60), 10);
    // Collecting since before the month: the span is the month so far (Sep 1 → Sep 26 noon).
    const whole = costPreview({ mtdM: 10_400_000 }, 300_000, NOW, 'UTC', { sweepAtMs: NOW, collectingSinceMs: Date.parse('2026-08-01T00:00:00.000Z') })!;
    expect(whole.minutes).toBe(25.5 * 1440);
    // No cost: nothing prorated, no payback.
    expect(costPreview({ mtdM: 5 }, 0, NOW, 'UTC', { sweepAtMs: NOW })).toEqual({ savedMtdM: 5, proratedM: 0, netM: 5, minutes: 25.5 * 1440 });
  });
});

// ─── Alerts ──────────────────────────────────────────────────────────────────

describe('alerts', () => {
  it('maps α to the nearest memory option', () => {
    expect(memoryKeyForAlpha(0.0014)).toBe('24h');
    expect(memoryKeyForAlpha(2 / 61)).toBe('1h');
    expect(memoryKeyForAlpha(2 / 361)).toBe('6h');
    expect(memoryKeyForAlpha(2 / 10_081)).toBe('7d');
    expect(memoryKeyForAlpha(0.2)).toBe('1h');
    expect(memoryKeyForAlpha(0)).toBe('24h');
  });

  it('an untouched memory picker never rewrites α; a new pick sets α = 2/(N+1)', () => {
    const draft = alertsDraftFrom(DEFAULTS);
    expect(draft.memory).toBe('24h');
    expect(applyAlerts(DEFAULTS, draft).next.thresholds.ewmaAlpha).toBe(0.0014);
    expect(applyAlerts(DEFAULTS, { ...draft, memory: '6h' }).next.thresholds.ewmaAlpha).toBeCloseTo(2 / 361, 12);
  });

  it('validates SPEC 5 ranges and parse errors inline, and converts the spike minimum to cents', () => {
    const draft = alertsDraftFrom(DEFAULTS);
    expect(draft.spikeMinPerHour).toBe('5');
    const out = applyAlerts(DEFAULTS, { ...draft, regressionPoints: '60', regressionMinutes: 'x', spikeMinPerHour: '7.50', goodNewsEnabled: true });
    expect(out.errors['thresholds.regressionPoints']).toBe("Couldn't save: regression points must be between 5 and 50.");
    expect(out.errors['thresholds.regressionMinutes']).toBe("Couldn't save: regression minutes must be 0 or more.");
    expect(out.next.thresholds.spikeMinCentsPerHour).toBe(750);
    expect(out.next.goodNewsEnabled).toBe(true);
    const ok = applyAlerts(DEFAULTS, { ...draft, regressionPoints: '20', regressionMinutes: '2', budgetWarnPct: '80' });
    expect(ok.errors).toEqual({});
    expect(ok.next.thresholds).toMatchObject({ regressionPoints: 20, regressionMinutes: 2, budgetWarnPct: 80 });
    expect(applyAlerts(DEFAULTS, { ...draft, spikeMinutes: '1.5' }).errors['thresholds.spikeMinutes']).toMatch(/whole number/);
    expect(applyAlerts(DEFAULTS, { ...draft, spikeMinPerHour: '' }).errors['thresholds.spikeMinCentsPerHour']).toMatch(/0 or more/);
  });
});

// ─── Where to send alerts ────────────────────────────────────────────────────

const SLACK = 'https://hooks.slack.com/services/T0000/B0000/XXXXabcd';

/** A stored Cribl notification-target endpoint (D57: the only list endpoint; no URL). */
function endpoint(over: Partial<NotificationEndpoint> = {}): NotificationEndpoint {
  return { id: 'e1', name: 'Ops Slack', url: '', host: '', format: 'generic', minSeverity: 'medium', weeklyReceipt: true, enabled: true, channel: 'cribl-target', criblTargetId: 'ops_slack', ...over };
}

describe('endpoints', () => {
  it('keeps lastTest only while the target is unchanged, and stores no URL (D57)', () => {
    const saved = draftFromEndpoint(endpoint({ lastTest: { at: NOW_ISO, status: 200, hostAuthorized: true } }));
    expect(saved).toMatchObject({ saved: true, criblTargetId: 'ops_slack', savedTargetId: 'ops_slack', weeklyReceipt: true });
    expect(draftToEndpoint(saved).lastTest?.status).toBe(200);
    const moved = draftToEndpoint({ ...saved, criblTargetId: 'ops_pager' });
    expect(moved).toMatchObject({ criblTargetId: 'ops_pager', url: '', host: '' });
    expect(moved.lastTest).toBeUndefined();
  });

  it('validates names, the target id and the 10-endpoint cap with SPEC 17 copy', () => {
    const draft = { ...newEndpointDraft('n1'), name: 'X', criblTargetId: '' };
    const { errors } = applyEndpoints(DEFAULTS, [draft]);
    expect(errors[0].criblTargetId).toBe("Couldn't save: choose a Cribl notification target.");
    expect(applyEndpoints(DEFAULTS, [{ ...draft, name: ' ', criblTargetId: 'ops' }]).errors[0].name).toMatch(/name/);
    const many = Array.from({ length: 11 }, (_, i) => ({ ...newEndpointDraft(`n${i}`), name: `E${i}`, criblTargetId: 'ops' }));
    expect(applyEndpoints(DEFAULTS, many).listError).toMatch(/at most 10/);
    const ok = applyEndpoints(DEFAULTS, [{ ...draft, criblTargetId: 'ops' }]);
    expect(ok.errors).toEqual({});
    expect(ok.next.notifications[0]).toMatchObject({ id: 'n1', channel: 'cribl-target', criblTargetId: 'ops', url: '', host: '', minSeverity: 'medium', weeklyReceipt: true, enabled: true });
  });

  it('D57: a stored direct webhook never becomes a draft, and core refuses one in the settings document', () => {
    const hook: NotificationEndpoint = { id: 'h', name: 'Old hook', url: SLACK, host: 'hooks.slack.com', format: 'slack', minSeverity: 'medium', weeklyReceipt: true, enabled: true };
    const settings: Settings = { ...DEFAULTS, notifications: [hook, endpoint()] };
    expect(draftsFromSettings(settings).map((d) => d.id)).toEqual(['e1']);
    const { errors } = applyEndpoints({ ...DEFAULTS, notifications: [hook] }, []);
    // The drafts never carry the hook, so applying them drops it; validating the raw document refuses it.
    expect(errors).toEqual({});
  });

  it('counts added, changed and removed endpoints', () => {
    const settings: Settings = { ...DEFAULTS, notifications: [endpoint(), endpoint({ id: 'e2', name: 'Two' })] };
    const drafts = draftsFromSettings(settings);
    expect(endpointsDirty(drafts, settings)).toBe(false);
    expect(endpointDirtyCount(drafts, settings)).toBe(0);
    const edited = [{ ...drafts[0], name: 'Renamed' }, newEndpointDraft('e3')];
    expect(endpointDirtyCount(edited, settings)).toBe(3); // e1 changed, e2 removed, e3 added
  });

  it('the refusal names where a direct webhook goes instead', () => {
    expect(WEBHOOK_NOT_STORED_MESSAGE).toMatch(/stores no webhook URL/);
    expect(WEBHOOK_NOT_STORED_MESSAGE).toMatch(/Cribl notification target/);
    expect(WEBHOOK_NOT_STORED_MESSAGE).toMatch(/runner/);
  });

  it('names Cribl target types, and leaves unknown ones as they are', () => {
    expect(targetTypeLabel('pagerduty')).toBe('PagerDuty');
    expect(targetTypeLabel('bulletin_message')).toBe('Cribl bell');
    expect(targetTypeLabel('toString')).toBe('toString');
    expect(targetTypeLabel('custom_thing')).toBe('custom_thing');
  });
});

describe('weekly receipt result (Settings → Where to send alerts)', () => {
  const hook: NotificationEndpoint = endpoint({ id: 'hook' });
  const log = (endpointId: string, status: number, attempt = 1) => ({ endpointId, event: 'receipt.weekly' as const, status, attempt, at: NOW_ISO, kind: 'notify' as const });

  it('reads each endpoint by its newest attempt and totals exactly', () => {
    const v = weeklyView({ sent: 1, endpoints: 2, calls: 5, deliveries: [log('hook', 0), log('hook', 403, 2), log('cribl-bell', 200)] }, [hook]);
    expect(v.tone).toBe('warn');
    expect(v.summary).toBe('Sent to 1 of 2 endpoints.');
    expect(v.lines.map((l) => l.text)).toEqual(['Ops Slack: failed (403)', 'Cribl notifications: sent (200)']);
    // A target that did not answer: its own line, no plan note (D57: no direct webhook is sent from a tab).
    expect(weeklyView({ sent: 0, endpoints: 1, calls: 1, deliveries: [log('hook', 0)] }, [hook])).toMatchObject({
      tone: 'error',
      summary: 'Not sent: the endpoint did not accept it.',
      lines: [{ text: 'Ops Slack: no response', ok: false }],
    });
  });

  it('all sent, nothing to send, rate limited, and a failed run', () => {
    expect(weeklyView({ sent: 2, endpoints: 2, calls: 5, deliveries: [log('hook', 200), log('cribl-bell', 208)] }, [hook])).toMatchObject({
      tone: 'ok',
      summary: 'Sent to all 2 endpoints.',
    });
    expect(weeklyView({ sent: 0, endpoints: 0, calls: 3, deliveries: [], skipped: 'no_endpoints' }, []).summary).toBe(
      'No enabled endpoint has Weekly receipt on. Turn it on for an endpoint above and save, then send.',
    );
    expect(weeklyView({ sent: 0, endpoints: 0, calls: 1, deliveries: [], skipped: 'rate_limited' }, []).tone).toBe('warn');
    expect(weeklyView({ sent: 0, endpoints: 0, calls: 1, deliveries: [], error: 'KV PUT failed: HTTP 503' }, [])).toMatchObject({
      tone: 'error',
      summary: "Couldn't send the weekly receipt: KV PUT failed: HTTP 503",
    });
  });
});

// Keep the PricesDoc import meaningful for readers: an empty doc prices nothing.
describe('empty prices', () => {
  it('prices nothing', () => {
    const doc: PricesDoc = emptyPrices(NOW_ISO);
    expect(buildRows([{ groupId: 'default', outputId: 'a', type: 's3' }], doc, NOW)[0].unpriced).toBe(true);
  });
});
