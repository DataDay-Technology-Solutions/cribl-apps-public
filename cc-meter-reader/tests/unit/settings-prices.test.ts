// Prices, wave 2 (EPIC_AUDIT P1-F11, P1-G03, P2-W09, P2-W24): the billing model behind each preset and the
// entitlement line, and the Prices page's pure additions.

import { describe, expect, it } from 'vitest';
import { PRESETS } from '../../core/presets.ts';
import { entitlementPresets, receiptTextForPeriod } from '../../core/receipt.ts';
import { appendPriceVersion, emptyPrices } from '../../core/pricing.ts';
import type { DestinationFigures, PricesDoc, Snapshot } from '../../core/types.ts';
import { entitlementLine } from '../../src/components/PriceTable/entitlement.ts';

const SWEEP_ISO = '2026-09-26T12:00:00.000Z';
const SWEEP_MS = Date.parse(SWEEP_ISO);

function dest(outputId: string, perDay: { whp: number; paid: number }): DestinationFigures {
  return {
    groupId: 'default',
    outputId,
    type: 'devnull',
    whpPerDayM: perDay.whp,
    paidPerDayM: perDay.paid,
    savedPerDayM: Math.max(0, perDay.whp - perDay.paid),
    mtdPaidM: 0,
    mtdSavedM: 0,
    mtdWhpM: 0,
    milliCentsPerGb: 0,
    counterfactual: { kind: 'same' },
    unpriced: false,
  };
}

function snapshotWith(destinations: DestinationFigures[]): Snapshot {
  return {
    sweepAt: SWEEP_ISO,
    destinations,
    headline: {
      todayM: 0,
      mtdM: 1_000_000,
      d30M: 0,
      annualizedM: 0,
      annualizedFromDays: 0,
      whpMtdM: 2_000_000,
      paidMtdM: 1_000_000,
      ratioMtd: 0.5,
      whpTodayM: 0,
      paidTodayM: 0,
      whp30dM: 0,
      paid30dM: 0,
    },
    incidents: [],
  } as unknown as Snapshot;
}

function pricesOf(byOutputId: Record<string, { preset?: string; mc: number }>): PricesDoc {
  const entries = Object.fromEntries(
    Object.entries(byOutputId).map(([k, v]) => [`default:${k}`, { milliCentsPerGb: v.mc, ...(v.preset ? { preset: v.preset as never } : {}) }]),
  );
  return appendPriceVersion(emptyPrices(SWEEP_ISO), entries, SWEEP_MS - 60_000);
}

describe('P1-F11: every preset says how its vendor bills', () => {
  it('every preset has a billing field of metered, entitlement or storage', () => {
    for (const p of PRESETS) expect(['metered', 'entitlement', 'storage'], p.id).toContain(p.billing);
  });

  it('prepaid per-GB/day subscriptions, commitment tiers and credit pools are entitlements; object stores are storage', () => {
    const billing = Object.fromEntries(PRESETS.map((p) => [p.id, p.billing]));
    expect(billing.splunk_cloud).toBe('entitlement');
    expect(billing.sentinel).toBe('entitlement');
    expect(billing.sumo).toBe('entitlement');
    expect(billing.datadog).toBe('metered');
    expect(billing.s3).toBe('storage');
    expect(billing.cribl_lake).toBe('storage');
  });
});

describe('P1-F11: the entitlement line', () => {
  const siem = dest('siem', { whp: 500_000_000, paid: 200_000_000 });
  const archive = dest('archive', { whp: 3_000_000, paid: 1_000_000 });

  it('names an entitlement-billed destination that carries money', () => {
    const snap = snapshotWith([siem, archive]);
    const prices = pricesOf({ siem: { preset: 'splunk_cloud', mc: 225_000 }, archive: { preset: 's3', mc: 2_300 } });
    expect(entitlementPresets(snap, prices)).toEqual(['splunk_cloud']);
    expect(entitlementLine(snap, prices)).toBe(
      'Splunk Cloud is billed as a prepaid entitlement: its share of these dollars is realized at renewal, not on the next bill.',
    );
  });

  it('stays silent when only metered or storage destinations carry money', () => {
    const snap = snapshotWith([siem, archive]);
    const prices = pricesOf({ siem: { preset: 'datadog', mc: 180_000 }, archive: { preset: 's3', mc: 2_300 } });
    expect(entitlementLine(snap, prices)).toBeNull();
  });

  it('stays silent when the entitlement-billed destination carries no money', () => {
    const snap = snapshotWith([dest('siem', { whp: 0, paid: 0 }), archive]);
    const prices = pricesOf({ siem: { preset: 'splunk_cloud', mc: 225_000 }, archive: { preset: 's3', mc: 2_300 } });
    expect(entitlementLine(snap, prices)).toBeNull();
  });

  it('keeps the vendor when a contract rate replaces the typical price, and leaves out a Custom price with no preset', () => {
    const snap = snapshotWith([siem, dest('custom', { whp: 900_000_000, paid: 100_000_000 })]);
    const prices = pricesOf({ siem: { preset: 'splunk_cloud', mc: 180_000 }, custom: { mc: 300_000 } });
    expect(entitlementPresets(snap, prices)).toEqual(['splunk_cloud']);
  });

  it('names several vendors once each, largest would-have-paid first, in one sentence', () => {
    const snap = snapshotWith([siem, dest('sentinel', { whp: 900_000_000, paid: 300_000_000 }), dest('siem2', { whp: 1_000, paid: 0 })]);
    const prices = pricesOf({
      siem: { preset: 'splunk_cloud', mc: 225_000 },
      siem2: { preset: 'splunk_cloud', mc: 225_000 },
      sentinel: { preset: 'sentinel', mc: 250_000 },
    });
    expect(entitlementPresets(snap, prices)).toEqual(['sentinel', 'splunk_cloud']);
    expect(entitlementLine(snap, prices)).toBe(
      'Microsoft Sentinel and Splunk Cloud are billed as prepaid entitlements: their share of these dollars is realized at renewal, not on the next bill.',
    );
  });

  it('no snapshot or no prices: no line', () => {
    expect(entitlementLine(null, pricesOf({ siem: { preset: 'splunk_cloud', mc: 225_000 } }))).toBeNull();
    expect(entitlementLine(snapshotWith([siem]), null)).toBeNull();
  });

  it('Copy receipt carries the line under the totals, wrapped to the receipt width', () => {
    const snap = snapshotWith([siem]);
    const note = entitlementLine(snap, pricesOf({ siem: { preset: 'splunk_cloud', mc: 225_000 } })) ?? '';
    const text = receiptTextForPeriod('month to date', snap, { period: 'mtd', note });
    const lines = text.split('\n');
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(48);
    const at = lines.findIndex((l) => l.startsWith('Splunk Cloud is billed'));
    expect(at).toBeGreaterThan(lines.findIndex((l) => l.startsWith('Would have paid')));
    const alerts = lines.findIndex((l) => l.startsWith('Open alerts'));
    expect(lines.slice(at, alerts).join(' ')).toBe(note);
    expect(receiptTextForPeriod('month to date', snap, { period: 'mtd' })).not.toContain('entitlement');
  });
});

describe('P1-G03: Prices polish', () => {
  it('the meta line leads with the id only when the name does not already say it', async () => {
    const { destinationMeta } = await import('../../src/components/PriceTable/model.ts');
    expect(destinationMeta({ name: 'SIEM (prod)', outputId: 'mrd_siem_prod', type: 'devnull', groupId: 'default' })).toBe('mrd_siem_prod · devnull · default');
    expect(destinationMeta({ name: 'Devnull', outputId: 'devnull', type: 'devnull', groupId: 'default' })).toBe('devnull · default');
    expect(destinationMeta({ name: 'Google SecOps', outputId: 'google_secops', type: 'google_chronicle', groupId: 'datacenter' })).toBe(
      'google_chronicle · datacenter',
    );
  });

  it('every preset source names its publisher, never a host', async () => {
    const { PRESET_NOTES } = await import('../../core/presets.ts');
    for (const [id, note] of Object.entries(PRESET_NOTES)) {
      for (const source of note.sources) {
        expect(source.publisher, `${id} ${source.url}`).toBeTruthy();
        expect(source.publisher, `${id} ${source.url}`).not.toMatch(/\.(com|net|uk|io|ai|co)\b|https?:/);
      }
    }
  });

  it('price errors are short; a value with no field of its own keeps the long form that names it', async () => {
    const { validateDraft, initialDraft } = await import('../../src/components/PriceTable/model.ts');
    const row = { groupId: 'default', outputId: 'x', type: 'splunk_hec', key: 'default:x', name: 'x', suggestedPreset: 'splunk_cloud' as const, unpriced: true };
    const draft = { ...initialDraft(row), price: 'abc' };
    expect(validateDraft(row, draft).price).toBe('Enter a number, 0 or more.');
    expect(validateDraft(row, { ...draft, price: '1.2345' }).price).toBe('At most 3 decimals.');
    expect(validateDraft(row, { ...draft, price: '1', committed: 'x' }).committed).toBe("Couldn't save: committed price must be 0 or more.");
  });
});

describe('P2-W09: the live receipt', () => {
  const GB = 1e9;
  async function setup() {
    const model = await import('../../src/components/PriceTable/model.ts');
    const live = await import('../../src/components/PriceTable/receiptModel.ts');
    const destinations = [
      { groupId: 'default', outputId: 'siem', type: 'splunk_hec' },
      { groupId: 'default', outputId: 'archive', type: 's3' },
      { groupId: 'default', outputId: 'idle', type: 'splunk_hec' },
    ];
    const snapshot = {
      flows: [
        { groupId: 'default', outputId: 'siem', inBPerDay: 1000 * GB, outBPerDay: 400 * GB },
        { groupId: 'default', outputId: 'siem', inBPerDay: 500 * GB, outBPerDay: 200 * GB },
        { groupId: 'default', outputId: 'archive', inBPerDay: 300 * GB, outBPerDay: 300 * GB },
      ],
    } as unknown as Snapshot;
    return { model, live, destinations, snapshot };
  }

  it('prices the last sweep\'s traffic at the draft, the way the sweep would (600 GB/day × $2.25 = $1,350)', async () => {
    const { model, live, destinations, snapshot } = await setup();
    const rows = model.buildRows(destinations, null, SWEEP_MS);
    const drafts = model.initialDrafts(rows);
    drafts['default:siem'] = { ...drafts['default:siem'], price: '2.25' };
    const r = live.draftReceipt(rows, drafts, null, snapshot, SWEEP_MS);
    expect(r).not.toBeNull();
    const siem = r!.rows['default:siem'];
    expect(siem.outBPerDay).toBe(600 * GB);
    expect(siem.paidPerDayM).toBe(135_000_000); // $1,350
    expect(siem.whpPerDayM).toBe(337_500_000); // 1,500 GB × $2.25
    expect(siem.savedPerDayM).toBe(202_500_000);
    expect(siem.wasPaidPerDayM).toBeUndefined();
    // Unpriced rows print nothing; the idle destination had no traffic.
    expect(r!.rows['default:archive']).toBeUndefined();
    expect(r!.total).toEqual({ whpPerDayM: 337_500_000, paidPerDayM: 135_000_000, savedPerDayM: 202_500_000, destinations: 1 });
  });

  it('honours the counterfactual: "Nowhere" saves nothing; another destination prices would-have-paid at its rate', async () => {
    const { model, live, destinations, snapshot } = await setup();
    const rows = model.buildRows(destinations, null, SWEEP_MS);
    const drafts = model.initialDrafts(rows);
    drafts['default:siem'] = { ...drafts['default:siem'], price: '2.00' };
    drafts['default:archive'] = { ...drafts['default:archive'], price: '0.023', counterfactual: 'none' };
    let r = live.draftReceipt(rows, drafts, null, snapshot, SWEEP_MS)!;
    expect(r.rows['default:archive']).toMatchObject({ paidPerDayM: 690_000, whpPerDayM: 0, savedPerDayM: 0 });
    drafts['default:archive'] = { ...drafts['default:archive'], counterfactual: 'other:siem' };
    r = live.draftReceipt(rows, drafts, null, snapshot, SWEEP_MS)!;
    expect(r.rows['default:archive']).toMatchObject({ paidPerDayM: 690_000, whpPerDayM: 60_000_000, savedPerDayM: 59_310_000 });
    expect(r.total.destinations).toBe(2);
  });

  it('an invalid draft prints no line and keeps the stored price in the totals; a changed stored price says what it was', async () => {
    const { model, live, destinations, snapshot } = await setup();
    const stored = appendPriceVersion(emptyPrices(SWEEP_ISO), { 'default:siem': { milliCentsPerGb: 250_000, preset: 'splunk_cloud' } }, SWEEP_MS - 3_600_000);
    const rows = model.buildRows(destinations, stored, SWEEP_MS);
    const drafts = model.initialDrafts(rows);
    drafts['default:siem'] = { ...drafts['default:siem'], price: 'abc' };
    let r = live.draftReceipt(rows, drafts, stored, snapshot, SWEEP_MS)!;
    expect(r.rows['default:siem']).toBeUndefined();
    expect(r.total.paidPerDayM).toBe(150_000_000); // 600 GB × the stored $2.50
    drafts['default:siem'] = { ...drafts['default:siem'], price: '2.25' };
    r = live.draftReceipt(rows, drafts, stored, snapshot, SWEEP_MS)!;
    expect(r.rows['default:siem']).toMatchObject({ paidPerDayM: 135_000_000, wasPaidPerDayM: 150_000_000 });
  });

  it('W3-RECEIPT-1: the card prints a footed triple and the destination lines add up to its Paid', async () => {
    const { model, live, destinations, snapshot } = await setup();
    const rows = model.buildRows(destinations, null, SWEEP_MS);
    const drafts = model.initialDrafts(rows);
    // SIEM pays $1,200.60 and the archive $3.60 a day: rounded one at a time the lines print $1,201 + $4 = $1,205,
    // a dollar over the card's footed Paid ($3,005 would have paid − $1,801 saved = $1,204).
    drafts['default:siem'] = { ...drafts['default:siem'], price: '2.001' };
    drafts['default:archive'] = { ...drafts['default:archive'], price: '0.012' };
    const r = live.draftReceipt(rows, drafts, null, snapshot, SWEEP_MS)!;
    const DOLLAR = 100_000;
    expect(r.shown.whpM - r.shown.paidM).toBe(r.shown.savedM);
    for (const v of Object.values(r.shown)) expect(v % DOLLAR).toBe(0);
    const lines = Object.values(r.rows).map((l) => l.shownPaidPerDayM);
    expect(lines).toHaveLength(2);
    expect(lines.reduce((a, b) => a + b, 0)).toBe(r.shown.paidM);
    // Rounded on their own the two lines would not add up here: the footing is what makes them agree.
    const own = Object.values(r.rows).reduce((a, l) => a + Math.floor(l.paidPerDayM / DOLLAR + 0.5) * DOLLAR, 0);
    expect(own).not.toBe(r.shown.paidM);
  });

  it('a never-swept workspace has no traffic, so no receipt at all (never a guess)', async () => {
    const { model, live, destinations } = await setup();
    const rows = model.buildRows(destinations, null, SWEEP_MS);
    expect(live.draftReceipt(rows, model.initialDrafts(rows), null, null, SWEEP_MS)).toBeNull();
    expect(live.draftReceipt(rows, model.initialDrafts(rows), null, { flows: [] } as unknown as Snapshot, SWEEP_MS)).toBeNull();
  });

  it('lists what Save will write, receipt-style', async () => {
    const { model, live, destinations } = await setup();
    const stored = appendPriceVersion(emptyPrices(SWEEP_ISO), { 'default:siem': { milliCentsPerGb: 225_000, preset: 'splunk_cloud' } }, SWEEP_MS - 3_600_000);
    const rows = model.buildRows(destinations, stored, SWEEP_MS);
    const drafts = model.initialDrafts(rows);
    drafts['default:siem'] = { ...drafts['default:siem'], price: '2.50' };
    drafts['default:archive'] = { ...drafts['default:archive'], price: '0.023' };
    drafts['default:idle'] = { ...drafts['default:idle'], price: 'x' };
    const { dirty } = model.collectChanges(rows, drafts);
    const list = live.pendingChanges(rows, drafts, new Set(dirty), () => 'Nowhere (archive-only data)');
    expect(list.map((c) => [c.key, c.before, c.after])).toEqual([
      ['default:siem', '$2.25', '$2.50'],
      ['default:archive', 'unpriced', '$0.023'],
    ]);
    drafts['default:siem'] = { ...drafts['default:siem'], price: '2.25', counterfactual: 'none' };
    const cf = live.pendingChanges(rows, drafts, new Set(model.collectChanges(rows, drafts).dirty), () => 'Nowhere (archive-only data)');
    expect(cf[0]).toMatchObject({ before: '$2.25', after: '$2.25', detail: 'without Cribl: Nowhere (archive-only data)' });
  });
});

describe('P2-W24: who changed a price, and the vendor tiles', () => {
  it('a version carries its author; the history lists changes only, and the price in force names who set it', async () => {
    const { priceHistory, priceChangeAt } = await import('../../core/pricing.ts');
    let doc = appendPriceVersion(emptyPrices(SWEEP_ISO), { 'default:siem': { milliCentsPerGb: 250_000, preset: 'splunk_cloud' } }, SWEEP_MS - 7_200_000, 'alice');
    doc = appendPriceVersion(doc, { 'default:archive': { milliCentsPerGb: 2_300, preset: 's3' } }, SWEEP_MS - 3_600_000, 'bob');
    doc = appendPriceVersion(doc, { 'default:siem': { milliCentsPerGb: 225_000, preset: 'splunk_cloud' } }, SWEEP_MS - 60_000, 'carol');
    expect(doc.versions.map((v) => v.changedBy)).toEqual(['alice', 'bob', 'carol']);
    const h = priceHistory(doc, 'default', 'siem');
    expect(h.map((c) => [c.entry.milliCentsPerGb, c.changedBy])).toEqual([
      [250_000, 'alice'],
      [225_000, 'carol'],
    ]);
    expect(priceChangeAt(doc, 'default', 'siem', SWEEP_MS)?.changedBy).toBe('carol');
    expect(priceChangeAt(doc, 'default', 'siem', SWEEP_MS - 600_000)?.changedBy).toBe('alice');
    // Older than the first price (D25): the first change.
    expect(priceChangeAt(doc, 'default', 'siem', SWEEP_MS - 86_400_000)?.changedBy).toBe('alice');
    expect(priceChangeAt(doc, 'default', 'nothing', SWEEP_MS)).toBeUndefined();
    // No author known: the version says nothing rather than guessing.
    expect(appendPriceVersion(doc, {}, SWEEP_MS).versions.at(-1)).not.toHaveProperty('changedBy');
  });

  it('compaction past 50 versions keeps the later author', async () => {
    let doc = emptyPrices(SWEEP_ISO);
    for (let i = 0; i < 52; i++) doc = appendPriceVersion(doc, { 'default:siem': { milliCentsPerGb: 1_000 + i } }, SWEEP_MS + i * 1000, `u${i}`);
    expect(doc.versions).toHaveLength(50);
    expect(doc.versions[0].changedBy).toBe('u2');
  });

  it('a save rebased on top of another tab keeps its author', async () => {
    const { rebasePrices } = await import('../../src/state/pricesMerge.ts');
    const base = appendPriceVersion(emptyPrices(SWEEP_ISO), { 'default:siem': { milliCentsPerGb: 250_000 } }, SWEEP_MS - 7_200_000, 'alice');
    const other = { ...appendPriceVersion(base, { 'default:archive': { milliCentsPerGb: 2_300 } }, SWEEP_MS - 3_600_000, 'bob'), updatedAt: 'other' };
    const mine = appendPriceVersion(base, { 'default:siem': { milliCentsPerGb: 225_000 } }, SWEEP_MS, 'carol');
    const { doc, merged } = rebasePrices(mine, base, other, SWEEP_ISO);
    expect(merged).toBe(true);
    expect(doc.versions.at(-1)?.changedBy).toBe('carol');
  });

  it('the tiles: the suggestion pinned first, vendors, then Custom price and Internal / free; search matches names, ids and types', async () => {
    const { presetTiles } = await import('../../src/components/PriceTable/model.ts');
    const all = presetTiles('datadog');
    expect(all.suggested?.id).toBe('datadog');
    expect(all.suggested?.monogram).toBe('DD');
    expect(all.listed.map((t) => t.id)).not.toContain('datadog');
    expect(all.listed).toHaveLength(13);
    expect(all.other.map((t) => t.id)).toEqual(['custom', 'internal']);
    for (const tile of [...all.listed, all.suggested!]) {
      expect(tile.monogram).toMatch(/^[A-Z0-9$]{2}$/);
      expect(tile.tone).toBeGreaterThanOrEqual(1);
      expect(tile.tone).toBeLessThanOrEqual(6);
      expect(tile.caption).toMatch(/^typical \$[\d.]+ \/ GB$/);
    }
    // Internal / free is never pinned as a suggestion.
    expect(presetTiles('internal').suggested).toBeUndefined();
    expect(presetTiles('internal', 'splunk').listed.map((t) => t.id)).toEqual(['splunk_cloud', 'splunk_enterprise']);
    expect(presetTiles('internal', 'hec').listed.map((t) => t.id)).toEqual(['splunk_cloud', 'crowdstrike_ngsiem']);
    expect(presetTiles('internal', 'free').other.map((t) => t.id)).toEqual(['internal']);
    const none = presetTiles('datadog', 'zzz');
    expect([none.suggested, ...none.listed, ...none.other].filter(Boolean)).toHaveLength(0);
  });

  it('criblMemberName: the platform member as "First Last", else the username, trimmed; undefined outside Cribl, on refusal, or when it does not answer', async () => {
    const { criblMemberName } = await import('../../src/lib/env.ts');
    const w = globalThis as unknown as { window?: { getCriblUser?: () => Promise<unknown> } };
    const had = w.window;
    try {
      w.window = undefined;
      expect(await criblMemberName()).toBeUndefined();
      w.window = { getCriblUser: () => Promise.resolve({ id: 'u1', username: ' s.koelpin ' }) };
      expect(await criblMemberName()).toBe('s.koelpin');
      w.window = { getCriblUser: () => Promise.resolve({ id: 'u1', username: 's.koelpin', firstName: ' Steve ', lastName: 'Koelpin' }) };
      expect(await criblMemberName()).toBe('Steve Koelpin');
      w.window = { getCriblUser: () => Promise.resolve({ id: 'u1', username: 's.koelpin', firstName: 'Steve', lastName: '' }) };
      expect(await criblMemberName()).toBe('Steve');
      w.window = { getCriblUser: () => Promise.reject(new Error('no')) };
      expect(await criblMemberName()).toBeUndefined();
      w.window = { getCriblUser: () => new Promise(() => undefined) };
      expect(await criblMemberName(20)).toBeUndefined();
    } finally {
      w.window = had;
    }
  });
});
