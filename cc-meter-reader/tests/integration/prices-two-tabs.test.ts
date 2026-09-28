// EPIC_AUDIT P1-D04: two open tabs, one KV. Tab B saves a price; tab A, still holding the document it loaded,
// saves another. A's save must not revert B's (measured before the fix: B's $0.55 back to $0.03) — both saves
// survive as versions, and the newest version carries both prices.

import { describe, expect, it } from 'vitest';
import { appendPriceVersion, effectivePrices } from '../../core/pricing.ts';
import { defaultSettings, mergeSettings } from '../../core/settings.ts';
import type { PricesDoc, Settings } from '../../core/types.ts';
import type { AppDocs, SweepEngine } from '../../src/state/ports.ts';
import { changedEntries, isSameSave, rebasePrices } from '../../src/state/pricesMerge.ts';
import { createAppServices, type AppServices } from '../../src/state/services.ts';
import { createAppStore } from '../../src/state/store.ts';

const T0 = Date.parse('2026-09-26T15:00:00.000Z');
const DEFAULTS: Settings = defaultSettings('2026-09-26T00:00:00.000Z', 'UTC');
const MC = (dollars: number) => Math.round(dollars * 100_000);

const INITIAL: PricesDoc = {
  schemaVersion: 1,
  updatedAt: '2026-09-25T00:00:00.000Z',
  versions: [
    {
      effectiveFrom: '2026-09-25T00:00:00.000Z',
      byOutputId: { mrd_siem_prod: { milliCentsPerGb: MC(2.25), preset: 'splunk_cloud' }, mrd_analytics: { milliCentsPerGb: MC(0.03) } },
    },
  ],
};

/** One KV shared by every tab: documents are stored as JSON text, as the platform does. */
function sharedKv() {
  const kv = new Map<string, string>([['prices', JSON.stringify(INITIAL)], ['settings', JSON.stringify(DEFAULTS)]]);
  const read = <T>(key: string) => async (): Promise<T | null> => {
    const v = kv.get(key);
    return v === undefined ? null : (JSON.parse(v) as T);
  };
  const docs: AppDocs = {
    readSettings: read('settings'),
    readPrices: read('prices'),
    readSnapshot: read('snapshot'),
    readMeta: read('meta'),
    readDemoState: read('demo/state'),
    readInventory: read('inventory'),
    writeSettings: async (doc) => void kv.set('settings', JSON.stringify(doc)),
    writePrices: async (doc) => void kv.set('prices', JSON.stringify(doc)),
  };
  const stored = (): PricesDoc => JSON.parse(kv.get('prices') ?? 'null') as PricesDoc;
  return { docs, stored };
}

const idle: SweepEngine = {
  runLocal: async (mode) => ({ ok: true, mode, skipped: 'current' }),
  invokeBackend: async () => ({ ok: true, mode: 'manual' }),
};

function openTab(docs: AppDocs, clock: { now: number }): AppServices {
  return createAppServices({
    store: createAppStore(DEFAULTS),
    docs,
    engine: idle,
    mergeSettings: (s) => mergeSettings(s, DEFAULTS),
    // Nothing runs on a timer in this test: saves and reads are driven by hand.
    timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    visibility: { hidden: false, addEventListener: () => undefined, removeEventListener: () => undefined },
    now: () => clock.now,
  });
}

/** What the Prices page builds on Save: the newest version plus the member's edits, from the document it holds. */
function edit(tab: AppServices, byOutputId: PricesDoc['versions'][number]['byOutputId'], atMs: number): PricesDoc {
  return appendPriceVersion(tab.store.getState().prices ?? INITIAL, byOutputId, atMs);
}

describe('two tabs saving prices over one KV (P1-D04)', () => {
  it("B saves, then A saves from its stale copy: A's save keeps B's version and price", async () => {
    const { docs, stored } = sharedKv();
    const clock = { now: T0 };
    const a = openTab(docs, clock);
    const b = openTab(docs, clock);
    await a.actions.refresh(); // both tabs have loaded the same document
    await b.actions.refresh();
    // Hydration isn't under test here: mark both tabs ready to write.
    for (const tab of [a, b]) tab.store.setState({ hasHydrated: true, settingsStored: true });
    expect(a.store.getState().prices).toEqual(INITIAL);
    expect(b.store.getState().prices).toEqual(INITIAL);

    clock.now = T0 + 60_000;
    const bSave = await b.actions.savePrices(edit(b, { mrd_analytics: { milliCentsPerGb: MC(0.55) } }, clock.now));
    expect(bSave).toEqual({ ok: true });
    expect(stored().versions).toHaveLength(2);

    clock.now = T0 + 120_000;
    const aSave = await a.actions.savePrices(edit(a, { mrd_siem_prod: { milliCentsPerGb: MC(3), preset: 'splunk_cloud' } }, clock.now));
    expect(aSave).toEqual({ ok: true, merged: true });

    const doc = stored();
    // Both saves survive as versions: the original, B's, then A's on top.
    expect(doc.versions).toHaveLength(3);
    expect(doc.versions[1].byOutputId.mrd_analytics.milliCentsPerGb).toBe(MC(0.55));
    const newest = doc.versions[2].byOutputId;
    expect(newest.mrd_analytics.milliCentsPerGb).toBe(MC(0.55)); // B's price, not reverted to $0.03
    expect(newest.mrd_siem_prod.milliCentsPerGb).toBe(MC(3)); // A's edit
    // A price lookup now and at B's save time both see B's analytics price.
    expect(effectivePrices(doc, 'default', 'mrd_analytics', T0 + 130_000).paidMcPerGb).toBe(MC(0.55));
    expect(effectivePrices(doc, 'default', 'mrd_analytics', T0 + 90_000).paidMcPerGb).toBe(MC(0.55));
    // Tab A now holds what it wrote; B adopts it on its next prices read.
    expect(a.store.getState().prices).toEqual(doc);
    await b.actions.refresh();
    expect(b.store.getState().prices).toEqual(doc);
  });

  it('a tab that holds the stored document writes it as built (no merge)', async () => {
    const { docs, stored } = sharedKv();
    const clock = { now: T0 };
    const a = openTab(docs, clock);
    await a.actions.refresh();
    a.store.setState({ hasHydrated: true, settingsStored: true });
    clock.now = T0 + 30_000;
    const built = edit(a, { mrd_analytics: { milliCentsPerGb: MC(0.1) } }, clock.now);
    expect(await a.actions.savePrices(built)).toEqual({ ok: true });
    expect(stored()).toEqual({ ...built, updatedAt: new Date(clock.now).toISOString() });
  });

  it('refuses to write blind when the stored document cannot be read', async () => {
    const { docs } = sharedKv();
    const clock = { now: T0 };
    const a = openTab({ ...docs, readPrices: async () => Promise.reject(Object.assign(new Error('KV GET prices failed: HTTP 503'), { status: 503 })) }, clock);
    a.store.setState({ hasHydrated: true, settingsStored: true, prices: INITIAL });
    const result = await a.actions.savePrices(edit(a, { mrd_analytics: { milliCentsPerGb: MC(0.1) } }, T0));
    expect(result).toMatchObject({ ok: false, reason: 'error', error: { kind: 'server', status: 503 } });
  });
});

describe('pricesMerge helpers', () => {
  it('isSameSave compares the save stamp and the version count', () => {
    expect(isSameSave(INITIAL, { ...INITIAL })).toBe(true);
    expect(isSameSave(INITIAL, { ...INITIAL, updatedAt: '2026-09-26T00:00:00.000Z' })).toBe(false);
    expect(isSameSave(null, null)).toBe(true);
    expect(isSameSave(INITIAL, null)).toBe(false);
  });

  it('changedEntries lists only what this save changed', () => {
    const next = appendPriceVersion(INITIAL, { mrd_analytics: { milliCentsPerGb: MC(0.2) } }, T0);
    expect(Object.keys(changedEntries(INITIAL, next))).toEqual(['mrd_analytics']);
  });

  it('keeps the appended version after the stored newest even when this clock is behind', () => {
    const stored = appendPriceVersion(INITIAL, { mrd_analytics: { milliCentsPerGb: MC(0.55) } }, T0 + 60_000);
    const mine = appendPriceVersion(INITIAL, { mrd_siem_prod: { milliCentsPerGb: MC(3) } }, T0); // skewed 60 s behind
    const { doc, merged } = rebasePrices(mine, INITIAL, stored, new Date(T0).toISOString());
    expect(merged).toBe(true);
    const froms = doc.versions.map((v) => Date.parse(v.effectiveFrom));
    expect(froms[2]).toBeGreaterThan(froms[1]);
    expect(doc.versions[2].byOutputId.mrd_analytics.milliCentsPerGb).toBe(MC(0.55));
  });

  it('a save that changed nothing on top of a newer document writes the newer document back unchanged', () => {
    const stored = appendPriceVersion(INITIAL, { mrd_analytics: { milliCentsPerGb: MC(0.55) } }, T0 + 60_000);
    const { doc, merged } = rebasePrices({ ...INITIAL }, INITIAL, stored, new Date(T0 + 90_000).toISOString());
    expect(merged).toBe(true);
    expect(doc.versions).toEqual(stored.versions);
  });
});
