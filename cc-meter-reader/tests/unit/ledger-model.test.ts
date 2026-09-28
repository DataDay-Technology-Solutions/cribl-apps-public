// Ledger row model (src/components/LedgerTable/model.ts), layout and URL params (src/views/Ledger/params.ts).

import { describe, expect, it } from 'vitest';
import type { FlowFigures, Incident } from '../../core/types.ts';
import {
  DEFAULT_SORT,
  buildRows,
  destinationOptions,
  filterRows,
  formatSort,
  groupOptions,
  hasActiveFilters,
  matchesSearch,
  nextSort,
  objectLabel,
  parseSort,
  pipelineHref,
  primaryObjectKey,
  routeAddsInfo,
  rowsForObject,
  sortRows,
  spansGroups,
  statusCounts,
  totals,
  unlistedWindow,
  withWindow,
  isQuiet,
} from '../../src/components/LedgerTable/model.ts';
import { estimateLabelPx, layoutForWidth, LAYOUT_MIN_WIDTH, planColumns, sparkSplitIndex } from '../../src/components/LedgerTable/layout.ts';
import { ratioDayDelta } from '../../src/views/Ledger/strip.ts';
import { statusText, statusTitle } from '../../src/components/LedgerTable/status.ts';
import { patchLedgerParams, readLedgerParams } from '../../src/views/Ledger/params.ts';

const SWEEP = Date.parse('2026-09-26T12:00:00.000Z');

function flow(inputId: string, pipelineId: string, outputId: string, over: Partial<FlowFigures> = {}): FlowFigures {
  const groupId = over.groupId ?? 'default';
  const routeId = over.routeId ?? inputId;
  return {
    key: `${groupId}|${inputId}|${routeId}|${pipelineId}|${outputId}`,
    groupId,
    inputId,
    routeId,
    pipelineId,
    outputId,
    inB: 1000,
    outB: 500,
    whpM: 100,
    paidM: 50,
    savedM: 50,
    ratio: 0.5,
    ratePerHourM: 3000,
    savedPerDayM: 5_000_000,
    whpPerDayM: 10_000_000,
    paidPerDayM: 5_000_000,
    inBPerDay: 100e9,
    outBPerDay: 50e9,
    attribution: 'route',
    sparkline: [0.5, 0.5, 0.5],
    state: 'ok',
    ...over,
  };
}

function incident(over: Partial<Incident>): Incident {
  return {
    id: 'inc_1',
    type: 'regression',
    severity: 'high',
    objectKey: 'route:default:mrd_payments_api',
    label: 'Payments API sampling',
    openedAt: '2026-09-26T11:50:00.000Z',
    before: 0.75,
    after: 0.5,
    impactPerDayM: 2_500_000,
    notes: [],
    deliveries: [],
    ...over,
  };
}

const FLOWS: FlowFigures[] = [
  flow('mrd_windows_dc', 'mrd_win_xml_pack', 'mrd_siem_prod', {
    savedPerDayM: 12_000_000,
    whpPerDayM: 36_000_000,
    paidPerDayM: 24_000_000,
    inBPerDay: 150e9,
    outBPerDay: 100e9,
  }),
  flow('mrd_payments_api', 'mrd_pay_sample', 'mrd_siem_prod', {
    state: 'regression',
    savedPerDayM: 6_000_000,
    inBPerDay: 40e9,
    outBPerDay: 13e9,
  }),
  flow('mrd_vpc_flow', 'mrd_passthrough', 'mrd_archive_s3', {
    state: 'unpriced',
    savedPerDayM: 0,
    whpPerDayM: 0,
    paidPerDayM: 0,
  }),
  flow('http', 'main', 'devnull', {
    routeId: 'default',
    state: 'learning',
    savedPerDayM: 0,
    whpPerDayM: 0,
    paidPerDayM: 0,
    inBPerDay: 0,
    outBPerDay: 0,
    sparkline: [],
  }),
  flow('mrd_k8s_prod', 'mrd_k8s_noise', 'mrd_analytics', {
    groupId: 'edge',
    state: 'learning',
    savedPerDayM: 3_000_000,
  }),
];

describe('buildRows', () => {
  const rows = buildRows({ flows: FLOWS, incidents: [incident({})] }, { now: SWEEP });

  it('humanizes every segment of the path and keeps the raw ids', () => {
    const dc = rows[0];
    expect(dc.source).toBe('Windows DC security events');
    expect(dc.pipeline).toBe('Windows XML pack');
    expect(dc.destination).toBe('SIEM (prod)');
    expect(dc.sourceId).toBe('mrd_windows_dc');
    expect(dc.objectKeys).toEqual([
      'in:default:mrd_windows_dc',
      'route:default:mrd_windows_dc',
      'pipe:default:mrd_win_xml_pack',
      'out:default:mrd_siem_prod',
    ]);
  });

  it('an open incident on the route sets the status and severity', () => {
    const pay = rows[1];
    expect(pay.status).toBe('regression');
    expect(pay.severity).toBe('high');
    expect(pay.incident?.id).toBe('inc_1');
  });

  it('a closed incident does not colour the row; the flow state still does', () => {
    const closed = buildRows({
      flows: [FLOWS[1]],
      incidents: [incident({ closedAt: '2026-09-26T11:59:00.000Z' })],
    })[0];
    expect(closed.status).toBe('regression');
    expect(closed.incident).toBeUndefined();
    expect(closed.severity).toBe('high');
  });

  it('spike incidents on the input are medium by default and read from the incident when present', () => {
    const r = buildRows({
      flows: [FLOWS[0]],
      incidents: [
        incident({
          type: 'spike',
          severity: 'medium',
          objectKey: 'in:default:mrd_windows_dc',
        }),
      ],
    })[0];
    expect(r.status).toBe('spike');
    expect(r.severity).toBe('medium');
  });

  it('budget incidents on the destination mark every flow into it', () => {
    const rs = buildRows({
      flows: FLOWS.slice(0, 2),
      incidents: [
        incident({
          type: 'budget',
          severity: 'medium',
          objectKey: 'out:default:mrd_siem_prod',
        }),
      ],
    });
    expect(rs.map((r) => r.status)).toEqual(['budget', 'budget']);
  });

  it('a flow with no traffic is idle, not learning; unpriced flows are not priced', () => {
    expect(rows[3].status).toBe('idle');
    expect(rows[3].reduction).toBeNull();
    expect(rows[2].status).toBe('unpriced');
    expect(rows[2].priced).toBe(false);
    expect(rows[4].status).toBe('learning');
  });

  it('mutes win over everything and count down in whole minutes', () => {
    const r = buildRows(
      {
        flows: [
          flow('mrd_payments_api', 'mrd_pay_sample', 'mrd_siem_prod', {
            muted: true,
            mutedUntil: '2026-09-26T12:05:30.000Z',
            state: 'regression',
          }),
        ],
        incidents: [incident({})],
      },
      { now: SWEEP },
    )[0];
    expect(r.status).toBe('muted');
    expect(r.mutedMinutes).toBe(6);
    // P1-K05: the chip reads whole in sentence case; the sentence is its title.
    expect(statusText(r)).toBe('Muted · 6 min');
    expect(statusTitle(r)).toBe('Muted after a demo change · 6 min left');
  });

  it('reduction is the byte reduction over the last hour', () => {
    expect(rows[1].reduction).toBeCloseTo(1 - 13 / 40, 6);
  });

  it("names a route by its own Cribl name, after an override, and humanizes the id only without one", () => {
    const vpc = flow('in_vpc', 'vpc_flow_agg', 'google_secops', { routeId: 'r_vpc', routeName: 'VPC Flow' });
    expect(buildRows({ flows: [vpc], incidents: [] })[0].route).toBe('VPC Flow');
    expect(buildRows({ flows: [vpc], incidents: [] }, { humanize: { r_vpc: 'Flow logs' } })[0].route).toBe('Flow logs');
    expect(buildRows({ flows: [{ ...vpc, routeName: undefined }], incidents: [] })[0].route).toBe('R VPC');
    expect(buildRows({ flows: [vpc], incidents: [] })[0].haystack).toContain('vpc flow');
  });

  it('settings.humanize overrides labels', () => {
    const r = buildRows({ flows: [FLOWS[0]], incidents: [] }, { humanize: { mrd_siem_prod: 'Splunk (prod)' } })[0];
    expect(r.destination).toBe('Splunk (prod)');
  });

  it('null snapshot → no rows', () => {
    expect(buildRows(null)).toEqual([]);
  });
});

describe('search and filters', () => {
  const rows = buildRows({ flows: FLOWS, incidents: [] });
  it('every term must match, against labels and raw ids, case-insensitively', () => {
    expect(matchesSearch(rows[1], 'PAYMENTS sampling')).toBe(true);
    expect(matchesSearch(rows[1], 'mrd_pay_sample')).toBe(true);
    expect(matchesSearch(rows[1], 'payments kubernetes')).toBe(false);
    expect(matchesSearch(rows[1], '   ')).toBe(true);
  });
  it('filters by status, destination and group', () => {
    expect(filterRows(rows, { state: 'unpriced' }).map((r) => r.sourceId)).toEqual(['mrd_vpc_flow']);
    expect(filterRows(rows, { destination: 'mrd_siem_prod' })).toHaveLength(2);
    expect(filterRows(rows, { group: 'edge' }).map((r) => r.sourceId)).toEqual(['mrd_k8s_prod']);
    expect(filterRows(rows, { q: 'windows', destination: 'mrd_archive_s3' })).toHaveLength(0);
  });
  it('knows when a filter is active', () => {
    expect(hasActiveFilters({})).toBe(false);
    expect(hasActiveFilters({ q: '  ' })).toBe(false);
    expect(hasActiveFilters({ group: 'edge' })).toBe(true);
  });
  it('builds options with counts', () => {
    expect(destinationOptions(rows).map((o) => [o.id, o.count])).toEqual([
      ['mrd_analytics', 1],
      ['mrd_archive_s3', 1],
      ['devnull', 1],
      ['mrd_siem_prod', 2],
    ]);
    expect(groupOptions(rows).map((o) => [o.id, o.count])).toEqual([
      ['default', 4],
      ['edge', 1],
    ]);
    const counts = statusCounts(rows);
    expect(counts.regression).toBe(1);
    expect(counts.idle).toBe(1);
    expect(counts.ok).toBe(1);
  });
});

describe('sort', () => {
  const rows = buildRows({ flows: FLOWS, incidents: [] });
  it('default: saved / day, biggest first; unpriced rows sink', () => {
    const ids = sortRows(rows, DEFAULT_SORT).map((r) => r.sourceId);
    expect(ids.slice(0, 3)).toEqual(['mrd_windows_dc', 'mrd_payments_api', 'mrd_k8s_prod']);
    expect(ids.at(-1)).toBe('mrd_vpc_flow');
  });
  it('text columns sort A→Z and flip on a second click', () => {
    const asc = nextSort(DEFAULT_SORT, 'source');
    expect(asc).toEqual({ key: 'source', dir: 'asc' });
    expect(sortRows(rows, asc).map((r) => r.source)[0]).toBe('AWS VPC Flow Logs');
    expect(nextSort(asc, 'source')).toEqual({ key: 'source', dir: 'desc' });
    expect(nextSort(asc, 'paid')).toEqual({ key: 'paid', dir: 'desc' });
  });
  it('status sorts the most urgent first', () => {
    expect(sortRows(rows, { key: 'status', dir: 'desc' })[0].status).toBe('regression');
  });
  it('is stable: ties fall back to saved, then the key', () => {
    const tie = buildRows({
      flows: [flow('a', 'p', 'o', { savedPerDayM: 1 }), flow('b', 'p', 'o', { savedPerDayM: 1 })],
      incidents: [],
    });
    expect(sortRows(tie, { key: 'destination', dir: 'asc' }).map((r) => r.sourceId)).toEqual(['a', 'b']);
    expect(sortRows([...tie].reverse(), { key: 'destination', dir: 'asc' }).map((r) => r.sourceId)).toEqual(['a', 'b']);
  });
  it('parses and formats ?sort=', () => {
    expect(parseSort('-paid')).toEqual({ key: 'paid', dir: 'desc' });
    expect(parseSort('source')).toEqual({ key: 'source', dir: 'asc' });
    expect(parseSort('bogus')).toEqual(DEFAULT_SORT);
    expect(parseSort(null)).toEqual(DEFAULT_SORT);
    expect(formatSort(DEFAULT_SORT)).toBeNull();
    expect(formatSort({ key: 'paid', dir: 'desc' })).toBe('-paid');
  });
});

describe('deep links and totals', () => {
  const rows = buildRows({ flows: FLOWS, incidents: [] });
  it('matches any of a row’s object keys, or its flow key', () => {
    expect(rowsForObject(rows, 'pipe:default:mrd_pay_sample').map((r) => r.sourceId)).toEqual(['mrd_payments_api']);
    expect(rowsForObject(rows, 'out:default:mrd_siem_prod')).toHaveLength(2);
    expect(rowsForObject(rows, FLOWS[0].key)).toHaveLength(1);
    expect(rowsForObject(rows, 'route:default:nope')).toEqual([]);
    expect(rowsForObject(rows, undefined)).toEqual([]);
  });
  it('a row selects its route', () => {
    expect(primaryObjectKey(rows[1])).toBe('route:default:mrd_payments_api');
  });
  it('labels an object key', () => {
    expect(objectLabel('route:default:mrd_payments_api')).toBe('Payments API');
    expect(objectLabel('not-a-key')).toBe('not-a-key');
    // P1-K05: a flow key reads as its pipeline (else route, else source), never as the raw pipe-separated key.
    expect(objectLabel('default|mrd_payments_api|mrd_payments_api|mrd_pay_sample|mrd_siem_prod')).toBe('Payments API sampling');
    expect(objectLabel('default|in_splunk_hec|default|main|devnull')).toBe('Main (default)');
    expect(objectLabel('default|in_splunk_hec|default|-|devnull')).toBe('Default route');
    expect(objectLabel('default|mrd_x|mrd_x|mrd_pay_sample|out', { mrd_pay_sample: 'Sampled payments' })).toBe('Sampled payments');
  });
  it('totals add volume for every row and money for priced rows only', () => {
    const t = totals(rows);
    expect(t.flows).toBe(5);
    expect(t.savedPerDayM).toBe(12_000_000 + 6_000_000 + 0 + 0 + 3_000_000);
    expect(t.inBPerDay).toBe(150e9 + 40e9 + 100e9 + 0 + 100e9);
    expect(t.reduction).toBeCloseTo(1 - (100e9 + 13e9 + 50e9 + 0 + 50e9) / 390e9, 6);
    expect(totals([]).reduction).toBeNull();
  });
  it('links a pipeline to its Cribl page', () => {
    expect(pipelineHref('default', 'mrd_pay_sample')).toBe('/stream/m/default/pipelines/mrd_pay_sample');
    expect(pipelineHref('edge west', 'a/b')).toBe('/stream/m/edge%20west/pipelines/a%2Fb');
    expect(pipelineHref('default', '-')).toBeUndefined();
  });
});

describe('layout', () => {
  it('picks the layout from the table width', () => {
    expect(layoutForWidth(1392)).toBe('wide');
    expect(layoutForWidth(LAYOUT_MIN_WIDTH.wide - 1)).toBe('medium');
    expect(layoutForWidth(LAYOUT_MIN_WIDTH.medium)).toBe('medium');
    expect(layoutForWidth(358)).toBe('narrow');
  });

  // P1-K01: the columns follow the rows and the room.
  const FIGURES = ['in', 'out', 'reduction', 'whp', 'paid', 'saved', 'trend', 'status'];
  /** The template's minimum width: its tracks' floors, the gaps and the padding (no scrollbar headroom). */
  const floorOf = (template: string) => {
    const floors = [...template.matchAll(/minmax\((\d+)px, [^)]+\)|(\d+)px/g)].map((m) => Number(m[1] ?? m[2]));
    return floors.reduce((s, n) => s + n, 0) + 8 * (floors.length - 1) + 32;
  };

  it('folds Route into Source where every route repeats its source, and keeps it where one does not', () => {
    const same = planColumns(1278, { route: false, groups: false });
    expect(same.layout).toBe('wide');
    expect(same.columns).toEqual(['source', 'pipeline', 'destination', ...FIGURES]);
    const differs = planColumns(1278, { route: true, groups: false });
    expect(differs.columns).toEqual(['source', 'route', 'pipeline', 'destination', ...FIGURES]);
    // With Route, the pipeline keeps 160 px and Route 128 px.
    expect(differs.template.startsWith('minmax(128px, 1fr) minmax(128px, 1fr) minmax(160px, 1.4fr) minmax(72px, 0.6fr)')).toBe(true);
    // Without Route the wide table starts narrower (the names need fewer columns).
    expect(same.minWidth).toBeLessThan(differs.minWidth);
    expect(planColumns(same.minWidth - 1, { route: false, groups: false }).layout).toBe('medium');
    expect(planColumns(same.minWidth, { route: false, groups: false }).layout).toBe('wide');
  });

  it('adds Worker group only across groups, and only where every name keeps 200 px beside it', () => {
    expect(planColumns(1438, { route: false, groups: false }).columns).not.toContain('group');
    const wide = planColumns(1438, { route: false, groups: true });
    expect(wide.columns).toEqual(['source', 'pipeline', 'destination', 'group', ...FIGURES]);
    expect(wide.template.startsWith('minmax(200px, 1.6fr) minmax(200px, 1.6fr)')).toBe(true);
    // The 1280 px page has no room for it; the names keep theirs.
    expect(planColumns(1278, { route: false, groups: true }).columns).not.toContain('group');
    // Route and group together need more than the 1440 px page.
    expect(planColumns(1438, { route: true, groups: true }).columns).not.toContain('group');
  });

  it('medium caps Status at 160 px and brings Would have paid back from about 960 px', () => {
    const at976 = planColumns(976, { route: true, groups: false });
    expect(at976.layout).toBe('medium');
    expect(at976.columns).toEqual(['flow', 'reduction', 'whp', 'paid', 'saved', 'trend', 'status']);
    expect(at976.template.endsWith('minmax(128px, 160px)')).toBe(true);
    const at852 = planColumns(852, { route: true, groups: false });
    expect(at852.columns).toEqual(['flow', 'reduction', 'paid', 'saved', 'trend', 'status']);
    expect(at852.template.endsWith('minmax(128px, 160px)')).toBe(true);
    // The first width with Would have paid: about 960 px (the flow column keeps 280 px for a whole path).
    let from = 760;
    while (!planColumns(from, { route: true, groups: false }).columns.includes('whp')) from += 1;
    expect(from).toBeGreaterThanOrEqual(940);
    expect(from).toBeLessThanOrEqual(960);
  });

  it("every plan's floors fit the width it is chosen at (no sideways scroll)", () => {
    for (const route of [true, false])
      for (const groups of [true, false])
        for (let w = 360; w <= 1600; w += 7) {
          const p = planColumns(w, { route, groups });
          if (p.layout === 'narrow') continue;
          expect(floorOf(p.template) + 16, `${w} ${route} ${groups}: ${p.template}`).toBeLessThanOrEqual(w);
          expect(p.minWidth).toBeLessThanOrEqual(w);
        }
  });

  it('shares the name columns by their typical label, never under a floor', () => {
    const labels = {
      source: [100, 110, 120, 130, 140, 150, 160, 170, 180, 190].map((n) => n),
      pipeline: Array.from({ length: 10 }, () => 300),
      destination: Array.from({ length: 10 }, () => 40),
    };
    const p = planColumns(1278, { route: false, groups: false, labels });
    // p90: source 190, pipeline 300, destination 40 → its floor (88).
    expect(p.template.startsWith('minmax(160px, 1.9fr) minmax(176px, 3fr) minmax(88px, 0.88fr)')).toBe(true);
    // A column without labels keeps the default shares.
    expect(planColumns(1278, { route: false, groups: false, labels: { source: [100] } }).template.startsWith('minmax(160px, 1.6fr)')).toBe(true);
    expect(estimateLabelPx('Windows workstation events')).toBe(Math.ceil(26 * 7.6));
  });
});

describe('columns', () => {
  const rowsOf = (flows: FlowFigures[]) => buildRows({ flows, incidents: [] }, { now: SWEEP });
  it('Route adds information only where a route is named unlike its source', () => {
    // Each source has a route of its own name (the demo rig): nothing to add.
    expect(routeAddsInfo(rowsOf([flow('mrd_payments_api', 'mrd_pay_sample', 'mrd_siem_prod')]))).toBe(false);
    // The default route carries every built-in source: "Default route" is news.
    expect(routeAddsInfo(rowsOf([flow('in_syslog', 'main', 'devnull', { routeId: 'default' })]))).toBe(true);
    expect(routeAddsInfo([])).toBe(false);
  });
  it('Worker group adds information only across two or more groups', () => {
    expect(spansGroups(rowsOf([flow('a', 'p', 'o'), flow('b', 'p', 'o')]))).toBe(false);
    expect(spansGroups(rowsOf([flow('a', 'p', 'o'), flow('b', 'p', 'o', { groupId: 'edge' })]))).toBe(true);
    expect(spansGroups([])).toBe(false);
  });
  it('sorts by worker group, A to Z first', () => {
    const rows = rowsOf([flow('a', 'p', 'o', { groupId: 'zeta' }), flow('b', 'p', 'o', { groupId: 'alpha' })]);
    expect(parseSort('group')).toEqual({ key: 'group', dir: 'asc' });
    expect(nextSort(DEFAULT_SORT, 'group')).toEqual({ key: 'group', dir: 'asc' });
    expect(sortRows(rows, { key: 'group', dir: 'asc' }).map((r) => r.groupId)).toEqual(['alpha', 'zeta']);
  });
});

describe('URL params', () => {
  it('reads every Ledger param, ignoring junk', () => {
    const p = readLedgerParams(
      new URLSearchParams('q=pay&state=regression&dest=mrd_siem_prod&group=default&sort=-paid&timeline=7d&object=route:default:x'),
    );
    expect(p).toEqual({
      q: 'pay',
      state: 'regression',
      dest: 'mrd_siem_prod',
      group: 'default',
      sort: { key: 'paid', dir: 'desc' },
      range: '7d',
      object: 'route:default:x',
    });
    const junk = readLedgerParams(new URLSearchParams('state=nope&timeline=1y&dest=&sort=zzz'));
    expect(junk.state).toBeUndefined();
    expect(junk.range).toBe('24h');
    expect(junk.dest).toBeUndefined();
    expect(junk.sort).toEqual(DEFAULT_SORT);
  });
  it('patches keep URLs short: defaults and blanks remove keys; other params survive', () => {
    const next = patchLedgerParams(new URLSearchParams('present=1&q=x&timeline=7d'), {
      q: '  ',
      range: '24h',
      sort: DEFAULT_SORT,
      state: 'spike',
      object: 'in:default:a',
    });
    expect(next.get('present')).toBe('1');
    expect(next.has('q')).toBe(false);
    expect(next.has('timeline')).toBe(false);
    expect(next.has('sort')).toBe(false);
    expect(next.get('state')).toBe('spike');
    expect(next.get('object')).toBe('in:default:a');
    expect(patchLedgerParams(next, { state: null, object: null }).toString()).toBe('present=1');
  });
});

// P2-W14: the Receipt's custom range on the Ledger — every row carries its window's money.
describe('window money (P2-W14)', () => {
  const a = flow('a', 'pa', 'siem');
  const b = flow('b', 'pb', 'siem', { savedPerDayM: 9_000_000 });
  const quiet = flow('q', 'pq', 'devnull', { inBPerDay: 0, outBPerDay: 0, whpPerDayM: 0, paidPerDayM: 0, savedPerDayM: 0 });
  const byFlow = {
    [a.key]: { whpM: 700, paidM: 400, savedM: 300 },
    [b.key]: { whpM: 100, paidM: 90, savedM: 10 },
    [quiet.key]: { whpM: 50, paidM: 20, savedM: 30 },
    'default|gone|gone|pg|siem': { whpM: 5, paidM: 1, savedM: 4 },
  };
  const rows = withWindow(buildRows({ flows: [a, b, quiet], incidents: [] }, { now: SWEEP }), byFlow);

  it('sorts and totals by the window, not the day rate', () => {
    expect(sortRows(rows, { key: 'saved', dir: 'desc' }).map((r) => r.sourceId)).toEqual(['a', 'q', 'b']);
    expect(totals(rows).window).toEqual({ whpM: 850, paidM: 510, savedM: 340 });
    // Per-day figures are untouched (the strip without a range still reads them).
    expect(totals(rows).savedPerDayM).toBe(5_000_000 + 9_000_000);
  });

  it('a flow quiet in the last hour but with money in the window is listed', () => {
    expect(isQuiet(rows.find((r) => r.sourceId === 'q')!)).toBe(false);
    expect(isQuiet(buildRows({ flows: [quiet], incidents: [] })[0])).toBe(true);
  });

  it('flows the window metered that the sweep no longer lists reconcile the totals with the Receipt', () => {
    const u = unlistedWindow(rows, byFlow);
    expect(u).toEqual({ flows: 1, money: { whpM: 5, paidM: 1, savedM: 4 } });
    const receipt = Object.values(byFlow).reduce((s, m) => s + m.savedM, 0);
    expect((totals(rows).window?.savedM ?? 0) + u.money.savedM).toBe(receipt);
    // A row the window never metered sums to zero, not to its day rate.
    expect(withWindow(buildRows({ flows: [a], incidents: [] }), {})[0].window).toEqual({ whpM: 0, paidM: 0, savedM: 0 });
  });
});

// P2-W17: the trend splits at the newest commit; the strip's 24 h delta comes from the ratio series.
describe('trend split and the strip delta (P2-W17)', () => {
  it('splits a 30-minute line at the first point after the commit, only when the commit is inside it', () => {
    const end = SWEEP;
    expect(sparkSplitIndex(30, end, end - 10 * 60_000)).toBe(20);
    expect(sparkSplitIndex(30, end, end - 45 * 60_000)).toBeUndefined();
    expect(sparkSplitIndex(30, end, end + 1)).toBeUndefined();
    expect(sparkSplitIndex(0, end, end - 60_000)).toBeUndefined();
    expect(sparkSplitIndex(30, end, undefined)).toBeUndefined();
  });
  it('the 24 h delta: the newest bucket against the one a day before it, within 15 minutes, else none', () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    const day = 86_400_000;
    const series = [
      { t: iso(SWEEP - day - 5 * 60_000), ratio: 0.3 },
      { t: iso(SWEEP - 3_600_000), ratio: 0.32 },
      { t: iso(SWEEP), ratio: 0.34 },
    ];
    expect(ratioDayDelta(series)).toBeCloseTo(0.04, 6);
    expect(ratioDayDelta(series.slice(1))).toBeUndefined();
    expect(ratioDayDelta([])).toBeUndefined();
  });
});
