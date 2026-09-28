// tests/unit/wave3-flow-layout.test.ts — wave 3, the Flow map's plates and pipeline names (W3-FLOW-1…3) on the
// placement function itself: a crowded, sample-tour-like map with a "Removed by Cribl" sink, on a desk and on stage.
//
// W3-FLOW-1: a saved plate touches its own wedge or carries a leader to it; no money plate sits on another route's
// incident outline; a plate is drawn only where its pipeline's name is. W3-FLOW-2: every pipeline name is one line,
// truncated in the middle. W3-FLOW-3: a plate with no leader keeps its centre in its pipeline's row.

import { describe, expect, it } from 'vitest';
import { buildTourDoc } from '../../testdata/tour.ts';
import { boxOnOutline, boxOnWedge, computeFlowLayout, segmentHitsBox, tAtX, wedgePointAt, type FlowLayout, type FlowMark, type LayoutFlow, type LayoutText } from '../../src/components/FlowDiagram/layout.ts';

const GB = 1_000_000_000;
const TEXT: LayoutText = {
  name: (kind, id) => `${kind === 'in' ? 'Source' : kind === 'pipe' ? 'Pipeline' : 'Destination'} ${id}`,
  caption: (kind, t) => (kind === 'in' ? `${(t.inBPerDay / GB).toFixed(1)} GB/day` : `$${Math.round(t.paidPerDayM / 100_000)} / day`),
  whp: (mc) => `$${Math.round(mc / 100_000).toLocaleString('en-US')} / day`,
  saved: (mc) => `$${Math.round(mc / 100_000).toLocaleString('en-US')} saved`,
  other: (kind, n) => (kind === 'in' ? `${n} smaller flows` : 'Their pipelines'),
  sink: { name: 'Removed by Cribl', caption: (t) => `$${Math.round(t.savedPerDayM / 100_000)} / day` },
};

function flow(inputId: string, pipelineId: string, outputId: string, inGb: number, outGb: number, mcPerGb = 225_000): LayoutFlow {
  const whp = Math.round(inGb * mcPerGb);
  const paid = Math.round(outGb * mcPerGb);
  return {
    key: `dc|${inputId}|${inputId}|${pipelineId}|${outputId}`,
    groupId: 'dc',
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
  } as LayoutFlow;
}

/** The crowded desk map (W3-FLOW-3): a dozen pipelines into one SIEM, two into a lake, every wedge pooled in the sink. */
const CROWDED: LayoutFlow[] = [
  flow('pan_east', 'pan_agg', 'siem', 3100, 1880),
  flow('pan_west', 'pan_agg', 'siem', 2200, 1310),
  flow('win_ws', 'win_ws_trim', 'siem', 3200, 2720),
  flow('fwd_fleet', 'passthrough', 'siem', 2700, 2700),
  flow('payments', 'pay_sample', 'siem', 2300, 620),
  flow('win_srv', 'win_xml', 'siem', 1900, 1280),
  flow('win_dc', 'win_evt_trim', 'siem', 1700, 1150),
  flow('proxy', 'proxy_trim', 'siem', 1400, 850),
  flow('asa', 'asa_trim', 'siem', 1100, 720),
  flow('syslog', 'syslog_trim', 'siem', 900, 640),
  flow('dns', 'dns_lake', 'lake', 1100, 1100 * 0.08, 50_000),
  flow('esxi', 'esxi_lake', 'lake', 394, 394 * 0.1, 50_000),
];

const COLORS = ['siem', 'lake'];
const layoutOf = (flows: readonly LayoutFlow[], width: number, maxHeight: number, extra: Partial<Parameters<typeof computeFlowLayout>[1]> = {}): FlowLayout =>
  computeFlowLayout(flows, { width, maxHeight, text: TEXT, colorOrder: COLORS, sink: true, ...extra });

const MAPS: [string, FlowLayout][] = [
  ['desk 1180×700', layoutOf(CROWDED, 1180, 700)],
  ['desk 960×600', layoutOf(CROWDED, 960, 600)],
  ['desk 1500×820', layoutOf(CROWDED, 1500, 820)],
  ['stage 1400×880 at 2', layoutOf(CROWDED, 1400, 880, { scale: 2, fill: true })],
  ['stage 1100×600 at 1.5', layoutOf(CROWDED, 1100, 600, { scale: 1.5, fill: true })],
];

describe('W3-FLOW-3: on a crowded map a saved plate stays in its pipeline row, or a leader joins it to its wedge', () => {
  for (const [name, L] of MAPS) {
    it(`${name}`, () => {
      const plates = L.labels.filter((l) => l.kind === 'saved');
      expect(plates.length).toBeGreaterThan(3);
      for (const l of plates) {
        const r = L.ribbons.find((x) => x.id === l.ownerId)!;
        const pipe = L.nodes.find((n) => n.id === r.pipeId)!;
        if (l.inBand) {
          expect(boxOnWedge(l, r), `${l.id} touches its own wedge`).toBe(true);
          expect(l.leader).toBeUndefined();
          const cy = l.y + l.h / 2;
          expect(cy, `${l.id} centre in its row`).toBeGreaterThanOrEqual(pipe.y0 - l.h / 2 - 0.01);
          expect(cy, `${l.id} centre in its row`).toBeLessThanOrEqual(pipe.y1 + l.h / 2 + 0.01);
        } else {
          expect(l.leader, `${l.id} has a leader`).toBeDefined();
          const { x1, y1, x2, y2 } = l.leader!;
          // one end on the plate's edge (its top or bottom, or its left edge back towards the pipeline)
          expect(x1).toBeGreaterThanOrEqual(l.x - 0.01);
          expect(x1).toBeLessThanOrEqual(l.x + l.w + 0.01);
          expect(y1).toBeGreaterThanOrEqual(l.y - 0.01);
          expect(y1).toBeLessThanOrEqual(l.y + l.h + 0.01);
          expect([l.y, l.y + l.h].some((e) => Math.abs(e - y1) < 0.01) || Math.abs(x1 - l.x) < 0.01).toBe(true);
          // a short line, never across the map (a plate sits at most 140 px right of its pipeline, at the label scale)
          expect(Math.hypot(x2 - x1, y2 - y1), `${l.id} leader length`).toBeLessThan(200 * L.scale);
          // the leader's other end is on the middle of its own wedge
          const end = r.s2.sinkTop !== undefined ? (r.s2.sinkX ?? r.s2.x1) : r.s2.x1;
          const w = wedgePointAt(r.s2, tAtX(r.s2.x0, end, x2));
          expect(Math.abs(y2 - w.y)).toBeLessThan(0.01);
          // a leader starts near the pipeline row, not several rows away
          const near = Math.min(Math.abs(l.y - pipe.y1), Math.abs(l.y + l.h - pipe.y0), l.y < pipe.y1 && l.y + l.h > pipe.y0 ? 0 : Infinity);
          expect(near, `${l.id} beside its row`).toBeLessThanOrEqual(3 * l.h + 12);
        }
      }
    });
  }
});

describe('W3-FLOW-1/2: pipeline names come before plates, on one line', () => {
  for (const [name, L] of MAPS) {
    it(`${name}: every plate's pipeline is named, every name is one line`, () => {
      const named = new Set(L.labels.filter((l) => l.kind === 'node-pipe').map((l) => l.ownerId));
      for (const l of L.labels.filter((x) => x.kind === 'saved')) {
        const r = L.ribbons.find((x) => x.id === l.ownerId)!;
        expect(named.has(r.pipeId), `${l.id}: ${r.pipeId} is named`).toBe(true);
      }
      for (const l of L.labels.filter((x) => x.kind === 'node-pipe')) expect(l.lines, l.id).toHaveLength(1);
      // the tour's pipelines are all named on these maps
      expect(named.size).toBe(L.nodes.filter((n) => n.kind === 'pipe').length);
    });
  }

  it('a long pipeline name is truncated in the middle, its whole name kept for the <title>', () => {
    const long = (id: string) => `Extremely long pipeline name for ${id} that never ends`;
    const text: LayoutText = { ...TEXT, name: (kind, id) => (kind === 'pipe' ? long(id) : TEXT.name(kind, id)) };
    const L = layoutOf(CROWDED.slice(0, 6), 1180, 700, { text });
    const names = L.labels.filter((l) => l.kind === 'node-pipe');
    expect(names.length).toBeGreaterThanOrEqual(4);
    for (const l of names) {
      expect(l.lines).toHaveLength(1);
      expect(l.full).toBe(long(L.nodes.find((n) => n.id === l.ownerId)!.rawId));
      if (l.truncated) {
        expect(l.lines[0].text).toContain('…');
        expect(l.lines[0].text.endsWith('ends')).toBe(true);
      }
    }
    // never over a plate
    const plates = L.labels.filter((l) => l.plate);
    for (const n of names) for (const p of plates) expect(n.x < p.x + p.w && p.x < n.x + n.w && n.y < p.y + p.h && p.y < n.y + n.h, `${n.id} over ${p.id}`).toBe(false);
  });
});

describe('W3-FLOW-1: no money plate sits on another route’s incident outline', () => {
  const pay = CROWDED.find((f) => f.inputId === 'payments')!;
  const marks: Record<string, FlowMark> = { [pay.key]: { tone: 'high', text: '−$25 / day since 3:50 PM · a1f3c9e', short: '−$25 / day · a1f3c9e', tiny: '−$25 / day' } };
  for (const [name, w, h, extra] of [
    ['desk', 1180, 700, {}],
    ['stage', 1400, 880, { scale: 2, fill: true }],
    ['small stage', 1100, 600, { scale: 1.5, fill: true }],
  ] as const) {
    it(`${name}`, () => {
      const L = layoutOf(CROWDED, w, h, { ...extra, marks });
      const marked = L.ribbons.find((r) => r.flowKey === pay.key)!;
      expect(L.labels.some((l) => l.kind === 'incident')).toBe(true);
      for (const l of L.labels.filter((x) => (x.kind === 'saved' || x.kind === 'whp') && x.ownerId !== marked.id)) {
        expect(boxOnOutline(l, marked), `${l.id} on the incident's outline`).toBe(false);
      }
    });
  }
});

// App QA 9/27 (after wave 3): two more placement rules, on the crowded maps above and on a map with a folded tail.
describe('a leader never crosses a label it does not point at (the Story P1-C03 rule on the Flow map)', () => {
  const TIGHT: [string, FlowLayout][] = [...MAPS, ['desk 882×577 (the tour at 1440×900)', layoutOf(CROWDED, 882, 577)], ['desk 882×520', layoutOf(CROWDED, 882, 520)]];
  for (const [name, L] of TIGHT) {
    it(`${name}`, () => {
      const withLeader = L.labels.filter((l) => l.leader);
      for (const l of withLeader) {
        for (const other of L.labels) {
          if (other.id === l.id) continue;
          expect(segmentHitsBox(l.leader!, other), `${l.id}'s leader crosses ${other.id} (${other.full})`).toBe(false);
        }
      }
    });
  }
  it('the sample tour at the 1440 × 900 frame (882 × 577): leaders drawn, none through another label', () => {
    const { doc } = buildTourDoc();
    const group = doc.snapshot.flows[0].groupId;
    const L = layoutOf(doc.snapshot.flows.filter((f) => f.groupId === group) as unknown as LayoutFlow[], 882, 577);
    const withLeader = L.labels.filter((l) => l.leader);
    expect(withLeader.length, 'the tight frame needs leaders').toBeGreaterThan(0);
    for (const l of withLeader) for (const other of L.labels) if (other.id !== l.id) expect(segmentHitsBox(l.leader!, other), `${l.id} × ${other.id}`).toBe(false);
  });

  it('segmentHitsBox: a vertical leader through a plate hits it; one beside it does not', () => {
    const box = { x: 540, y: 410, w: 87, h: 20 };
    expect(segmentHitsBox({ x1: 584.5, y1: 392.7, x2: 584.5, y2: 443.5 }, box)).toBe(true);
    expect(segmentHitsBox({ x1: 640, y1: 392.7, x2: 640, y2: 443.5 }, box)).toBe(false);
    expect(segmentHitsBox({ x1: 500, y1: 400, x2: 530, y2: 400 }, box)).toBe(false);
  });
});

describe('the folded "N smaller flows" row carries one plate of each kind, with the row total (App QA 9/27)', () => {
  // three big flows and a long tail feeding two destinations: the tail folds into one source row with two ribbons
  const tail = Array.from({ length: 14 }, (_, i) => flow(`tail${i}`, `tail_pipe${i}`, i % 2 ? 'siem' : 'lake', 22 + i, 11 + i / 2, i % 2 ? 225_000 : 50_000));
  const FOLDED: LayoutFlow[] = [flow('big_a', 'pipe_a', 'siem', 3000, 1800), flow('big_b', 'pipe_b', 'siem', 2600, 1500), flow('big_c', 'pipe_c', 'lake', 2000, 200, 50_000), ...tail];
  for (const [w, h] of [
    [1180, 700],
    [882, 577],
  ] as const) {
    it(`${w}×${h}`, () => {
      const L = layoutOf(FOLDED, w, h);
      const folded = L.ribbons.filter((r) => r.flow.inputId === '~other');
      expect(folded.length, 'the tail folds into ribbons to both destinations').toBeGreaterThanOrEqual(2);
      const ids = new Set(folded.map((r) => r.id));
      const whp = L.labels.filter((l) => l.kind === 'whp' && ids.has(l.ownerId));
      const saved = L.labels.filter((l) => l.kind === 'saved' && ids.has(l.ownerId));
      expect(whp.length, 'one would-have-paid plate on the folded row').toBeLessThanOrEqual(1);
      expect(saved.length, 'one saved plate on the folded row').toBeLessThanOrEqual(1);
      const total = folded.reduce((a, r) => a + r.flow.whpPerDayM, 0);
      for (const l of whp) expect(l.full).toBe(TEXT.whp(total));
      const savedTotal = folded.reduce((a, r) => a + r.flow.savedPerDayM, 0);
      for (const l of saved) expect(l.full).toBe(TEXT.saved(savedTotal));
    });
  }
});
