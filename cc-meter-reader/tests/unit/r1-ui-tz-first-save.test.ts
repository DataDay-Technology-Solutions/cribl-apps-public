// @vitest-environment jsdom
// r1 ui-1 (FINDINGS_R1 B1, contract C1'): the first prices save of a fresh install also stores the settings document,
// so the member's browser zone is in KV before the first sweep buckets Today, MTD and the trend. Without it the sweep
// falls back to UTC (core/sweep.ts reads the stored settings) while the Receipt labels the figures in the browser zone.

import { describe, expect, it } from 'vitest';
import { defaultSettings, mergeSettings } from '../../core/settings.ts';
import type { PricesDoc, Settings } from '../../core/types.ts';
import { hydrate } from '../../src/state/hydrate.ts';
import type { AppDocs } from '../../src/state/ports.ts';
import { isFirstRunWorkspace } from '../../src/state/selectors.ts';
import { createAppServices } from '../../src/state/services.ts';
import { createAppStore } from '../../src/state/store.ts';
import { browserTimeZone } from '../../src/lib/zone.ts';

const LA_DEFAULTS: Settings = defaultSettings('2026-09-28T01:00:00.000Z', 'America/Los_Angeles');
const merge = (stored: Settings) => mergeSettings(stored, LA_DEFAULTS);

const PRICES: PricesDoc = {
  schemaVersion: 1,
  updatedAt: '2026-09-28T01:00:00.000Z',
  versions: [{ effectiveFrom: '2026-09-28T01:00:00.000Z', byOutputId: { mrd_siem_prod: { milliCentsPerGb: 225_000 } } }],
};

interface Kv {
  settings: Settings | null;
  prices: PricesDoc | null;
}

function fakeDocs(kv: Kv, opts: { failSettingsWrite?: boolean } = {}) {
  const writes: string[] = [];
  const docs: AppDocs = {
    readSettings: async () => kv.settings,
    readPrices: async () => kv.prices,
    readSnapshot: async () => null,
    readMeta: async () => null,
    readDemoState: async () => null,
    readInventory: async () => null,
    writeSettings: async (doc) => {
      if (opts.failSettingsWrite) throw Object.assign(new Error('KV PUT failed: HTTP 503'), { status: 503 });
      writes.push('settings');
      kv.settings = doc;
    },
    writePrices: async (doc) => {
      writes.push('prices');
      kv.prices = doc;
    },
  };
  return { docs, writes };
}

async function servicesFor(kv: Kv, opts: { failSettingsWrite?: boolean } = {}) {
  const fake = fakeDocs(kv, opts);
  const store = createAppStore(LA_DEFAULTS);
  await hydrate({ store, docs: fake.docs, mergeSettings: merge });
  const services = createAppServices({ store, docs: fake.docs, mergeSettings: merge, engine: { runLocal: async () => { throw new Error('no sweep'); }, invokeBackend: async () => { throw new Error('no backend'); } } as never });
  return { ...fake, store, services };
}

describe('r1 ui-1: the first prices save stores the display zone (B1, C1\')', () => {
  it('writes the settings document with the browser zone before the prices, and first-run detection still reads prices + snapshot', async () => {
    const kv: Kv = { settings: null, prices: null };
    const { services, store, writes } = await servicesFor(kv);
    expect(store.getState().settingsStored).toBe(false);
    expect(isFirstRunWorkspace(store.getState().prices, store.getState().snapshot, store.getState().errors)).toBe(true);

    const result = await services.actions.savePrices(PRICES);
    expect(result).toEqual({ ok: true });
    // Settings first: the meter loop may start its first sweep the moment prices exist.
    expect(writes).toEqual(['settings', 'prices']);
    expect(kv.settings?.displayTimezone).toBe('America/Los_Angeles');
    expect(store.getState().settingsStored).toBe(true);
    expect(store.getState().settings.displayTimezone).toBe('America/Los_Angeles');
    // Nothing else of the defaults is changed by the write (the implicit bell stays implicit: no endpoint stored).
    expect(kv.settings?.notifications).toEqual([]);
    expect(kv.settings?.headlinePeriodDefault).toBe(LA_DEFAULTS.headlinePeriodDefault);
  });

  it('writes prices only once a settings document exists (a later save never rewrites the zone)', async () => {
    const stored: Settings = { ...LA_DEFAULTS, displayTimezone: 'America/New_York' };
    const kv: Kv = { settings: stored, prices: null };
    const { services, writes } = await servicesFor(kv);
    expect(await services.actions.savePrices(PRICES)).toEqual({ ok: true });
    expect(writes).toEqual(['prices']);
    expect(kv.settings?.displayTimezone).toBe('America/New_York');
  });

  it('adopts a settings document another tab wrote after this one hydrated, instead of overwriting it', async () => {
    const kv: Kv = { settings: null, prices: null };
    const { services, store, writes } = await servicesFor(kv);
    kv.settings = { ...LA_DEFAULTS, displayTimezone: 'America/Chicago', criblCostCentsPerMonth: 100_000 };
    expect(await services.actions.savePrices(PRICES)).toEqual({ ok: true });
    expect(writes).toEqual(['prices']);
    expect(kv.settings?.displayTimezone).toBe('America/Chicago');
    expect(store.getState().settingsStored).toBe(true);
    expect(store.getState().settings.displayTimezone).toBe('America/Chicago');
    expect(store.getState().settings.criblCostCentsPerMonth).toBe(100_000);
  });

  it('writes nothing when the settings write fails, so the member can retry Start the meter', async () => {
    const kv: Kv = { settings: null, prices: null };
    const { services, store, writes } = await servicesFor(kv, { failSettingsWrite: true });
    const result = await services.actions.savePrices(PRICES);
    expect(result.ok).toBe(false);
    expect(writes).toEqual([]);
    expect(kv.prices).toBeNull();
    expect(store.getState().settingsStored).toBe(false);
  });

  it('browserTimeZone() is exported for the Receipt fallback and the meter loop (a valid IANA name)', () => {
    const tz = browserTimeZone();
    expect(typeof tz).toBe('string');
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz })).not.toThrow();
  });
});
