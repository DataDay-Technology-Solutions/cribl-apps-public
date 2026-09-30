import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { FlowFigures, Snapshot } from '../../core/types.ts';
import {
  DOCUMENTED,
  PACK_TREATMENTS,
  applyProjection,
  byteRatio,
  clampDropPct,
  currentProjection,
  estimateTreatment,
  sourceKind,
  treatmentApplies,
  unclaimedSavings,
  nextTreatment,
  streamsRunning,
  findSimilarStream,
  isCustomTreatment,
  isPackTreatment,
  measureActual,
  pipelineMatchesTreatment,
  currentRateBasis,
  previewHeadline,
  stackRatios,
  streamKeyOf,
  suggestTreatment,
  type Estimate,
  type EstimateOk,
  type WhatIfFlow,
} from '../../core/whatif.ts';
import { leverTarget } from '../../src/components/WhatIf/leverTarget.ts';
import { projectBar } from '../../src/components/WhatIf/figures.ts';

const GB = 1_000_000_000;
/** $2.50 / GB in millicents per byte. */
const SIEM_MC_PER_BYTE = 250_000 / GB;

function fig(p: Partial<FlowFigures> & Pick<FlowFigures, 'inputId' | 'pipelineId'>): FlowFigures {
  const groupId = p.groupId ?? 'default';
  const routeId = p.routeId ?? p.inputId;
  const outputId = p.outputId ?? 'mrd_siem_prod';
  const inBPerDay = p.inBPerDay ?? 100 * GB;
  const outBPerDay = p.outBPerDay ?? inBPerDay;
  const whp = p.whpPerDayM ?? Math.round(inBPerDay * SIEM_MC_PER_BYTE);
  const paid = p.paidPerDayM ?? Math.round(outBPerDay * SIEM_MC_PER_BYTE);
  return {
    key: `${groupId}|${p.inputId}|${routeId}|${p.pipelineId}|${outputId}`,
    groupId,
    inputId: p.inputId,
    routeId,
    pipelineId: p.pipelineId,
    outputId,
    inB: p.inB ?? inBPerDay / 1440,
    outB: p.outB ?? outBPerDay / 1440,
    whpM: 0,
    paidM: 0,
    savedM: 0,
    ratio: whp > 0 ? (whp - paid) / whp : 0,
    ratePerHourM: p.ratePerHourM ?? Math.round(paid / 24),
    savedPerDayM: p.savedPerDayM ?? whp - paid,
    whpPerDayM: whp,
    paidPerDayM: paid,
    inBPerDay,
    outBPerDay,
    attribution: 'route',
    sparkline: [],
    state: 'ok',
  };
}

/** The demo rig at its SPEC 14.2 steady state. */
const RIG_FLOWS: FlowFigures[] = [
  fig({ inputId: 'mrd_windows_dc', pipelineId: 'mrd_win_xml_pack', inBPerDay: 150 * GB, outBPerDay: 100.5 * GB }),
  fig({ inputId: 'mrd_windows_workstations', pipelineId: 'mrd_passthrough', inBPerDay: 80 * GB }),
  fig({ inputId: 'mrd_pan_firewall', pipelineId: 'mrd_passthrough', inBPerDay: 60 * GB }),
  fig({ inputId: 'mrd_vpc_flow', pipelineId: 'mrd_passthrough', inBPerDay: 60 * GB, outputId: 'mrd_archive_s3', whpPerDayM: 180_000, paidPerDayM: 180_000 }),
  fig({ inputId: 'mrd_payments_api', pipelineId: 'mrd_pay_sample', inBPerDay: 40 * GB, outBPerDay: 10 * GB }),
  fig({ inputId: 'mrd_k8s_prod', pipelineId: 'mrd_k8s_noise', inBPerDay: 60 * GB, outBPerDay: 18 * GB, outputId: 'mrd_analytics' }),
];
const snap = (flows: FlowFigures[], windowStart = '2026-09-28T15:00:00.000Z', windowEnd = '2026-09-28T15:01:00.000Z') =>
  ({ flows, windowStart, windowEnd }) as Pick<Snapshot, 'flows' | 'windowStart' | 'windowEnd'>;

const WS = RIG_FLOWS[1];
const WS_STREAM = streamKeyOf(WS);
const ok = (e: Estimate): EstimateOk => {
  if (!e.ok) throw new Error(`expected an estimate, got ${e.reason}`);
  return e;
};

describe('treatments', () => {
  it('recognizes pack and custom treatments', () => {
    for (const t of PACK_TREATMENTS) expect(isPackTreatment(t)).toBe(true);
    expect(isPackTreatment('pack-cisco')).toBe(false);
    expect(isPackTreatment({ dropPct: 5 })).toBe(false);
    expect(isCustomTreatment({ dropPct: 5 })).toBe(true);
    expect(isCustomTreatment('pack-windows')).toBe(false);
    expect(isCustomTreatment(null)).toBe(false);
  });

  it('clamps a custom drop to a whole percent in [0, 100]', () => {
    expect(clampDropPct(-3)).toBe(0);
    expect(clampDropPct(12.6)).toBe(13);
    expect(clampDropPct(140)).toBe(100);
    expect(clampDropPct(Number.NaN)).toBe(0);
  });

  it('carries the SPEC 14.1 documented ranges, Palo Alto stacked, VPC Flow without a number', () => {
    expect(DOCUMENTED['pack-windows']).toMatchObject({ min: 0.3, max: 0.35 });
    expect(DOCUMENTED['aggressive-windows']).toMatchObject({ min: 0.34, max: 0.7 });
    // syslog 20–30 % then Palo Alto 15–30 % on what is left: 1 − 0.8·0.85 … 1 − 0.7·0.7
    expect(DOCUMENTED['pack-panos']).toMatchObject({ min: 0.32, max: 0.51 });
    expect(DOCUMENTED['pack-panos']?.source).toMatch(/stacked/);
    expect(DOCUMENTED['pack-vpc']).toBeNull();
    expect(stackRatios(0, 0)).toBe(0);
    expect(stackRatios(1, 0.4)).toBe(1);
  });

  it('matches pipelines to treatments by pattern (rig ids and Pack references)', () => {
    expect(pipelineMatchesTreatment('mrd_win_xml_pack', 'pack-windows')).toBe(true);
    expect(pipelineMatchesTreatment('pack:cribl-splunk-forwarder-windows-xml-events-to-json', 'pack-windows')).toBe(true);
    expect(pipelineMatchesTreatment('mrd_win_docs_reduce', 'pack-windows')).toBe(false);
    expect(pipelineMatchesTreatment('mrd_win_docs_reduce', 'aggressive-windows')).toBe(true);
    expect(pipelineMatchesTreatment('windows_reduction', 'aggressive-windows')).toBe(true);
    expect(pipelineMatchesTreatment('mrd_win_xml_pack', 'aggressive-windows')).toBe(false);
    expect(pipelineMatchesTreatment('mrd_pan_pack', 'pack-panos')).toBe(true);
    expect(pipelineMatchesTreatment('pack:cribl-palo-alto-networks', 'pack-panos')).toBe(true);
    expect(pipelineMatchesTreatment('panos_cleanup', 'pack-panos')).toBe(true);
    expect(pipelineMatchesTreatment('mrd_passthrough', 'pack-panos')).toBe(false);
    expect(pipelineMatchesTreatment('mrd_vpc_pack', 'pack-vpc')).toBe(true);
    expect(pipelineMatchesTreatment('pack:cribl-vpc-flow-for-security-teams', 'pack-vpc')).toBe(true);
    expect(pipelineMatchesTreatment('vpc_raw', 'pack-vpc')).toBe(false);
    for (const t of PACK_TREATMENTS) {
      expect(pipelineMatchesTreatment('-', t)).toBe(false);
      expect(pipelineMatchesTreatment('', t)).toBe(false);
    }
  });

  it('suggests a treatment from the source id', () => {
    expect(suggestTreatment('mrd_windows_workstations')).toBe('pack-windows');
    expect(suggestTreatment('wineventlog_dc')).toBe('pack-windows');
    expect(suggestTreatment('mrd_pan_firewall')).toBe('pack-panos');
    expect(suggestTreatment('palo_alto_east')).toBe('pack-panos');
    expect(suggestTreatment('mrd_vpc_flow')).toBe('pack-vpc');
    expect(suggestTreatment('mrd_payments_api')).toBeUndefined();
    expect(suggestTreatment(undefined as unknown as string)).toBeUndefined();
  });
});

describe('streams', () => {
  it('keys a stream without its pipeline, so applying a pack keeps the key', () => {
    expect(WS_STREAM).toBe('default|mrd_windows_workstations|mrd_windows_workstations|mrd_siem_prod');
    expect(streamKeyOf({ ...WS, pipelineId: 'mrd_win_xml_pack' } as FlowFigures)).toBe(WS_STREAM);
    expect(streamKeyOf({ groupId: 'g', inputId: '', routeId: 'r', outputId: 'o' })).toBe('g|-|r|o');
  });

  it('computes the byte ratio (0 without traffic)', () => {
    expect(byteRatio({ inBPerDay: 100, outBPerDay: 67 })).toBeCloseTo(0.33, 10);
    expect(byteRatio({ inBPerDay: 0, outBPerDay: 5 })).toBe(0);
    expect(byteRatio({ inBPerDay: 100, outBPerDay: -5 })).toBe(1);
  });

  it('finds the Windows DC stream as evidence for the Windows pack on the workstations', () => {
    const s = findSimilarStream(snap(RIG_FLOWS), 'pack-windows', { excludeStreamKey: WS_STREAM, groupId: 'default' });
    expect(s).not.toBeNull();
    expect(s!.inputId).toBe('mrd_windows_dc');
    expect(s!.pipelineId).toBe('mrd_win_xml_pack');
    expect(s!.ratio).toBe(0.33);
    expect(s!.fromObject).toBe('route:default:mrd_windows_dc');
    expect(s).not.toHaveProperty('routeName');
    // The route's Cribl name travels with it, so the basis line names it as the Ledger does (not "R Windows servers").
    const named = RIG_FLOWS.map((f) => (f.inputId === 'mrd_windows_dc' ? { ...f, routeName: 'Windows DC security' } : f));
    expect(findSimilarStream(snap(named), 'pack-windows', { excludeStreamKey: WS_STREAM, groupId: 'default' })!.routeName).toBe('Windows DC security');
  });

  it('never uses the projected stream as its own evidence, and prefers the same group then the most bytes', () => {
    const dc = RIG_FLOWS[0];
    expect(findSimilarStream(snap([dc]), 'pack-windows', { excludeStreamKey: streamKeyOf(dc) })).toBeNull();
    const other = fig({ groupId: 'emea', inputId: 'win_emea', pipelineId: 'win_xml', inBPerDay: 900 * GB, outBPerDay: 600 * GB });
    const small = fig({ inputId: 'win_small', pipelineId: 'pack:cribl-splunk-forwarder-windows-xml-events-to-json', inBPerDay: 1 * GB, outBPerDay: 0.7 * GB });
    expect(findSimilarStream(snap([other, small, dc]), 'pack-windows', { groupId: 'default' })!.inputId).toBe('mrd_windows_dc');
    expect(findSimilarStream(snap([other, small, dc]), 'pack-windows')!.inputId).toBe('win_emea');
    // ties on bytes resolve by key, so the answer never depends on input order
    const a = fig({ inputId: 'a_win', pipelineId: 'win_xml', inBPerDay: 5 * GB, outBPerDay: 3 * GB });
    const b = fig({ inputId: 'b_win', pipelineId: 'win_xml', inBPerDay: 5 * GB, outBPerDay: 4 * GB });
    expect(findSimilarStream(snap([b, a]), 'pack-windows')!.inputId).toBe('a_win');
    expect(findSimilarStream(snap([a, b]), 'pack-windows')!.inputId).toBe('a_win');
  });

  it('names the source when the similar stream has no route; nothing for custom or empty inputs', () => {
    const noRoute = fig({ inputId: 'win_qc', routeId: '-', pipelineId: 'win_xml', inBPerDay: 5 * GB, outBPerDay: 3 * GB });
    expect(findSimilarStream(snap([noRoute]), 'pack-windows')!.fromObject).toBe('in:default:win_qc');
    expect(findSimilarStream(snap(RIG_FLOWS), { dropPct: 10 })).toBeNull();
    expect(findSimilarStream(null, 'pack-windows')).toBeNull();
    expect(findSimilarStream(snap(RIG_FLOWS), 'pack-vpc')).toBeNull(); // nothing runs the VPC pack yet
    const idle = fig({ inputId: 'win_idle', pipelineId: 'win_xml', inBPerDay: 0, outBPerDay: 0 });
    expect(findSimilarStream(snap([idle]), 'pack-windows')).toBeNull();
  });
});

describe('estimateTreatment', () => {
  it('projects the Windows pack on the workstations from the similar stream (SPEC 14.4: ≈ $66 / day)', () => {
    const similar = findSimilarStream(snap(RIG_FLOWS), 'pack-windows', { excludeStreamKey: WS_STREAM })!;
    const e = ok(estimateTreatment({ flow: WS, treatment: 'pack-windows', measuredSimilar: similar }));
    expect(e.basis).toBe('similar');
    expect(e.ratio).toBe(0.33);
    expect(e.range).toBe(false);
    expect(e.detail.fromObject).toBe('route:default:mrd_windows_dc');
    // 80 GB/day at $2.50 = $200 would-have-paid; out 53.6 GB → paid $134; saved $66 (was $0)
    expect(e.current.savedPerDayM).toBe(0);
    expect(e.mid.whpPerDayM).toBe(20_000_000);
    expect(e.mid.outBPerDay).toBe(Math.round(80 * GB * 0.67));
    expect(e.mid.paidPerDayM).toBe(13_400_000);
    expect(e.mid.savedPerDayM).toBe(6_600_000);
    expect(e.mid.deltaSavedPerDayM).toBe(6_600_000);
    expect(e.mid.deltaSavedPerYearM).toBe(6_600_000 * 365);
    expect(e.mid.savedPerYearM).toBe(6_600_000 * 365);
    expect(e.mid.ratio).toBe(0.33);
    expect(e.low).toEqual(e.mid);
    expect(e.high).toEqual(e.mid);
  });

  it('prefers a dry run over a similar stream and a documented range', () => {
    const e = ok(
      estimateTreatment({
        flow: WS,
        treatment: 'pack-windows',
        dryRun: { inBytes: 1_000_000, outBytes: 640_000, events: 400 },
        measuredSimilar: { ratio: 0.33, fromObject: 'route:default:mrd_windows_dc' },
      }),
    );
    expect(e.basis).toBe('dry-run');
    expect(e.ratio).toBe(0.36);
    expect(e.detail.dryRun).toEqual({ inBytes: 1_000_000, outBytes: 640_000, events: 400 });
    expect(e.mid.outBPerDay).toBe(Math.round(80 * GB * 0.64));
  });

  it('ignores an unusable dry run (no input bytes) and falls back', () => {
    const e = ok(estimateTreatment({ flow: WS, treatment: 'pack-windows', dryRun: { inBytes: 0, outBytes: 0 } }));
    expect(e.basis).toBe('documented');
    const e2 = ok(estimateTreatment({ flow: WS, treatment: 'pack-windows', dryRun: { inBytes: 10, outBytes: Number.NaN }, measuredSimilar: { ratio: Number.NaN, fromObject: 'x' } }));
    expect(e2.basis).toBe('documented');
  });

  it('carries a documented range as low / mid / high', () => {
    const e = ok(estimateTreatment({ flow: WS, treatment: 'pack-windows' }));
    expect(e.basis).toBe('documented');
    expect(e.range).toBe(true);
    expect(e.ratio).toEqual({ min: 0.3, max: 0.35 });
    expect(e.detail.source).toMatch(/README/);
    expect(e.low.savedPerDayM).toBe(6_000_000); // 30 % of $200
    expect(e.high.savedPerDayM).toBe(7_000_000); // 35 %
    expect(e.mid.savedPerDayM).toBe(6_500_000);
    expect(e.low.savedPerDayM).toBeLessThanOrEqual(e.mid.savedPerDayM);
    expect(e.mid.savedPerDayM).toBeLessThanOrEqual(e.high.savedPerDayM);
  });

  it('accepts a documented override; a point range is not a range; an invalid one is no basis', () => {
    const VPC = RIG_FLOWS[3]; // the VPC pack on a VPC stream (P1-F13)
    const point = ok(estimateTreatment({ flow: VPC, treatment: 'pack-vpc', documented: { min: 0.5, max: 0.5 } }));
    expect(point.range).toBe(false);
    expect(point.ratio).toBe(0.5);
    expect(point.detail).toEqual({});
    const named = ok(estimateTreatment({ flow: WS, treatment: 'pack-windows', documented: { min: 0.2, max: 0.4, source: 'custom README' } }));
    expect(named.detail.source).toBe('custom README');
    const inherits = ok(estimateTreatment({ flow: WS, treatment: 'pack-windows', documented: { min: 0.2, max: 0.4 } }));
    expect(inherits.detail.source).toBe(DOCUMENTED['pack-windows']!.source);
    expect(estimateTreatment({ flow: VPC, treatment: 'pack-vpc', documented: { min: 0.6, max: 0.2 } })).toEqual({ ok: false, treatment: 'pack-vpc', reason: 'no-basis' });
    expect(estimateTreatment({ flow: VPC, treatment: 'pack-vpc', documented: { min: -0.1, max: 0.2 } }).ok).toBe(false);
  });

  it('refuses to guess: VPC Flow with no similar stream and no dry run has no basis', () => {
    const vpc = RIG_FLOWS[3];
    expect(estimateTreatment({ flow: vpc, treatment: 'pack-vpc' })).toEqual({ ok: false, treatment: 'pack-vpc', reason: 'no-basis' });
  });

  it('reports no traffic instead of a projection for an idle stream', () => {
    const idle: WhatIfFlow = { inBPerDay: 0, outBPerDay: 0, whpPerDayM: 0, paidPerDayM: 0, savedPerDayM: 0 };
    expect(estimateTreatment({ flow: idle, treatment: { dropPct: 20 } })).toEqual({ ok: false, treatment: { dropPct: 20 }, reason: 'no-traffic' });
  });

  it('applies a custom drop on top of what the stream sends today', () => {
    const pay = RIG_FLOWS[4]; // 40 GB in, 10 GB out ($25 paid of $100)
    const e = ok(estimateTreatment({ flow: pay, treatment: { dropPct: 20 } }));
    expect(e.basis).toBe('custom');
    expect(e.detail.dropPct).toBe(20);
    expect(e.mid.outBPerDay).toBe(8 * GB);
    expect(e.mid.paidPerDayM).toBe(2_000_000);
    expect(e.mid.savedPerDayM).toBe(8_000_000);
    expect(e.mid.deltaSavedPerDayM).toBe(500_000);
    expect(e.ratio).toBe(0.8);
    const none = ok(estimateTreatment({ flow: pay, treatment: { dropPct: 0 } }));
    expect(none.mid.deltaSavedPerDayM).toBe(0);
    const all = ok(estimateTreatment({ flow: pay, treatment: { dropPct: 250 } }));
    expect(all.detail.dropPct).toBe(100);
    expect(all.mid.paidPerDayM).toBe(0);
  });

  it('shows a negative delta when a pack saves less than the stream already does', () => {
    // a Windows stream already trimmed to 75 % by a hand-made pipeline (P1-F13: the pack must fit the source)
    const pay = fig({ inputId: 'win_legacy_servers', pipelineId: 'win_hand_trim', inBPerDay: 40 * GB, outBPerDay: 10 * GB });
    const e = ok(estimateTreatment({ flow: pay, treatment: 'pack-windows', measuredSimilar: { ratio: 0.33, fromObject: 'route:default:mrd_windows_dc' } }));
    expect(e.mid.savedPerDayM).toBe(3_300_000);
    expect(e.mid.deltaSavedPerDayM).toBe(3_300_000 - 7_500_000);
    expect(e.mid.deltaSavedPerYearM).toBeLessThan(0);
  });

  it('prices a stream that sends nothing today at would-have-paid per in-byte', () => {
    const dropped: WhatIfFlow = { inBPerDay: 10 * GB, outBPerDay: 0, whpPerDayM: 2_500_000, paidPerDayM: 0, savedPerDayM: 2_500_000 };
    const e = ok(estimateTreatment({ flow: dropped, treatment: 'pack-windows', measuredSimilar: { ratio: 0.5, fromObject: 'x' } }));
    expect(e.mid.paidPerDayM).toBe(1_250_000);
    const zero: WhatIfFlow = { inBPerDay: 10 * GB, outBPerDay: 0, whpPerDayM: 0, paidPerDayM: 0, savedPerDayM: 0 };
    expect(ok(estimateTreatment({ flow: zero, treatment: { dropPct: 10 } })).mid.paidPerDayM).toBe(0);
  });

  it('clamps borrowed ratios into [0, 1]', () => {
    const hi = ok(estimateTreatment({ flow: WS, treatment: 'pack-windows', measuredSimilar: { ratio: 1.4, fromObject: 'x' } }));
    expect(hi.ratio).toBe(1);
    expect(hi.mid.paidPerDayM).toBe(0);
    const lo = ok(estimateTreatment({ flow: WS, treatment: 'pack-windows', measuredSimilar: { ratio: -0.2, fromObject: 'x' } }));
    expect(lo.ratio).toBe(0);
  });

  it('keeps money conserved: whp = paid + saved on every projection (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1e13, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (inB, keep, mcPerGb, r) => {
          const outB = inB * keep;
          const whp = Math.round((inB / GB) * mcPerGb);
          const paid = Math.round((outB / GB) * mcPerGb);
          const flow: WhatIfFlow = { inBPerDay: inB, outBPerDay: outB, whpPerDayM: whp, paidPerDayM: paid, savedPerDayM: whp - paid };
          for (const e of [
            estimateTreatment({ flow, treatment: 'pack-windows', measuredSimilar: { ratio: r, fromObject: 'x' } }),
            estimateTreatment({ flow, treatment: { dropPct: r * 100 } }),
            estimateTreatment({ flow, treatment: 'pack-panos' }),
          ]) {
            const k = ok(e);
            for (const p of [k.low, k.mid, k.high, k.current]) {
              expect(p.whpPerDayM).toBe(p.paidPerDayM + p.savedPerDayM);
              expect(p.outBPerDay).toBeGreaterThanOrEqual(0);
              expect(p.savedPerYearM).toBe(p.savedPerDayM * 365);
            }
            expect(k.low.savedPerDayM).toBeLessThanOrEqual(k.high.savedPerDayM);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('applyProjection', () => {
  const similar = findSimilarStream(snap(RIG_FLOWS), 'pack-windows', { excludeStreamKey: WS_STREAM })!;
  const est = estimateTreatment({ flow: WS, treatment: 'pack-windows', measuredSimilar: similar });

  it('replaces only the chosen stream, re-routed to the similar stream pipeline', () => {
    const out = applyProjection(RIG_FLOWS, WS_STREAM, est, similar.pipelineId);
    expect(out).toHaveLength(RIG_FLOWS.length);
    const ws = out.find((f) => f.inputId === 'mrd_windows_workstations')!;
    expect(ws.projected).toBe(true);
    expect(ws.pipelineId).toBe('mrd_win_xml_pack');
    expect(ws.key).toBe('default|mrd_windows_workstations|mrd_windows_workstations|mrd_win_xml_pack|mrd_siem_prod');
    expect(ws.outBPerDay).toBe(Math.round(80 * GB * 0.67));
    expect(ws.savedPerDayM).toBe(6_600_000);
    expect(ws.ratio).toBeCloseTo(0.33, 6);
    expect(ws.ratePerHourM).toBe(Math.round(WS.ratePerHourM * (13_400_000 / WS.paidPerDayM)));
    for (const f of out.filter((x) => x.inputId !== 'mrd_windows_workstations')) {
      expect(f.projected).toBeUndefined();
      expect(f).toEqual(RIG_FLOWS.find((r) => r.key === f.key));
    }
    // the input array is untouched
    expect(RIG_FLOWS[1].pipelineId).toBe('mrd_passthrough');
  });

  it('keeps the pipeline without a target, and copies unchanged when there is no estimate', () => {
    const kept = applyProjection(RIG_FLOWS, WS_STREAM, est).find((f) => f.projected)!;
    expect(kept.pipelineId).toBe('mrd_passthrough');
    const none = applyProjection(RIG_FLOWS, WS_STREAM, { ok: false, treatment: 'pack-vpc', reason: 'no-basis' });
    expect(none).toEqual(RIG_FLOWS);
    expect(none[0]).not.toBe(RIG_FLOWS[0]);
    const free = estimateTreatment({ flow: { inBPerDay: 5, outBPerDay: 5, whpPerDayM: 0, paidPerDayM: 0, savedPerDayM: 0 }, treatment: { dropPct: 50 } });
    const zero = applyProjection([fig({ inputId: 'z', pipelineId: 'p', inBPerDay: 5, whpPerDayM: 0, paidPerDayM: 0 })], 'default|z|z|mrd_siem_prod', free);
    expect(zero[0].ratio).toBe(0);
    expect(zero[0].ratePerHourM).toBe(0);
  });
});

describe('previewHeadline', () => {
  const est = estimateTreatment({ flow: WS, treatment: 'pack-windows', measuredSimilar: { ratio: 0.33, fromObject: 'x' } });

  it('adds the stream delta to the annualized run rate', () => {
    const p = previewHeadline({ annualizedM: 9_561_000_000 }, est)!;
    expect(p.beforeM).toBe(9_561_000_000);
    expect(p.deltaM).toBe(6_600_000 * 365);
    expect(p.afterM).toBe(9_561_000_000 + 6_600_000 * 365);
    expect(p.hasBasis).toBe(true);
  });

  it('flags a headline without a run rate, and returns nothing without an estimate', () => {
    expect(previewHeadline(null, est)!.hasBasis).toBe(false);
    expect(previewHeadline({ annualizedM: Number.NaN }, est)!.beforeM).toBe(0);
    expect(previewHeadline({ annualizedM: 1 }, { ok: false, treatment: 'pack-vpc', reason: 'no-basis' })).toBeNull();
  });
});

// Founder-build r2 ui-7 (FINDINGS_EXTRA IC-2): the hero and its bar on one rate basis. The strip ("Before and after") is
// the stream at current rates; the hero used to add that current-rate delta to the Receipt's trailing annualized run
// rate, which for a stream whose traffic covers only part of the trailing window is diluted: walkE (a Datagen 10 h old,
// 600 of the 1,440 metered minutes) read "$2,525 annualized … 74% saved" beside a strip that said 50% → 60%, $4,075 →
// $4,894 a year. The hero now rests on the workspace at current rates (currentRateBasis) whenever it has flows.
describe('r2 ui-7: the What if hero and its bar on the strip\'s basis (IC-2)', () => {
  // One stream, $2.25/GB SIEM, 50 % dropped today: the walkE world (5.94 GB/day in, 2.97 out → $4,878 a year saved).
  const PRICE = 225_000 / GB;
  const inB = 5.94 * GB;
  const stream = fig({ inputId: 'mrc_datagen', pipelineId: 'mrc_trim', inBPerDay: inB, outBPerDay: inB / 2, whpPerDayM: Math.round(inB * PRICE), paidPerDayM: Math.round((inB / 2) * PRICE) });
  const drop20 = estimateTreatment({ flow: stream, treatment: { dropPct: 20 } }) as EstimateOk;
  const current = currentRateBasis([stream]);

  it('600 of 1,440 metered minutes, custom drop 20 %: the hero reads the strip\'s after (60 %), not the diluted run rate', () => {
    expect(drop20.ok).toBe(true);
    expect(drop20.mid.ratio).toBeCloseTo(0.6, 4);
    // The Receipt's trailing run rate over 1,440 minutes, of which the stream carried 600.
    const trailing = { annualizedM: Math.round(currentProjection(stream).savedPerYearM * (600 / 1440)) };
    const p = previewHeadline(trailing, drop20, current)!;
    expect(p.basis).toBe('current');
    expect(p.hasBasis).toBe(true);
    expect(p.beforeM).toBe(currentProjection(stream).savedPerYearM);
    expect(p.afterM).toBe(drop20.mid.savedPerYearM);
    expect(p.deltaM).toBe(drop20.mid.deltaSavedPerYearM);
    const bar = projectBar(p.bar!, p.deltaM);
    expect(bar.savedM).toBe(drop20.mid.savedPerYearM);
    expect(bar.ratio).toBeCloseTo(0.6, 4);
    // Before the fix: the trailing run rate plus the delta, and a bar ratio matching neither 50 % nor 60 %.
    const old = previewHeadline(trailing, drop20)!;
    expect(old.basis).toBe('annualized');
    expect(old.afterM).not.toBe(drop20.mid.savedPerYearM);
  });

  it('a warm workspace (the run rate equals today\'s rates): the figure and the bar are unchanged', () => {
    const warm = { annualizedM: currentProjection(stream).savedPerYearM };
    const was = previewHeadline(warm, drop20)!;
    const now = previewHeadline(warm, drop20, current)!;
    expect(now.afterM).toBe(was.afterM);
    expect(now.beforeM).toBe(was.beforeM);
    expect(now.deltaM).toBe(was.deltaM);
    const wasBar = projectBar({ whpM: perYearOf(stream.whpPerDayM), paidM: perYearOf(stream.paidPerDayM), savedM: warm.annualizedM }, was.deltaM);
    expect(projectBar(now.bar!, now.deltaM)).toEqual(wasBar);
  });

  it('the rig: several streams, the hero moves by exactly the stream\'s delta on today\'s whole-workspace rates', () => {
    const est = estimateTreatment({ flow: WS, treatment: 'pack-windows', measuredSimilar: { ratio: 0.33, fromObject: 'x' } }) as EstimateOk;
    const basis = currentRateBasis(RIG_FLOWS);
    const p = previewHeadline({ annualizedM: 1 }, est, basis)!;
    expect(p.beforeM).toBe(RIG_FLOWS.reduce((a, f) => a + Math.max(0, Math.round(f.savedPerDayM)), 0) * 365);
    expect(p.afterM - p.beforeM).toBe(est.mid.deltaSavedPerYearM);
    expect(p.bar!.whpM).toBe(RIG_FLOWS.reduce((a, f) => a + Math.round(f.whpPerDayM), 0) * 365);
  });

  it('no flows priced at current rates: the Receipt\'s run rate stays the basis (and none at all says so)', () => {
    expect(currentRateBasis([])).toBeUndefined();
    expect(currentRateBasis([fig({ inputId: 'z', pipelineId: 'p', whpPerDayM: 0, paidPerDayM: 0, savedPerDayM: 0 })])).toBeUndefined();
    const p = previewHeadline({ annualizedM: 9_561_000_000 }, drop20, currentRateBasis([]))!;
    expect(p.basis).toBe('annualized');
    expect(p.beforeM).toBe(9_561_000_000);
  });
});

function perYearOf(perDayM: number): number {
  return Math.round(perDayM) * 365;
}

describe('measureActual', () => {
  const applied = Date.parse('2026-09-28T14:57:30.000Z');
  const after = { ...fig({ inputId: 'mrd_windows_workstations', pipelineId: 'mrd_win_xml_pack', inBPerDay: 80 * GB, outBPerDay: 70 * GB }), inB: 1000, outB: 660 };

  it('reads the last completed minute once it started after the apply', () => {
    const m = measureActual(snap([RIG_FLOWS[0], after]), WS_STREAM, applied)!;
    expect(m.ratio).toBe(0.34);
    expect(m.minutes).toBe(3);
    expect(m.pipelineId).toBe('mrd_win_xml_pack');
  });

  it('waits while the minute still predates the apply, or the stream is idle or absent', () => {
    expect(measureActual(snap([after], '2026-09-28T14:57:00.000Z', '2026-09-28T14:58:00.000Z'), WS_STREAM, applied)).toBeNull();
    expect(measureActual(snap([{ ...after, inB: 0 }]), WS_STREAM, applied)).toBeNull();
    expect(measureActual(snap([RIG_FLOWS[0]]), WS_STREAM, applied)).toBeNull();
    expect(measureActual(null, WS_STREAM, applied)).toBeNull();
    expect(measureActual(snap([after]), WS_STREAM, Number.NaN)).toBeNull();
    expect(measureActual(snap([after], 'bad', 'bad'), WS_STREAM, applied)).toBeNull();
  });
});

describe('currentProjection', () => {
  it('mirrors today with a zero delta', () => {
    const c = currentProjection(RIG_FLOWS[4]);
    expect(c.ratio).toBe(0.75);
    expect(c.savedPerDayM).toBe(7_500_000);
    expect(c.deltaSavedPerDayM).toBe(0);
    expect(c.whpPerYearM).toBe(10_000_000 * 365);
    expect(c.paidPerYearM).toBe(2_500_000 * 365);
  });
});

describe('Apply for real: lever target (demo build)', () => {

  it('maps the three raw rig streams to their pack, and Go aggressive to the Docs pipeline', () => {
    expect(leverTarget('mrd_windows_workstations', 'mrd_windows_workstations', 'pack-windows')).toEqual({ routeKey: 'windows_workstations', level: 'pack', pipelineId: 'mrd_win_xml_pack' });
    expect(leverTarget('mrd_windows_workstations', 'mrd_rt_windows_workstations', 'aggressive-windows')).toEqual({ routeKey: 'windows_workstations', level: 'aggressive', pipelineId: 'mrd_win_docs_reduce' });
    expect(leverTarget('mrd_pan_firewall', 'mrd_pan_firewall', 'pack-panos')).toEqual({ routeKey: 'pan_firewall', level: 'pack', pipelineId: 'mrd_pan_pack' });
    expect(leverTarget('mrd_vpc_flow', 'mrd_vpc_flow', 'pack-vpc')).toEqual({ routeKey: 'vpc_flow', level: 'pack', pipelineId: 'mrd_vpc_pack' });
  });

  it('refuses a pack that does not fit, a reduced stream, and anything outside the rig', () => {
    expect(leverTarget('mrd_pan_firewall', 'mrd_pan_firewall', 'pack-windows')).toBeUndefined();
    expect(leverTarget('mrd_pan_firewall', 'mrd_pan_firewall', 'aggressive-windows')).toBeUndefined();
    expect(leverTarget('mrd_windows_dc', 'mrd_windows_dc', 'pack-windows')).toBeUndefined();
    expect(leverTarget('mrd_payments_api', 'mrd_payments_api', 'pack-windows')).toBeUndefined();
    expect(leverTarget('wineventlog', 'win_route', 'pack-windows')).toBeUndefined();
  });
});

describe('applicability (P1-F13)', () => {
  const PAN = RIG_FLOWS[2];
  const VPC = RIG_FLOWS[3];
  const PAY = RIG_FLOWS[4];

  it('reads the source kind from the ids, the rig’s and the tour’s', () => {
    expect(sourceKind(WS)).toBe('windows');
    expect(sourceKind(PAN)).toBe('panos');
    expect(sourceKind(VPC)).toBe('vpc');
    expect(sourceKind(PAY)).toBe('other');
    expect(sourceKind({ inputId: 'win_dc' })).toBe('windows');
    expect(sourceKind({ inputId: 'wineventlog_dc' })).toBe('windows');
    expect(sourceKind({ inputId: 'pan_fw_east' })).toBe('panos');
    expect(sourceKind({ inputId: 'aws_vpc_flow' })).toBe('vpc');
    expect(sourceKind({ inputId: 'linux_syslog' })).toBe('other'); // the Palo Alto half would see nothing
    expect(sourceKind({ inputId: 'cisco_asa' })).toBe('other');
    expect(sourceKind({ inputId: 'in_1', routeId: 'r_windows_servers' })).toBe('windows'); // the route names it
    expect(sourceKind({ inputId: '-', routeId: '-' })).toBe('other');
  });

  it('estimateTreatment(Windows XML pack, a Palo Alto stream) is not applicable, and projects nothing', () => {
    const e = estimateTreatment({ flow: PAN, treatment: 'pack-windows', measuredSimilar: { ratio: 0.33, fromObject: 'route:default:mrd_windows_dc' } });
    expect(e).toEqual({ ok: false, treatment: 'pack-windows', reason: 'not-applicable', applicable: false });
    expect(estimateTreatment({ flow: WS, treatment: 'pack-panos' })).toMatchObject({ ok: false, applicable: false });
    expect(estimateTreatment({ flow: PAY, treatment: 'pack-vpc', documented: { min: 0.5, max: 0.5 } })).toMatchObject({ ok: false, reason: 'not-applicable' });
    expect(estimateTreatment({ flow: WS, treatment: 'aggressive-windows' }).ok).toBe(true);
    expect(estimateTreatment({ flow: PAN, treatment: 'pack-panos' }).ok).toBe(true);
  });

  it('a custom drop fits every stream; a stream without ids is not judged', () => {
    expect(treatmentApplies({ dropPct: 20 }, PAY)).toBe(true);
    expect(treatmentApplies('pack-windows', { inBPerDay: 1 } as never)).toBe(true);
    expect(estimateTreatment({ flow: PAY, treatment: { dropPct: 20 } }).ok).toBe(true);
  });

  it('suggests the pack written for the source, and nothing for the rest', () => {
    expect(suggestTreatment('pan_fw_east')).toBe('pack-panos');
    expect(suggestTreatment('aws_vpc_flow')).toBe('pack-vpc');
    expect(suggestTreatment('xml_feed')).toBeUndefined();
    expect(suggestTreatment('linux_syslog')).toBeUndefined();
  });
});

describe('the biggest unclaimed savings (P2-W23)', () => {
  it('ranks every stream × the pack written for it, on the calculator’s bases, and leaves out what it cannot estimate', () => {
    const lines = unclaimedSavings(RIG_FLOWS, snap(RIG_FLOWS), { groupId: 'default' });
    // workstations (similar stream: the DC at 33 %), Palo Alto (documented 32–51 %); VPC has no basis, payments
    // and Kubernetes have no pack written for them, and the DC already runs its pack
    expect(lines.map((l) => [l.flow.inputId, l.treatment, l.estimate.basis])).toEqual([
      ['mrd_windows_workstations', 'pack-windows', 'similar'],
      ['mrd_pan_firewall', 'pack-panos', 'documented'],
    ]);
    expect(lines[0].deltaPerYearM).toBe(lines[0].estimate.mid.deltaSavedPerYearM);
    expect(lines[0].deltaPerYearM).toBeGreaterThan(lines[1].deltaPerYearM);
    expect(lines[0].streamKey).toBe(WS_STREAM);
  });

  it('a stream that runs its pack drops out; limit trims the list', () => {
    const applied = RIG_FLOWS.map((f) => (f === WS ? fig({ inputId: 'mrd_windows_workstations', pipelineId: 'mrd_win_xml_pack', inBPerDay: 80 * GB, outBPerDay: 53.6 * GB }) : f));
    expect(unclaimedSavings(applied, snap(applied)).map((l) => l.flow.inputId)).toEqual(['mrd_pan_firewall']);
    expect(unclaimedSavings(RIG_FLOWS, snap(RIG_FLOWS), { limit: 1 })).toHaveLength(1);
    expect(nextTreatment({ inputId: 'mrd_windows_dc', routeId: 'mrd_windows_dc', pipelineId: 'mrd_win_xml_pack' })).toBeUndefined();
    expect(nextTreatment({ inputId: 'mrd_payments_api', routeId: 'mrd_payments_api', pipelineId: 'mrd_pay_sample' })).toBeUndefined();
    expect(nextTreatment({ inputId: 'mrd_vpc_flow', routeId: 'mrd_vpc_flow', pipelineId: 'mrd_passthrough' })).toBe('pack-vpc');
  });

  it('counts the streams running a pack in a group', () => {
    expect(streamsRunning(snap(RIG_FLOWS), 'pack-windows', 'default')).toBe(1);
    expect(streamsRunning(snap(RIG_FLOWS), 'pack-panos', 'default')).toBe(0);
    expect(streamsRunning(null, 'pack-windows')).toBe(0);
    expect(streamsRunning(snap(RIG_FLOWS), 'pack-windows', 'other')).toBe(0);
  });
});
