import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  GB,
  GROUP_BELOW_SHARE,
  FILL_ASPECT,
  MIN_FIT_HEIGHT,
  MIN_NODE_PADDING,
  OTHER_ID,
  PLATE_MIN_RIBBON,
  SINK_ID,
  PLATE_MIN_SHARE,
  autoHeight,
  bandKeep,
  bandSlot,
  bandPath,
  bandPointAt,
  boxOnRibbon,
  centerLinePath,
  computeFlowLayout,
  earnsBytePlate,
  earnsPlate,
  figuresChanged,
  groupSmallFlows,
  interpolateLayout,
  isDrawable,
  keepFraction,
  otherFlowKey,
  paidFraction,
  priceWeight,
  ribbonId,
  ribbonSpanAt,
  tAtX,
  sameGeometry,
  selectFlows,
  splitSharedPipes,
  solidPath,
  sumTotals,
  textWidth,
  truncateToWidth,
  namesSharingStarts,
  wedgePath,
  wedgePointAt,
  wedgeThicknessAt,
  wrapToWidth,
  type FlowLayout,
  type LayoutFlow,
  type LayoutText,
} from '../../src/components/FlowDiagram/layout.ts';
import { undrawnCounts } from '../../src/components/FlowDiagram/selection.ts';
import { LIVE_TWEEN_MS, stageScaleFor, tweenDuration, tweenOf } from '../../src/components/FlowDiagram/hooks.ts';
import { incidentMarks } from '../../src/components/FlowDiagram/marks.ts';
import type { Incident } from '../../core/types.ts';

const TEXT: LayoutText = {
  name: (kind, id) => `${kind === 'in' ? 'Source' : kind === 'pipe' ? 'Pipeline' : 'Destination'} ${id}`,
  caption: (kind, t) => (kind === 'in' ? `${(t.inBPerDay / GB).toFixed(1)} GB/day` : `$${Math.round(t.paidPerDayM / 100_000)} / day`),
  whp: (mc) => `$${Math.round(mc / 100_000).toLocaleString('en-US')} / day`,
  saved: (mc) => `$${Math.round(mc / 100_000).toLocaleString('en-US')} saved`,
  other: (kind, n) => (kind === 'in' ? `${n} smaller flows` : 'Their pipelines'),
};

function flow(inputId: string, pipelineId: string, outputId: string, inGb: number, outGb: number, mcPerGb = 250_000, extra: Partial<LayoutFlow> = {}): LayoutFlow {
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
    ...extra,
  };
}

/** The demo rig as the emulator meters it (numbers from a live mock sweep). */
const RIG: LayoutFlow[] = [
  flow('mrd_windows_dc', 'mrd_win_xml_pack', 'mrd_siem_prod', 149.8, 100.3),
  flow('mrd_windows_workstations', 'mrd_passthrough', 'mrd_siem_prod', 79.8, 79.8),
  flow('mrd_pan_firewall', 'mrd_passthrough', 'mrd_siem_prod', 60, 60),
  flow('mrd_vpc_flow', 'mrd_passthrough', 'mrd_archive_s3', 60, 60, 3_000),
  flow('mrd_payments_api', 'mrd_pay_sample', 'mrd_siem_prod', 40, 10),
  flow('mrd_k8s_prod', 'mrd_k8s_noise', 'mrd_analytics', 60.1, 18, 150_000),
  // zero-dollar and idle flows are never drawn
  flow('in_syslog', 'main', 'devnull', 0, 0, 0),
  flow('in_http', 'main', 'devnull', 3, 3, 0),
];
const COLORS = ['devnull', 'mrd_analytics', 'mrd_archive_s3', 'mrd_siem_prod'];

const layoutOf = (flows: readonly LayoutFlow[], width = 1020, extra: Partial<Parameters<typeof computeFlowLayout>[1]> = {}): FlowLayout =>
  computeFlowLayout(flows, { width, text: TEXT, colorOrder: COLORS, ...extra });

function shuffle<T>(xs: readonly T[], seed: number): T[] {
  const out = [...xs];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('flow selection', () => {
  it('draws only priced flows with traffic, largest would-have-paid first, capped', () => {
    expect(RIG.filter(isDrawable)).toHaveLength(6);
    const { shown, eligible } = selectFlows(RIG, 3);
    expect(eligible).toBe(6);
    expect(shown.map((f) => f.inputId)).toEqual(['mrd_windows_dc', 'mrd_windows_workstations', 'mrd_pan_firewall']);
    expect(selectFlows(RIG, 0).shown).toHaveLength(1);
    expect(isDrawable({ ...RIG[0], outputId: '-' })).toBe(false);
  });

  it('sums totals', () => {
    const t = sumTotals(RIG.slice(0, 2));
    expect(t.inBPerDay).toBeCloseTo((149.8 + 79.8) * GB, 0);
    expect(t.savedPerDayM).toBe(RIG[0].savedPerDayM);
  });

  it('keeps the byte fraction in [0, 1]', () => {
    expect(keepFraction({ inBPerDay: 100, outBPerDay: 25 })).toBe(0.25);
    expect(keepFraction({ inBPerDay: 100, outBPerDay: 180 })).toBe(1);
    expect(keepFraction({ inBPerDay: 0, outBPerDay: 5 })).toBe(1);
    expect(keepFraction({ inBPerDay: 100, outBPerDay: -1 })).toBe(0);
  });

  it('keeps the dollar fraction (paid ÷ would-have-paid) in [0, 1]', () => {
    expect(paidFraction({ whpPerDayM: 400, paidPerDayM: 100 })).toBe(0.25);
    expect(paidFraction({ whpPerDayM: 100, paidPerDayM: 180 })).toBe(1);
    expect(paidFraction({ whpPerDayM: 0, paidPerDayM: 5 })).toBe(1);
    expect(paidFraction({ whpPerDayM: 100, paidPerDayM: -1 })).toBe(0);
  });

  it('measures a band slot in √($/day) by default and in √(GB/day) on the byte map', () => {
    const f = { whpPerDayM: 400 * 100_000, inBPerDay: 9 * GB, paidPerDayM: 100 * 100_000, outBPerDay: 6 * GB };
    expect(bandSlot(f)).toBeCloseTo(20, 9);
    expect(bandSlot(f, 'bytes')).toBeCloseTo(3, 9);
    expect(bandSlot({ whpPerDayM: 0, inBPerDay: 0 })).toBe(0);
    expect(bandKeep(f)).toBeCloseTo(0.25, 9);
    expect(bandKeep(f, 'bytes')).toBeCloseTo(2 / 3, 9);
  });
});

describe('the footer: why a flow is not drawn (P1-I04)', () => {
  it('splits idle flows, unpriced destinations and $0 prices; only an unpriced destination with traffic counts as unpriced', () => {
    // RIG: in_syslog is idle, in_http sends 3 GB/day to devnull, which is priced at $0 (internal)
    expect(undrawnCounts(RIG)).toEqual({ noTraffic: 1, unpriced: 0, zero: 1 });
    expect(undrawnCounts(RIG, ['devnull'])).toEqual({ noTraffic: 1, unpriced: 1, zero: 0 });
    // an unpriced destination without traffic is just idle
    expect(undrawnCounts([flow('quiet', 'main', 'splunk_new', 0, 0, 0)], ['splunk_new'])).toEqual({ noTraffic: 1, unpriced: 0, zero: 0 });
    expect(undrawnCounts(RIG.filter(isDrawable), ['devnull'])).toEqual({ noTraffic: 0, unpriced: 0, zero: 0 });
  });
});

describe('layout', () => {
  const L = layoutOf(RIG);

  it('is deterministic: input order never changes the picture', () => {
    for (const seed of [1, 7, 42, 1234]) expect(layoutOf(shuffle(RIG, seed))).toEqual(L);
  });

  it('places Source → Pipeline → Destination in three columns', () => {
    const xs = (kind: string) => L.nodes.filter((n) => n.kind === kind).map((n) => n.x0);
    expect(new Set(xs('in')).size).toBe(1);
    expect(new Set(xs('pipe')).size).toBe(1);
    expect(new Set(xs('out')).size).toBe(1);
    expect(xs('in')[0]).toBeLessThan(xs('pipe')[0]);
    expect(xs('pipe')[0]).toBeLessThan(xs('out')[0]);
    expect(L.nodes.filter((n) => n.kind === 'in')).toHaveLength(6);
    // the passthrough feeds the SIEM and the S3 archive: one node per destination (P1-I07), the same pipeline
    expect(L.nodes.filter((n) => n.kind === 'pipe').map((n) => n.rawId).sort()).toEqual(['mrd_k8s_noise', 'mrd_passthrough', 'mrd_passthrough', 'mrd_pay_sample', 'mrd_win_xml_pack']);
    expect(L.nodes.filter((n) => n.kind === 'pipe').map((n) => n.id)).toContain('pipe:default:mrd_passthrough>mrd_archive_s3');
    expect(L.nodes.filter((n) => n.kind === 'out').map((n) => n.rawId).sort()).toEqual(['mrd_analytics', 'mrd_archive_s3', 'mrd_siem_prod']);
    expect(L.shown).toBe(6);
    expect(L.eligible).toBe(6);
  });

  it(`keeps at least ${MIN_NODE_PADDING} px between nodes in a column, inside the frame`, () => {
    for (const kind of ['in', 'pipe', 'out']) {
      const col = L.nodes.filter((n) => n.kind === kind).sort((a, b) => a.y0 - b.y0);
      for (let i = 1; i < col.length; i++) expect(col[i].y0 - col[i - 1].y1).toBeGreaterThanOrEqual(MIN_NODE_PADDING - 1e-6);
      for (const n of col) {
        expect(n.y0).toBeGreaterThanOrEqual(0);
        expect(n.y1).toBeLessThanOrEqual(L.height);
      }
    }
  });

  it('scales band width with the square root of would-have-paid dollars (P1-I01: "This is dollars")', () => {
    expect(L.weightBy).toBe('dollars');
    // the plates' dollar-rank base: every drawable flow's would-have-paid (the idle and $0 flows add nothing)
    expect(L.totalWhpPerDayM).toBe(RIG.filter(isDrawable).reduce((a, f) => a + f.whpPerDayM, 0));
    expect(L.k).toBeGreaterThan(0);
    for (const r of L.ribbons) expect(r.s1.w / Math.sqrt(r.flow.whpPerDayM / 100_000)).toBeCloseTo(L.k, 6);
    // $374.50/day is √(374.5/100) ≈ 1.94× as wide as $100/day, not 3.75×
    const dc = L.ribbons.find((r) => r.flow.inputId === 'mrd_windows_dc')!;
    const pay = L.ribbons.find((r) => r.flow.inputId === 'mrd_payments_api')!;
    expect(dc.s1.w / pay.s1.w).toBeCloseTo(Math.sqrt(RIG[0].whpPerDayM / RIG[4].whpPerDayM), 6);
    // the cheapest flow is the thinnest shape: the 60 GB/day archive at $0.03/GB ($1.80/day) is a thread beside
    // the 40 GB/day SIEM stream ($100/day), although it carries 1.5× the bytes
    const vpc = L.ribbons.find((r) => r.flow.inputId === 'mrd_vpc_flow')!;
    expect(vpc.s1.w).toBeLessThan(pay.s1.w / 5);
  });

  it('orders band widths exactly as would-have-paid (monotonic in whpPerDayM)', () => {
    const byWhp = [...L.ribbons].sort((a, b) => a.flow.whpPerDayM - b.flow.whpPerDayM);
    for (let i = 1; i < byWhp.length; i++) {
      if (byWhp[i].flow.whpPerDayM > byWhp[i - 1].flow.whpPerDayM) expect(byWhp[i].s1.w).toBeGreaterThan(byWhp[i - 1].s1.w);
      else expect(byWhp[i].s1.w).toBeCloseTo(byWhp[i - 1].s1.w, 9);
    }
  });

  it('keeps the Insights-style byte map behind weightBy: bytes', () => {
    const B = layoutOf(RIG, 1020, { weightBy: 'bytes' });
    expect(B.weightBy).toBe('bytes');
    for (const r of B.ribbons) expect(r.s1.w / Math.sqrt(r.flow.inBPerDay / GB)).toBeCloseTo(B.k, 6);
    const dc = B.ribbons.find((r) => r.flow.inputId === 'mrd_windows_dc')!;
    const pay = B.ribbons.find((r) => r.flow.inputId === 'mrd_payments_api')!;
    expect(dc.s1.w / pay.s1.w).toBeCloseTo(Math.sqrt(149.8 / 40), 6);
    for (const r of B.ribbons) expect((r.s2.wIn - r.s2.wOut) / r.s2.wIn).toBeCloseTo(1 - keepFraction(r.flow), 9);
  });

  it('cuts the saved wedge from the same ribbon: its share of the band is exactly saved ÷ would-have-paid', () => {
    for (const r of L.ribbons) {
      const savedShare = (r.s2.wIn - r.s2.wOut) / r.s2.wIn;
      expect(savedShare).toBeCloseTo(r.flow.savedPerDayM / r.flow.whpPerDayM, 9);
      // at one price for both sides (counterfactual "this destination") that is also 1 − out/in
      expect(savedShare).toBeCloseTo(1 - r.flow.outBPerDay / r.flow.inBPerDay, 3);
      expect(r.s2.wIn).toBeCloseTo(r.s1.w, 9);
      expect(wedgeThicknessAt(r.s2, 0)).toBeCloseTo(r.s2.wIn - r.s2.wOut, 9);
      expect(wedgeThicknessAt(r.s2, 1)).toBeCloseTo(0, 9);
    }
    const pay = L.ribbons.find((r) => r.flow.inputId === 'mrd_payments_api')!;
    expect((pay.s2.wIn - pay.s2.wOut) / pay.s2.wIn).toBeCloseTo(0.75, 9);
    const ws = L.ribbons.find((r) => r.flow.inputId === 'mrd_windows_workstations')!;
    expect(wedgePath(ws.s2)).toBe('');
    expect(wedgePath(pay.s2)).toMatch(/^M.*C.*C.*Z$/);
  });

  it('draws a diversion credit as dollars: an archive priced against the SIEM it replaced is mostly wedge', () => {
    // 60 GB/day kept whole (out = in) but sent to S3 at $0.03/GB instead of the $2.50/GB SIEM
    const diverted = flow('mrd_vpc_flow', 'mrd_passthrough', 'mrd_archive_s3', 60, 60, 250_000, { paidPerDayM: 60 * 3_000, savedPerDayM: 60 * 250_000 - 60 * 3_000 });
    const D = layoutOf([diverted]);
    const r = D.ribbons[0];
    expect((r.s2.wIn - r.s2.wOut) / r.s2.wIn).toBeCloseTo(1 - 3_000 / 250_000, 9);
    expect(wedgePath(r.s2)).not.toBe('');
    // the byte map shows no reduction at all
    const B = layoutOf([diverted], 1020, { weightBy: 'bytes' });
    expect(wedgePath(B.ribbons[0].s2)).toBe('');
  });

  it('draws a growing flow at full width, without a wedge', () => {
    const grow = layoutOf([flow('enrich_src', 'enrich', 'mrd_siem_prod', 10, 14)]);
    expect(grow.ribbons[0].s2.wOut).toBeCloseTo(grow.ribbons[0].s2.wIn, 9);
    expect(wedgePath(grow.ribbons[0].s2)).toBe('');
  });

  it('stacks each pipeline’s outgoing ribbons into contiguous W_in slots that fill the node exactly', () => {
    for (const n of L.nodes.filter((x) => x.kind === 'pipe')) {
      const out = L.ribbons.filter((r) => r.pipeId === n.id).sort((a, b) => a.s2.top0 - b.s2.top0);
      expect(out[0].s2.top0).toBeCloseTo(n.y0, 6);
      for (let i = 1; i < out.length; i++) expect(out[i].s2.top0).toBeCloseTo(out[i - 1].s2.top0 + out[i - 1].s2.wIn, 6);
      const total = out.reduce((a, r) => a + r.s2.wIn, 0);
      expect(total).toBeCloseTo(n.y1 - n.y0, 6);
      // the incoming ribbons fill the same height
      const inn = L.ribbons.filter((r) => r.pipeId === n.id).reduce((a, r) => a + r.s1.w, 0);
      expect(inn).toBeCloseTo(n.y1 - n.y0, 6);
    }
  });

  it('docks only the paid (solid) part at the destination', () => {
    for (const n of L.nodes.filter((x) => x.kind === 'out')) {
      const docked = L.ribbons.filter((r) => r.destId === n.id).reduce((a, r) => a + r.s2.wOut, 0);
      expect(docked).toBeCloseTo(n.y1 - n.y0, 6);
    }
  });

  it('keeps each destination\'s ramp index stably (the bands wear their source\'s hue and destinations are ink on the map, D55)', () => {
    const idx = (out: string) => L.ribbons.find((r) => r.flow.outputId === out)!.colorIndex;
    expect(idx('mrd_analytics')).toBe(1);
    expect(idx('mrd_archive_s3')).toBe(2);
    expect(idx('mrd_siem_prod')).toBe(3);
    const noOrder = computeFlowLayout(RIG, { width: 1020, text: TEXT });
    expect(noOrder.ribbons.find((r) => r.flow.outputId === 'mrd_analytics')!.colorIndex).toBe(0);
  });

  it('keeps a stable ribbon id across a pipeline change (so the What-if can morph it)', () => {
    const f = RIG[1];
    const moved: LayoutFlow = { ...f, pipelineId: 'mrd_win_xml_pack' };
    expect(ribbonId(f)).toBe(ribbonId(moved));
  });

  it('marks projected ribbons and nodes that exist only in the after-state', () => {
    const projected = RIG.map((f) => (f.inputId === 'mrd_windows_workstations' ? { ...f, pipelineId: 'mrd_new_pack', outBPerDay: 53 * GB, projected: true } : f));
    const P = layoutOf(projected);
    expect(P.ribbons.find((r) => r.flow.inputId === 'mrd_windows_workstations')!.projected).toBe(true);
    expect(P.nodes.find((n) => n.rawId === 'mrd_new_pack')!.projected).toBe(true);
    expect(P.nodes.find((n) => n.rawId === 'mrd_passthrough')!.projected).toBe(false);
  });

  it('caps the flows it draws and reports the count', () => {
    const many = Array.from({ length: 40 }, (_, i) => flow(`src_${String(i).padStart(2, '0')}`, `p${i % 5}`, `d${i % 4}`, 1 + i, (1 + i) * 0.6));
    const W = layoutOf(many, 1020, { groupBelowShare: 0 });
    expect(W.shown).toBe(24);
    expect(W.eligible).toBe(40);
    const C = layoutOf(many, 358, { groupBelowShare: 0 });
    expect(C.compact).toBe(true);
    expect(C.shown).toBe(10);
    expect(layoutOf(many, 1020, { maxFlows: 5, groupBelowShare: 0 }).shown).toBe(5);
  });

  it('returns an empty frame when nothing is drawable', () => {
    const E = layoutOf([RIG[6], RIG[7]]);
    expect(E.nodes).toEqual([]);
    expect(E.ribbons).toEqual([]);
    expect(E.labels).toEqual([]);
    expect(E.eligible).toBe(0);
  });

  it('sizes the frame to the tallest column', () => {
    expect(autoHeight(1, false)).toBe(420);
    expect(autoHeight(10, false)).toBe(756);
    expect(autoHeight(100, false)).toBe(900);
    expect(autoHeight(3, true)).toBe(408);
    expect(autoHeight(1, true)).toBe(380);
    expect(layoutOf(RIG, 1020, { height: 500 }).height).toBe(500);
  });
});

describe('labels', () => {
  for (const width of [1020, 1190, 358]) {
    it(`never overlap each other, a node bar or the frame edge (width ${width})`, () => {
      const L = layoutOf(RIG, width);
      expect(L.labels.length).toBeGreaterThan(0);
      for (let i = 0; i < L.labels.length; i++) {
        const a = L.labels[i];
        expect(a.x).toBeGreaterThanOrEqual(-0.5);
        expect(a.y).toBeGreaterThanOrEqual(-0.5);
        expect(a.x + a.w).toBeLessThanOrEqual(L.width + 0.5);
        expect(a.y + a.h).toBeLessThanOrEqual(L.height + 0.5);
        for (let j = i + 1; j < L.labels.length; j++) expect(overlap(a, L.labels[j])).toBe(false);
        for (const n of L.nodes) expect(overlap(a, { x: n.x0, y: n.y0, w: n.x1 - n.x0, h: n.y1 - n.y0 })).toBe(false);
      }
    });
  }

  it('names every node and prices every ribbon on the desktop map', () => {
    const L = layoutOf(RIG);
    for (const n of L.nodes) expect(L.labels.some((l) => l.ownerId === n.id)).toBe(true);
    const saved = L.labels.filter((l) => l.kind === 'saved');
    // every ribbon that saves carries a saved plate (windows_dc, payments, k8s)
    expect(saved.map((l) => l.ownerId).sort()).toEqual(
      L.ribbons.filter((r) => r.flow.savedPerDayM > 0).map((r) => r.id).sort(),
    );
    expect(saved.every((l) => l.plate && l.lines[0].role === 'money' && /saved$/.test(l.lines[0].text))).toBe(true);
    expect(L.labels.filter((l) => l.kind === 'whp').length).toBeGreaterThanOrEqual(4);
    // sources on the left of their node, destinations on the right, pipelines above or below
    for (const l of L.labels.filter((x) => x.kind === 'node-in')) {
      const n = L.nodes.find((x) => x.id === l.ownerId)!;
      expect(l.x + l.w).toBeLessThanOrEqual(n.x0);
      // a name may wrap onto a second line; the caption is always last
      const roles = l.lines.map((x) => x.role);
      expect(roles[roles.length - 1]).toBe('caption');
      expect(roles.slice(0, -1).every((r) => r === 'name')).toBe(true);
      expect(roles.length).toBeLessThanOrEqual(3);
    }
    for (const l of L.labels.filter((x) => x.kind === 'node-out')) expect(l.x).toBeGreaterThanOrEqual(L.nodes.find((x) => x.id === l.ownerId)!.x1);
  });

  it('truncates a long name with an ellipsis and keeps the full text for the tooltip', () => {
    const long = flow('a_very_long_source_identifier_that_will_never_fit_in_the_gutter_x', 'p', 'mrd_siem_prod', 50, 25);
    const L = layoutOf([long]);
    const label = L.labels.find((l) => l.kind === 'node-in')!;
    expect(label.truncated).toBe(true);
    expect(label.lines.some((l) => l.role === 'name' && l.text.endsWith('…'))).toBe(true);
    expect(label.full).toContain('a_very_long_source_identifier_that_will_never_fit_in_the_gutter_x');
  });

  it('puts phone labels above their nodes', () => {
    const L = layoutOf(RIG, 358);
    for (const l of L.labels.filter((x) => x.kind === 'node-in' || x.kind === 'node-out')) {
      const n = L.nodes.find((x) => x.id === l.ownerId)!;
      expect(l.y + l.h <= n.y0 || l.y >= n.y1).toBe(true);
    }
  });

  it('never lets labels collide, for any rig subset (property)', () => {
    fc.assert(
      fc.property(fc.subarray(RIG.slice(0, 6), { minLength: 1 }), fc.integer({ min: 300, max: 1600 }), (subset, width) => {
        const L = layoutOf(subset, width);
        for (let i = 0; i < L.labels.length; i++) for (let j = i + 1; j < L.labels.length; j++) expect(overlap(L.labels[i], L.labels[j])).toBe(false);
      }),
      { numRuns: 60 },
    );
  });
});

describe('text measure', () => {
  it('wraps a name onto two lines before truncating it', () => {
    expect(wrapToWidth('Windows DC security events', 1000, 14, true)).toEqual({ lines: ['Windows DC security events'], truncated: false });
    const two = wrapToWidth('Windows DC security events', 120, 14, true);
    expect(two.lines).toHaveLength(2);
    expect(two.truncated).toBe(false);
    expect(two.lines.join(' ')).toBe('Windows DC security events');
    const three = wrapToWidth('one two three four five six seven eight', 40, 14, true);
    expect(three.lines).toHaveLength(2);
    expect(three.truncated).toBe(true);
    expect(wrapToWidth('', 100, 14)).toEqual({ lines: [''], truncated: false });
  });

  it('estimates widths monotonically and truncates to fit', () => {
    expect(textWidth('abc', 13)).toBeLessThan(textWidth('abcd', 13));
    expect(textWidth('abc', 13, true)).toBeGreaterThanOrEqual(textWidth('abc', 13));
    expect(textWidth('WWW', 12)).toBeGreaterThan(textWidth('iii', 12));
    expect(truncateToWidth('short', 200, 13)).toEqual({ text: 'short', truncated: false });
    const t = truncateToWidth('Windows workstation events', 90, 13, true);
    expect(t.truncated).toBe(true);
    expect(textWidth(t.text, 13, true)).toBeLessThanOrEqual(90);
    expect(truncateToWidth('Windows', 1, 13).text).toBe('Win…');
  });

  it('keeps the tails of names that share their start, so they never truncate to the same text (OQ-08)', () => {
    const a = 'Extremely long destination or pipeline name number 1';
    const b = 'Extremely long destination or pipeline name number 2';
    expect(truncateToWidth(a, 160, 13, true).text).toBe(truncateToWidth(b, 160, 13, true).text); // the end ellipsis collides
    const ta = truncateToWidth(a, 160, 13, true, true);
    const tb = truncateToWidth(b, 160, 13, true, true);
    expect(ta.text).not.toBe(tb.text);
    expect(ta.text.endsWith('1')).toBe(true);
    expect(textWidth(ta.text, 13, true)).toBeLessThanOrEqual(160);
    const nodes = [
      { id: 'in:a', kind: 'in', name: a },
      { id: 'in:b', kind: 'in', name: b },
      { id: 'out:a', kind: 'out', name: a },
      { id: 'in:c', kind: 'in', name: 'Windows DC' },
    ];
    expect([...namesSharingStarts(nodes)].sort()).toEqual(['in:a', 'in:b']);
  });
});

describe('paths', () => {
  it('draws closed cubic bands and a tapering wedge', () => {
    expect(bandPath(0, 10, 100, 40, 20)).toBe('M0,10C50,10 50,40 100,40L100,60C50,60 50,30 0,30Z');
    const s2 = { x0: 0, x1: 100, top0: 0, top1: 50, wIn: 40, wOut: 10 };
    expect(solidPath(s2)).toBe(bandPath(0, 0, 100, 50, 10));
    expect(wedgePath(s2)).toBe('M0,10C50,10 50,60 100,60C50,60 50,40 0,40Z');
    expect(centerLinePath(0, 5, 10, 15)).toBe('M0,5C5,5 5,15 10,15');
    const p = wedgePointAt(s2, 0);
    expect(p).toEqual({ x: 0, y: 25, thickness: 30 });
    expect(wedgePointAt(s2, 1).thickness).toBe(0);
    expect(bandPointAt(0, 0, 100, 40, 10, 0.5)).toEqual({ x: 50, y: 25 });
  });
});

describe('interpolateLayout', () => {
  const A = layoutOf(RIG);
  const projected = RIG.map((f) => (f.inputId === 'mrd_windows_workstations' ? { ...f, pipelineId: 'mrd_win_xml_pack', outBPerDay: 53.5 * GB, projected: true } : f));
  const B = layoutOf(projected);

  it('starts at the old geometry and ends at the new one, matching ribbons by stable id', () => {
    expect(interpolateLayout(A, B, 1)).toBe(B);
    const start = interpolateLayout(A, B, 0);
    const ws = (L: FlowLayout) => L.ribbons.find((r) => r.flow.inputId === 'mrd_windows_workstations')!;
    expect(ws(start).s1).toEqual(ws(A).s1);
    expect(ws(start).s2).toEqual(ws(A).s2);
    const mid = interpolateLayout(A, B, 0.5);
    expect(ws(mid).s2.wOut).toBeCloseTo((ws(A).s2.wOut + ws(B).s2.wOut) / 2, 9);
    expect(mid.labels.length).toBe(B.labels.length);
  });

  it('grows ribbons and nodes that are new in the target', () => {
    const one = layoutOf(RIG.slice(0, 1));
    const g = interpolateLayout(one, A, 0);
    const fresh = g.ribbons.find((r) => r.flow.inputId === 'mrd_k8s_prod')!;
    expect(fresh.s1.w).toBe(0);
    expect(fresh.s2.wIn).toBe(0);
    const node = g.nodes.find((n) => n.rawId === 'mrd_k8s_noise')!;
    expect(node.y1 - node.y0).toBe(0);
  });

  it('fades in a plate that is new in the target instead of popping it in (P1-I08)', () => {
    // Payments' trim broken: no wedge, no "saved" plate; restored: the plate appears with its growing wedge
    const broken = layoutOf(RIG.map((f) => (f.inputId === 'mrd_payments_api' ? { ...f, outBPerDay: f.inBPerDay, paidPerDayM: f.whpPerDayM, savedPerDayM: 0 } : f)));
    const fixed = layoutOf(RIG);
    const id = `saved:${ribbonId(RIG[4])}`;
    expect(broken.labels.some((l) => l.id === id)).toBe(false);
    const quarter = interpolateLayout(broken, fixed, 0.25).labels.find((l) => l.id === id)!;
    expect(quarter.appear).toBeCloseTo(0.25, 9);
    // labels already on screen move, they do not fade
    expect(interpolateLayout(broken, fixed, 0.25).labels.filter((l) => l.appear !== undefined).map((l) => l.id)).toEqual([id]);
    expect(interpolateLayout(broken, fixed, 1).labels.find((l) => l.id === id)!.appear).toBeUndefined();
  });
});

describe('a projection keeps the live map’s rows (P1-I06)', () => {
  // the What-if: Payments re-routed through a new pack pipeline and saving 60 % more, so its would-have-paid rank
  // and the pipeline column change
  const projected = RIG.map((f) =>
    f.inputId === 'mrd_pan_firewall' ? { ...f, pipelineId: 'mrd_pan_pack', outBPerDay: 30 * GB, paidPerDayM: f.whpPerDayM / 2, savedPerDayM: f.whpPerDayM / 2, projected: true } : f,
  );
  const columns = (L: FlowLayout) =>
    (['in', 'pipe', 'out'] as const).map((kind) => L.nodes.filter((n) => n.kind === kind).sort((a, b) => a.y0 - b.y0).map((n) => n.id));
  const common = (order: string[], other: readonly string[]) => order.filter((id) => other.includes(id));

  it('pins every column to the live order; a node only the projection has sits among its neighbours', () => {
    for (const width of [1020, 1400]) {
      const live = layoutOf(RIG, width);
      const pinned = layoutOf(projected, width, { nodeOrder: live.nodes.map((n) => n.id) });
      const [liveCols, pinnedCols] = [columns(live), columns(pinned)];
      for (let c = 0; c < 3; c++) expect(common(pinnedCols[c], liveCols[c]), `column ${c} at ${width}`).toEqual(common(liveCols[c], pinnedCols[c]));
      // the new pack pipeline is placed beside the Palo Alto row it serves, not at the end of the column
      const pipes = pinnedCols[1];
      expect(pipes).toContain('pipe:default:mrd_pan_pack');
      expect(pipes.indexOf('pipe:default:mrd_pan_pack')).toBeLessThan(pipes.length - 1);
      // deterministic
      expect(layoutOf(shuffle(projected, 7), width, { nodeOrder: live.nodes.map((n) => n.id) })).toEqual(pinned);
    }
  });

  it('the pin, not d3’s crossing order, decides the rows (a reversed pin draws every column reversed)', () => {
    // (since shared pipelines split per destination, P1-I07, d3's own order rarely moves under a projection on these
    // fixtures; the pin must still win whenever it would)
    const live = layoutOf(RIG, 1020);
    const reversed = [...live.nodes].reverse().map((n) => n.id);
    const flipped = layoutOf(projected, 1020, { nodeOrder: reversed });
    const [liveCols, flippedCols] = [columns(live), columns(flipped)];
    for (let c = 0; c < 3; c++) expect(common(flippedCols[c], liveCols[c])).toEqual([...common(liveCols[c], flippedCols[c])].reverse());
  });
});

describe('the tween (P1-I08)', () => {
  const A = layoutOf(RIG);
  // the next snapshot: Payments saves half as much (its docked band widens), everything else unchanged
  const half = RIG.map((f) => (f.inputId === 'mrd_payments_api' ? { ...f, savedPerDayM: f.savedPerDayM / 2, paidPerDayM: f.whpPerDayM - f.savedPerDayM / 2, outBPerDay: 25 * GB } : f));
  const B = layoutOf(half);

  it('eases a live snapshot’s new figures over 1.2 s, a re-fit over 200 ms, the What-if morph over 400 ms', () => {
    expect(LIVE_TWEEN_MS).toBeGreaterThanOrEqual(1000);
    expect(figuresChanged(A, B)).toBe(true);
    expect(tweenOf(A, B, false, 200, 400)).toEqual({ kind: 'live', ms: LIVE_TWEEN_MS });
    expect(tweenDuration(A, B, true, 200, 400)).toBe(400);
    // the same figures in a shorter frame (the fit height moved): a re-fit, not a data change
    const shorter = layoutOf(RIG, 1020, { height: 520 });
    expect(figuresChanged(A, shorter)).toBe(false);
    expect(tweenOf(A, shorter, false, 200, 400)).toEqual({ kind: 'refit', ms: 200 });
    // a new flow (or one gone) is a data change
    expect(figuresChanged(A, layoutOf(RIG.slice(0, 5)))).toBe(true);
  });

  it('knows when there is nothing to animate (a re-read of the same snapshot)', () => {
    const again = layoutOf(RIG.map((f) => ({ ...f })));
    expect(again).not.toBe(A);
    expect(sameGeometry(A, again)).toBe(true);
    expect(sameGeometry(A, B)).toBe(false);
    expect(sameGeometry(A, layoutOf(RIG, 1000))).toBe(false);
  });
});

// ─── BEAUTY F9: real workspaces (long tails, the fold, projector contrast) ─────

describe('long tail', () => {
  /** A sample-tour-like workspace: five big SIEM streams, a cheap archive, and a tail of $2–$9 flows. */
  const TAIL: LayoutFlow[] = [
    ...RIG.slice(0, 6),
    flow('okta', 'mrd_passthrough', 'mrd_siem_prod', 1.2, 1.2),
    flow('cdn', 'cdn_sample', 'mrd_siem_prod', 3.2, 1.6),
    flow('edge_a', 'mrd_passthrough', 'mrd_siem_prod', 2, 2),
    flow('lake_a', 'mrd_passthrough', 'lake', 4, 4, 20_000),
    flow('lake_b', 'mrd_passthrough', 'lake', 6, 6, 20_000),
  ];
  const total = TAIL.filter(isDrawable).reduce((a, f) => a + f.whpPerDayM, 0);

  it('folds flows under 2 % of would-have-paid into one flow per destination, preserving every total', () => {
    const { flows, folded } = groupSmallFlows(TAIL);
    const small = TAIL.filter((f) => isDrawable(f) && f.whpPerDayM < GROUP_BELOW_SHARE * total);
    expect(small.map((f) => f.inputId).sort()).toEqual(['cdn', 'edge_a', 'lake_a', 'lake_b', 'mrd_vpc_flow', 'okta']);
    // the lone small feeder of the S3 archive keeps its name; the other five fold into two flows
    expect(folded).toBe(5);
    const others = flows.filter((f) => f.inputId === OTHER_ID);
    expect(others.map((f) => [f.key, f.folded])).toEqual([
      [otherFlowKey('default', 'lake'), 2],
      [otherFlowKey('default', 'mrd_siem_prod'), 3],
    ]);
    expect(flows.some((f) => f.inputId === 'mrd_vpc_flow')).toBe(true);
    expect(sumTotals(flows.filter(isDrawable))).toEqual(sumTotals(TAIL.filter(isDrawable)));
  });

  it('captions a Destination with its whole group totals, the same at every width (P1-I04)', () => {
    const wide = layoutOf(TAIL, 1400);
    // a phone's compact map draws at most 3 flows here: the destination still reads its whole bill
    const narrow = layoutOf(TAIL, 390, { maxFlows: 3 });
    expect(narrow.shown).toBeLessThan(wide.shown);
    const whole = (raw: string) => sumTotals(TAIL.filter((f) => isDrawable(f) && f.outputId === raw));
    for (const L of [wide, narrow]) {
      for (const n of L.nodes.filter((x) => x.kind === 'out')) {
        expect(n.totals, n.id).toEqual(whole(n.rawId));
        expect(n.flows, n.id).toBe(TAIL.filter((f) => isDrawable(f) && f.outputId === n.rawId).length);
        const caption = L.labels.find((l) => l.id === `label:${n.id}`);
        if (caption) expect(caption.full).toContain(TEXT.caption('out', whole(n.rawId)));
      }
    }
    const siem = (L: FlowLayout) => L.nodes.find((n) => n.id === 'out:default:mrd_siem_prod')!;
    expect(siem(narrow).totals).toEqual(siem(wide).totals);
    expect(siem(narrow).totals.paidPerDayM).toBeGreaterThan(sumTotals(narrow.ribbons.filter((r) => r.destId === siem(narrow).id).map((r) => r.flow)).paidPerDayM);
    // the shared "smaller flows" source counts every flow it folds (both destinations' folds)
    const other = wide.nodes.find((n) => n.kind === 'in' && n.other)!;
    expect(other.flows).toBe(5);
    expect(other.name).toBe('5 smaller flows');
    // a Source and a pipeline sum what is drawn through them: a Source's flows may be clones of the same events
    const clone = [...TAIL, flow('mrd_windows_dc', 'mrd_passthrough', 'mrd_archive_s3', 149.8, 149.8, 3_000)];
    const C = layoutOf(clone, 1400);
    const dc = C.nodes.find((n) => n.id === 'in:default:mrd_windows_dc')!;
    expect(dc.totals).toEqual(sumTotals(C.ribbons.filter((r) => r.sourceId === dc.id).map((r) => r.flow)));
    const pass = wide.nodes.find((n) => n.id === 'pipe:default:mrd_passthrough')!;
    expect(pass.totals).toEqual(sumTotals(wide.ribbons.filter((r) => r.pipeId === pass.id).map((r) => r.flow)));
  });

  it('never folds a projected flow, a kept flow, or anything at share 0', () => {
    const projected = TAIL.map((f) => (f.inputId === 'okta' ? { ...f, projected: true } : f));
    expect(groupSmallFlows(projected).flows.some((f) => f.inputId === 'okta')).toBe(true);
    const kept = groupSmallFlows(TAIL, GROUP_BELOW_SHARE, [TAIL.find((f) => f.inputId === 'cdn')!.key]);
    expect(kept.flows.some((f) => f.inputId === 'cdn')).toBe(true);
    expect(kept.flows.find((f) => f.key === otherFlowKey('default', 'mrd_siem_prod'))!.folded).toBe(2);
    expect(groupSmallFlows(TAIL, 0)).toEqual({ flows: TAIL, folded: 0 });
    expect(groupSmallFlows([], 0.02)).toEqual({ flows: [], folded: 0 });
  });

  it('draws the folded flows from one shared source through one shared pipeline, named by count', () => {
    const T = layoutOf(TAIL);
    const otherIn = T.nodes.filter((n) => n.kind === 'in' && n.rawId === OTHER_ID);
    const otherPipe = T.nodes.filter((n) => n.kind === 'pipe' && n.rawId === OTHER_ID);
    expect(otherIn).toHaveLength(1);
    expect(otherPipe).toHaveLength(1);
    expect(otherIn[0].name).toBe('5 smaller flows');
    expect(otherIn[0].other).toBe(true);
    expect(otherPipe[0].name).toBe('Their pipelines');
    expect(T.ribbons.filter((r) => r.folded).map((r) => r.folded)).toEqual([2, 3]);
    // every flow is still represented; the caption does not claim a cap
    expect(T.shown).toBe(11);
    expect(T.eligible).toBe(11);
    expect(T.folded).toBe(5);
    // deterministic with folding too
    for (const seed of [3, 99]) expect(layoutOf(shuffle(TAIL, seed))).toEqual(T);
  });

  it('gates $ plates by dollar rank: every ribbon worth ≥ 2 % of the map carries one, a thin cheap one does not', () => {
    expect(PLATE_MIN_SHARE).toBe(GROUP_BELOW_SHARE);
    for (const width of [1020, 1400]) {
      // unfolded, so the $2–$9 flows are drawn as thin ribbons
      const T = layoutOf(TAIL, width, { groupBelowShare: 0 });
      const thin = T.ribbons.filter((r) => r.s1.w < PLATE_MIN_RIBBON);
      expect(thin.length).toBeGreaterThan(0);
      for (const l of T.labels.filter((x) => x.kind === 'whp' || x.kind === 'saved')) {
        const r = T.ribbons.find((x) => x.id === l.ownerId)!;
        expect(earnsPlate(r, total), l.id).toBe(true);
      }
      // every ribbon worth ≥ 2 % of the map's would-have-paid has its whp plate, however thin it is drawn
      for (const r of T.ribbons.filter((x) => x.flow.whpPerDayM >= PLATE_MIN_SHARE * total)) {
        expect(T.labels.some((l) => l.id === `whp:${r.id}`), r.id).toBe(true);
      }
    }
    // the rule is dollars, not pixels: a 3 px ribbon worth 5 % earns a plate; a 3 px one worth 1 % does not
    const r = (whp: number) => ({ flow: { ...RIG[0], whpPerDayM: whp }, s1: { x0: 0, x1: 1, top0: 0, top1: 0, w: 3 } });
    expect(earnsPlate(r(5), 100)).toBe(true);
    expect(earnsPlate(r(1), 100)).toBe(false);
    expect(earnsPlate({ ...r(1), s1: { ...r(1).s1, w: PLATE_MIN_RIBBON } }, 100)).toBe(true);
    expect(earnsPlate(r(1), 0)).toBe(false);
  });

  it('fades nothing on the dollar map (a cheap flow is already thin); the byte map weights opacity by price', () => {
    expect(layoutOf(TAIL).ribbons.every((r) => r.weight === 1)).toBe(true);
    const T = layoutOf(TAIL, 1020, { weightBy: 'bytes' });
    const weight = (id: string) => T.ribbons.find((r) => r.flow.inputId === id)!.weight;
    expect(weight('mrd_windows_dc')).toBe(1);
    expect(weight('mrd_k8s_prod')).toBeCloseTo(Math.sqrt(150_000 / 250_000), 2);
    expect(weight('mrd_vpc_flow')).toBeLessThan(0.15);
    expect(priceWeight({ whpPerDayM: 1, inBPerDay: 0 }, 5)).toBe(1);
    expect(priceWeight({ whpPerDayM: 10, inBPerDay: 1 }, 0)).toBe(1);
    expect(priceWeight({ whpPerDayM: 10, inBPerDay: 1 }, 5)).toBe(1); // clamped
  });

  it('fits the viewport: never taller than maxHeight, never below the minimum, and grows into the room up to 0.66 of its width (P1-I07)', () => {
    const natural = layoutOf(TAIL).height;
    const fill = Math.max(natural, Math.round(1020 * FILL_ASPECT));
    expect(layoutOf(TAIL, 1020, { maxHeight: 500 }).height).toBe(Math.min(fill, 500));
    expect(layoutOf(TAIL, 1020, { maxHeight: 120 }).height).toBe(Math.min(fill, MIN_FIT_HEIGHT));
    // a projector's room: the map takes it, up to the aspect cap
    expect(layoutOf(TAIL, 1020, { maxHeight: 640 }).height).toBe(Math.min(640, fill));
    expect(layoutOf(TAIL, 1020, { maxHeight: 5_000 }).height).toBe(fill);
    // an explicit height still wins
    expect(layoutOf(TAIL, 1020, { maxHeight: 500, height: 640 }).height).toBe(640);
    // a compact (phone) map keeps its natural height: squeezing it would leave no room for its bands
    expect(layoutOf(TAIL, 358, { maxHeight: 200 }).height).toBe(layoutOf(TAIL, 358).height);
  });

  it('keeps every node name on a fitted desktop map (labels are placed, not dropped)', () => {
    for (const [width, maxHeight] of [
      [880, 520],
      [1180, 700],
    ] as const) {
      const T = layoutOf(TAIL, width, { maxHeight });
      const named = new Set(T.labels.filter((l) => l.kind.startsWith('node')).map((l) => l.ownerId));
      for (const n of T.nodes) expect(named.has(n.id), `${n.id} at ${width}×${maxHeight}`).toBe(true);
    }
  });
});

describe('labels hug their own node, saved plates their own band (P1-I02)', () => {
  /** A sample-tour-like workspace: a SIEM trunk, a shared passthrough, a tail. */
  const TAIL: LayoutFlow[] = [
    ...RIG.slice(0, 6),
    flow('okta', 'mrd_passthrough', 'mrd_siem_prod', 1.2, 1.2),
    flow('cdn', 'cdn_sample', 'mrd_siem_prod', 3.2, 1.6),
    flow('edge_a', 'mrd_passthrough', 'mrd_siem_prod', 2, 2),
    flow('lake_a', 'mrd_passthrough', 'lake', 4, 4, 20_000),
    flow('lake_b', 'mrd_passthrough', 'lake', 6, 6, 20_000),
  ];
  const maps: [string, FlowLayout][] = [
    ['rig 1020', layoutOf(RIG, 1020)],
    ['rig 1190', layoutOf(RIG, 1190)],
    ['rig fitted 880×520', layoutOf(RIG, 880, { maxHeight: 520 })],
    ['tail fitted 880×520', layoutOf(TAIL, 880, { maxHeight: 520 })],
    ['tail fitted 1180×700', layoutOf(TAIL, 1180, { maxHeight: 700 })],
  ];
  /** Vertical gap between a box and a node bar (0 when they overlap vertically). */
  const gap = (l: { y: number; h: number }, n: { y0: number; y1: number }) => Math.max(0, n.y0 - (l.y + l.h), l.y - n.y1);

  it('tAtX inverts the band’s x(t), and ribbonSpanAt reads the band it draws', () => {
    for (const t of [0, 0.1, 0.37, 0.5, 0.9, 1]) {
      const x = bandPointAt(100, 0, 500, 0, 10, t).x;
      expect(tAtX(100, 500, x)).toBeCloseTo(t, 4);
    }
    const L = layoutOf(RIG);
    for (const r of L.ribbons) {
      // at the pipeline the span is the whole slot (W_in): the solid part and the wedge cut from it
      const at = ribbonSpanAt(r, r.s2.x0 + 0.01)!;
      expect(at.top).toBeCloseTo(r.s2.top0, 1);
      expect(at.bottom - at.top).toBeCloseTo(r.s2.wIn, 1);
      // at the destination only the paid part docks
      const dock = ribbonSpanAt(r, r.s2.x1)!;
      expect(dock.bottom - dock.top).toBeCloseTo(r.s2.wOut, 1);
      expect(ribbonSpanAt(r, r.s1.x0 - 5)).toBeNull();
    }
  });

  for (const [name, L] of maps) {
    it(`${name}: every pipeline name is nearer its own bar than any other node in its column`, () => {
      const pipes = L.nodes.filter((n) => n.kind === 'pipe');
      const labels = L.labels.filter((l) => l.kind === 'node-pipe');
      expect(labels.length).toBe(pipes.length);
      for (const l of labels) {
        const own = pipes.find((n) => n.id === l.ownerId)!;
        const d = gap(l, own);
        expect(d, `${l.id} hugs its bar`).toBeCloseTo(2, 5);
        for (const other of pipes) if (other.id !== own.id) expect(gap(l, other), `${l.id} vs ${other.id}`).toBeGreaterThan(d);
      }
    });

    it(`${name}: every saved plate sits on its own band, or a leader joins it to its wedge`, () => {
      const plates = L.labels.filter((l) => l.kind === 'saved');
      expect(plates.length).toBeGreaterThan(0);
      for (const l of plates) {
        const r = L.ribbons.find((x) => x.id === l.ownerId)!;
        if (l.inBand) {
          expect(boxOnRibbon(l, r), `${l.id} on its band`).toBe(true);
          expect(l.leader).toBeUndefined();
        } else {
          expect(l.leader, `${l.id} has a leader`).toBeDefined();
          const { x1, y1, x2, y2 } = l.leader!;
          // one end on the plate's top or bottom edge, the other inside its own band
          expect(x1).toBeGreaterThanOrEqual(l.x);
          expect(x1).toBeLessThanOrEqual(l.x + l.w);
          expect([l.y, l.y + l.h].some((e) => Math.abs(e - y1) < 0.01)).toBe(true);
          const span = ribbonSpanAt(r, x2)!;
          expect(y2).toBeGreaterThanOrEqual(span.top - 0.01);
          expect(y2).toBeLessThanOrEqual(span.bottom + 0.01);
        }
      }
    });
  }

  it('anchors saved plates at the pipeline, before the ribbons cross (not 40–111 px out over the crossings)', () => {
    const L = layoutOf(RIG, 1020);
    const plates = L.labels.filter((l) => l.kind === 'saved');
    expect(plates).toHaveLength(3);
    for (const l of plates) {
      const r = L.ribbons.find((x) => x.id === l.ownerId)!;
      expect(l.x - r.s2.x0, l.id).toBeGreaterThanOrEqual(8);
      expect(l.x - r.s2.x0, l.id).toBeLessThanOrEqual(80);
      expect(l.inBand).toBe(true);
    }
  });

  it('a name over a ribbon keeps its halo; one on open panel has none', () => {
    for (const [, L] of maps) {
      for (const l of L.labels.filter((x) => x.kind.startsWith('node'))) {
        expect(l.halo, l.id).toBe(L.ribbons.some((r) => boxOnRibbon(l, r)));
      }
    }
    // the rig's source names sit in the gutter, clear of every band
    expect(layoutOf(RIG).labels.filter((l) => l.kind === 'node-in').every((l) => !l.halo)).toBe(true);
  });

  it('a displaced plate’s leader follows the plate through a tween', () => {
    const L = layoutOf(TAIL, 880, { maxHeight: 520 });
    const withLeader = L.labels.find((l) => l.leader);
    if (!withLeader) return; // nothing displaced on this frame
    const from = { ...L, labels: L.labels.map((l) => (l.id === withLeader.id ? { ...l, x: l.x - 20, y: l.y - 10 } : l)) };
    const mid = interpolateLayout(from, L, 0.5).labels.find((l) => l.id === withLeader.id)!;
    expect(mid.leader!.x1 - mid.x).toBeCloseTo(withLeader.leader!.x1 - withLeader.x, 5);
    expect(mid.leader!.y1 - mid.y).toBeCloseTo(withLeader.leader!.y1 - withLeader.y, 5);
  });
});

describe('a shared pipeline is drawn once per destination (P1-I07)', () => {
  it('keeps the plain node for the destination with the most would-have-paid; the rest get their own node', () => {
    const key = splitSharedPipes(RIG);
    const byInput = (id: string) => key(RIG.find((f) => f.inputId === id)!);
    expect(byInput('mrd_windows_workstations')).toBe('mrd_passthrough');
    expect(byInput('mrd_pan_firewall')).toBe('mrd_passthrough');
    expect(byInput('mrd_vpc_flow')).toBe('mrd_passthrough>mrd_archive_s3');
    expect(byInput('mrd_windows_dc')).toBe('mrd_win_xml_pack');
  });

  it('never splits the shared "smaller flows" pipeline', () => {
    const f = { ...RIG[0], key: 'x', inputId: OTHER_ID, pipelineId: OTHER_ID, outputId: 'a' };
    const g = { ...f, key: 'y', outputId: 'b', whpPerDayM: 1 };
    const key = splitSharedPipes([f, g]);
    expect(key(f)).toBe(OTHER_ID);
    expect(key(g)).toBe(OTHER_ID);
  });

  it('the far destination’s flow leaves its own node, so it crosses fewer ribbons than through the shared one', () => {
    // one pipeline feeds a big SIEM trunk at the top and a small flow to a destination at the bottom
    const flows = [
      flow('a', 'shared', 'siem', 100, 80),
      flow('b', 'shared', 'siem', 90, 70),
      flow('c', 'p_c', 'siem', 80, 60),
      flow('d', 'p_d', 'lake', 70, 50),
      flow('e', 'p_e', 'lake', 60, 40),
      flow('f', 'shared', 'lake', 5, 5),
    ];
    const L = layoutOf(flows, 1020);
    const ribbon = L.ribbons.find((r) => r.flow.inputId === 'f')!;
    const pipe = L.nodes.find((n) => n.id === ribbon.pipeId)!;
    expect(pipe.rawId).toBe('shared');
    expect(pipe.id).toBe('pipe:default:shared>lake');
    // its node sits with the lake's pipelines, below the SIEM trunk's shared node
    const trunk = L.nodes.find((n) => n.id === 'pipe:default:shared')!;
    expect(pipe.y0).toBeGreaterThan(trunk.y1);
    // and both nodes read the same name, and link to the same pipeline
    expect(pipe.name).toBe(trunk.name);
  });
});

describe('the byte map (P2-W02)', () => {
  const bytesText: LayoutText = { ...TEXT, volume: (b) => `${(b / GB).toFixed(1)} GB / day`, removed: (b) => `${(b / GB).toFixed(1)} GB removed` };
  it('keeps the dollar map’s ribbons and, pinned to its rows, the same order; widths follow in-bytes', () => {
    const dollars = layoutOf(RIG, 1020, { text: bytesText });
    const bytes = layoutOf(RIG, 1020, { text: bytesText, weightBy: 'bytes', nodeOrder: dollars.nodes.map((n) => n.id) });
    expect(bytes.ribbons.map((r) => r.id)).toEqual(dollars.ribbons.map((r) => r.id));
    const order = (L: FlowLayout) => (['in', 'pipe', 'out'] as const).map((k) => L.nodes.filter((n) => n.kind === k).sort((a, b) => a.y0 - b.y0).map((n) => n.id));
    expect(order(bytes)).toEqual(order(dollars));
    const byIn = [...bytes.ribbons].sort((a, b) => a.flow.inBPerDay - b.flow.inBPerDay);
    for (let i = 1; i < byIn.length; i++) if (byIn[i].flow.inBPerDay > byIn[i - 1].flow.inBPerDay) expect(byIn[i].s1.w).toBeGreaterThan(byIn[i - 1].s1.w);
  });

  it('labels its plates in bytes, gated by byte rank: the 60 GB/day archive earns one', () => {
    const L = layoutOf(RIG, 1020, { text: bytesText, weightBy: 'bytes' });
    const whp = L.labels.filter((l) => l.kind === 'whp');
    expect(whp.length).toBeGreaterThan(0);
    for (const l of whp) expect(l.lines[0].text).toMatch(/GB \/ day$/);
    expect(whp.some((l) => l.ownerId.includes('mrd_vpc_flow'))).toBe(true);
    const saved = L.labels.filter((l) => l.kind === 'saved');
    for (const l of saved) expect(l.lines[0].text).toMatch(/GB removed$/);
    const vpc = L.ribbons.find((r) => r.flow.inputId === 'mrd_vpc_flow')!;
    expect(earnsBytePlate(vpc, L.ribbons.reduce((a, r) => a + r.flow.inBPerDay, 0))).toBe(true);
  });
});

describe('the map on stage (P2-W10)', () => {
  it('scales labels with the projector: 2 at 1080 rows, 1.5 at 720, never past 2.5', () => {
    expect(stageScaleFor(1080)).toBe(2);
    expect(stageScaleFor(720)).toBe(1.5);
    expect(stageScaleFor(600)).toBe(1.5);
    expect(stageScaleFor(2160)).toBe(2.5);
  });

  it('fills the room it is given and lays labels out at the scale (plates 40 px tall at 2)', () => {
    const L = layoutOf(RIG, 1460, { maxHeight: 1000, scale: 2, fill: true });
    expect(L.height).toBe(1000);
    expect(L.scale).toBe(2);
    const plates = L.labels.filter((l) => l.plate);
    expect(plates.length).toBeGreaterThan(0);
    for (const l of plates) expect(l.h).toBe(40);
    for (const l of L.labels.filter((x) => x.kind === 'node-pipe')) expect(l.h % 38).toBe(0);
    // still clean: no label overlaps another or a node bar
    for (let i = 0; i < L.labels.length; i++) {
      for (let j = i + 1; j < L.labels.length; j++) expect(overlap(L.labels[i], L.labels[j])).toBe(false);
      for (const n of L.nodes) expect(overlap(L.labels[i], { x: n.x0, y: n.y0, w: n.x1 - n.x0, h: n.y1 - n.y0 })).toBe(false);
    }
    // and a screen map is untouched by it (the metrics are restored)
    expect(layoutOf(RIG)).toEqual(layoutOf(RIG));
    expect(layoutOf(RIG).scale).toBe(1);
    expect(layoutOf(RIG).labels.filter((l) => l.plate).every((l) => l.h === 20)).toBe(true);
  });
});

describe('savings as a place and incidents on the map (P2-W16)', () => {
  const SINK_TEXT: LayoutText = { ...TEXT, sink: { name: 'Removed by Cribl', caption: (t) => `$${Math.round(t.savedPerDayM / 100_000)} / day` } };

  it('pools every saved wedge in one sink whose height is the sum of the wedges', () => {
    const L = layoutOf(RIG, 1020, { text: SINK_TEXT, sink: true });
    const sink = L.nodes.find((n) => n.sink)!;
    expect(sink.rawId).toBe(SINK_ID);
    expect(sink.name).toBe('Removed by Cribl');
    const feeding = L.ribbons.filter((r) => r.sinkId === sink.id);
    expect(feeding.map((r) => r.flow.inputId).sort()).toEqual(['mrd_k8s_prod', 'mrd_payments_api', 'mrd_windows_dc']);
    expect(sink.y1 - sink.y0).toBeCloseTo(feeding.reduce((a, r) => a + (r.s2.wIn - r.s2.wOut), 0), 6);
    // its money is exactly what those flows save, and its caption says so
    expect(sink.totals.savedPerDayM).toBe(feeding.reduce((a, r) => a + r.flow.savedPerDayM, 0));
    expect(L.labels.find((l) => l.ownerId === sink.id)!.full).toBe(`Removed by Cribl · $${Math.round(sink.totals.savedPerDayM / 100_000)} / day`);
    // each wedge docks in its own slot, contiguous, filling the sink
    const slots = feeding.map((r) => [r.s2.sinkTop!, r.s2.sinkTop! + r.s2.wIn - r.s2.wOut] as const).sort((a, b) => a[0] - b[0]);
    expect(slots[0][0]).toBeCloseTo(sink.y0, 6);
    for (let i = 1; i < slots.length; i++) expect(slots[i][0]).toBeCloseTo(slots[i - 1][1], 6);
    expect(slots[slots.length - 1][1]).toBeCloseTo(sink.y1, 6);
    // the destinations keep their padding above it, inside the frame
    for (const n of L.nodes.filter((x) => x.kind === 'out' && !x.sink)) {
      expect(n.y1).toBeLessThanOrEqual(sink.y0 - MIN_NODE_PADDING + 0.01);
      expect(n.y0).toBeGreaterThanOrEqual(0);
    }
    // and no label lands on a node bar
    for (const l of L.labels) for (const n of L.nodes) expect(overlap(l, { x: n.x0, y: n.y0, w: n.x1 - n.x0, h: n.y1 - n.y0 }), `${l.id} on ${n.id}`).toBe(false);
  });

  it('draws no sink on a phone map or without the sink copy, and keeps the taper there', () => {
    expect(layoutOf(RIG, 358, { text: SINK_TEXT, sink: true }).nodes.some((n) => n.sink)).toBe(false);
    expect(layoutOf(RIG, 1020, { sink: true }).nodes.some((n) => n.sink)).toBe(false);
  });

  const now = Date.parse('2026-09-26T21:00:00Z');
  const inc = (over: Partial<Incident>): Incident => ({
    id: 'i1',
    type: 'regression',
    severity: 'high',
    objectKey: 'pipe:default:mrd_pay_sample',
    label: 'Payments API sampling',
    openedAt: new Date(now - 600_000).toISOString(),
    before: 0.75,
    after: 0.5,
    impactPerDayM: 2_500_000,
    notes: [],
    deliveries: [],
    commit: { hash: 'a1f3c9e5b2', message: 'm', author: 's', committedAt: new Date(now - 700_000).toISOString(), groupId: 'default', match: 'object' as never },
    ...over,
  });

  it('marks every flow through the object an open alert names, in its severity, with what it costs and since when', () => {
    const marks = incidentMarks(RIG, [inc({})], now, 'America/Chicago');
    const payments = RIG.find((f) => f.inputId === 'mrd_payments_api')!;
    expect(Object.keys(marks)).toEqual([payments.key]);
    expect(marks[payments.key].tone).toBe('high');
    expect(marks[payments.key].text).toBe('−$25 / day since 3:50 PM · a1f3c9e');
    expect(marks[payments.key].short).toBe('−$25 / day · a1f3c9e');
    // a route or source alert marks its flows too; a destination's budget never marks a ribbon
    expect(Object.keys(incidentMarks(RIG, [inc({ objectKey: 'route:default:mrd_k8s_prod', severity: 'medium' })], now))).toHaveLength(1);
    expect(Object.keys(incidentMarks(RIG, [inc({ type: 'budget', objectKey: 'out:default:mrd_siem_prod' })], now))).toHaveLength(0);
  });

  it('turns green for ten seconds after it closes, then lets go', () => {
    const closed = inc({ closedAt: new Date(now - 4_000).toISOString(), recoveredTo: 0.74 });
    const marks = incidentMarks(RIG, [closed], now, 'America/Chicago');
    expect(Object.values(marks)[0].tone).toBe('recovered');
    expect(Object.values(marks)[0].text).toMatch(/^Recovered at /);
    expect(incidentMarks(RIG, [closed], now + 7_000)).toEqual({});
  });

  it('keeps a marked flow out of the fold and gives its ribbon a plate', () => {
    const tail = [...RIG, flow('okta', 'mrd_passthrough', 'mrd_siem_prod', 1.2, 1.2), flow('cdn', 'cdn_sample', 'mrd_siem_prod', 3.2, 1.6), flow('edge_a', 'mrd_passthrough', 'mrd_siem_prod', 2, 2)];
    const cdn = tail.find((f) => f.inputId === 'cdn')!;
    const unmarked = layoutOf(tail, 1020);
    expect(unmarked.ribbons.some((r) => r.flowKey === cdn.key)).toBe(false); // folded
    const L = layoutOf(tail, 1020, { marks: { [cdn.key]: { tone: 'high', text: '−$4 / day since 3:50 PM · a1f3c9e', short: '−$4 / day · a1f3c9e' } } });
    const r = L.ribbons.find((x) => x.flowKey === cdn.key)!;
    expect(r.mark).toBe('high');
    const plate = L.labels.find((l) => l.id === `incident:${r.id}`)!;
    expect(plate.tone).toBe('high');
    expect(plate.plate).toBe(true);
  });

  it('an incident flag keeps a clear gap from every name when the map has room (craft review, round 1)', () => {
    const payments = RIG.find((f) => f.inputId === 'mrd_payments_api')!;
    for (let width = 560; width <= 1600; width += 40) {
      const L = layoutOf(RIG, width, { marks: { [payments.key]: { tone: 'high', text: '−$25 / day since 2:30 PM · 86dade0', short: '−$25 / day · 86dade0' } } });
      const flag = L.labels.find((l) => l.id.startsWith('incident:'))!;
      expect(flag, `${width}: the flag is placed`).toBeDefined();
      const gap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
        Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));
      for (const other of L.labels.filter((l) => l.kind === 'node-in' || l.kind === 'node-pipe' || l.kind === 'node-out')) {
        // the first pass keeps 10 px (× the label metric scale); a map too tight for it falls back to the usual 3
        expect(gap(flag, other), `${width}: the flag is clear of ${other.id}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('a name over a band carries the halo that draws its pill', () => {
    const L = layoutOf(RIG, 1440);
    for (const l of L.labels.filter((x) => x.halo)) expect(l.plate).toBe(false);
  });
});
