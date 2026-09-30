// @vitest-environment jsdom
// r2 ui-3 (FINDINGS_R2 #4 UI half, contract C1''): a settings-less live workspace (a 1.1.0 upgrade, or one another
// runtime metered) gets a settings document on this tab's first live sweep, once, through ensureSettingsStored, so every
// later tab, the runner and the backend follow one zone instead of re-bucketing on every sweep. The zone it stores is the
// one the workspace was already metered in (snapshot.zone), else this tab's (the defaults carry the browser's zone): the
// tab stores what its Receipt shows. The tour's and replay's sample never write. The Receipt resolves its view zone as
// the stored settings' zone ?? snapshot.zone ?? the browser's.

import { describe, expect, it } from 'vitest';
import { defaultSettings, mergeSettings } from '../../core/settings.ts';
import type { Meta, PricesDoc, Settings, Snapshot } from '../../core/types.ts';
import { hydrate } from '../../src/state/hydrate.ts';
import type { AppDocs, SweepEngine } from '../../src/state/ports.ts';
import { createAppServices } from '../../src/state/services.ts';
import { createAppStore, type SweepSummary } from '../../src/state/store.ts';
import { receiptZone } from '../../src/views/Receipt/model.ts';

const LA_DEFAULTS: Settings = defaultSettings('2026-09-28T01:00:00.000Z', 'America/Los_Angeles');
const merge = (stored: Settings) => mergeSettings(stored, LA_DEFAULTS);

const PRICES: PricesDoc = {
  schemaVersion: 1,
  updatedAt: '2026-09-27T01:00:00.000Z',
  versions: [{ effectiveFrom: '2026-09-27T01:00:00.000Z', byOutputId: { mrd_siem_prod: { milliCentsPerGb: 225_000 } } }],
};

function snapshot(zone?: string): Snapshot {
  return {
    schemaVersion: 1,
    sweepAt: '2026-09-28T00:59:30.000Z',
    collectingSince: '2026-09-26T00:00:00.000Z',
    ...(zone ? { zone } : {}),
    headline: { todayM: 1, mtdM: 1, d30M: 1, annualizedM: 1, annualizedFromDays: 1, whpMtdM: 2, paidMtdM: 1, ratioMtd: 0.5, whpTodayM: 2, paidTodayM: 1, whp30dM: 2, paid30dM: 1 },
    flows: [],
    destinations: [],
    topSavers: [],
    incidents: [],
    trend: [],
    unpricedOutputIds: [],
    openIncidents: 0,
  } as unknown as Snapshot;
}

const META: Meta = { schemaVersion: 1, meteredThrough: '2026-09-28T00:59:00.000Z', collectingSince: '2026-09-26T00:00:00.000Z' } as unknown as Meta;

interface Kv {
  settings: Settings | null;
  prices: PricesDoc | null;
  snapshot: Snapshot | null;
}

function setup(kv: Kv) {
  const events: string[] = [];
  const docs: AppDocs = {
    readSettings: async () => kv.settings,
    readPrices: async () => kv.prices,
    readSnapshot: async () => kv.snapshot,
    readMeta: async () => META,
    readDemoState: async () => null,
    readInventory: async () => null,
    writeSettings: async (doc) => {
      events.push(`settings:${doc.displayTimezone}`);
      kv.settings = doc;
    },
    writePrices: async (doc) => {
      events.push('prices');
      kv.prices = doc;
    },
  };
  const engine: SweepEngine = {
    runLocal: async (mode: 'ui' | 'manual'): Promise<SweepSummary> => {
      events.push(`sweep:${kv.settings ? kv.settings.displayTimezone : 'no-settings'}`);
      return { ok: true, mode };
    },
    invokeBackend: async () => ({ ok: false, mode: 'manual', error: 'no backend' }),
  } as unknown as SweepEngine;
  return { docs, engine, events };
}

async function servicesFor(kv: Kv) {
  const { docs, engine, events } = setup(kv);
  const store = createAppStore(LA_DEFAULTS);
  await hydrate({ store, docs, mergeSettings: merge });
  const services = createAppServices({ store, docs, mergeSettings: merge, engine });
  return { services, store, events };
}

describe('r2 ui-3: the first live sweep stores the zone once (C1\'\')', () => {
  it('a settings-less workspace metered in New York: an LA tab stores New York before its first sweep, and only once', async () => {
    const kv: Kv = { settings: null, prices: PRICES, snapshot: snapshot('America/New_York') };
    const { services, store, events } = await servicesFor(kv);
    expect(store.getState().settingsStored).toBe(false);
    const first = await services.actions.sweepNow();
    expect(first.status).toBe('done');
    // Stored before the sweep ran, so the sweep reads the stored zone (never a re-bucket into the tab's zone).
    expect(events).toEqual(['settings:America/New_York', 'sweep:America/New_York']);
    expect(kv.settings?.displayTimezone).toBe('America/New_York');
    expect(store.getState().settingsStored).toBe(true);
    expect(store.getState().settings.displayTimezone).toBe('America/New_York');
    // Everything else is the defaults of the day (the new install default included).
    expect(kv.settings?.headlinePeriodDefault).toBe(LA_DEFAULTS.headlinePeriodDefault);
    expect(kv.settings?.notifications).toEqual([]);
  });

  it('a settings-less workspace with no zone on its snapshot (a 1.1.0 upgrade, UTC-bucketed): the tab stores its own zone', async () => {
    const kv: Kv = { settings: null, prices: PRICES, snapshot: snapshot() };
    const { services, events } = await servicesFor(kv);
    await services.actions.sweepNow();
    expect(events).toEqual(['settings:America/Los_Angeles', 'sweep:America/Los_Angeles']);
    expect(kv.settings?.displayTimezone).toBe('America/Los_Angeles');
  });

  it('a UTC snapshot zone (what 1.1.0 and a settings-less runner bucket in by default) is not adopted: the tab stores its own', async () => {
    for (const zone of ['UTC', 'Etc/UTC']) {
      const kv: Kv = { settings: null, prices: PRICES, snapshot: snapshot(zone) };
      const { services, events } = await servicesFor(kv);
      await services.actions.sweepNow();
      expect(events).toEqual(['settings:America/Los_Angeles', 'sweep:America/Los_Angeles']);
    }
  });

  it('a stored settings document is never rewritten by a sweep', async () => {
    const stored: Settings = { ...LA_DEFAULTS, displayTimezone: 'Asia/Kolkata', criblCostCentsPerMonth: 5 };
    const kv: Kv = { settings: stored, prices: PRICES, snapshot: snapshot('America/New_York') };
    const { services, events } = await servicesFor(kv);
    await services.actions.sweepNow();
    expect(events).toEqual(['sweep:Asia/Kolkata']);
    expect(kv.settings).toBe(stored);
  });

  it('a document another tab stored since this one hydrated is adopted, never overwritten', async () => {
    const kv: Kv = { settings: null, prices: PRICES, snapshot: snapshot('America/New_York') };
    const { services, store, events } = await servicesFor(kv);
    kv.settings = { ...LA_DEFAULTS, displayTimezone: 'America/Chicago' };
    await services.actions.sweepNow();
    expect(events).toEqual(['sweep:America/Chicago']);
    expect(store.getState().settings.displayTimezone).toBe('America/Chicago');
    expect(store.getState().settingsStored).toBe(true);
  });

  it('the tour\'s sample never writes (and never sweeps)', async () => {
    const kv: Kv = { settings: null, prices: PRICES, snapshot: snapshot('America/New_York') };
    const { services, events } = await servicesFor(kv);
    services.actions.enterSample({ source: 'sample', snapshot: snapshot('America/Chicago'), settings: { ...LA_DEFAULTS, displayTimezone: 'America/Chicago' } });
    const r = await services.actions.sweepNow();
    expect(r).toEqual({ status: 'blocked', reason: 'not-live' });
    expect(events).toEqual([]);
    expect(kv.settings).toBeNull();
  });

  it('a failed settings write still lets the sweep run, and the next sweep tries again', async () => {
    const kv: Kv = { settings: null, prices: PRICES, snapshot: snapshot('America/New_York') };
    const { docs, engine, events } = setup(kv);
    let fail = true;
    const flaky: AppDocs = {
      ...docs,
      writeSettings: async (doc) => {
        if (fail) throw Object.assign(new Error('KV PUT failed: HTTP 503'), { status: 503 });
        await docs.writeSettings(doc);
      },
    };
    const store = createAppStore(LA_DEFAULTS);
    await hydrate({ store, docs: flaky, mergeSettings: merge });
    let t = Date.parse('2026-09-28T01:00:00.000Z');
    const services = createAppServices({ store, docs: flaky, mergeSettings: merge, engine, now: () => t });
    await services.actions.sweepNow();
    expect(events).toEqual(['sweep:no-settings']);
    expect(store.getState().settingsStored).toBe(false);
    fail = false;
    t += 60_000; // past the manual throttle
    await services.actions.sweepNow();
    expect(events).toEqual(['sweep:no-settings', 'settings:America/New_York', 'sweep:America/New_York']);
  });
});

describe('r2 ui-3: the Receipt\'s view zone', () => {
  it('stored settings\' zone, else the snapshot\'s, else the browser\'s', () => {
    expect(receiptZone({ settingsStored: true, displayTimezone: 'Asia/Kolkata' }, 'America/New_York', 'America/Los_Angeles')).toBe('Asia/Kolkata');
    // Not stored: the in-memory defaults carry the browser's zone; the workspace's own zone wins.
    expect(receiptZone({ settingsStored: false, displayTimezone: 'America/Los_Angeles' }, 'America/New_York', 'America/Los_Angeles')).toBe('America/New_York');
    expect(receiptZone({ settingsStored: false, displayTimezone: 'America/Los_Angeles' }, undefined, 'America/Los_Angeles')).toBe('America/Los_Angeles');
    // An invalid stored or snapshot zone falls through.
    expect(receiptZone({ settingsStored: true, displayTimezone: 'Bad/Zone' }, 'America/New_York', 'America/Los_Angeles')).toBe('America/New_York');
    expect(receiptZone({ settingsStored: false, displayTimezone: 'America/Los_Angeles' }, 'Not/AZone', 'America/Chicago')).toBe('America/Chicago');
  });
});
