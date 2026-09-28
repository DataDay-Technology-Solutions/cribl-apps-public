// @vitest-environment jsdom
// P2-W06 — "flip it on, watch it land": good news under the demo profile, the 'landed' takeover mode, the
// forecast the What-if froze, and the green card that prints "Projected N%, measured M% after K min".

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detect, emptyBaselines, type DetectInput, type DetectOutput } from '../../core/detector.ts';
import { defaultSettings, goodNewsActive } from '../../core/settings.ts';
import type { BaselinesDoc, Commit, Incident, InventoryDoc, Settings, Snapshot } from '../../core/types.ts';
import { IncidentTakeover } from '../../src/components/IncidentTakeover/IncidentTakeover.tsx';
import { TAKEOVER_MS, createTracker, enqueue, observeIncidents, type TakeoverEvent } from '../../src/components/IncidentTakeover/tracker.ts';
import { LandedCard } from '../../src/components/WhatIf/LandedCard.tsx';
import {
  clearAppliedForecasts,
  forecastFor,
  landedAllowed,
  minutesToLand,
  recordApplied,
  type AppliedForecast,
} from '../../src/components/WhatIf/landing.ts';
import { StoreProvider } from '../../src/state/providers.tsx';
import { createAppStore, type AppStore } from '../../src/state/store.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-09-26T15:00:05Z');
const iso = (ms: number) => new Date(ms).toISOString();

const settings = (over: Partial<Settings> = {}): Settings => ({ ...defaultSettings('2026-09-26T00:00:00.000Z', 'UTC'), ...over });
const demoProfile = (): Settings => settings({ demo: { enabled: true, replayMode: false, profile: true } });

describe('goodNewsActive (core/settings.ts)', () => {
  it('is the switch outside demo mode, and on under the demo profile', () => {
    expect(goodNewsActive(settings())).toBe(false);
    expect(goodNewsActive(settings({ goodNewsEnabled: true }))).toBe(true);
    expect(goodNewsActive(demoProfile())).toBe(true);
    expect(goodNewsActive(settings({ demo: { enabled: true, replayMode: false, profile: false } }))).toBe(false);
    expect(goodNewsActive(settings({ demo: { enabled: false, replayMode: false, profile: true } }))).toBe(false);
  });
});

// ─── The detector, end to end ────────────────────────────────────────────────

const ROUTE = 'route:default:r_ws';
const PAY = 'route:default:r_pay';
const inventory: InventoryDoc = {
  schemaVersion: 1,
  updatedAt: '',
  hash: 'h',
  byGroup: {
    default: {
      inputs: [],
      outputs: [],
      pipelines: [],
      routes: [
        { id: 'r_ws', filter: "__inputId=='datagen:mrd_windows_workstations'", pipeline: 'mrd_passthrough', output: 'mrd_siem_prod' },
        { id: 'r_pay', filter: "__inputId=='datagen:mrd_payments_api'", pipeline: 'mrd_pay_sample', output: 'mrd_siem_prod' },
      ],
    },
  },
};
const commit = (hash: string, deployedMs: number, message: string, files: string[] = []): Commit => ({
  hash,
  message,
  author: 's.koelpin',
  committedAt: iso(deployedMs - 10_000),
  deployedAt: iso(deployedMs),
  groupId: 'default',
  files,
  source: 'demo',
});
const warm = (entries: Record<string, number>): BaselinesDoc => ({
  ...emptyBaselines('x'),
  byObject: Object.fromEntries(Object.entries(entries).map(([k, mean]) => [k, { mean, variance: 0.0001, samples: 500, warm: [] }])),
});
const base = (over: Partial<DetectInput>): DetectInput => ({
  nowMs: T0,
  settings: settings(),
  baselines: emptyBaselines('x'),
  openIncidents: [],
  ratioSeries: {},
  costSeries: {},
  budgetSeries: {},
  muted: {},
  commits: [],
  inventory,
  evaluateBudget: false,
  ...over,
});

/** Consecutive minutes on two routes, carrying baselines and open incidents like the sweep does. */
function run(start: DetectInput, minutes: { ws?: number; pay?: number; commits?: Commit[]; muted?: Record<string, string> }[]) {
  let baselines = start.baselines;
  let open = [...start.openIncidents];
  const outs: DetectOutput[] = [];
  minutes.forEach((m, i) => {
    const series: DetectInput['ratioSeries'] = {};
    if (m.ws !== undefined) series[ROUTE] = { x: m.ws, whpPerDayM: 10_000_000, label: 'Windows workstations', outputId: 'mrd_siem_prod' };
    if (m.pay !== undefined) series[PAY] = { x: m.pay, whpPerDayM: 10_000_000, label: 'Payments API sampling', outputId: 'mrd_siem_prod' };
    const out = detect({ ...start, nowMs: start.nowMs + i * MIN, baselines, openIncidents: open, ratioSeries: series, ...(m.commits ? { commits: m.commits } : {}), ...(m.muted ? { muted: m.muted } : {}) });
    outs.push(out);
    baselines = out.baselines;
    const closedIds = new Set(out.closed.map((c) => c.id));
    open = [...open.filter((o) => !closedIds.has(o.id)).map((o) => out.updated.find((u) => u.id === o.id) ?? o), ...out.opened.filter((o) => !o.closedAt)];
  });
  return outs;
}

describe('the detector announces a pack under the demo profile (P2-W06)', () => {
  const pack = [commit('7c2d410aa', T0 - MIN, 'demo: apply the pack on r_ws')];

  it('opens a closed good-news incident for the pack under the demo profile, with the switch off', () => {
    const s = demoProfile();
    expect(s.goodNewsEnabled).toBe(false);
    const [first] = run(base({ settings: s, baselines: warm({ [ROUTE]: 0 }), commits: pack }), [{ ws: 0.33 }]);
    expect(first.opened).toHaveLength(1);
    expect(first.opened[0]).toMatchObject({ type: 'goodnews', objectKey: ROUTE, before: 0, after: 0.33, cause: 'commit', commit: { hash: '7c2d410aa' } });
    expect(first.opened[0].closedAt).toBe(first.opened[0].openedAt);
  });

  it('release defaults never open one', () => {
    const outs = run(base({ baselines: warm({ [ROUTE]: 0 }), commits: pack }), [{ ws: 0.33 }, { ws: 0.33 }, { ws: 0.33 }, { ws: 0.33 }]);
    expect(outs.flatMap((o) => o.opened)).toEqual([]);
  });

  it('break → regression → restore → recovery opens no good news on the way back', () => {
    const trim = commit('trim001', T0 + MIN, 'demo: break the trim on mrd_pay_sample', ['groups/default/local/cribl/pipelines/mrd_pay_sample/conf.yml']);
    const restore = commit('rest001', T0 + 5 * MIN, 'demo: restore the trim on mrd_pay_sample', ['groups/default/local/cribl/pipelines/mrd_pay_sample/conf.yml']);
    const until = iso(T0 + 30 * MIN);
    const outs = run(base({ settings: demoProfile(), baselines: warm({ [PAY]: 0.75 }) }), [
      { pay: 0.75 },
      { pay: 0.75, commits: [trim] },
      { pay: 0.5, commits: [trim] },
      { pay: 0.5, commits: [trim] },
      { pay: 0.5, commits: [trim] },
      { pay: 0.5, commits: [trim, restore] },
      { pay: 0.75, commits: [trim, restore], muted: { [PAY]: until } },
      { pay: 0.75, commits: [trim, restore], muted: { [PAY]: until } },
      { pay: 0.75, commits: [trim, restore] },
      { pay: 0.75, commits: [trim, restore] },
      { pay: 0.75, commits: [trim, restore] },
    ]);
    const opened = outs.flatMap((o) => o.opened);
    expect(opened.map((i) => i.type)).toEqual(['regression']);
    expect(outs.flatMap((o) => o.closed).map((i) => i.type)).toEqual(['regression']);
  });
});

// ─── The tracker's 'landed' mode ─────────────────────────────────────────────

const T = Date.parse('2026-09-30T16:42:03.000Z');
const at = (deltaSec: number) => iso(T + deltaSec * 1000);

function good(id: string, over: Partial<Incident> = {}): Incident {
  return {
    id,
    type: 'goodnews',
    severity: 'info',
    objectKey: 'route:default:mrd_windows_workstations',
    label: 'Windows workstations',
    openedAt: at(0),
    closedAt: at(0),
    cause: 'commit',
    commit: { hash: '7c2d410ee', message: 'demo: apply the pack on mrd_windows_workstations', author: 's.koelpin', committedAt: at(-190), deployedAt: at(-180), groupId: 'default', match: 'message' },
    before: 0,
    after: 0.33,
    impactPerDayM: 134_000_000,
    caughtInSec: 180,
    notes: ['demo-profile'],
    deliveries: [],
    ...over,
  };
}
function alert(id: string): Incident {
  return { ...good(id), type: 'regression', severity: 'high', closedAt: undefined, objectKey: `route:default:${id}`, label: 'Payments API sampling', before: 0.75, after: 0.5 };
}

describe('tracker: good news lands (P2-W06)', () => {
  it('is off unless the caller allows it, and never for good news already there when the presenter opened', () => {
    const off = createTracker();
    observeIncidents(off, []);
    expect(observeIncidents(off, [good('g1')])).toEqual([]);

    const on = createTracker();
    observeIncidents(on, [good('old')], { landed: true });
    const events = observeIncidents(on, [good('old'), good('g2')], { landed: true });
    expect(events.map((e) => [e.key, e.mode])).toEqual([['landed:g2', 'landed']]);
    expect(observeIncidents(on, [good('old'), good('g2')], { landed: true })).toEqual([]); // once
  });

  it('stays 15 s, and never pre-empts an alert: a showing card yields, waiting ones queue behind it', () => {
    expect(TAKEOVER_MS.landed).toBe(15_000);
    const l = (id: string): TakeoverEvent => ({ key: `landed:${id}`, mode: 'landed', incident: good(id) });
    const a = (id: string): TakeoverEvent => ({ key: `alert:${id}`, mode: 'alert', incident: alert(id) });
    // a showing good-news card is replaced by the alert
    expect(enqueue([l('g1')], [a('a1')]).map((e) => e.key)).toEqual(['alert:a1']);
    // an alert showing, good news waiting: the next alert goes ahead of the good news
    expect(enqueue([a('a1'), l('g1')], [a('a2')]).map((e) => e.key)).toEqual(['alert:a1', 'alert:a2', 'landed:g1']);
    // good news after an alert waits its turn
    expect(enqueue([a('a1')], [l('g1')]).map((e) => e.key)).toEqual(['alert:a1', 'landed:g1']);
    // the same alert twice is still one
    expect(enqueue([a('a1'), l('g1')], [a('a1')]).map((e) => e.key)).toEqual(['alert:a1', 'landed:g1']);
  });
});

// ─── The forecast registry ───────────────────────────────────────────────────

const WS: AppliedForecast = {
  streamKey: 'default|mrd_windows_workstations|mrd_windows_workstations|mrd_siem_prod',
  groupId: 'default',
  inputId: 'mrd_windows_workstations',
  routeId: 'mrd_windows_workstations',
  outputId: 'mrd_siem_prod',
  treatment: 'pack-windows',
  projected: { min: 0.3, max: 0.35 },
  was: 0,
  appliedAt: T - 180_000,
};

describe('forecastFor (landing.ts)', () => {
  afterEach(() => clearAppliedForecasts());

  it('matches the good news on the applied route, after the apply, with the lever’s own commit', () => {
    expect(forecastFor(good('g'), [WS])).toEqual(WS);
    expect(minutesToLand(WS, good('g'))).toBe(3);
    expect(minutesToLand({ appliedAt: T }, good('g'))).toBe(1); // never "after 0 min"
  });

  it('refuses another route, another group, news from before the apply or hours later, and someone else’s commit', () => {
    expect(forecastFor(good('g', { objectKey: 'route:default:mrd_pan_firewall' }), [WS])).toBeUndefined();
    expect(forecastFor(good('g', { objectKey: 'route:other:mrd_windows_workstations' }), [WS])).toBeUndefined();
    expect(forecastFor(good('g', { openedAt: at(-600) }), [WS])).toBeUndefined();
    expect(forecastFor(good('g', { openedAt: at(2 * 3600) }), [WS])).toBeUndefined();
    const other = good('g');
    other.commit = { ...other.commit!, deployedAt: at(-1800) };
    expect(forecastFor(other, [WS])).toBeUndefined();
    expect(forecastFor(good('g', { objectKey: 'junk' }), [WS])).toBeUndefined();
  });

  it('reads the in-memory record the What-if wrote, newest apply first', () => {
    expect(forecastFor(good('g'))).toBeUndefined();
    recordApplied({ ...WS, appliedAt: T - 600_000, projected: { min: 0.2, max: 0.2 } });
    recordApplied(WS); // the same stream again replaces it
    expect(forecastFor(good('g'))?.projected).toEqual({ min: 0.3, max: 0.35 });
    recordApplied({ ...WS, appliedAt: Number.NaN });
    expect(forecastFor(good('g'))?.appliedAt).toBe(WS.appliedAt);
  });

  it('landedAllowed: the release build takes over only when the switch is on', () => {
    expect(landedAllowed(null)).toBe(false);
    expect(landedAllowed(settings())).toBe(false);
    expect(landedAllowed(demoProfile())).toBe(false); // vitest runs the release build (VITE_MR_BUILD unset)
    expect(landedAllowed(settings({ goodNewsEnabled: true }))).toBe(true);
  });
});

// ─── The card ────────────────────────────────────────────────────────────────

describe('<LandedCard>', () => {
  afterEach(() => cleanup());

  it('prints the forecast the What-if made against what landed, with the money, the commit and the author', () => {
    const { container } = render(<LandedCard incident={good('g')} forecast={WS} placement="inline" tz="UTC" />);
    const card = container.querySelector('[data-testid="landed-takeover"]')!;
    expect(card.getAttribute('role')).toBe('status');
    expect(card.getAttribute('data-mode')).toBe('landed');
    expect(card.className).toContain('mr-takeover--recovered');
    expect(screen.getByRole('heading').textContent).toBe('Savings improved: Windows workstations');
    const ratio = screen.getByTestId('landed-ratio');
    expect(ratio.querySelector('.mr-tk-before')!.textContent).toBe('0%');
    expect(ratio.querySelector('.mr-tk-after--saved')!.textContent).toBe('33%');
    expect(screen.getByTestId('landed-money').textContent).toBe('+$1,340 a day · +$489,100 a year');
    expect(screen.getByTestId('landed-forecast').textContent).toBe('What-ifProjected 30%–35%, measured 33% after 3\u00a0min');
    expect(container.querySelector('[data-callout="commit"]')!.textContent).toBe('7c2d410');
    expect(container.querySelector('[data-callout="author"]')!.textContent).toBe('s.koelpin');
    expect(container.querySelector('[data-callout="per-day"]')).not.toBeNull();
    expect(card.textContent).toContain('Landed 4:42:03 PM');
  });

  it('without a forecast it says how long the change took to land, never a projection it did not make', () => {
    render(<LandedCard incident={good('g')} forecast={null} placement="inline" tz="UTC" />);
    expect(screen.queryByTestId('landed-forecast')).toBeNull();
    expect(screen.getByTestId('landed-in').textContent).toBe('Landed 3:00 after the deploy');
  });
});

// ─── The takeover host ───────────────────────────────────────────────────────

describe('<IncidentTakeover> with good news', () => {
  let store: AppStore;
  const snapshot = (incidents: Incident[]) => ({ incidents }) as unknown as Snapshot;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T + 9_000);
    clearAppliedForecasts();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    clearAppliedForecasts();
  });
  const mount = () =>
    render(
      <StoreProvider store={store}>
        <IncidentTakeover />
      </StoreProvider>,
    );

  it('opens the green card for new good news when the switch is on, with the recorded forecast, for 15 s', () => {
    store = createAppStore({ ...defaultSettings(at(0), 'UTC'), goodNewsEnabled: true });
    recordApplied(WS);
    act(() => store.setState({ snapshot: snapshot([]) }));
    mount();
    act(() => store.setState({ snapshot: snapshot([good('g1')]) }));
    expect(screen.getByTestId('landed-takeover').getAttribute('data-incident-id')).toBe('g1');
    expect(screen.getByTestId('landed-forecast').textContent).toContain('Projected 30%–35%, measured 33% after 3\u00a0min');
    act(() => {
      vi.advanceTimersByTime(14_000);
    });
    expect(screen.queryByTestId('landed-takeover')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    expect(screen.queryByTestId('landed-takeover')).toBeNull();
  });

  it('the release build never opens one while the switch is off, demo profile or not', () => {
    store = createAppStore({ ...defaultSettings(at(0), 'UTC'), demo: { enabled: true, replayMode: false, profile: true } });
    act(() => store.setState({ snapshot: snapshot([]) }));
    mount();
    act(() => store.setState({ snapshot: snapshot([good('g1')]) }));
    expect(screen.queryByTestId('landed-takeover')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('an alert takes the stage from good news at once', () => {
    store = createAppStore({ ...defaultSettings(at(0), 'UTC'), goodNewsEnabled: true });
    act(() => store.setState({ snapshot: snapshot([]) }));
    mount();
    act(() => store.setState({ snapshot: snapshot([good('g1')]) }));
    expect(screen.getByTestId('landed-takeover')).toBeTruthy();
    act(() => store.setState({ snapshot: snapshot([good('g1'), alert('a1')]) }));
    expect(screen.queryByTestId('landed-takeover')).toBeNull();
    expect(screen.getByRole('alert').getAttribute('data-incident-id')).toBe('a1');
  });
});
