// tests/unit/flow-source-colors.test.ts — every Source on the Flow map wears its own hue (DECISIONS D55).
//
// The owner (9/27): three of the top sources sharing one blue is a terrible look; then "a calmer set built around
// Cribl teal and blue with one warm accent: no two sources alike, no source sharing its destination's colour". These
// pin the two halves of the fix:
//   1. assignment (sourceColors.ts, layout.ts sourceHues): the top five sources by would-have-paid get five distinct
//      hues; a colour follows its source's id, never its rank (a sweep that swaps two sources' ranks repaints nothing,
//      input order is irrelevant, the byte map and a What-if projection colour the map as the live one does); sources
//      past five take the neutral tail, never a repeated hue;
//   2. the palette (src/styles/palette.css --mr-src-1..5, resolved through Capra's own palette tables): five families
//      (teal, azure, navy, purple, copper) that, as drawn over the panel at the band opacity, keep every PAIR ≥ 14 ΔE
//      apart for full-colour readers and ≥ 8 under protanopia and deuteranopia (OKLab ×100, Machado 2009); none reads
//      as the incident red or amber, the saved hatch or the ink the destinations are drawn in; a light band holds 3:1 on
//      the white panel (P1-I03), and the $ / day plate on any band reads at ≥ 4.5:1.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { getChartTheme } from '@capra/theme/visualizations';
import { GB, OTHER_ID, computeFlowLayout, nodeId, sourceHues, type LayoutFlow, type LayoutText } from '../../src/components/FlowDiagram/layout.ts';
import { SOURCE_HUES, assignSourceHues, hashKey, hueClass } from '../../src/components/FlowDiagram/sourceColors.ts';

const TEXT: LayoutText = {
  name: (kind, id) => `${kind} ${id}`,
  caption: () => 'caption',
  whp: (mc) => `$${Math.round(mc / 100_000)} / day`,
  saved: (mc) => `$${Math.round(mc / 100_000)} saved`,
  other: (kind, n) => (kind === 'in' ? `${n} smaller flows` : 'Their pipelines'),
};

function flow(inputId: string, outputId: string, dollarsPerDay: number, extra: Partial<LayoutFlow> = {}, groupId = 'default'): LayoutFlow {
  const whp = Math.round(dollarsPerDay * 100_000);
  const paid = Math.round(whp * 0.7);
  return {
    key: `${groupId}|${inputId}|${inputId}|p_${inputId}|${outputId}`,
    groupId,
    inputId,
    routeId: inputId,
    pipelineId: `p_${inputId}`,
    outputId,
    inBPerDay: (dollarsPerDay / 2.5) * GB,
    outBPerDay: (dollarsPerDay / 2.5) * GB * 0.7,
    whpPerDayM: whp,
    paidPerDayM: paid,
    savedPerDayM: whp - paid,
    ratePerHourM: Math.round(paid / 24),
    ...extra,
  };
}

/** The live rig: the owner's three into SIEM (prod) first. */
const RIG: LayoutFlow[] = [
  flow('mrd_windows_dc', 'mrd_siem_prod', 375),
  flow('mrd_windows_workstations', 'mrd_siem_prod', 200),
  flow('mrd_pan_firewall', 'mrd_siem_prod', 150),
  flow('mrd_payments_api', 'mrd_siem_prod', 100),
  flow('mrd_k8s_prod', 'mrd_analytics', 90),
  flow('mrd_vpc_flow', 'mrd_archive_s3', 2),
];

/** A tour-sized group: eleven named sources, two of them feeding two destinations. */
const WIDE: LayoutFlow[] = [
  ['win_workstations', 7185],
  ['pan_fw_east', 6933],
  ['splunk_uf_fleet', 6055],
  ['payments_api', 5098],
  ['pan_fw_west', 5016],
  ['win_servers', 4210],
  ['win_dc', 3771],
  ['web_proxy', 3062],
  ['infoblox_dns', 2559],
  ['cisco_asa', 2438],
  ['vmware_esxi', 887],
].map(([id, d]) => flow(id as string, 'splunk_cloud', d as number));
WIDE.push(flow('pan_fw_east', 's3_archive', 400, { key: 'default|pan_fw_east|pan_fw_east|p2|s3_archive', pipelineId: 'p2', routeId: 'pan_fw_east' }));

const src = (id: string, groupId = 'default') => nodeId('in', groupId, id);

describe('assignSourceHues: rank picks who is coloured, the id picks the hue', () => {
  it('gives the top five sources five distinct hues and leaves the rest to the tail', () => {
    const totals = new Map<string, number>();
    for (const f of WIDE) totals.set(src(f.inputId), (totals.get(src(f.inputId)) ?? 0) + f.whpPerDayM);
    const hues = assignSourceHues(totals);
    expect(SOURCE_HUES).toBe(5);
    expect(hues.size).toBe(5);
    expect(new Set(hues.values()).size).toBe(5);
    for (const slot of hues.values()) expect(slot >= 0 && slot < SOURCE_HUES).toBe(true);
    // the five largest are the coloured ones
    const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
    expect([...hues.keys()].sort()).toEqual([...top].sort());
    expect(hues.has(src('win_servers'))).toBe(false);
  });

  it('is stable: the same totals in any order give the same hues, and so does a second call', () => {
    const entries = RIG.map((f) => [src(f.inputId), f.whpPerDayM] as const);
    const base = assignSourceHues(new Map(entries));
    fc.assert(
      fc.property(fc.shuffledSubarray([...entries], { minLength: entries.length, maxLength: entries.length }), (shuffled) => {
        expect(assignSourceHues(new Map(shuffled))).toEqual(base);
      }),
    );
    expect(assignSourceHues(new Map(entries))).toEqual(base);
  });

  it('never repaints on a rank swap: any dollars among the same five sources give the same hues', () => {
    const ids = RIG.slice(0, SOURCE_HUES).map((f) => src(f.inputId));
    const base = assignSourceHues(new Map(ids.map((id, i) => [id, 1000 - i])));
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: ids.length, maxLength: ids.length }), (dollars) => {
        expect(assignSourceHues(new Map(ids.map((id, i) => [id, dollars[i]])))).toEqual(base);
      }),
    );
  });

  it('a new source below the five changes nothing; one that enters the five takes a free hue and moves at most the one it displaces', () => {
    const totals = new Map(RIG.map((f) => [src(f.inputId), f.whpPerDayM]));
    const base = assignSourceHues(totals);
    expect(assignSourceHues(new Map([...totals, [src('mrd_tiny'), 1]]))).toEqual(base);
    const entered = assignSourceHues(new Map([...totals, [src('mrd_new_big'), 999 * 100_000]]));
    expect(entered.has(src('mrd_k8s_prod'))).toBe(false); // the smallest coloured one left the five
    expect(new Set(entered.values()).size).toBe(5);
    const moved = [...base.keys()].filter((k) => entered.has(k) && entered.get(k) !== base.get(k));
    expect(moved.length).toBeLessThanOrEqual(1);
  });

  it('skips zero, negative and non-finite totals, and hashes deterministically', () => {
    const hues = assignSourceHues(
      new Map([
        ['a', 0],
        ['b', -5],
        ['c', Number.NaN],
        ['d', 10],
      ]),
    );
    expect([...hues.keys()]).toEqual(['d']);
    expect(hashKey('in:default:mrd_windows_dc')).toBe(hashKey('in:default:mrd_windows_dc'));
    expect(hashKey('a')).not.toBe(hashKey('b'));
    expect(hueClass(0)).toBe('mr-flow-s1');
    expect(hueClass(4)).toBe('mr-flow-s5');
    expect(hueClass(undefined)).toBe('mr-flow-tail');
  });
});

describe('sourceHues and the layout: one hue per source, on every map', () => {
  it('the owner\'s three into SIEM (prod) are three different hues; the rig\'s five largest differ and its $2 hairline is the tail', () => {
    const hues = sourceHues(RIG);
    const h = (id: string) => hues.get(src(id));
    expect(new Set([h('mrd_windows_dc'), h('mrd_windows_workstations'), h('mrd_pan_firewall')]).size).toBe(3);
    // Payments API and Kubernetes (a purple beside a lavender, the owner's first-cut complaint) are two of five families
    expect(h('mrd_payments_api')).not.toBe(h('mrd_k8s_prod'));
    expect(new Set(RIG.slice(0, 5).map((f) => h(f.inputId))).size).toBe(5);
    expect(h('mrd_vpc_flow')).toBeUndefined();
  });

  it('sums a source over its flows, per group, and never colours the fold or an undrawable flow', () => {
    const flows = [
      ...WIDE,
      flow('idle', 'splunk_cloud', 0),
      flow(OTHER_ID, 'splunk_cloud', 99_999, { folded: 12 }),
      flow('win_dc', 'splunk_cloud', 3000, {}, 'cloud'),
    ];
    const hues = sourceHues(flows);
    expect(hues.has(src('idle'))).toBe(false);
    expect(hues.has(src(OTHER_ID))).toBe(false);
    // Palo Alto east's two flows sum to the second-largest total and it is coloured
    expect(hues.has(src('pan_fw_east'))).toBe(true);
    // another group is its own map: its lone source is coloured there
    expect(hues.has(src('win_dc', 'cloud'))).toBe(true);
    expect(hues.has(src('win_dc'))).toBe(false);
  });

  it('draws each ribbon and each source node in its source\'s hue; the destination ramp index is unchanged', () => {
    const L = computeFlowLayout(WIDE, { width: 1400, text: TEXT, groupBelowShare: 0, colorOrder: ['s3_archive', 'splunk_cloud'] });
    const hues = sourceHues(WIDE);
    for (const r of L.ribbons) {
      expect(r.hue, r.id).toBe(hues.get(r.sourceId));
      expect(r.colorIndex, r.id).toBe(r.flow.outputId === 's3_archive' ? 0 : 1);
    }
    for (const n of L.nodes.filter((x) => x.kind === 'in')) expect(n.hue, n.id).toBe(hues.get(n.id));
    // both of Palo Alto east's ribbons wear one hue
    const pan = L.ribbons.filter((r) => r.flow.inputId === 'pan_fw_east');
    expect(pan).toHaveLength(2);
    expect(pan[0].hue).toBe(pan[1].hue);
    // five hued sources, the rest the tail (no hue), never a sixth repeated hue
    const hued = new Set(L.ribbons.filter((r) => r.hue !== undefined).map((r) => r.sourceId));
    expect(hued.size).toBe(5);
    const bySlot = new Map<number, Set<string>>();
    for (const r of L.ribbons) if (r.hue !== undefined) bySlot.set(r.hue, new Set([...(bySlot.get(r.hue) ?? []), r.sourceId]));
    for (const ids of bySlot.values()) expect(ids.size).toBe(1);
  });

  it('keeps every hue on the byte map, when the map folds or caps, and in a What-if projection given the live hues', () => {
    const live = sourceHues(RIG);
    const hueOf = (L: ReturnType<typeof computeFlowLayout>) => Object.fromEntries(L.ribbons.filter((r) => !r.folded).map((r) => [r.sourceId, r.hue]));
    const dollars = hueOf(computeFlowLayout(RIG, { width: 1020, text: TEXT }));
    expect(hueOf(computeFlowLayout(RIG, { width: 1020, text: TEXT, weightBy: 'bytes' }))).toEqual(dollars);
    // a phone's map draws fewer flows: the ones it draws keep their hues
    const phone = hueOf(computeFlowLayout(RIG, { width: 390, text: TEXT, maxFlows: 3 }));
    for (const [id, h] of Object.entries(phone)) expect(h).toBe(dollars[id]);
    // the projection multiplies the smallest flow's dollars (enough to change ranks) but is coloured from the live flows
    const projected = RIG.map((f) => (f.inputId === 'mrd_vpc_flow' ? { ...f, whpPerDayM: f.whpPerDayM * 400, projected: true } : f));
    expect(hueOf(computeFlowLayout(projected, { width: 1020, text: TEXT, sourceColors: live }))).toEqual(dollars);
    // a folded "smaller flows" ribbon never takes a hue
    const folded = computeFlowLayout(WIDE, { width: 1400, text: TEXT, groupBelowShare: 0.08 });
    for (const r of folded.ribbons.filter((x) => x.folded)) expect(r.hue).toBeUndefined();
  });
});

// ─── The palette, measured ───────────────────────────────────────────────────

/** Capra's visualization tokens resolved through its own palette tables (theme-independent by design). */
function capraHex(token: string): string {
  const name = token.replace(/^visualization\./, '');
  if (name.startsWith('consistent.')) {
    const names = ['Brown', 'Blue', 'Tomato', 'Teal', 'Plum', 'Amber', 'Cribl Teal', 'Red', 'Yellow', 'Bronze', 'Indigo', 'Gold', 'Iris', 'Lime', 'Violet', 'Grass', 'Purple', 'Green', 'Pink', 'Jade', 'Crimson', 'Mint', 'Ruby', 'Cyan', 'Orange', 'Sky'];
    const i = names.indexOf(name.slice('consistent.'.length));
    expect(i, token).toBeGreaterThanOrEqual(0);
    return getChartTheme({ palette: 'consistent', mode: 'light' }).palette[i];
  }
  const m = name.match(/^(.+)\.(\d+)$/)!;
  const palette = getChartTheme({ palette: m[1] as Parameters<typeof getChartTheme>[0]['palette'], mode: 'light' }).palette;
  const hex = palette[Number(m[2]) - 1];
  expect(hex, token).toMatch(/^#[0-9a-f]{6}$/i);
  return hex;
}

/** The --mr-src-N tokens of one rule block of palette.css. */
function sourceTokens(css: string, selector: string): string[] {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const block = css.slice(start, css.indexOf('}', start));
  return Array.from({ length: SOURCE_HUES }, (_, i) => {
    const m = block.match(new RegExp(`--mr-src-${i + 1}: token\\('([^']+)'\\)`));
    expect(m, `${selector} --mr-src-${i + 1}`).not.toBeNull();
    return m![1];
  });
}

const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const over = (fg: string, bg: string, a: number): number[] => rgb(fg).map((c, i) => c * a + rgb(bg)[i] * (1 - a));
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (c: number[]) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const MACHADO = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
};
function oklab(linear: number[]): number[] {
  const [r, g, b] = linear;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
/** OKLab ΔE ×100, under normal vision or a simulated deficiency. */
function deltaE(a: number[], b: number[], kind?: keyof typeof MACHADO): number {
  const sim = (c: number[]) => {
    const l = c.map(lin);
    if (!kind) return l;
    const M = MACHADO[kind];
    return M.map((row) => Math.max(0, Math.min(1, row[0] * l[0] + row[1] * l[1] + row[2] * l[2])));
  };
  const [x, y] = [oklab(sim(a)), oklab(sim(b))];
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

const PALETTE_CSS = readFileSync(new URL('../../src/styles/palette.css', import.meta.url), 'utf8');
const FLOW_CSS = readFileSync(new URL('../../src/components/FlowDiagram/FlowDiagram.css', import.meta.url), 'utf8');

/** Each theme as the map draws it: the panel, the text, the band opacity and the plate. */
const THEMES = {
  light: { selector: 'body:not(.dark)', panel: '#ffffff', text: '#1c2024', alpha: 0.9, minBand: 3, wedgeFill: 0.18 },
  dark: { selector: 'body,\n.dark', panel: '#18191b', text: '#edeef0', alpha: 0.88, minBand: 2.2, wedgeFill: 0.2 },
} as const;
const SAVED = '#30a46c';
const INCIDENT = { high: '#e5484d', medium: '#ffc100' };
/** The saved wedge as the eye averages it: the green tint under 1.5 px lines at 0.7 every 6 px. */
const hatchAsDrawn = (panel: number[], tint: number): number[] => {
  const g = rgb(SAVED);
  const bg = panel.map((c, k) => c * (1 - tint) + g[k] * tint);
  const line = bg.map((c, k) => c * 0.3 + g[k] * 0.7);
  return bg.map((c, k) => c * 0.75 + line[k] * 0.25);
};

describe('the source palette, measured as drawn (D55)', () => {
  it('draws light bands at 0.9 and dark bands at 0.88 (the opacities the palette was measured at)', () => {
    expect(FLOW_CSS).toMatch(/\.mr-flow-svg \{[^}]*--mr-band-hi: 0\.9;/);
    expect(FLOW_CSS).toMatch(/body\.dark \.mr-flow-svg \{[^}]*--mr-band-hi: 0\.88;/);
  });

  for (const [theme, T] of Object.entries(THEMES)) {
    describe(theme, () => {
      const tokens = sourceTokens(PALETTE_CSS, T.selector);
      const bands = tokens.map((tk) => over(capraHex(tk), T.panel, T.alpha));
      const panel = rgb(T.panel);

      it('five Capra visualization tokens, five different colours', () => {
        for (const tk of tokens) expect(tk).toMatch(/^visualization\./);
        expect(new Set(tokens.map(capraHex)).size).toBe(SOURCE_HUES);
      });

      it('every pair stays apart: ≥ 14 ΔE for full-colour readers, ≥ 8 under protanopia and deuteranopia', () => {
        for (let i = 0; i < bands.length; i++)
          for (let j = i + 1; j < bands.length; j++) {
            const pair = `${tokens[i]} vs ${tokens[j]}`;
            expect(deltaE(bands[i], bands[j]), pair).toBeGreaterThanOrEqual(14);
            expect(Math.min(deltaE(bands[i], bands[j], 'protan'), deltaE(bands[i], bands[j], 'deutan')), pair).toBeGreaterThanOrEqual(8);
          }
      });

      it('no band reads as the incident red or amber, the saved hatch, or the ink the destinations are drawn in', () => {
        const hatch = hatchAsDrawn(panel, T.wedgeFill);
        for (const [i, b] of bands.entries()) {
          for (const [name, hex] of Object.entries(INCIDENT)) expect(deltaE(b, rgb(hex)), `${tokens[i]} vs incident ${name}`).toBeGreaterThanOrEqual(10);
          expect(deltaE(b, hatch), `${tokens[i]} vs the saved hatch`).toBeGreaterThanOrEqual(15);
          // the Cribl teal is the nearest hue to the saved green's solid colour; the wedge is never solid (a hatch)
          expect(deltaE(b, rgb(SAVED)), `${tokens[i]} vs the solid saved green`).toBeGreaterThanOrEqual(7);
          expect(deltaE(b, rgb(T.text)), `${tokens[i]} vs a destination's ink`).toBeGreaterThanOrEqual(15);
        }
      });

      it(`every band holds ${T.minBand}:1 on the panel, and its $ / day plate reads at 4.5:1`, () => {
        for (const [i, b] of bands.entries()) {
          expect(contrast(b, panel), tokens[i]).toBeGreaterThanOrEqual(T.minBand);
          // the plate is the panel at 0.94 over the band: the text on it never depends on the band's hue
          const plate = [0, 1, 2].map((k) => panel[k] * 0.94 + b[k] * 0.06);
          expect(contrast(rgb(T.text), plate), `${tokens[i]} plate`).toBeGreaterThanOrEqual(4.5);
        }
      });
    });
  }

  it('destinations are ink on the map (no source shares its destination\'s colour), and the neutral tail holds 3:1 (P1-I03)', () => {
    expect(FLOW_CSS).toMatch(/\.mr-flow-node--out \.mr-flow-node-bar \{\s*fill: token\('color\.foreground\.default'\);/);
    expect(FLOW_CSS).toMatch(/\.mr-flowmap-chip-dot \{[^}]*background: token\('color\.foreground\.default'\);/);
    // the tail is one neutral at the band's own opacity (the dollar map fades nothing by price): color.neutral.11 in
    // light (slate 11, #60646c: 4.7:1), color.neutral.8 in dark (slate 8, #5a6169: 2.4:1, the dark contract is 2:1),
    // each a lightness step away from the muted Cribl teal, the hue nearest grey
    expect(PALETTE_CSS).toMatch(/body:not\(\.dark\) \{[^}]*--mr-src-tail: token\('color\.neutral\.11'\);/);
    expect(PALETTE_CSS).toMatch(/body,\n\.dark \{[^}]*--mr-src-tail: token\('color\.neutral\.8'\);/);
    for (const [theme, T] of Object.entries(THEMES)) {
      const tail = over(theme === 'light' ? '#60646c' : '#5a6169', T.panel, T.alpha);
      expect(contrast(tail, rgb(T.panel)), `${theme} tail`).toBeGreaterThanOrEqual(theme === 'light' ? 3 : 2);
      for (const tk of sourceTokens(PALETTE_CSS, T.selector)) expect(deltaE(tail, over(capraHex(tk), T.panel, T.alpha)), `${theme} tail vs ${tk}`).toBeGreaterThanOrEqual(10);
    }
  });
});
