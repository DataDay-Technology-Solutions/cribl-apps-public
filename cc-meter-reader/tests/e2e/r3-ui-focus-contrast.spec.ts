// r3 ui-6 (FINDINGS_R3 #12, r3/5 F2): r2 ui-13 (IC-17) fixed the focus ring only for the top tabs. About 25 component
// rules kept Capra's `border.focus` ring (blue-8: 2.33:1 on white, 2.22:1 on the settings grey), and being more
// specific than base.css's :where() rule they won: the Receipt list's lines, the Ledger's sort buttons and links, the
// Prices history toggle, the Flow map's chips, the skip link… Every one is now drawn in the accent foreground.
// This spec tabs through every stop on six views in both themes and measures each ring we draw (outline, or a 2px
// box-shadow ring) against the opaque backdrop it sits on: at least 3:1 (WCAG 1.4.11). Capra's own controls
// (class capra-*, or a bare input a Capra control wraps) draw Capra's ring, which is Cribl's palette (the BO-18 / IC-16
// carve-out; measured 2.22–2.33:1 in light); they are listed in the test's annotations with their ratio, not asserted.
// Probes: app-assurance r3/5/specs/zz-r3f5-focus.spec.ts (focus/chromium-focus-*.json), OUT/skeptic2-r3-focus.

import { expect, test, type Page } from '@playwright/test';
import { gotoApp, kvGet, resetMock, seedPrices, setTheme, waitForHydration } from './helpers/index.ts';

const VIEWS = ['/', '/ledger', '/settings/prices', '/settings?section=notifications', '/report?report=mtd', '/whatif'];
const STOPS = 30;

interface Stop {
  el: string;
  capra: boolean;
  ring: string | null;
  ratio: number | null;
}

/** Tabs through `n` stops from the top of the page; for each, the ring we can see and its contrast with its backdrop. */
async function stops(page: Page, n: number): Promise<Stop[]> {
  const out: Stop[] = [];
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.click(2, 2);
  for (let i = 0; i < n; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(60);
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body || !el.matches(':focus-visible')) return null;
      // Each stop once (a Tab loop that wraps around repeats them).
      const w = window as unknown as { __seen?: Set<Element> };
      if ((w.__seen ??= new Set()).has(el)) return null;
      w.__seen.add(el);
      type RGBA = [number, number, number, number];
      const parse = (c: string): RGBA | null => {
        const m = c.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
      };
      const over = (top: RGBA, under: RGBA): RGBA => {
        const a = top[3];
        return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
      };
      const lum = (c: RGBA) => {
        const f = (v: number) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
      };
      const ratio = (a: RGBA, b: RGBA) => {
        const x = lum(a);
        const y = lum(b);
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
      };
      /**
       * An element's own paint: its background, unless an absolutely placed ::before panel paints over it (the Receipt
       * hero is painted in the border colour and its ::before is the card, so its perforated edge has an outline).
       */
      const paint = (e: Element): RGBA | null => {
        const before = getComputedStyle(e, '::before');
        if (before.content !== 'none' && before.position === 'absolute') {
          const b = parse(before.backgroundColor);
          if (b && b[3] >= 1) return b;
        }
        return parse(getComputedStyle(e).backgroundColor);
      };
      /** The colour an element's background resolves to, compositing translucent layers down to an opaque one. */
      const backdrop = (start: Element | null): RGBA => {
        const layers: RGBA[] = [];
        for (let e = start; e; e = e.parentElement) {
          const c = paint(e);
          if (c && c[3] > 0) {
            layers.push(c);
            if (c[3] >= 1) break;
          }
        }
        const dark = document.body.classList.contains('dark');
        let acc: RGBA = dark ? [17, 17, 19, 1] : [255, 255, 255, 1];
        for (let k = layers.length - 1; k >= 0; k--) acc = over(layers[k], acc);
        return acc;
      };
      const cs = getComputedStyle(el);
      const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') ?? '');
      const name = `${el.tagName}.${cls.slice(0, 50)} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}"`;
      const ow = parseFloat(cs.outlineWidth) || 0;
      const oo = parseFloat(cs.outlineOffset) || 0;
      let ringColor: RGBA | null = null;
      let behind: RGBA;
      const svg = el instanceof SVGElement ? el.ownerSVGElement : null;
      if (svg) {
        // An SVG stop draws its ring as a stroke: its own (a ribbon key), a ring inside it (a timeline marker), or the
        // map's focus rectangle around it (a Flow node). It sits on whatever is behind the chart.
        const own = cs.stroke && cs.stroke !== 'none' ? cs.stroke : null;
        const inner = el.querySelector('[class*="ring"]');
        const innerStroke = inner ? getComputedStyle(inner).stroke : 'none';
        const rect = svg.querySelector('.mr-flow-focus');
        const rectStroke = rect ? getComputedStyle(rect).stroke : 'none';
        const stroke = own ?? (innerStroke !== 'none' ? innerStroke : rectStroke !== 'none' ? rectStroke : null);
        ringColor = stroke ? parse(stroke) : null;
        behind = backdrop(svg.parentElement);
      } else if (cs.outlineStyle !== 'none' && ow > 0) {
        ringColor = parse(cs.outlineColor);
        // An outline outside the box sits on what is behind the element; an inset one on the element itself.
        behind = oo + ow <= 0 ? backdrop(el) : backdrop(el.parentElement);
      } else {
        // A box-shadow ring (0 0 0 2px <colour>, inset or not): its last colour.
        const colours = cs.boxShadow.match(/rgba?\([^)]+\)/g) ?? [];
        ringColor = colours.length ? parse(colours[colours.length - 1]) : null;
        behind = cs.boxShadow.includes('inset') ? backdrop(el) : backdrop(el.parentElement);
      }
      const shown = ringColor ? over(ringColor, behind) : null;
      return {
        el: name,
        // Capra's own control: its class, or a bare native input a Capra control wraps (Radio, Switch, Checkbox).
        capra: /\bcapra-/.test(cls) || (!cls.trim() && /\bcapra-/.test(String(el.parentElement?.className ?? ''))),
        ring: ringColor ? `rgba(${ringColor.join(',')})` : null,
        ratio: shown ? Math.round(ratio(shown, behind) * 100) / 100 : null,
      };
    });
    if (!stop) continue;
    out.push({ el: stop.el, capra: stop.capra, ring: stop.ring, ratio: stop.ratio });
  }
  return out;
}

for (const theme of ['light', 'dark'] as const) {
  test(`every focus ring we draw holds 3:1 on its backdrop (${theme})`, async ({ page }, info) => {
    test.setTimeout(300_000);
    await gotoApp(page, '/first-run');
    await resetMock(page);
    await seedPrices(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await expect.poll(async () => (await kvGet(page, 'snapshot')) !== null, { timeout: 60_000 }).toBe(true);
    const low: string[] = [];
    const capra: string[] = [];
    let measured = 0;
    for (const view of VIEWS) {
      await page.goto(view, { waitUntil: 'domcontentloaded' });
      await waitForHydration(page);
      await setTheme(page, theme);
      await page.waitForTimeout(1200);
      await page.evaluate(() => delete (window as unknown as { __seen?: Set<Element> }).__seen);
      for (const s of await stops(page, STOPS)) {
        if (s.capra) {
          capra.push(`${view} ${s.el} ${s.ratio ?? 'no ring'}`);
          continue;
        }
        measured++;
        if (s.ratio === null || s.ratio < 3) low.push(`${view} ${s.el} ring ${s.ring ?? 'none'} → ${s.ratio ?? 'no ring'}:1`);
      }
    }
    info.annotations.push({ type: 'capra rings (Cribl palette, not asserted)', description: capra.join('\n') });
    expect(measured, 'rings of ours measured').toBeGreaterThan(10);
    expect(low).toEqual([]);
  });
}
