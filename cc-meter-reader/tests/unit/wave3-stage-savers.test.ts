// tests/unit/wave3-stage-savers.test.ts — W3-STAGE-1: saverDrops() names the saver an open regression took money
// off, so the stage can set the drop beside that line's own figure (src/views/Presenter/savers.ts).

import { describe, expect, it } from 'vitest';
import type { Incident, TopSaver } from '../../core/types.ts';
import { saverDrops } from '../../src/views/Presenter/savers.ts';

const MC = 100_000;

function saver(routeId: string, pipelineId: string, perDay: number, groupId = 'datacenter'): TopSaver {
  return { objectKey: `route:${groupId}:${routeId}`, label: pipelineId, savedPerDayM: perDay * MC, ratio: 0.6, groupId, pipelineId };
}

function incident(over: Partial<Incident>): Incident {
  return {
    id: 'inc_1',
    type: 'regression',
    severity: 'high',
    objectKey: 'route:datacenter:r_payments',
    label: 'Payments API sampling',
    openedAt: '2026-09-24T16:30:00.000Z',
    before: 0.75,
    after: 0.5,
    impactPerDayM: 124_999_959,
    notes: [],
    deliveries: [],
    ...over,
  };
}

const SAVERS = [
  saver('r_pan', 'pan_traffic_agg', 4_784),
  saver('r_vpc', 'vpc_flow_agg', 4_107, 'cloud'),
  saver('r_payments', 'pay_api_sample', 3_764),
  saver('r_k8s', 'k8s_noise', 2_888, 'apps'),
  saver('r_edr', 'edr_dedupe', 2_643, 'cloud'),
];

describe('saverDrops (W3-STAGE-1)', () => {
  it('names the saver an open regression is keyed by, with its impact per day', () => {
    const drops = saverDrops(SAVERS, [incident({})]);
    expect([...drops]).toEqual([['route:datacenter:r_payments', 124_999_959]]);
  });

  it('a closed regression leaves every line plain', () => {
    expect(saverDrops(SAVERS, [incident({ closedAt: '2026-09-24T16:44:00.000Z' })]).size).toBe(0);
  });

  it('a spike, a budget warning and good news leave every line plain', () => {
    const others = [
      incident({ id: 'a', type: 'spike', impactPerDayM: 5_000 * MC }),
      incident({ id: 'b', type: 'budget' }),
      incident({ id: 'c', type: 'goodnews' }),
    ];
    expect(saverDrops(SAVERS, others).size).toBe(0);
  });

  it('an open regression with no impact adds nothing', () => {
    expect(saverDrops(SAVERS, [incident({ impactPerDayM: 0 })]).size).toBe(0);
  });

  it('no incidents, null or undefined: an empty map', () => {
    expect(saverDrops(SAVERS, []).size).toBe(0);
    expect(saverDrops(SAVERS, null).size).toBe(0);
    expect(saverDrops(SAVERS, undefined).size).toBe(0);
  });

  it('a pipeline-keyed incident falls back to the saver carrying that pipeline in that group', () => {
    const drops = saverDrops(SAVERS, [incident({ objectKey: 'pipe:datacenter:pay_api_sample', impactPerDayM: 25 * MC })]);
    expect([...drops]).toEqual([['route:datacenter:r_payments', 25 * MC]]);
  });

  it('the pipeline fallback respects the worker group', () => {
    expect(saverDrops(SAVERS, [incident({ objectKey: 'pipe:cloud:pay_api_sample' })]).size).toBe(0);
  });

  it('a route-keyed incident matches a saver keyed by another kind on that route', () => {
    const pipeKeyed: TopSaver[] = [{ ...SAVERS[2], objectKey: 'route:datacenter:r_payments' }];
    expect([...saverDrops(pipeKeyed, [incident({ objectKey: 'route:datacenter:r_payments' })])]).toEqual([['route:datacenter:r_payments', 124_999_959]]);
    // A saver keyed by its pipeline is not on a route the incident names.
    const byPipe: TopSaver[] = [{ ...SAVERS[2], objectKey: 'pipe:datacenter:r_payments' }];
    expect(saverDrops(byPipe, [incident({ objectKey: 'route:datacenter:other' })]).size).toBe(0);
  });

  it('two routes through one pipeline: the drop goes on the first line only, never twice', () => {
    const twoRoutes = [saver('r_pay_east', 'pay_api_sample', 3_000), saver('r_pay_west', 'pay_api_sample', 1_000)];
    const drops = saverDrops(twoRoutes, [incident({ objectKey: 'pipe:datacenter:pay_api_sample' })]);
    expect([...drops]).toEqual([['route:datacenter:r_pay_east', 124_999_959]]);
  });

  it('two incidents on one saver (its route and its pipeline): the larger stands, never their sum', () => {
    const drops = saverDrops(SAVERS, [
      incident({ id: 'route', impactPerDayM: 900 * MC }),
      incident({ id: 'pipe', objectKey: 'pipe:datacenter:pay_api_sample', impactPerDayM: 1_250 * MC }),
    ]);
    expect([...drops]).toEqual([['route:datacenter:r_payments', 1_250 * MC]]);
  });

  it('an incident on an object off the list, or on a source or destination, names no saver', () => {
    const drops = saverDrops(SAVERS, [
      incident({ id: 'x', objectKey: 'route:datacenter:r_unlisted' }),
      incident({ id: 'y', objectKey: 'in:datacenter:pan_fw_east' }),
      incident({ id: 'z', objectKey: 'out:datacenter:splunk_cloud' }),
      incident({ id: 'w', objectKey: 'not a key' }),
    ]);
    expect(drops.size).toBe(0);
  });

  it('open regressions on two savers mark both', () => {
    const drops = saverDrops(SAVERS, [incident({}), incident({ id: 'k8s', objectKey: 'route:apps:r_k8s', impactPerDayM: 300 * MC })]);
    expect(drops.get('route:datacenter:r_payments')).toBe(124_999_959);
    expect(drops.get('route:apps:r_k8s')).toBe(300 * MC);
    expect(drops.size).toBe(2);
  });
});
