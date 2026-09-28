// tests/unit/flow-label-collisions.test.ts — craft review, round 2: on the Flow and What-if maps the pipeline names
// "Passthrough (no reduction)", "Payments API sampling" and "Kubernetes noise filter" sat on other routes' ribbons.
// After placement, a pipeline name left on another route's band moves to a free spot above or below its own bar
// (its own flows run into and out of the bar, under any spot beside it). The name still hugs its bar, nothing
// overlaps, and no label is dropped for the move.

import { describe, expect, it } from 'vitest';
import { GB, boxOnRibbon, computeFlowLayout, type FlowLayout, type LayoutFlow } from '../../src/components/FlowDiagram/layout.ts';
import { layoutText } from '../../src/components/FlowDiagram/text.ts';

function flow(inputId: string, pipelineId: string, outputId: string, inGb: number, outGb: number, mcPerGb = 250_000): LayoutFlow {
  const whp = Math.round(inGb * mcPerGb);
  const paid = Math.round(outGb * mcPerGb);
  return {
    key: `default|${inputId}|${inputId}|${pipelineId}|${outputId}`,
    groupId: 'default',
    inputId,
    routeId: inputId,
    pipelineId,
    outputId,
    inBPerDay: inGb * GB,
    outBPerDay: outGb * GB,
    whpPerDayM: whp,
    paidPerDayM: paid,
    savedPerDayM: whp - paid,
    ratePerHourM: Math.round(paid / 24),
  };
}

// The judge's state: the Windows pack on both Windows sources, the payments sampling broken (an open regression).
const RIG: LayoutFlow[] = [
  flow('mrd_windows_dc', 'mrd_win_xml_pack', 'mrd_siem_prod', 149.8, 100.3),
  flow('mrd_windows_workstations', 'mrd_win_xml_pack', 'mrd_siem_prod', 79.8, 68.2),
  flow('mrd_pan_firewall', 'mrd_passthrough', 'mrd_siem_prod', 60, 60),
  flow('mrd_vpc_flow', 'mrd_passthrough', 'mrd_archive_s3', 60, 60, 3_000),
  flow('mrd_payments_api', 'mrd_pay_sample', 'mrd_siem_prod', 40, 13),
  flow('mrd_k8s_prod', 'mrd_k8s_noise', 'mrd_analytics', 60.1, 18, 150_000),
];
const TEXT = layoutText({
  mrd_passthrough: 'Passthrough (no reduction)',
  mrd_pay_sample: 'Payments API sampling',
  mrd_k8s_noise: 'Kubernetes noise filter',
  mrd_win_xml_pack: 'Windows XML pack',
});
const MARKS = { [RIG[4].key]: { tone: 'high' as const, text: '−$25 / day since 5:01 PM · 2db02e5', short: '−$25 / day · 2db02e5', tiny: '−$25 / day' } };

const onOtherRoute = (L: FlowLayout) =>
  L.labels
    .filter((l) => l.kind === 'node-pipe')
    .filter((l) => L.ribbons.some((r) => r.pipeId !== l.ownerId && boxOnRibbon({ x: l.x, y: l.y, w: l.w, h: l.h }, r)))
    .map((l) => l.full);

const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('pipeline names keep off other routes’ ribbons (craft r2)', () => {
  for (const width of [1150, 1000, 900]) {
    it(`at ${width} px with an open regression`, () => {
      const L = computeFlowLayout(RIG, { width, text: TEXT, sink: true, maxHeight: 420, marks: MARKS });
      expect(onOtherRoute(L)).toEqual([]);
      // the moved names still hug their own bars and nothing overlaps
      for (const l of L.labels.filter((x) => x.kind === 'node-pipe')) {
        const own = L.nodes.find((n) => n.id === l.ownerId)!;
        const gap = Math.max(0, own.y0 - (l.y + l.h), l.y - own.y1);
        expect(gap, l.id).toBeCloseTo(2, 5);
      }
      for (let i = 0; i < L.labels.length; i++) for (let j = i + 1; j < L.labels.length; j++) expect(overlap(L.labels[i], L.labels[j]), `${L.labels[i].id} × ${L.labels[j].id}`).toBe(false);
      // a moved name keeps the incident flag's clearance (the W16 e2e holds it at 6 px or more)
      const flag = L.labels.find((x) => x.kind === 'incident');
      if (flag) {
        for (const l of L.labels.filter((x) => x.kind === 'node-pipe')) {
          const gap = Math.max(flag.x - (l.x + l.w), l.x - (flag.x + flag.w), flag.y - (l.y + l.h), l.y - (flag.y + flag.h));
          expect(gap, `${l.id} vs the flag`).toBeGreaterThanOrEqual(6);
        }
      }
      // no name or plate is dropped for the move: every pipeline the rig names, every saving ribbon's plate
      expect(L.labels.filter((x) => x.kind === 'saved').length).toBe(4);
    });
  }
});
