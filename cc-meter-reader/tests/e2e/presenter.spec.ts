// tests/e2e/presenter.spec.ts — the stage view and the incident takeover (PRD 8.1, 8.8 item 8; DESIGN_BRIEF
// 5.2), on the in-browser emulator.
//
// The presenter's test hook (src/views/Presenter/testHook.ts, mock builds only) pauses polling and the UI
// meter so the spec can put an exact snapshot on stage and then open, deliver and close incidents the way a
// sweep would publish them — the detector itself is covered by the unit and integration suites.
//
// Beauty evidence: tests/report/beauty/presenter-<theme>-<width>.png, takeover-<theme>-<width>.png,
// takeover-recovery-<theme>-<width>.png at 1920 and 1440 (PRD 8.8 item 12). Only the `chromium` project
// writes them (shooting()), so the phone and 1920 projects never overwrite the grid.
//
// BEAUTY F1: the takeover owns the lower half and must never cover what the audience still needs at the
// payoff — the hero's figure and caption, all five savers, the QR and its vote ask (`coveredBy`).

import { expect, test, type Page } from '@playwright/test';
import type { Incident, Settings, Snapshot } from '../../core/types.ts';
import { gotoApp, setTheme, trackConsoleErrors, type Theme } from './helpers/index.ts';

const BEAUTY = 'tests/report/beauty';
const SCREENS = 'tests/report/screens';
const MC = 100_000; // millicents per dollar

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SAVERS = [
  { id: 'mrd_win_xml_pack', label: 'Windows event trimming', perDay: 1_340 },
  { id: 'mrd_pan_pack', label: 'Firewall duplicate suppression', perDay: 912 },
  { id: 'mrd_k8s_noise', label: 'Kubernetes noise filter', perDay: 640 },
  { id: 'mrd_pay_sample', label: 'Payments API sampling', perDay: 388 },
  { id: 'mrd_cdn_agg', label: 'CDN log aggregation', perDay: 121 },
];

function snapshotAt(now: number, incidents: Incident[] = []): Snapshot {
  const perDayM = SAVERS.reduce((s, x) => s + x.perDay, 0) * MC + 118 * MC; // $3,519 / day
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    schemaVersion: 1,
    sweepAt: iso(now - 4_000),
    windowStart: iso(now - 64_000),
    windowEnd: iso(now - 4_000),
    mode: 'ui',
    headline: {
      todayM: 1_602 * MC,
      mtdM: 91_420 * MC,
      d30M: 104_380 * MC,
      annualizedM: perDayM * 365,
      annualizedFromDays: 5,
      whpMtdM: 152_400 * MC,
      paidMtdM: 60_980 * MC,
      ratioMtd: 0.6,
      whpTodayM: 2_670 * MC,
      paidTodayM: 1_068 * MC,
      whp30dM: 174_000 * MC,
      paid30dM: 69_620 * MC,
    },
    ratePerSecM: perDayM / 86_400,
    flows: [],
    destinations: [],
    topSavers: SAVERS.map((s) => ({
      objectKey: `pipe:default:${s.id}`,
      label: s.label,
      savedPerDayM: s.perDay * MC,
      ratio: 0.6,
      groupId: 'default',
      pipelineId: s.id,
    })),
    unpricedOutputIds: [],
    openIncidents: incidents.filter((i) => !i.closedAt).length,
    incidents,
    trend: [],
    ratioSeries: [],
    timeline: [],
    deliveries: [],
    calls: 22,
    collectingSince: iso(now - 5 * 86_400_000),
    metricsSource: 'metrics-query',
    attributionSummary: 'route',
  };
}

/** P0-14: a 66-character label (a two-line title at 1920) and a 121-character commit message. */
const LONG_LABEL = 'Firewall duplicate suppression for the Palo Alto perimeter cluster';
const LONG_MESSAGE = 'feat(pan): rework the perimeter dedupe pipeline so the audit keeps every threat log while dropping the traffic duplicates';

const SLACK_ENDPOINT = {
  id: 'ep_slack',
  name: 'Slack',
  url: 'https://hooks.slack.com/services/T000/B000/abcd',
  host: 'hooks.slack.com',
  format: 'slack' as const,
  minSeverity: 'medium' as const,
  weeklyReceipt: true,
  enabled: true,
};

function regression(now: number, over: Partial<Incident> = {}): Incident {
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    id: 'inc_7f3a01',
    type: 'regression',
    severity: 'high',
    objectKey: 'pipe:default:mrd_pay_sample',
    label: 'Payments API sampling',
    outputId: 'mrd_siem_prod',
    openedAt: iso(now - 1_000),
    cause: 'commit',
    commit: {
      hash: 'a1f3c9e5b2',
      message: 'demo: break the trim on mrd_pay_sample',
      author: 's.koelpin',
      committedAt: iso(now - 180_000),
      deployedAt: iso(now - 171_000),
      groupId: 'default',
      match: 'message',
    },
    before: 0.75,
    after: 0.5,
    impactPerDayM: 25 * MC,
    caughtInSec: 170,
    notes: ['demo-profile'],
    deliveries: [],
    ...over,
  };
}

/**
 * P2-W15: the Payments API flow's last 30 minutes as the sweep records them — 75 % until the minute the change
 * deployed, 50 % after — so the cards can draw the drop.
 */
function payFlow(windowEndMs: number, deployMs: number, recoverMs?: number): Snapshot['flows'][number] {
  const values = Array.from({ length: 30 }, (_, i) => {
    const minuteStart = windowEndMs - (30 - i) * 60_000;
    if (recoverMs !== undefined && minuteStart >= recoverMs) return 0.75;
    return minuteStart + 60_000 <= deployMs ? 0.75 : 0.5;
  });
  return {
    key: 'default|mrd_payments_api|mrd_payments_api|mrd_pay_sample|mrd_siem_prod',
    groupId: 'default',
    inputId: 'mrd_payments_api',
    routeId: 'mrd_payments_api',
    pipelineId: 'mrd_pay_sample',
    outputId: 'mrd_siem_prod',
    inB: 0,
    outB: 0,
    whpM: 0,
    paidM: 0,
    savedM: 0,
    ratio: 0.5,
    ratePerHourM: 0,
    savedPerDayM: 388 * MC,
    whpPerDayM: 780 * MC,
    paidPerDayM: 392 * MC,
    inBPerDay: 0,
    outBPerDay: 0,
    attribution: 'route',
    sparkline: values,
    state: 'regression',
  };
}

// ─── Driving the page ────────────────────────────────────────────────────────

interface Hook {
  store: {
    getState(): { settings: Settings; snapshot: Snapshot | null };
    setState(p: Record<string, unknown>): void;
  };
  stop(): void;
}

async function openPresenter(page: Page, theme: Theme, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await gotoApp(page, '/?present=1');
  await page.waitForFunction(() => '__MR_PRESENTER__' in window);
  await setTheme(page, theme);
  // Pause polling and the UI meter, then put an exact snapshot on stage (source stays 'live').
  const now = await page.evaluate(() => Date.now());
  await page.evaluate(
    ({ snap, endpoint }) => {
      const h = (window as unknown as { __MR_PRESENTER__: Hook }).__MR_PRESENTER__;
      h.stop();
      const { settings } = h.store.getState();
      h.store.setState({
        snapshot: snap,
        source: 'live',
        errors: {},
        // A priced workspace (with no prices document nothing can meter, and the stage says so: WP-D, P1-D01).
        prices: { schemaVersion: 1, updatedAt: new Date(0).toISOString(), versions: [] },
        settings: {
          ...settings,
          notifications: [endpoint],
          presenter: { ...settings.presenter, headlinePeriod: 'annualized' },
        },
      });
    },
    { snap: snapshotAt(now), endpoint: SLACK_ENDPOINT },
  );
  await expect.poll(() => stageDollars(page)).toBe(1_284_435);
}

async function publishIncidents(page: Page, incidents: Incident[]): Promise<void> {
  await page.evaluate((incs) => {
    const h = (window as unknown as { __MR_PRESENTER__: Hook }).__MR_PRESENTER__;
    const snap = h.store.getState().snapshot;
    if (!snap) throw new Error('no snapshot on stage');
    h.store.setState({
      snapshot: {
        ...snap,
        incidents: incs,
        openIncidents: incs.filter((i) => !i.closedAt).length,
      },
    });
  }, incidents);
}

async function pageNow(page: Page): Promise<number> {
  return page.evaluate(() => Date.now());
}

/** Replaces fields of the snapshot on stage. */
async function patchSnapshot(page: Page, patch: Partial<Snapshot>): Promise<void> {
  await page.evaluate((p) => {
    const h = (window as unknown as { __MR_PRESENTER__: Hook }).__MR_PRESENTER__;
    const snap = h.store.getState().snapshot;
    if (!snap) throw new Error('no snapshot on stage');
    h.store.setState({ snapshot: { ...snap, ...p } });
  }, patch);
}

interface StorePatch {
  live?: Record<string, unknown>;
  hydrate?: Record<string, unknown>;
  snapshot?: null;
  prices?: null;
}

/** Patches the runtime status (null deletes a field) and, optionally, clears the snapshot and prices. */
async function patchStore(page: Page, patch: StorePatch): Promise<void> {
  await page.evaluate((p) => {
    const h = (window as unknown as { __MR_PRESENTER__: { store: { getState(): Record<string, unknown>; setState(x: unknown): void } } })
      .__MR_PRESENTER__;
    const state = h.store.getState() as { status: Record<string, Record<string, unknown>> };
    const merge = (base: Record<string, unknown>, over?: Record<string, unknown>) => {
      const out: Record<string, unknown> = { ...base };
      for (const [k, v] of Object.entries(over ?? {})) {
        if (v === null) delete out[k];
        else out[k] = v;
      }
      return out;
    };
    const next: Record<string, unknown> = {
      status: { ...state.status, live: merge(state.status.live, p.live), hydrate: merge(state.status.hydrate, p.hydrate) },
    };
    if (p.snapshot === null) next.snapshot = null;
    if (p.prices === null) next.prices = null;
    h.store.setState(next);
  }, patch);
}

/** The computed colour of a CSS colour expression (a token variable), via a throwaway probe element. */
async function resolvedColor(page: Page, css: string): Promise<string> {
  return page.evaluate((value) => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = value;
    // Inside the stage when it is up: the stage is dark on every account (P1-A07), so its tokens are the dark ones.
    (document.querySelector('.mr-pv') ?? document.body).appendChild(probe);
    const out = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return out;
  }, css);
}

/** Whole dollars on the stage's figure (the Meter writes its value, in millicents, as data-value-m); NaN when absent. */
async function stageDollars(page: Page): Promise<number> {
  const figure = page.locator('.mr-pv-figure [data-callout="saved"][data-value-m]');
  if ((await figure.count()) === 0) return Number.NaN;
  return Math.floor(Number(await figure.getAttribute('data-value-m')) / MC);
}

/** Switches the stage's headline period through settings (the store the stage reads). */
async function setHeadlinePeriod(page: Page, period: 'annualized' | 'mtd' | 'today' | '30d'): Promise<void> {
  await page.evaluate((p) => {
    const h = (window as unknown as { __MR_PRESENTER__: Hook }).__MR_PRESENTER__;
    const { settings } = h.store.getState();
    h.store.setState({ settings: { ...settings, presenter: { ...settings.presenter, headlinePeriod: p } } });
  }, period);
}

/** Counts every requestAnimationFrame call in the page (installed before the app's own scripts run). */
async function countAnimationFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let calls = 0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      calls += 1;
      return raf(cb);
    };
    (window as unknown as { __mrRafCalls: () => number }).__mrRafCalls = () => calls;
  });
}

/** requestAnimationFrame calls per second over `ms` (Playwright's waits do not call it). */
async function framesPerSecond(page: Page, ms = 1_000): Promise<number> {
  const calls = () => page.evaluate(() => (window as unknown as { __mrRafCalls: () => number }).__mrRafCalls());
  const a = await calls();
  await page.waitForTimeout(ms);
  return ((await calls()) - a) / (ms / 1000);
}

/**
 * Open Sans (Capra's face, node_modules/@capra/theme/dist/font-files): ascender 2189 and descender 600 of 2048
 * units; every digit's ink lies between 21 units below the baseline and 1485 above it.
 */
const OPEN_SANS = { ascent: 2189 / 2048, descent: 600 / 2048, digitTop: 1485 / 2048, digitBottom: 21 / 2048 };

interface InkProbe {
  cells: number;
  /** ink pixels found above a digit window's cap line or below its baseline (should be 0) */
  outside: number;
  /** ink pixels inside the cap boxes (proves the probe saw the figure) */
  inside: number;
  worst: string;
}

/**
 * P0-16: compares a frame of the figure with the same region with the figure hidden; a pixel that differs is
 * ink. Each digit window's cap box comes from the font's metrics and the window's own line box; the bands above
 * the cap line and below the baseline (less 3 px for rounding) must carry no ink at all.
 */
async function probeDigitInk(page: Page, frame: Buffer, empty: Buffer, clip: { x: number; y: number }, cellSel: string): Promise<InkProbe> {
  const cells = await page.locator(cellSel).evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      const fs = parseFloat(getComputedStyle(el).fontSize);
      // The line box of one digit in the window's strip (its first child's first child).
      const digit = el.firstElementChild?.firstElementChild as HTMLElement | null;
      const lh = digit ? digit.getBoundingClientRect().height : r.height;
      return { x: r.x, y: r.y, w: r.width, h: r.height, fs, lh };
    }),
  );
  return page.evaluate(
    async ({ a, b, cells, ox, oy, m }) => {
      const decode = async (b64: string) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const off = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = off.getContext('2d')!;
        ctx.drawImage(bmp, 0, 0);
        return ctx.getImageData(0, 0, bmp.width, bmp.height);
      };
      const [fa, fb] = await Promise.all([decode(a), decode(b)]);
      const diff = (x: number, y: number) => {
        const i = (y * fa.width + x) * 4;
        return Math.max(Math.abs(fa.data[i] - fb.data[i]), Math.abs(fa.data[i + 1] - fb.data[i + 1]), Math.abs(fa.data[i + 2] - fb.data[i + 2]));
      };
      let outside = 0;
      let inside = 0;
      let worst = '';
      for (const [n, c] of cells.entries()) {
        const baseline = c.y + (m.ascent + (c.lh / c.fs - (m.ascent + m.descent)) / 2) * c.fs;
        // 3 px of slack: the clip's own 1.5 px, a device-pixel snap and the anti-aliased edge row.
        const capTop = baseline - m.digitTop * c.fs - 3;
        const inkBottom = baseline + m.digitBottom * c.fs + 3;
        for (let y = Math.ceil(c.y); y < Math.floor(c.y + c.h); y++) {
          for (let x = Math.ceil(c.x) + 1; x < Math.floor(c.x + c.w) - 1; x++) {
            const px = x - ox;
            const py = y - oy;
            if (px < 0 || py < 0 || px >= fa.width || py >= fa.height) continue;
            const d = diff(px, py);
            if (d <= 48) continue;
            if (y < capTop || y > inkBottom) {
              outside += 1;
              if (!worst) worst = `cell ${n} at y=${y} (cap ${capTop.toFixed(1)}–${inkBottom.toFixed(1)}), Δ${d}`;
            } else inside += 1;
          }
        }
      }
      return { cells: cells.length, outside, inside, worst };
    },
    { a: frame.toString('base64'), b: empty.toString('base64'), cells, ox: clip.x, oy: clip.y, m: OPEN_SANS },
  );
}

/** Hue (0–360) and saturation (0–1) of an rgb()/rgba() colour, or null when it is transparent or unparsable. */
function hueSat(color: string): { h: number; s: number } | null {
  const m = /rgba?\(([^)]+)\)/.exec(color);
  if (!m) return null;
  const [r, g, b, a = 1] = m[1]
    .split(/[ ,/]+/)
    .filter(Boolean)
    .map(Number);
  if (a < 0.1) return null;
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s };
}

/** Every painted colour on the stage (text, fill, border, outline, SVG fill), per element, with where it is. */
async function stageColours(page: Page): Promise<{ where: string; prop: string; color: string; inFigure: boolean }[]> {
  return page.evaluate(() => {
    const out: { where: string; prop: string; color: string; inFigure: boolean }[] = [];
    for (const el of document.querySelectorAll('.mr-pv, .mr-pv *')) {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
      const where = `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`;
      // The money figures: the hero, and the running total under it (P2-W01) — the stage's only green.
      // …and at rest the month's receipt bar and savings line (P2-W04): the saved segment is money too.
      const inFigure = !!el.closest('.mr-pv-figure, .mr-pv-session-figure, .mr-pv-rest');
      const hasText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim());
      const props: [string, string][] = [['background-color', style.backgroundColor]];
      if (hasText) props.push(['color', style.color]);
      for (const side of ['top', 'right', 'bottom', 'left']) {
        if (parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0) props.push([`border-${side}-color`, style.getPropertyValue(`border-${side}-color`)]);
      }
      if (el instanceof SVGElement && style.fill !== 'none') props.push(['fill', style.fill]);
      for (const [prop, color] of props) out.push({ where, prop, color, inFigure });
    }
    return out;
  });
}

/** Waits until the takeover's enter animation (450 ms slide-up) has finished, so its box is final. */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const el = document.querySelector('.mr-takeover');
    return !!el && el.getAnimations().every((a) => a.playState !== 'running' && !a.pending);
  });
}

/** What the audience still needs on stage while the card is up (BEAUTY F1). */
const MUST_STAY_VISIBLE = [
  '[data-callout="qr"]',
  '.mr-qr-caption',
  '.mr-pv-label',
  '.mr-pv-figure',
  '.mr-pv-caption',
  '.mr-pv-savers-title',
  '.mr-pv-item',
];

/** Every must-stay-visible box the takeover card intersects (by more than half a pixel), as "selector#i". */
async function coveredBy(page: Page, card = '.mr-takeover'): Promise<string[]> {
  return page.evaluate(
    ({ card, targets }) => {
      const c = document.querySelector(card)!.getBoundingClientRect();
      const out: string[] = [];
      for (const sel of targets) {
        const els = [...document.querySelectorAll(sel)];
        if (els.length === 0) out.push(`${sel} (missing)`);
        els.forEach((el, i) => {
          const r = el.getBoundingClientRect();
          const w = Math.min(c.right, r.right) - Math.max(c.left, r.left);
          const h = Math.min(c.bottom, r.bottom) - Math.max(c.top, r.top);
          if (w > 0.5 && h > 0.5) out.push(`${sel}#${i}`);
        });
      }
      return out;
    },
    { card, targets: MUST_STAY_VISIBLE },
  );
}

async function fontPx(page: Page, selector: string): Promise<number> {
  return page
    .locator(selector)
    .first()
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
}

/**
 * PRD 8.8 item 3: every text/background pair ≥ 4.5:1 (≥ 3:1 for large text: ≥ 24 px, or ≥ 18.66 px bold), in
 * both themes. Walks every visible text node under `root`, resolves the first opaque ancestor background.
 */
async function contrastFailures(page: Page, root: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const parse = (c: string): [number, number, number, number] | null => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return null;
      const p = m[1]
        .split(/[ ,/]+/)
        .filter(Boolean)
        .map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = (el: Element | null): number[] => {
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c && c[3] > 0.99) return c;
      }
      return parse(getComputedStyle(document.body).backgroundColor) ?? [255, 255, 255, 1];
    };
    const out: string[] = [];
    const rootEl = document.querySelector(sel);
    if (!rootEl) return [`no ${sel}`];
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || seen.has(el) || !(n.textContent ?? '').trim()) continue;
      seen.add(el);
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (
        rect.width === 0 ||
        style.visibility === 'hidden' ||
        Number(style.opacity) === 0 ||
        el.closest('[aria-hidden="true"], .mr-visually-hidden, .mr-meter-strip')
      )
        continue;
      const fg = parse(style.color);
      if (!fg) continue;
      const bg = bgOf(el);
      const a = fg[3];
      const mixed = [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
      const l1 = lum(mixed);
      const l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 600);
      if (ratio < (large ? 3 : 4.5)) out.push(`${(n.textContent ?? '').trim().slice(0, 40)} — ${ratio.toFixed(2)}:1`);
    }
    return out;
  }, root);
}

/** Contrast of one element's own text colour against its first opaque ancestor background. */
async function contrastOf(page: Page, selector: string): Promise<number> {
  return page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const parse = (c: string) =>
        (/rgba?\(([^)]+)\)/.exec(c)?.[1] ?? '0,0,0,0')
          .split(/[ ,/]+/)
          .filter(Boolean)
          .map(Number);
      const lum = (rgb: number[]) =>
        rgb
          .slice(0, 3)
          .map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4))
          .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      let bg = [255, 255, 255, 1];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if ((c[3] ?? 1) > 0.99) {
          bg = c;
          break;
        }
      }
      const a = lum(parse(getComputedStyle(el).color));
      const b = lum(bg);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
}

/** Beauty evidence is written by the `chromium` project only, so other projects never overwrite the grid. */
function shooting(): boolean {
  return test.info().project.name === 'chromium';
}

/** Wave-1 evidence for this package's changes (tests/report/screens/wave1-b-*.png), chromium project only. */
async function evidence(page: Page, name: string, opts: { selector?: string } = {}): Promise<void> {
  if (!shooting()) return;
  await page.evaluate(() => document.fonts.ready);
  const path = `${SCREENS}/wave1-b-${name}.png`;
  if (opts.selector) await page.locator(opts.selector).screenshot({ path });
  else await page.screenshot({ path, fullPage: false });
}

/** Wave-2 evidence for this package (tests/report/screens/wave2-b-*.png), chromium project only. */
async function evidence2(page: Page, name: string, opts: { selector?: string } = {}): Promise<void> {
  if (!shooting()) return;
  await page.evaluate(() => document.fonts.ready);
  const path = `${SCREENS}/wave2-b-${name}.png`;
  if (opts.selector) await page.locator(opts.selector).screenshot({ path });
  else await page.screenshot({ path, fullPage: false });
}

/** The evidence frames: both themes at 1920, 1440, 1280×720 and on a phone. */
const EVIDENCE_SIZES = [
  [1920, 1080],
  [1440, 900],
  [1280, 720],
  [390, 844],
] as const;

interface MorphFrame {
  card: boolean;
  mode?: string;
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  transform?: string;
  opacity?: number;
  ghost: number | null;
}

/** Samples every animation frame: the card on stage (box, transform, opacity) and the crossfade's frozen copy. */
async function startFrameSampler(page: Page, frames = 90): Promise<void> {
  await page.evaluate((max) => {
    const w = window as unknown as { __mrFrames: MorphFrame[] };
    w.__mrFrames = [];
    const tick = () => {
      const card = document.querySelector<HTMLElement>('.mr-takeover');
      const ghost = document.querySelector<HTMLElement>('.mr-tk-ghost');
      const r = card?.getBoundingClientRect();
      w.__mrFrames.push({
        card: !!card,
        mode: card?.dataset.mode,
        top: r?.top,
        bottom: r?.bottom,
        left: r?.left,
        right: r?.right,
        transform: card ? getComputedStyle(card).transform : undefined,
        opacity: card ? Number(getComputedStyle(card).opacity) : undefined,
        ghost: ghost ? Number(getComputedStyle(ghost).opacity) : null,
      });
      if (w.__mrFrames.length < max) requestAnimationFrame(tick);
    };
    tick(); // the frame on screen now, then every frame after it
  }, frames);
}

async function sampledFrames(page: Page): Promise<MorphFrame[]> {
  return page.evaluate(() => (window as unknown as { __mrFrames: MorphFrame[] }).__mrFrames);
}

async function shoot(page: Page, name: string, opts: { fullPage?: boolean; selector?: string } = {}): Promise<void> {
  if (!shooting()) return;
  await page.evaluate(() => document.fonts.ready);
  const path = `${BEAUTY}/${name}.png`;
  if (opts.selector) await page.locator(opts.selector).screenshot({ path });
  else await page.screenshot({ path, fullPage: opts.fullPage ?? true });
}

// ─── Stage layout ────────────────────────────────────────────────────────────

test.describe('presenter view', () => {
  test('the stage speaks its figure once per 30 s interval: no Meter live region beside the stage announcer (r1 ui-10, m21)', async ({ page }) => {
    test.skip(test.info().project.name !== 'chromium', 'a 65 s watch: one project covers it');
    test.setTimeout(120_000);
    await openPresenter(page, 'dark', 1920, 1080);
    // Every write to any live region on the stage, from now on, for 65 s.
    await page.evaluate(() => {
      const w = window as unknown as { __mrLive: { t: number; text: string; who: string }[] };
      w.__mrLive = [];
      const t0 = performance.now();
      const watch = (el: Element) => {
        new MutationObserver(() => {
          const text = (el.textContent ?? '').trim();
          if (text) w.__mrLive.push({ t: performance.now() - t0, text, who: el.getAttribute('data-testid') ?? el.className });
        }).observe(el, { childList: true, characterData: true, subtree: true });
      };
      document.querySelectorAll('[aria-live]').forEach(watch);
    });
    await page.waitForTimeout(65_000);
    const writes = await page.evaluate(() => (window as unknown as { __mrLive: { t: number; text: string; who: string }[] }).__mrLive);
    // One voice: the stage announcer (src/components/Shell/StageAnnouncer.tsx), once per 30 s.
    expect(writes.map((w) => w.who).filter((who) => who !== 'stage-announcer'), JSON.stringify(writes)).toEqual([]);
    for (const [from, to] of [[0, 30_000], [30_000, 60_000]] as const) {
      expect(writes.filter((w) => w.t >= from && w.t < to).length, `writes in [${from}, ${to}) ms: ${JSON.stringify(writes)}`).toBeLessThanOrEqual(1);
    }
    // The announcer itself spoke (it repeats the same words when the static run rate has not moved, so no new write).
    await expect(page.getByTestId('stage-announcer')).toHaveText(/^Saved by Cribl: \$[\d,]+, annualized run rate/);
    // The stage has no Meter status region of its own…
    expect(await page.locator('.mr-pv-figure [role="status"], .mr-pv-session [role="status"]').count()).toBe(0);
    // …but its figure stays readable as text (not live): a screen reader reading the stage still finds it (the wheels are
    // aria-hidden).
    await expect(page.locator('.mr-pv-figure .mr-meter > .mr-visually-hidden').first()).toHaveText(/: \$[\d,]+$/);
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`meets the 1920 stage checklist (${theme})`, async ({ page }) => {
      const errors = trackConsoleErrors(page);
      await openPresenter(page, theme, 1920, 1080);

      // Chrome hidden: no tab bar, no footer.
      await expect(page.getByRole('navigation')).toHaveCount(0);
      await expect(page.locator('.mr-footer')).toHaveCount(0);

      // PRD 8.8 item 8: hero ≥ 160 px, caption ≥ 28 px, top five ≥ 32 px, QR ≥ 220 px.
      expect(await fontPx(page, '.mr-pv-figure')).toBeGreaterThanOrEqual(160);
      expect(await fontPx(page, '.mr-pv-caption')).toBeGreaterThanOrEqual(28);
      expect(await fontPx(page, '.mr-pv-item')).toBeGreaterThanOrEqual(32);
      const qr = await page.locator('[data-callout="qr"]').boundingBox();
      expect(qr?.width ?? 0).toBeGreaterThanOrEqual(220);
      expect(qr?.height ?? 0).toBeGreaterThanOrEqual(220);

      // Copy and callouts.
      await expect(page.locator('.mr-pv-caption')).toHaveText('annualized run rate, from the last 5 days');
      await expect(page.locator('.mr-pv-item')).toHaveCount(5);
      await expect(page.locator('.mr-pv-item').first()).toContainText('Windows event trimming');
      await expect(page.locator('.mr-pv-item').first()).toContainText('$1,340');
      // The QR's caption says where the code goes (D51), stacked above the code in its own column (its " · "
      // joints are line breaks on stage).
      const ask = page.locator('.mr-qr-caption-main');
      await expect(ask).toHaveText('Meter Reader · get the App on GitHub');
      await expect(ask).toBeVisible();
      const askBox = (await page.locator('.mr-qr-caption').boundingBox())!;
      expect(askBox.x).toBeGreaterThanOrEqual(qr!.x - 0.5);
      expect(askBox.y + askBox.height).toBeLessThanOrEqual(qr!.y);
      // The stage is split at half height: the hero and the savers end in the upper half.
      for (const sel of ['.mr-pv-hero', '.mr-pv-savers']) {
        const box = (await page.locator(sel).boundingBox())!;
        expect(box.y + box.height, `${sel} bottom`).toBeLessThanOrEqual(1080 / 2);
      }
      await expect(page.locator('[data-callout="saved"]')).toBeVisible();

      // Corners breathe: nothing within 40 px of an edge.
      const boxes = await page.evaluate(() =>
        ['.mr-pv-top', '.mr-pv-hero', '.mr-pv-savers', '.mr-pv-qr', '.mr-pv-figure'].map((sel) => {
          const r = document.querySelector(sel)!.getBoundingClientRect();
          return {
            sel,
            left: r.left,
            top: r.top,
            right: window.innerWidth - r.right,
            bottom: window.innerHeight - r.bottom,
          };
        }),
      );
      for (const b of boxes) {
        for (const edge of [b.left, b.top, b.right, b.bottom]) expect(edge, `${b.sel} edge distance`).toBeGreaterThanOrEqual(40);
      }
      // No horizontal scroll, no default fonts.
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1920);
      expect(await page.locator('.mr-pv-figure').evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Open Sans');
      expect(await page.locator('.mr-pv-figure').evaluate((el) => getComputedStyle(el).fontVariantNumeric)).toContain('tabular-nums');

      await page.waitForTimeout(6_800); // let the exit hint fade, as it does on stage
      expect(await contrastFailures(page, '.mr-pv')).toEqual([]);
      // The hero's digits are aria-hidden (the odometer), so the walk above skips them: measure directly.
      expect(await contrastOf(page, '.mr-pv-figure')).toBeGreaterThanOrEqual(3);
      // The checker is not vacuous: a grey-on-grey probe is caught, and only it.
      await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.id = 'mr-contrast-probe';
        probe.textContent = 'probe';
        probe.style.cssText = 'color:#777;background:#888';
        document.querySelector('.mr-pv-top')!.appendChild(probe);
      });
      expect(await contrastFailures(page, '.mr-pv')).toEqual([expect.stringMatching(/^probe — 1\.\d\d:1$/)]);
      await page.evaluate(() => document.getElementById('mr-contrast-probe')!.remove());
      await shoot(page, `presenter-${theme}-1920`);
      expect(errors()).toEqual([]);
    });

    test(`reads at 1440 and at 390 on a phone (${theme})`, async ({ page }) => {
      const errors = trackConsoleErrors(page);
      await openPresenter(page, theme, 1440, 900);
      await shoot(page, `presenter-${theme}-1440`);

      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator('.mr-pv-figure')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      const qr = await page.locator('[data-callout="qr"]').boundingBox();
      expect(qr?.width ?? 0).toBeGreaterThanOrEqual(200);
      expect(await fontPx(page, '.mr-pv-figure')).toBeGreaterThanOrEqual(56);
      await shoot(page, `presenter-${theme}-390`);
      expect(errors()).toEqual([]);
    });
  }

  test('sample, replay, empty and unreachable states are designed', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openPresenter(page, 'dark', 1440, 900);
    const set = (patch: Record<string, unknown>) =>
      page.evaluate((p) => (window as unknown as { __MR_PRESENTER__: Hook }).__MR_PRESENTER__.store.setState(p), patch);

    // The shell hides the SAMPLE DATA band in presenter mode, so the stage carries its own marker.
    await set({ source: 'sample' });
    await expect(page.locator('.mr-pv-chip--sample')).toHaveText('Sample data');
    await expect(page.locator('.mr-pv-live')).toHaveCount(0);
    await shoot(page, 'presenter-sample-dark-1440');
    await set({ source: 'replay' });
    await expect(page.locator('.mr-pv-chip--sample')).toHaveText('Replay');

    // Never priced, never metered: "$—" and the next step, never a display-size "$0" (BEAUTY F2).
    await setTheme(page, 'light');
    await set({ source: 'live', snapshot: null, prices: null, errors: {} });
    await expect(page.locator('.mr-pv-caption')).toHaveText('Set prices to start the meter');
    await expect(page.locator('.mr-pv-empty')).toHaveText('Top savers appear after the first priced sweep.');
    await expect(page.locator('.mr-pv-figure--empty')).toContainText('$—');
    await expect(page.locator('.mr-pv-figure--empty')).toContainText('Saved by Cribl: no figure yet. Set prices to start the meter');
    await expect(page.locator('.mr-pv-figure [data-value-m]')).toHaveCount(0);
    expect(await page.locator('.mr-pv-hero').innerText()).not.toMatch(/\$0\b/);
    await expect(page.locator('.mr-pv-live')).toBeVisible();
    expect(await contrastFailures(page, '.mr-pv')).toEqual([]);
    await shoot(page, 'presenter-empty-light-1440');
    await setTheme(page, 'dark');
    await shoot(page, 'presenter-empty-dark-1440');
    await setTheme(page, 'light');

    // Priced, but the first sweep has not landed; then the Leader is unreachable.
    await set({ prices: { schemaVersion: 1, updatedAt: new Date().toISOString(), versions: [] } });
    await expect(page.locator('.mr-pv-caption')).toHaveText('Waiting for the first sweep');
    await set({ errors: { snapshot: { kind: 'server', status: 503, at: Date.now() } } });
    await expect(page.locator('.mr-pv-caption')).toHaveText("Couldn't reach Cribl. Showing the last good data.");
    expect(errors()).toEqual([]);
  });

  // P0-08: the stage status is derived from the same data status as the chrome — never "Live" forever.
  test('the stage status tells the truth: live, stale, offline, rate limited, unpriced, loading', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openPresenter(page, 'dark', 1440, 900);
    const status = page.locator('.mr-pv-live');
    const label = status.locator('.mr-pv-live-label');
    const green = await resolvedColor(page, 'var(--mr-fill-saved)');
    const dot = () => status.locator('.mr-pv-live-dot').evaluate((el) => getComputedStyle(el).backgroundColor);
    const glow = () => page.locator('.mr-pv-hero').evaluate((el) => getComputedStyle(el, '::before').display);

    // Fresh data: Live, with a neutral dot (the money green is spent only on the money).
    await expect(status).toHaveAttribute('data-status', 'live');
    await expect(label).toHaveText('Live');
    await expect(status).toContainText(/updated \d+ s ago|updated just now/);
    expect(await dot()).not.toBe(green);
    expect(await glow()).not.toBe('none');

    // A snapshot older than STALE_AFTER_MS (5 min): Stale, and how old.
    const now = await pageNow(page);
    await patchSnapshot(page, { sweepAt: new Date(now - 2 * 86_400_000).toISOString() });
    await expect(status).toHaveAttribute('data-status', 'stale');
    await expect(label).toHaveText('Stale');
    await expect(status).toContainText('updated 2 days ago');
    await evidence(page, 'status-stale-dark-1440');

    // Every poll answers 502: Offline.
    await patchStore(page, { live: { lastError: { kind: 'server', status: 502, at: now } } });
    await expect(status).toHaveAttribute('data-status', 'offline');
    await expect(label).toHaveText('Offline');

    // Rate limited by the Leader: says so, and when it checks again.
    await patchStore(page, { live: { lastError: { kind: 'rate-limited', status: 429, at: now }, backoffUntil: now + 60_000 } });
    await expect(status).toHaveAttribute('data-status', 'rate-limited');
    await expect(label).toHaveText('Rate limited');
    await expect(status).toContainText(/next check \d{1,2}:\d{2} [AP]M/);

    // Never priced: no green dot, no glow, nothing claims to be live.
    await patchStore(page, { live: { lastError: null, backoffUntil: null }, snapshot: null, prices: null });
    await expect(status).toHaveAttribute('data-status', 'unpriced');
    await expect(label).toHaveText('Not metering yet');
    expect(await dot()).not.toBe(green);
    expect(await glow()).toBe('none');
    await expect(page.locator('.mr-pv-caption')).toHaveText('Set prices to start the meter');

    // Loading: a skeleton with no glow and no basis sentence (never "from today so far" before any data).
    await patchStore(page, { hydrate: { phase: 'loading' } });
    await expect(status).toHaveAttribute('data-status', 'connecting');
    await expect(page.locator('.mr-pv-figure-skeleton')).toBeVisible();
    expect(await glow()).toBe('none');
    await expect(page.locator('.mr-pv-caption')).toHaveText('');
    await expect(page.locator('.mr-pv-hero')).not.toContainText('annualized run rate');
    await evidence(page, 'status-loading-dark-1440');
    expect(errors()).toEqual([]);
  });

  // P0-15: a 720p or 768p projector (or a laptop at that resolution) fits the whole stage: no vertical
  // scroll, and every callout keeps the 40 px the corners need — the QR scales with the frame's height.
  for (const [width, height] of [
    [1280, 720],
    [1366, 768],
  ] as const) {
    for (const theme of ['dark', 'light'] as const) {
      test(`fits a ${width}x${height} projector: no scroll, every callout 40 px from each edge (${theme}, P0-15)`, async ({ page }) => {
        const errors = trackConsoleErrors(page);
        await openPresenter(page, theme, width, height);
        await page.evaluate(() => document.fonts.ready);
        const fit = await page.evaluate(() => ({
          scrollHeight: document.documentElement.scrollHeight,
          scrollWidth: document.documentElement.scrollWidth,
          innerHeight: window.innerHeight,
          callouts: [...document.querySelectorAll('[data-callout]')].map((el) => {
            const r = el.getBoundingClientRect();
            return {
              id: el.getAttribute('data-callout'),
              left: r.left,
              top: r.top,
              right: window.innerWidth - r.right,
              bottom: window.innerHeight - r.bottom,
            };
          }),
        }));
        expect(fit.scrollHeight, 'document scrollHeight').toBe(fit.innerHeight);
        expect(fit.scrollWidth).toBeLessThanOrEqual(width);
        // The stage's callouts: the hero, the QR, and at rest the month's receipt bar (P2-W04).
        expect(fit.callouts.map((c) => c.id).sort()).toEqual(['paid', 'qr', 'saved', 'whp']);
        for (const c of fit.callouts) {
          for (const edge of ['left', 'top', 'right', 'bottom'] as const) {
            expect(c[edge], `${c.id} ${edge} edge distance`).toBeGreaterThanOrEqual(40);
          }
        }
        // The split still holds: the hero and the savers end in the upper half.
        for (const sel of ['.mr-pv-hero', '.mr-pv-savers']) {
          const box = (await page.locator(sel).boundingBox())!;
          expect(box.y + box.height, `${sel} bottom`).toBeLessThanOrEqual(height / 2);
        }
        await evidence(page, `stage-${theme}-${width}x${height}`);

        // And with the takeover up: the card fits, nothing the audience needs is covered, still no scroll.
        const t0 = await pageNow(page);
        const deliveredAt = new Date(t0 + 2_000).toISOString();
        await publishIncidents(page, [regression(t0, { deliveries: [{ endpointId: 'ep_slack', status: 200, at: deliveredAt }], lastNotifiedAt: deliveredAt })]);
        await expect(page.locator('.mr-takeover')).toHaveAttribute('data-delivered', 'true');
        await settled(page);
        expect(await coveredBy(page)).toEqual([]);
        const card = await page.locator('.mr-takeover').evaluate((el) => ({ scroll: el.scrollHeight - el.clientHeight, bottom: window.innerHeight - el.getBoundingClientRect().bottom }));
        expect(card.scroll).toBeLessThanOrEqual(0);
        expect(card.bottom).toBeGreaterThanOrEqual(40);
        expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(height);
        await evidence(page, `stage-takeover-${theme}-${width}x${height}`);
        expect(errors()).toEqual([]);
      });
    }
  }

  // P0-16: the digit window is the glyph's cap box — mid-ease, no fragment of the next or previous digit shows
  // above the cap line or below the baseline; at rest the clip never touches a digit's own ink.
  for (const [width, height] of [
    [1920, 1080],
    [1440, 900],
  ] as const) {
    test(`mid-ease the odometer shows no glyph fragments outside the digit windows (${width}x${height}, P0-16)`, async ({ page }) => {
      const errors = trackConsoleErrors(page);
      await openPresenter(page, 'dark', width, height);
      await page.waitForTimeout(6_800); // the exit hint has faded (it is not part of the probe, but keep the frame calm)
      const figure = page.locator('.mr-pv-figure');
      const cellSel = '.mr-pv-figure .mr-meter-wheel';
      const box = (await figure.boundingBox())!;
      const clip = { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width) + 2, height: Math.ceil(box.height) + 2 };
      const hide = (hidden: boolean) =>
        page.evaluate((h) => {
          const el = document.querySelector<HTMLElement>('.mr-pv-figure');
          if (el) el.style.visibility = h ? 'hidden' : '';
        }, hidden);
      await hide(true);
      const empty = await page.screenshot({ clip, scale: 'css' });
      await hide(false);

      // At rest: every digit is whole (the clip removes nothing but neighbours' ink).
      const rest = await page.screenshot({ clip, scale: 'css' });
      const atRest = await probeDigitInk(page, rest, empty, clip, cellSel);
      expect(atRest.cells).toBeGreaterThanOrEqual(7);
      expect(atRest.outside, atRest.worst).toBe(0);
      await page.addStyleTag({ content: '.mr-pv-figure .mr-meter-wheel { clip-path: none !important; }' });
      const unclipped = await page.screenshot({ clip, scale: 'css' });
      const same = await probeDigitInk(page, rest, unclipped, clip, cellSel);
      expect(same.outside + same.inside, 'the clip removes none of a resting digit').toBe(0);
      await page.evaluate(() => document.querySelectorAll('style').forEach((s) => s.textContent?.includes('clip-path: none !important') && s.remove()));

      // The worst mid-roll frame, held still: every wheel half-way between two digits (the static figure's frame
      // loop is idle at rest, so the positions stay put). Clipped, nothing shows outside the cap boxes; with the
      // clip removed the same frame shows the fragments the audit saw — the probe is not vacuous.
      const strips = page.locator(`${cellSel} .mr-meter-strip`);
      const resting = await strips.evaluateAll((els) => els.map((el) => (el as HTMLElement).style.transform));
      expect(resting).toHaveLength(atRest.cells);
      await strips.evaluateAll((els) => {
        for (const el of els) (el as HTMLElement).style.transform = `translate3d(0, ${(-3.5 * 100) / 11}%, 0)`;
      });
      const held = await probeDigitInk(page, await page.screenshot({ clip, scale: 'css' }), empty, clip, cellSel);
      expect(held.inside, 'the probe saw the figure').toBeGreaterThan(500);
      expect(held.outside, held.worst).toBe(0);
      await evidence(page, `odometer-half-roll-dark-${width}x${height}`, { selector: '.mr-pv-hero' });
      await page.addStyleTag({ content: '.mr-pv-figure .mr-meter-wheel { clip-path: none !important; }' });
      const bare = await probeDigitInk(page, await page.screenshot({ clip, scale: 'css' }), empty, clip, cellSel);
      expect(bare.outside, 'without the clip the half-roll frame shows fragments').toBeGreaterThan(200);
      await evidence(page, `odometer-half-roll-unclipped-dark-${width}x${height}`, { selector: '.mr-pv-hero' });
      await page.evaluate(() => document.querySelectorAll('style').forEach((s) => s.textContent?.includes('clip-path: none !important') && s.remove()));
      await strips.evaluateAll((els, before) => els.forEach((el, i) => ((el as HTMLElement).style.transform = before[i])), resting);

      // A real ease: a snapshot that moves every digit but the first, sampled through the 900 ms ease.
      const now = await pageNow(page);
      await patchSnapshot(page, { headline: { ...snapshotAt(now).headline, annualizedM: 1_398_762 * MC }, sweepAt: new Date(now).toISOString() });
      const frames: InkProbe[] = [];
      for (const wait of [120, 120, 120, 120]) {
        await page.waitForTimeout(wait);
        const frame = await page.screenshot({ clip, scale: 'css' });
        frames.push(await probeDigitInk(page, frame, empty, clip, cellSel));
        if (frames.length === 1) await evidence(page, `odometer-mid-ease-dark-${width}x${height}`, { selector: '.mr-pv-hero' });
      }
      for (const f of frames) {
        expect(f.inside, 'the probe saw the figure').toBeGreaterThan(500);
        expect(f.outside, f.worst).toBe(0);
      }
      await expect.poll(() => stageDollars(page)).toBe(1_398_762);
      expect(errors()).toEqual([]);
    });
  }

  // P0-16 · P1-B03: the stage's Meter follows prefers-reduced-motion live — switching it on while the stage is up
  // stops the frame loop at once; switching it off starts the ticking again.
  test('reduced motion switched on while the stage is up stops the frame loop (P0-16, P1-B03)', async ({ page }) => {
    await countAnimationFrames(page);
    await openPresenter(page, 'dark', 1440, 900);
    await setHeadlinePeriod(page, 'mtd'); // a running total: it ticks between sweeps
    await expect(page.locator('.mr-pv-caption')).toHaveText('month to date');
    const figure = page.locator('.mr-pv-figure [data-callout="saved"]');
    // Ticking: the loop runs (it sleeps between the wheels' rolls, P1-B05, but it is scheduling frames).
    await expect(figure).toHaveAttribute('data-running', 'true');
    expect(await framesPerSecond(page)).toBeGreaterThan(5);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    // One frame for the media change to land; after it, no loop is scheduling frames.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(await framesPerSecond(page)).toBe(0);
    // The figure is still there, whole dollars, not ticking.
    await expect(page.locator('.mr-pv-figure [data-callout="saved"]')).toHaveAttribute('data-ticking', 'false');
    expect(await stageDollars(page)).toBeGreaterThanOrEqual(91_420);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(figure).toHaveAttribute('data-ticking', 'true');
    await expect(figure).toHaveAttribute('data-running', 'true');
    expect(await framesPerSecond(page)).toBeGreaterThan(5);
  });

  // P1-B03: the figure is sized from a fixed budget, so crossing $1M never shrinks the hero or moves its caption.
  test('the figure keeps one size across magnitudes: $290,905 and $1,286,345 (P1-B03)', async ({ page }) => {
    await openPresenter(page, 'dark', 1920, 1080);
    const measure = () =>
      page.evaluate(() => {
        const figure = document.querySelector('.mr-pv-figure [data-callout="saved"]')!;
        const caption = document.querySelector('.mr-pv-caption')!.getBoundingClientRect();
        return { fontSize: getComputedStyle(figure).fontSize, captionTop: Math.round(caption.top) };
      });
    const now = await pageNow(page);
    await patchSnapshot(page, { headline: { ...snapshotAt(now).headline, annualizedM: 290_905 * MC } });
    await expect.poll(() => stageDollars(page)).toBe(290_905);
    const small = await measure();
    await patchSnapshot(page, { headline: { ...snapshotAt(now).headline, annualizedM: 1_286_345 * MC } });
    await expect.poll(() => stageDollars(page)).toBe(1_286_345);
    const large = await measure();
    expect(large.fontSize).toBe(small.fontSize);
    expect(large.captionTop).toBe(small.captionTop);
    expect(parseFloat(large.fontSize)).toBeGreaterThanOrEqual(160);
  });

  // P1-B03: a fresh figure (entering the stage, or a period switch) starts where the money is now — the accrual since
  // the sweep included — instead of rolling up from the snapshot's own value for 900 ms.
  test('a fresh figure starts at the accrued value, never rolling through the accrual since the sweep (P1-B03)', async ({ page }) => {
    await openPresenter(page, 'dark', 1440, 900);
    const now = await pageNow(page);
    // A running total swept 120 s ago, accruing $10 a second: $1,200 has accrued since the sweep.
    await patchSnapshot(page, { sweepAt: new Date(now - 120_000).toISOString(), ratePerSecM: 10 * MC });
    const firstFrames = await page.evaluate(async () => {
      const h = (window as unknown as { __MR_PRESENTER__: Hook }).__MR_PRESENTER__;
      const { settings } = h.store.getState();
      const seen: number[] = [];
      const read = () => {
        const el = document.querySelector('.mr-pv-figure [data-callout="saved"]');
        if (el?.getAttribute('data-value-m')) seen.push(Number(el.getAttribute('data-value-m')));
      };
      // The Meter is keyed by period: switching it mounts a fresh figure.
      h.store.setState({ settings: { ...settings, presenter: { ...settings.presenter, headlinePeriod: 'mtd' } } });
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        read();
      }
      return seen;
    });
    await expect(page.locator('.mr-pv-caption')).toHaveText('month to date');
    expect(firstFrames.length).toBeGreaterThan(10);
    // Every frame from the first is at least the snapshot's value plus 119 s of accrual (never $91,420 rolling up).
    for (const m of firstFrames) expect(m).toBeGreaterThanOrEqual((91_420 + 1_190) * MC);
  });

  // P1-B03: the QR reads from the back of the room — ≥ 220 px at 1440, the code is the address (no URL line), and
  // the ask is ≥ 24 px at 1920 in at most two lines of its own.
  test('the QR is at least 220 px at 1440, with no address line and a large ask (P1-B03)', async ({ page }) => {
    await openPresenter(page, 'dark', 1440, 900);
    const qr = (await page.locator('[data-callout="qr"]').boundingBox())!;
    expect(qr.width).toBeGreaterThanOrEqual(220);
    expect(qr.height).toBeGreaterThanOrEqual(220);
    await expect(page.locator('.mr-pv .mr-qr-url')).toHaveCount(0);
    await expect(page.locator('.mr-pv [data-callout="qr"] svg')).toHaveAttribute('aria-label', /^QR code: /);
    await evidence(page, 'qr-dark-1440x900', { selector: '.mr-pv-bottom' });

    await page.setViewportSize({ width: 1920, height: 1080 });
    const ask = page.locator('.mr-qr-caption .mr-qr-line').last();
    await expect(ask).toHaveText('get the App on GitHub');
    expect(await fontPx(page, '.mr-qr-caption .mr-qr-line:last-of-type')).toBeGreaterThanOrEqual(24);
    const lines = await ask.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
    expect(lines).toBeLessThanOrEqual(2);
    // The caption never reaches outside the code's own column (the takeover owns everything to its left).
    const col = (await page.locator('.mr-pv-qr').boundingBox())!;
    const cap = (await page.locator('.mr-qr-caption').boundingBox())!;
    expect(cap.x).toBeGreaterThanOrEqual(col.x - 0.5);
    await evidence(page, 'qr-dark-1920x1080', { selector: '.mr-pv-bottom' });
  });

  // P1-B03: the stage spends the money green only on the money, and no Capra accent blue anywhere; the sample
  // chip is warning-tinted like the Shell's SAMPLE DATA band.
  for (const theme of ['dark', 'light'] as const) {
    test(`no success green outside the figure and no accent blue on the stage (${theme}, P1-B03)`, async ({ page }) => {
      await openPresenter(page, theme, 1440, 900);
      const check = async (state: string) => {
        const offenders = (await stageColours(page))
          .map((c) => ({ ...c, hs: hueSat(c.color) }))
          .filter((c) => c.hs && c.hs.s >= 0.3)
          .filter((c) => (!c.inFigure && c.hs!.h >= 100 && c.hs!.h <= 170) || (c.hs!.h >= 195 && c.hs!.h <= 250))
          .map((c) => `${state}: ${c.where} ${c.prop} ${c.color}`);
        expect(offenders).toEqual([]);
      };
      await check('live');
      const set = (patch: Record<string, unknown>) =>
        page.evaluate((p) => (window as unknown as { __MR_PRESENTER__: Hook }).__MR_PRESENTER__.store.setState(p), patch);
      await set({ source: 'sample' });
      const chip = page.locator('.mr-pv-chip--sample');
      await expect(chip).toHaveText('Sample data');
      await check('sample');
      const warning = await resolvedColor(page, 'var(--mr-fill-incident-medium-subtle)');
      expect(await chip.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(warning);
      expect(await contrastFailures(page, '.mr-pv-top')).toEqual([]);
      await evidence(page, `sample-chip-${theme}-1440`, { selector: '.mr-pv-top' });
      await set({ source: 'replay' });
      await check('replay');
    });
  }

  // P1-B03: the stage names its keys, "?" opens a stage-scaled list (not the app's small blue sheet over the
  // number), any key closes it without also acting, and Escape leaves presenter mode like P.
  for (const theme of ['dark', 'light'] as const) {
    test(`"?" opens the stage's own key list; any key closes it; Escape leaves (${theme}, P1-B03)`, async ({ page }) => {
      const errors = trackConsoleErrors(page);
      await openPresenter(page, theme, 1920, 1080);
      await expect(page.locator('.mr-pv-exit')).toHaveText('P leaves the presenter view · ? shows keys');

      await page.keyboard.press('?');
      const sheet = page.getByTestId('stage-keys');
      await expect(sheet).toBeVisible();
      await expect(sheet).toHaveAttribute('aria-modal', 'true');
      await expect(sheet.getByRole('heading', { name: 'Presenter keys' })).toBeVisible();
      await expect(sheet).toContainText('Leave the presenter view');
      await expect(sheet.locator('kbd')).toHaveText(['P', 'Esc', 'Y', '?', 'M']);
      await expect(page.getByText('Keyboard shortcuts')).toHaveCount(0); // the app's Capra sheet stays shut
      expect(await fontPx(page, '.mr-pv-key')).toBeGreaterThanOrEqual(24);
      expect(await contrastFailures(page, '.mr-pv-keys')).toEqual([]);
      const blue = (await stageColours(page))
        .map((c) => ({ ...c, hs: hueSat(c.color) }))
        .filter((c) => c.hs && c.hs.s >= 0.3 && c.hs.h >= 195 && c.hs.h <= 250);
      expect(blue).toEqual([]);
      await evidence(page, `stage-keys-${theme}-1920x1080`);

      // Any key closes it and is consumed: P here closes the list and does NOT also leave presenter mode.
      await page.keyboard.press('p');
      await expect(sheet).toHaveCount(0);
      await expect(page.locator('.mr-pv')).toBeVisible();
      // Focus is not left on a detached node.
      expect(await page.evaluate(() => document.activeElement?.isConnected ?? true)).toBe(true);

      // Escape leaves presenter mode, like P.
      await page.keyboard.press('Escape');
      await expect(page.locator('.mr-pv')).toHaveCount(0);
      await expect(page).not.toHaveURL(/present=1/);
      expect(errors()).toEqual([]);
    });
  }

  test('the key list fits a 720p frame and a phone (P1-B03)', async ({ page }) => {
    await openPresenter(page, 'dark', 1280, 720);
    await page.keyboard.press('?');
    const sheet = page.getByTestId('stage-keys');
    await expect(sheet).toBeVisible();
    const box = (await sheet.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(720);
    await evidence(page, 'stage-keys-dark-1280x720');
    // A click anywhere closes it, too.
    await page.mouse.click(10, 10);
    await expect(sheet).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press('?');
    await expect(sheet).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const phone = (await sheet.boundingBox())!;
    expect(phone.x).toBeGreaterThanOrEqual(15);
    expect(phone.x + phone.width).toBeLessThanOrEqual(390 - 15);
    await evidence(page, 'stage-keys-dark-390');
  });

  // An alert card on stage owns the keyboard: Escape dismisses the card and stays on stage (the next Escape leaves).
  test('Escape with an alert card up dismisses the card, not presenter mode (P1-B03)', async ({ page }) => {
    await openPresenter(page, 'dark', 1440, 900);
    const t0 = await pageNow(page);
    await publishIncidents(page, [regression(t0)]);
    await expect(page.locator('.mr-takeover')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.mr-takeover')).toHaveCount(0);
    await expect(page.locator('.mr-pv')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.mr-pv')).toHaveCount(0);
  });

  // Wave-1 evidence (chromium project only): every visible change of this package in both themes at the stage
  // sizes — rest, stale status, loading, sample chip, a held mid-roll odometer and the long-title takeover.
  for (const [width, height] of [
    [1920, 1080],
    [1440, 900],
    [1280, 720],
    [390, 844],
  ] as const) {
    test(`evidence: stage states in both themes (${width}x${height})`, async ({ page }) => {
      test.skip(!shooting(), 'evidence is written by the chromium project');
      const size = `${width}x${height}`;
      for (const theme of ['dark', 'light'] as const) {
        await openPresenter(page, theme, width, height);
        await evidence(page, `rest-${theme}-${size}`);
        // A held half-roll frame: two half digits inside each window, nothing outside it.
        const strips = page.locator('.mr-pv-figure .mr-meter-strip');
        const resting = await strips.evaluateAll((els) => els.map((el) => (el as HTMLElement).style.transform));
        await strips.evaluateAll((els) => els.forEach((el) => ((el as HTMLElement).style.transform = `translate3d(0, ${(-3.5 * 100) / 11}%, 0)`)));
        await evidence(page, `odometer-half-roll-${theme}-${size}`, { selector: '.mr-pv-hero' });
        await strips.evaluateAll((els, before) => els.forEach((el, i) => ((el as HTMLElement).style.transform = before[i])), resting);
        // Stale data: amber dot, "Stale · updated 2 days ago".
        const now = await pageNow(page);
        await patchSnapshot(page, { sweepAt: new Date(now - 2 * 86_400_000).toISOString() });
        await expect(page.locator('.mr-pv-live')).toHaveAttribute('data-status', 'stale');
        await evidence(page, `status-stale-${theme}-${size}`);
        await patchSnapshot(page, { sweepAt: new Date(now - 4_000).toISOString() });
        // The long-title takeover.
        const t0 = await pageNow(page);
        const deliveredAt = new Date(t0 + 2_000).toISOString();
        await publishIncidents(page, [
          regression(t0, {
            label: LONG_LABEL,
            commit: { ...regression(t0).commit!, message: LONG_MESSAGE },
            deliveries: [{ endpointId: 'ep_slack', status: 200, at: deliveredAt }],
            lastNotifiedAt: deliveredAt,
          }),
        ]);
        await expect(page.locator('.mr-takeover')).toHaveAttribute('data-delivered', 'true');
        await settled(page);
        await evidence(page, `takeover-longtitle-${theme}-${size}`);
        await page.keyboard.press('x');
        await expect(page.locator('.mr-takeover')).toHaveCount(0);
        // Sample data chip, then never priced (no glow, "Not metering yet"), then loading.
        await page.evaluate((p) => (window as unknown as { __MR_PRESENTER__: Hook }).__MR_PRESENTER__.store.setState(p), { source: 'sample' });
        await evidence(page, `sample-${theme}-${size}`);
        await page.evaluate((p) => (window as unknown as { __MR_PRESENTER__: Hook }).__MR_PRESENTER__.store.setState(p), { source: 'live' });
        await patchStore(page, { snapshot: null, prices: null });
        await expect(page.locator('.mr-pv-live')).toHaveAttribute('data-status', 'unpriced');
        await evidence(page, `status-unpriced-${theme}-${size}`);
        await patchStore(page, { hydrate: { phase: 'loading' } });
        await expect(page.locator('.mr-pv-figure-skeleton')).toBeVisible();
        await evidence(page, `status-loading-${theme}-${size}`);
      }
    });
  }

  // P2-W01: "Saved since you started watching" — $0.00 when the stage opens, the measured rate × the time watched
  // after that, frozen and grey when the data goes stale, and absent on sample data.
  test('the session line starts at $0.00, accrues the rate × the time watched, freezes when stale, and never shows on sample data (P2-W01)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.clock.install();
    await openPresenter(page, 'dark', 1920, 1080);
    const line = page.getByTestId('session-ticker');
    const value = async () => Number(await line.locator('[data-value-m]').getAttribute('data-value-m'));
    const rate = await page.evaluate(() => (window as unknown as { __MR_PRESENTER__: Hook }).__MR_PRESENTER__.store.getState().snapshot!.ratePerSecM);
    await expect(line).toBeVisible();
    await expect(line.locator('.mr-pv-session-label')).toHaveText('Saved since you started watching');
    await expect(line.locator('.mr-pv-session-rate')).toHaveText('~$0.04 a second');
    await expect(line).toHaveAttribute('data-frozen', 'false');
    // A fresh session with the clock held still: exactly $0.00 at entry.
    const setSource = (source: string) =>
      page.evaluate((src) => (window as unknown as { __MR_PRESENTER__: Hook }).__MR_PRESENTER__.store.setState({ source: src }), source);
    await setSource('sample');
    await expect(line).toHaveCount(0);
    await page.clock.pauseAt(new Date((await pageNow(page)) + 1_000));
    await setSource('live');
    await expect(line).toBeVisible();
    expect(await value()).toBe(0);
    await expect(line.locator('.mr-meter-cents')).toBeVisible();
    // Ten seconds of watching: at least the rate × 10 s.
    await page.clock.fastForward(10_000);
    await page.clock.resume();
    await expect.poll(value).toBeGreaterThanOrEqual(rate * 10);
    expect(await value()).toBeLessThan(rate * 14);
    // The hero stays in the upper half with the line under it; nothing on the stage has a callout for it.
    const hero = (await page.locator('.mr-pv-hero').boundingBox())!;
    expect(hero.y + hero.height).toBeLessThanOrEqual(1080 / 2);
    await expect(line.locator('[data-callout]')).toHaveCount(0);
    await evidence2(page, 'session-live-dark-1920x1080');

    // The data goes stale: the line freezes where it is, greys, and says why.
    await patchSnapshot(page, { sweepAt: new Date((await pageNow(page)) - 2 * 86_400_000).toISOString() });
    await expect(line).toHaveAttribute('data-frozen', 'true');
    await expect(line.locator('.mr-pv-session-rate')).toHaveText('paused until the data is live again');
    const held = await value();
    await page.clock.fastForward(10_000);
    await page.waitForTimeout(400);
    expect(await value()).toBeCloseTo(held, -2);
    const grey = await line.locator('.mr-pv-session-figure').evaluate((el) => getComputedStyle(el).color);
    const green = await resolvedColor(page, 'var(--mr-color-saved)');
    expect(grey).not.toBe(green);

    // Sample data: no session line at all.
    await page.evaluate(() => (window as unknown as { __MR_PRESENTER__: Hook }).__MR_PRESENTER__.store.setState({ source: 'sample' }));
    await expect(line).toHaveCount(0);
    expect(errors()).toEqual([]);
  });

  test('the session line under reduced motion: static between snapshots, the total moves only when one lands (P2-W01)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openPresenter(page, 'dark', 1440, 900);
    const line = page.getByTestId('session-ticker');
    const value = async () => Number(await line.locator('[data-value-m]').getAttribute('data-value-m'));
    await expect(line).toBeVisible();
    await expect(line.locator('.mr-meter-wheel')).toHaveCount(0);
    const first = await value();
    await page.waitForTimeout(1_500);
    expect(await value()).toBe(first);
    // A snapshot lands: the total steps to what accrued since the stage opened.
    const now = await pageNow(page);
    await patchSnapshot(page, { sweepAt: new Date(now).toISOString() });
    await expect.poll(value).toBeGreaterThan(first);
    expect(errors()).toEqual([]);
  });

  for (const [width, height] of EVIDENCE_SIZES) {
    test(`evidence: the session line, both themes (${width}x${height}, P2-W01)`, async ({ page }) => {
      test.skip(!shooting(), 'evidence is written by the chromium project');
      const errors = trackConsoleErrors(page);
      for (const theme of ['dark', 'light'] as const) {
        await openPresenter(page, theme, width, height);
        await page.waitForTimeout(2_500);
        const hero = (await page.locator('.mr-pv-hero').boundingBox())!;
        if (width > 720) expect(hero.y + hero.height, 'the hero ends in the upper half').toBeLessThanOrEqual(height / 2);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await evidence2(page, `session-${theme}-${width}x${height}`);
      }
      expect(errors()).toEqual([]);
    });
  }

  // P2-W19: the small moments — a chime only when asked for, savers that rise in, the band stepping back for the
  // payoff, a first-paint roll-up of the hero, and an ask that reads from the back row.
  test('the chime never plays unless turned on; M turns it on for the session: two rising notes, then one for the recovery (P2-W19)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.addInitScript(() => {
      const notes: number[] = [];
      (window as unknown as { __mrNotes: number[] }).__mrNotes = notes;
      class Param {
        value = 0;
        setValueAtTime() {}
        linearRampToValueAtTime() {}
        exponentialRampToValueAtTime() {}
      }
      class FakeAudio {
        state = 'running';
        currentTime = 0;
        destination = {};
        createOscillator() {
          const osc = { type: '', frequency: new Param(), connect: () => ({}), start: () => notes.push(osc.frequency.value), stop: () => {} };
          return osc;
        }
        createGain() {
          return { gain: new Param(), connect: () => ({}) };
        }
        resume() {
          return Promise.resolve();
        }
      }
      (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudio;
    });
    await openPresenter(page, 'dark', 1920, 1080);
    const notes = () => page.evaluate(() => [...(window as unknown as { __mrNotes: number[] }).__mrNotes]);
    const takeover = page.locator('.mr-takeover');
    const t0 = await pageNow(page);
    // Off by default: an alert lands in silence.
    await publishIncidents(page, [regression(t0)]);
    await expect(takeover).toHaveAttribute('data-mode', 'alert');
    await page.waitForTimeout(300);
    expect(await notes()).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(takeover).toHaveCount(0);
    // The key list names M.
    await page.keyboard.press('?');
    await expect(page.getByTestId('stage-keys')).toContainText('Chime when an alert lands (on or off)');
    await evidence2(page, 'keys-chime-dark-1920x1080');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('stage-keys')).toHaveCount(0);
    // M: on. The next alert chimes E5 → B5; its recovery one lower note (B4).
    await page.keyboard.press('m');
    await expect(page.locator('.mr-chip')).toHaveText('Chime on');
    await publishIncidents(page, [regression(t0), regression(t0 + 1, { id: 'inc_chime' })]);
    await expect(page.locator('.mr-takeover[data-incident-id="inc_chime"]')).toBeVisible();
    await expect.poll(notes).toEqual([659.25, 987.77]);
    await publishIncidents(page, [regression(t0), regression(t0 + 1, { id: 'inc_chime', closedAt: new Date(t0 + 60_000).toISOString(), recoveredTo: 0.75 })]);
    await expect(takeover).toHaveAttribute('data-mode', 'recovery');
    await expect.poll(notes).toEqual([659.25, 987.77, 493.88]);
    await page.keyboard.press('Escape');
    await expect(takeover).toHaveCount(0);
    // M again: off.
    await page.keyboard.press('m');
    await expect(page.locator('.mr-chip')).toHaveText('Chime off');
    await publishIncidents(page, [regression(t0), regression(t0 + 2, { id: 'inc_quiet' })]);
    await expect(page.locator('.mr-takeover[data-incident-id="inc_quiet"]')).toBeVisible();
    await page.waitForTimeout(300);
    expect(await notes()).toHaveLength(3);
    expect(errors()).toEqual([]);
  });

  test('a saver row a sweep adds rises in; a changed amount glows; nothing moves on the first render (P2-W19)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openPresenter(page, 'dark', 1920, 1080);
    const items = page.locator('.mr-pv-item');
    await expect(items).toHaveCount(5);
    // Nothing animates for the rows the stage opened with.
    expect(await items.evaluateAll((els) => els.flatMap((el) => el.getAnimations()).length)).toBe(0);
    // Watch for the rows' animations the moment they are committed.
    await page.evaluate(() => {
      const w = window as unknown as { __mrRows: { key: string; running: boolean; transform: boolean }[] };
      w.__mrRows = [];
      const list = document.querySelector('.mr-pv-list')!;
      const mo = new MutationObserver((records) => {
        for (const r of records)
          for (const n of r.addedNodes) {
            if (!(n instanceof HTMLElement) || !n.classList.contains('mr-pv-item')) continue;
            const anims = n.getAnimations();
            w.__mrRows.push({
              key: n.dataset.key ?? '',
              running: anims.some((a) => a.playState === 'running'),
              transform: anims.some((a) => (a.effect as KeyframeEffect | null)?.getKeyframes().some((k) => typeof k.transform === 'string' && k.transform.includes('translateY')) ?? false),
            });
          }
      });
      mo.observe(list, { childList: true });
    });
    // "Apply the pack": a new saver enters second, and the Windows line's amount changes.
    const snap = await page.evaluate(() => (window as unknown as { __MR_PRESENTER__: Hook }).__MR_PRESENTER__.store.getState().snapshot!);
    const vpc = { objectKey: 'pipe:default:mrd_vpc_pack', label: 'VPC Flow aggregation', savedPerDayM: 1_100 * MC, ratio: 0.5, groupId: 'default', pipelineId: 'mrd_vpc_pack' };
    const top = [{ ...snap.topSavers[0], savedPerDayM: 1_402 * MC }, vpc, ...snap.topSavers.slice(1, 4)];
    await patchSnapshot(page, { topSavers: top });
    await expect(items.nth(1)).toContainText('VPC Flow aggregation');
    const rows = await page.evaluate(() => (window as unknown as { __mrRows: { key: string; running: boolean; transform: boolean }[] }).__mrRows);
    expect(rows).toEqual([{ key: 'pipe:default:mrd_vpc_pack', running: true, transform: true }]);
    await expect(items.first().locator('.mr-pv-item-amount')).toHaveClass(/mr-pv-changed/);
    await expect(items.nth(2).locator('.mr-pv-item-amount')).not.toHaveClass(/mr-pv-changed/);
    // Held mid-way for the evidence still.
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('.mr-pv-item, .mr-pv-item-amount')) for (const a of el.getAnimations()) {
        a.pause();
        a.currentTime = 200;
      }
    });
    await evidence2(page, 'savers-insert-dark-1920x1080', { selector: '.mr-pv-savers' });
    expect(errors()).toEqual([]);
  });

  test('the upper band steps back to 55 % while a red card is up and comes back after it (P2-W19)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openPresenter(page, 'dark', 1920, 1080);
    const opacity = (sel: string) => page.locator(sel).evaluate((el) => Number(getComputedStyle(el).opacity));
    expect(await opacity('.mr-pv-hero')).toBe(1);
    const t0 = await pageNow(page);
    await publishIncidents(page, [regression(t0, { deliveries: [{ endpointId: 'ep_slack', status: 200, at: new Date(t0 + 2_000).toISOString() }] })]);
    await expect(page.locator('.mr-takeover')).toHaveAttribute('data-mode', 'alert');
    await expect.poll(() => opacity('.mr-pv-hero')).toBeCloseTo(0.55, 2);
    await expect.poll(() => opacity('.mr-pv-savers')).toBeCloseTo(0.55, 2);
    // What the room still needs stays uncovered and above the contrast floor for large text at the dimmed strength.
    expect(await coveredBy(page)).toEqual([]);
    await evidence2(page, 'payoff-dim-dark-1920x1080');
    // The card turns green: the band comes back for the good news.
    await publishIncidents(page, [regression(t0, { closedAt: new Date(t0 + 60_000).toISOString(), recoveredTo: 0.75 })]);
    await expect(page.locator('.mr-takeover')).toHaveAttribute('data-mode', 'recovery');
    await expect.poll(() => opacity('.mr-pv-hero')).toBe(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.mr-takeover')).toHaveCount(0);
    expect(await opacity('.mr-pv-savers')).toBe(1);
    expect(errors()).toEqual([]);
  });

  for (const reduced of [false, true]) {
    test(`the hero rolls up from $0 on first paint, once${reduced ? ' — not under reduced motion' : ''} (P2-W19)`, async ({ page }) => {
      const errors = trackConsoleErrors(page);
      if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
      // Every frame from the page's start: the figure's wheel positions and its value attribute.
      await page.addInitScript(() => {
        const seen: { t: number; v: number; wheels: string }[] = [];
        (window as unknown as { __mrRoll: typeof seen }).__mrRoll = seen;
        const tick = () => {
          const el = document.querySelector('.mr-pv-figure [data-value-m]');
          if (el) {
            const wheels = [...el.querySelectorAll<HTMLElement>('.mr-meter-strip')].map((w) => w.style.transform).join('|');
            seen.push({ t: performance.now(), v: Number(el.getAttribute('data-value-m')), wheels });
          }
          if (seen.length < 600) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await openPresenter(page, 'dark', 1440, 900);
      await page.waitForTimeout(800);
      const seen = await page.evaluate(() => (window as unknown as { __mrRoll: { t: number; v: number; wheels: string }[] }).__mrRoll);
      const final = seen[seen.length - 1].v;
      expect(final).toBeGreaterThan(0);
      if (reduced) {
        expect(seen[0].v, 'no roll-up under reduced motion').toBe(final);
      } else {
        // The first frame is near $0, and the wheels keep turning for at least a second (the roll-up is 1.2 s).
        expect(seen[0].v).toBeLessThan(final * 0.1);
        let lastMove = 0;
        for (let i = 1; i < seen.length; i++) if (seen[i].wheels !== seen[i - 1].wheels) lastMove = i;
        expect(seen[lastMove].t - seen[0].t, 'the digit roll lasts at least a second').toBeGreaterThanOrEqual(1_000);
        // The box never grew while it rolled: the wheels were laid out for the figure it rolled to.
        await expect(page.locator('.mr-pv-figure .mr-meter-wheel')).toHaveCount(7);
      }
      // Once per page: a period switch mounts a fresh figure that does not roll up again.
      await setHeadlinePeriod(page, 'mtd');
      await expect(page.locator('.mr-pv-caption')).toHaveText('month to date');
      const again = await page.evaluate(async () => {
        const out: number[] = [];
        for (let i = 0; i < 6; i++) {
          await new Promise((r) => requestAnimationFrame(() => r(null)));
          const el = document.querySelector('.mr-pv-figure [data-value-m]');
          if (el) out.push(Number(el.getAttribute('data-value-m')));
        }
        return out;
      });
      for (const v of again) expect(v).toBeGreaterThanOrEqual(91_420 * MC);
      expect(errors()).toEqual([]);
    });
  }

  test('the QR caption reads from the back row: ≥ 28 px at 1920 over a code ≥ 220 px (P2-W19)', async ({ page }) => {
    await openPresenter(page, 'dark', 1920, 1080);
    expect(await fontPx(page, '.mr-qr-caption-main')).toBeGreaterThanOrEqual(28);
    const qr = (await page.locator('[data-callout="qr"]').boundingBox())!;
    expect(qr.width).toBeGreaterThanOrEqual(220);
    // The ask never climbs into the upper band.
    const ask = (await page.locator('.mr-qr-caption').boundingBox())!;
    expect(ask.y).toBeGreaterThanOrEqual(1080 / 2 - 40);
  });

  // P2-W04: the lower half at rest holds the month's receipt bar and the 30-day line — the card's footprint, which
  // fades out as a card lands and comes back after it.
  test('at rest the card\'s footprint holds the month\'s bar and the 30-day line; a card fades it out and it comes back (1920, P2-W04)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openPresenter(page, 'dark', 1920, 1080);
    const now = await pageNow(page);
    // Thirty completed days, ending two UTC days back (never the display zone's today, which the line leaves out).
    const trend = Array.from({ length: 30 }, (_, i) => ({ day: new Date(now - (31 - i) * 86_400_000).toISOString().slice(0, 10), savedM: (3_000 + 400 * Math.sin(i / 3) + i * 20) * MC, whpM: 0, paidM: 0 }));
    await patchSnapshot(page, { trend });
    const rest = page.getByTestId('stage-rest');
    await expect(rest).toBeVisible();
    await expect(rest.locator('.mr-rbar-whp')).toHaveText('You would have paid $152,400');
    await expect(rest.locator('.mr-rbar-legend-paid')).toHaveText('You paid $60,980');
    await expect(rest.locator('[data-testid="receipt-saved-pct"]')).toContainText('60% saved');
    await expect(rest.locator('.mr-pv-rest-title').first()).toHaveText('Month to date');
    await expect(rest.locator('.mr-pv-trend figcaption')).toContainText('Saved per day, the last 30 full days');
    expect(await fontPx(page, '.mr-pv-rest .mr-rbar-whp')).toBeGreaterThanOrEqual(28);
    // The footprint is filled: the panel is the card's box, and its bar and line span it; no empty stretch wider
    // than 600 px is left below the upper band, left of the QR column.
    const box = (await rest.boundingBox())!;
    expect(box.y).toBeCloseTo(1080 / 2, 0);
    expect(box.y + box.height).toBeCloseTo(1080 - 64, 0);
    const qr = (await page.locator('.mr-pv-qr').boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(qr.x);
    const track = (await rest.locator('.mr-rbar-track').boundingBox())!;
    const line = (await rest.locator('.mr-pv-trend-svg').boundingBox())!;
    for (const b of [track, line]) {
      expect(b.width).toBeGreaterThanOrEqual(box.width - 1);
      expect(box.width - b.width).toBeLessThan(600);
    }
    // Vertically: the content fills the band from its top to the scene row, no empty stretch taller than a line.
    const bar = (await rest.locator('.mr-pv-bar').boundingBox())!;
    expect(line.y - (bar.y + bar.height)).toBeLessThan(100);
    expect(await contrastFailures(page, '.mr-pv-rest')).toEqual([]);
    await evidence2(page, 'rest-dark-1920x1080');

    // A card lands: the panel fades out (it is under the card), and nothing the audience needs is covered.
    const t0 = await pageNow(page);
    await publishIncidents(page, [regression(t0)]);
    await expect(page.locator('.mr-takeover')).toHaveAttribute('data-mode', 'alert');
    await expect.poll(() => rest.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(0);
    expect(await coveredBy(page)).toEqual([]);
    // The card goes: the panel comes back.
    await page.keyboard.press('Escape');
    await expect(page.locator('.mr-takeover')).toHaveCount(0);
    await expect.poll(() => rest.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);
    expect(errors()).toEqual([]);
  });

  test('the rest panel fades out within 200 ms of a card arriving, before the card has landed (P2-W04)', async ({ page }) => {
    await openPresenter(page, 'dark', 1440, 900);
    const t0 = await pageNow(page);
    const fade = await page.evaluate(async (inc) => {
      const h = (window as unknown as { __MR_PRESENTER__: Hook }).__MR_PRESENTER__;
      const snap = h.store.getState().snapshot!;
      h.store.setState({ snapshot: { ...snap, incidents: [inc], openIncidents: 1 } });
      const start = performance.now();
      let goneAt = -1;
      let landedAt = -1;
      while (performance.now() - start < 1_000) {
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const rest = document.querySelector('[data-testid="stage-rest"]');
        const card = document.querySelector('.mr-takeover');
        if (goneAt < 0 && rest && Number(getComputedStyle(rest).opacity) === 0) goneAt = performance.now() - start;
        if (landedAt < 0 && card && getComputedStyle(card).transform === 'none' && card.getAnimations().every((a) => a.playState !== 'running')) landedAt = performance.now() - start;
      }
      return { goneAt, landedAt };
    }, regression(t0));
    expect(fade.goneAt).toBeGreaterThan(0);
    expect(fade.goneAt).toBeLessThan(fade.landedAt);
  });

  for (const [width, height] of EVIDENCE_SIZES) {
    test(`evidence: the stage at rest with the month's bar and line, both themes (${width}x${height}, P2-W04)`, async ({ page }) => {
      test.skip(!shooting(), 'evidence is written by the chromium project');
      const errors = trackConsoleErrors(page);
      for (const theme of ['dark', 'light'] as const) {
        await openPresenter(page, theme, width, height);
        const now = await pageNow(page);
        // Thirty completed days, ending two UTC days back (never the display zone's today, which the line leaves out).
    const trend = Array.from({ length: 30 }, (_, i) => ({ day: new Date(now - (31 - i) * 86_400_000).toISOString().slice(0, 10), savedM: (3_000 + 400 * Math.sin(i / 3) + i * 20) * MC, whpM: 0, paidM: 0 }));
        await patchSnapshot(page, { trend });
        await expect(page.getByTestId('stage-rest')).toBeVisible();
        await page.waitForTimeout(1_500);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        if (width > 720) expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(height);
        await evidence2(page, `rest-${theme}-${width}x${height}`);
      }
      expect(errors()).toEqual([]);
    });
  }

  test('the headline period follows ?period=', async ({ page }) => {
    await openPresenter(page, 'dark', 1440, 900);
    await page.goto('/?present=1&period=mtd');
    await page.waitForFunction(() => '__MR_PRESENTER__' in window);
    await expect(page.locator('.mr-pv-caption')).toHaveText(/month to date|Waiting for the first sweep|Set prices/);
  });
});

// ─── Incident takeover ───────────────────────────────────────────────────────

test.describe('incident takeover', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`slides up, holds its catch, flips on delivery, dismisses on any key, returns green (${theme}, 1920)`, async ({ page }) => {
      const errors = trackConsoleErrors(page);
      await openPresenter(page, theme, 1920, 1080);
      const takeover = page.locator('.mr-takeover');
      await expect(takeover).toHaveCount(0);

      // A new high-severity regression, not yet delivered: the clock counts.
      const t0 = await pageNow(page);
      await publishIncidents(page, [regression(t0)]);
      await expect(takeover).toBeVisible();
      await expect(takeover).toHaveAttribute('data-mode', 'alert');
      await expect(takeover.locator('.mr-tk-title')).toHaveText('Savings dropped: Payments API sampling');
      await expect(takeover.locator('[data-callout="per-day"]')).toHaveText('$25 a day · $9,125 a year if left');
      await expect(takeover.locator('[data-callout="commit"]')).toHaveText('a1f3c9e');
      await expect(takeover.locator('[data-callout="author"]')).toHaveText('s.koelpin');
      await expect(takeover.getByText('change naming this pipeline')).toBeVisible();
      await expect(takeover.getByText('1-minute confirmation (demo profile). Default is 3.')).toBeVisible();
      const clock = takeover.locator('.mr-tk-caught');
      const clockText = takeover.locator('.mr-tk-caught-text');
      await expect(clock).toHaveAttribute('data-live', 'true');
      // r2 ui-11 (FINDINGS_R2 #14): the measured catch holds while the delivery is on its way (it used to count on past
      // it and snap back when the delivery landed); data-live still says the delivery is owed.
      const first = await clockText.textContent();
      await page.waitForTimeout(1_300);
      expect(await clockText.textContent()).toBe(first);

      // The QR stays in its corner, uncovered.
      await settled(page);
      const qr = (await page.locator('[data-callout="qr"]').boundingBox())!;
      const card = (await takeover.boundingBox())!;
      expect(card.x + card.width).toBeLessThanOrEqual(qr.x);
      // It covers exactly the lower half of the frame, and the Meter keeps ticking above it.
      expect(card.y).toBeCloseTo(1080 / 2, 0);
      expect(card.y + card.height).toBeCloseTo(1080 - 64, 0);
      const figure = (await page.locator('.mr-pv-figure').boundingBox())!;
      expect(card.y).toBeGreaterThanOrEqual(figure.y + figure.height);
      // BEAUTY F1: the hero, its caption, all five savers, the QR and the vote ask stay uncovered.
      expect(await coveredBy(page)).toEqual([]);
      // Nothing about the stage moved when the card arrived.
      expect(qr.y + qr.height).toBeCloseTo(1080 - 64, 0);

      // The webhook lands: the clock stops at the measured number and "Sent to Slack ✓" appears.
      const deliveredAt = new Date(t0 + 2_000).toISOString();
      await publishIncidents(page, [
        regression(t0, {
          deliveries: [{ endpointId: 'ep_slack', status: 200, at: deliveredAt }],
          lastNotifiedAt: deliveredAt,
        }),
      ]);
      await expect(takeover).toHaveAttribute('data-delivered', 'true');
      await expect(clock).toHaveAttribute('data-live', 'false');
      await expect(clockText).toHaveText('Caught in 2:50');
      await expect(takeover.locator('.mr-tk-delivery')).toHaveText(/^Sent to Slack ✓ \d{1,2}:\d{2}:\d{2} [AP]M$/);
      await page.waitForTimeout(500);
      expect(await contrastFailures(page, '.mr-takeover')).toEqual([]);
      await shoot(page, `takeover-${theme}-1920`);

      // Any key dismisses — and is consumed (REVIEW-3a #7): P clears the card but does not also leave
      // presenter mode (the same path the lever keys take through the shell's dispatcher).
      await page.keyboard.press('p');
      await expect(takeover).toHaveCount(0);
      await expect(page.locator('.mr-pv')).toBeVisible();
      await page.waitForTimeout(300);
      await expect(page.locator('.mr-pv')).toBeVisible();

      // Restore: the incident closes itself → the same card returns in green. The close keeps the drop
      // (`after` 0.5) and records where it recovered to (D47).
      await publishIncidents(page, [
        regression(t0, {
          closedAt: new Date(t0 + 60_000).toISOString(),
          recoveredTo: 0.75,
          deliveries: [{ endpointId: 'ep_slack', status: 200, at: deliveredAt }],
        }),
      ]);
      await expect(takeover).toBeVisible();
      await expect(takeover).toHaveAttribute('data-mode', 'recovery');
      await expect(takeover.locator('.mr-tk-title')).toHaveText('Recovered · savings back to 75% · closed itself.');
      // BEAUTY F3: the same card in green — same box, how far it fell → where it is now, no "Savings dropped".
      await settled(page);
      const green = (await takeover.boundingBox())!;
      expect(green.y).toBeCloseTo(card.y, 0);
      expect(green.height).toBeCloseTo(card.height, 0);
      await expect(takeover.locator('.mr-tk-before')).toHaveText('50%');
      await expect(takeover.locator('.mr-tk-after')).toHaveText('75%');
      await expect(takeover.locator('.mr-tk-object')).toHaveText('Payments API sampling');
      await expect(takeover).not.toContainText('Savings dropped');
      await expect(takeover.locator('.mr-tk-recovery-sub')).toHaveCount(0);
      await expect(takeover.locator('[data-callout="per-day"]')).toHaveText('Saving $25 a day again · $9,125 a year');
      await expect(takeover.locator('.mr-tk-caught-text')).toHaveText('Alert open for 1:01');
      expect(await coveredBy(page)).toEqual([]);
      await page.waitForTimeout(500);
      expect(await contrastFailures(page, '.mr-takeover')).toEqual([]);
      await shoot(page, `takeover-recovery-${theme}-1920`);
      // The next key does what it says: P leaves presenter mode once no card is up.
      await page.keyboard.press('Escape');
      await expect(takeover).toHaveCount(0);
      await page.keyboard.press('p');
      await expect(page.locator('.mr-pv')).toHaveCount(0);
      expect(errors()).toEqual([]);
    });

    test(`keeps the stage readable at 1440 (${theme})`, async ({ page }) => {
      const errors = trackConsoleErrors(page);
      await openPresenter(page, theme, 1440, 900);
      const takeover = page.locator('.mr-takeover');
      const t0 = await pageNow(page);
      const delivered = [{ endpointId: 'ep_slack', status: 200, at: new Date(t0 + 2_000).toISOString() }];
      await publishIncidents(page, [regression(t0, { deliveries: delivered })]);
      await expect(takeover).toHaveAttribute('data-mode', 'alert');
      await settled(page);
      const card = (await takeover.boundingBox())!;
      expect(card.y).toBeCloseTo(900 / 2, 0);
      expect(await coveredBy(page)).toEqual([]);
      expect(await contrastFailures(page, '.mr-takeover')).toEqual([]);
      await page.waitForTimeout(300);
      await shoot(page, `takeover-${theme}-1440`, { fullPage: false });

      await publishIncidents(page, [regression(t0, { closedAt: new Date(t0 + 96_000).toISOString(), recoveredTo: 0.75, deliveries: delivered })]);
      await expect(takeover).toHaveAttribute('data-mode', 'recovery');
      await expect(takeover.locator('.mr-tk-before')).toHaveText('50%');
      await expect(takeover.locator('.mr-tk-after')).toHaveText('75%');
      await settled(page);
      const green = (await takeover.boundingBox())!;
      expect(green.height).toBeCloseTo(card.height, 0);
      expect(await coveredBy(page)).toEqual([]);
      expect(await contrastFailures(page, '.mr-takeover')).toEqual([]);
      await page.waitForTimeout(300);
      await shoot(page, `takeover-recovery-${theme}-1440`, { fullPage: false });

      // A browser window shorter than 16:9 (a toolbar on the projector laptop): the split still holds.
      await page.keyboard.press('Escape');
      await expect(takeover).toHaveCount(0);
      await page.setViewportSize({ width: 1920, height: 900 });
      await publishIncidents(page, [regression(t0 + 1, { id: 'inc_7f3a02', deliveries: delivered })]);
      await expect(page.locator('.mr-takeover[data-incident-id="inc_7f3a02"]')).toBeVisible();
      await settled(page);
      expect(await coveredBy(page)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1920);
      expect(errors()).toEqual([]);
    });

    test(`fits a phone at 390 (${theme})`, async ({ page }) => {
      const errors = trackConsoleErrors(page);
      await openPresenter(page, theme, 390, 844);
      const t0 = await pageNow(page);
      await publishIncidents(page, [
        regression(t0, {
          deliveries: [
            {
              endpointId: 'ep_slack',
              status: 200,
              at: new Date(t0 + 2_000).toISOString(),
            },
          ],
        }),
      ]);
      const takeover = page.locator('.mr-takeover');
      await expect(takeover).toBeVisible();
      await page.waitForTimeout(500);
      const card = (await takeover.boundingBox())!;
      expect(card.x).toBeGreaterThanOrEqual(16);
      expect(card.x + card.width).toBeLessThanOrEqual(390 - 16 + 0.5);
      expect(card.y).toBeGreaterThanOrEqual(0);
      expect(card.y + card.height).toBeLessThanOrEqual(844);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await shoot(page, `takeover-${theme}-390`, { fullPage: false });
      // Touch users have the close button.
      await takeover.getByRole('button', { name: 'Dismiss' }).click();
      await expect(takeover).toHaveCount(0);
      expect(errors()).toEqual([]);
    });
  }

  // P0-14: a two-line title and a long commit message must never push the foot ("Caught in 2:50 · Sent to
  // Slack ✓") out of the fixed lower-half card — the payoff line is the one thing the card exists to show.
  for (const [width, height] of [
    [1920, 1080],
    [1920, 900],
    [1440, 900],
    [1280, 720],
  ] as const) {
    test(`a long title and a long commit message still fit the card, foot inside (${width}x${height})`, async ({ page }) => {
      const errors = trackConsoleErrors(page);
      await openPresenter(page, 'dark', width, height);
      const t0 = await pageNow(page);
      const deliveredAt = new Date(t0 + 2_000).toISOString();
      const longCommit = regression(t0, {
        id: 'inc_long01',
        label: LONG_LABEL,
        objectKey: 'pipe:default:mrd_pan_perimeter',
        commit: { ...regression(t0).commit!, hash: 'c0ffee1d2e', message: LONG_MESSAGE, author: 'maria.gonzalez-santiago' },
        deliveries: [{ endpointId: 'ep_slack', status: 200, at: deliveredAt }],
        lastNotifiedAt: deliveredAt,
      });
      const nearby = regression(t0, {
        id: 'inc_long02',
        label: LONG_LABEL,
        objectKey: 'pipe:default:mrd_pan_perimeter',
        commit: { ...regression(t0).commit!, hash: 'c0ffee1d2e', message: LONG_MESSAGE, author: 'maria.gonzalez-santiago', match: 'nearby' },
        deliveries: [{ endpointId: 'ep_slack', status: 200, at: deliveredAt }],
        lastNotifiedAt: deliveredAt,
      });
      const takeover = page.locator('.mr-takeover');
      for (const incident of [longCommit, nearby]) {
        await publishIncidents(page, [incident]);
        await expect(page.locator(`.mr-takeover[data-incident-id="${incident.id}"]`)).toBeVisible();
        await settled(page);
        await expect(takeover.locator('.mr-tk-caught-text')).toHaveText('Caught in 2:50');
        const fit = await takeover.evaluate((card) => {
          const c = card.getBoundingClientRect();
          const inside = (sel: string) => {
            const el = card.querySelector(sel);
            if (!el) return `${sel} missing`;
            const r = el.getBoundingClientRect();
            return r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5 && r.left >= c.left - 0.5 && r.right <= c.right + 0.5 ? 'in' : `${sel} out`;
          };
          const body = card.querySelector('.mr-tk-body')!;
          return {
            cardScroll: card.scrollHeight - card.clientHeight,
            bodyScroll: body.scrollHeight - body.clientHeight,
            caught: inside('.mr-tk-caught'),
            delivery: inside('.mr-tk-delivery'),
            author: inside('[data-callout="author"]'),
            commit: inside('[data-callout="commit"]'),
            perDay: inside('[data-callout="per-day"]'),
          };
        });
        expect(fit.cardScroll, `${incident.id} card scroll`).toBeLessThanOrEqual(0);
        expect(fit.bodyScroll, `${incident.id} body clipped`).toBeLessThanOrEqual(0);
        expect(fit).toMatchObject({ caught: 'in', delivery: 'in', author: 'in', commit: 'in', perDay: 'in' });
        // The author callout is never cut by the message's ellipsis: it is painted, whole, on the commit line.
        const author = (await takeover.locator('[data-callout="author"]').boundingBox())!;
        const commitLine = (await takeover.locator('.mr-tk-commit-text').boundingBox())!;
        expect(author.x + author.width).toBeLessThanOrEqual(commitLine.x + commitLine.width + 0.5);
        // Clamped text keeps its full wording on hover (title=).
        await expect(takeover.locator('.mr-tk-title')).toHaveAttribute('title', `Savings dropped: ${LONG_LABEL}`);
        await expect(takeover.locator('.mr-tk-message')).toHaveAttribute('title', LONG_MESSAGE);
        expect(await coveredBy(page)).toEqual([]);
        if (incident === longCommit) await evidence(page, `takeover-longtitle-dark-${width}x${height}`);
        // On a 16:9 stage the nearby caveat fits beside its chip and is kept; it is dropped whole only when a
        // narrower frame leaves no room (never cut through its glyphs).
        if (incident === nearby && width === 1920) await expect(takeover.locator('.mr-tk-caveat')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(takeover).toHaveCount(0);
      }
      expect(errors()).toEqual([]);
    });
  }

  // P1-B01: when the incident closes while its red card is up, the red card turns green IN PLACE — every frame has
  // the card over the lower half, its box never moves, it never slides in again, and the red crossfades out.
  for (const reduced of [false, true]) {
    test(`the red card turns green in place: no empty frame, no second entrance${reduced ? ' (reduced motion)' : ''} (P1-B01)`, async ({ page }) => {
      const errors = trackConsoleErrors(page);
      if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
      await openPresenter(page, 'dark', 1920, 1080);
      const takeover = page.locator('.mr-takeover');
      const t0 = await pageNow(page);
      const delivered = [{ endpointId: 'ep_slack', status: 200, at: new Date(t0 + 2_000).toISOString() }];
      await publishIncidents(page, [regression(t0, { deliveries: delivered })]);
      await expect(takeover).toHaveAttribute('data-mode', 'alert');
      await settled(page);
      const red = (await takeover.boundingBox())!;
      const redId = await takeover.evaluate((el) => {
        (el as HTMLElement & { __mrSame?: boolean }).__mrSame = true;
        return el.getAttribute('data-incident-id');
      });

      await startFrameSampler(page, 60);
      await publishIncidents(page, [regression(t0, { closedAt: new Date(t0 + 60_000).toISOString(), recoveredTo: 0.75, deliveries: delivered })]);
      await expect(takeover).toHaveAttribute('data-mode', 'recovery');
      await expect.poll(async () => (await sampledFrames(page)).length, { timeout: 5_000 }).toBeGreaterThanOrEqual(60);
      const frames = await sampledFrames(page);

      // The same element turned green (no unmount), in the same box, with no slide.
      expect(await takeover.evaluate((el) => (el as HTMLElement & { __mrSame?: boolean }).__mrSame === true)).toBe(true);
      expect(await takeover.getAttribute('data-incident-id')).toBe(redId);
      for (const [i, f] of frames.entries()) {
        expect(f.card, `frame ${i}: a card is on stage`).toBe(true);
        expect(f.top!, `frame ${i}: top`).toBeCloseTo(red.y, 0);
        expect(f.bottom!, `frame ${i}: bottom`).toBeCloseTo(red.y + red.height, 0);
        expect(f.left!, `frame ${i}: left`).toBeCloseTo(red.x, 0);
        expect(f.right!, `frame ${i}: right`).toBeCloseTo(red.x + red.width, 0);
        expect(f.transform, `frame ${i}: no slide`).toBe('none');
        expect(f.opacity, `frame ${i}: never faded out`).toBe(1);
      }
      expect(frames.some((f) => f.mode === 'alert')).toBe(true);
      expect(frames.some((f) => f.mode === 'recovery')).toBe(true);
      const fading = frames.filter((f) => f.mode === 'recovery' && f.ghost !== null && f.ghost > 0.02 && f.ghost < 0.98);
      if (reduced) expect(frames.every((f) => f.ghost === null), 'reduced motion: no crossfade').toBe(true);
      else expect(fading.length, 'the red card crossfades out over the green one').toBeGreaterThanOrEqual(2);
      await expect(page.locator('.mr-tk-ghost')).toHaveCount(0);
      // The copy never doubled a callout while it was up (only one per-day, one author on the page).
      await expect(page.locator('[data-callout="per-day"]')).toHaveCount(1);
      expect(errors()).toEqual([]);
    });
  }

  for (const [width, height] of EVIDENCE_SIZES) {
    test(`evidence: the alert card turning green, mid-crossfade, both themes (${width}x${height}, P1-B01)`, async ({ page }) => {
      test.skip(!shooting(), 'evidence is written by the chromium project');
      const errors = trackConsoleErrors(page);
      for (const theme of ['dark', 'light'] as const) {
        await openPresenter(page, theme, width, height);
        const takeover = page.locator('.mr-takeover');
        const t0 = await pageNow(page);
        const delivered = [{ endpointId: 'ep_slack', status: 200, at: new Date(t0 + 2_000).toISOString() }];
        await publishIncidents(page, [regression(t0, { deliveries: delivered })]);
        await settled(page);
        // Freeze the morph the moment it starts (a load-slowed runner must not miss the 180 ms fade-out).
        await page.evaluate(() => {
          const mo = new MutationObserver(() => {
            if (!document.querySelector('.mr-tk-ghost')) return;
            mo.disconnect();
            for (const el of document.querySelectorAll('.mr-tk-ghost, .mr-takeover > *')) for (const a of el.getAnimations()) a.pause();
          });
          mo.observe(document.body, { childList: true, subtree: true });
        });
        await publishIncidents(page, [regression(t0, { closedAt: new Date(t0 + 60_000).toISOString(), recoveredTo: 0.75, deliveries: delivered })]);
        await expect(takeover).toHaveAttribute('data-mode', 'recovery');
        // Hold the morph at two moments for the stills: the red leaving (90 ms), the green arriving (260 ms).
        const hold = (ms: number) =>
          page.evaluate((at) => {
            const anims = [...document.querySelectorAll('.mr-tk-ghost, .mr-takeover > *')].flatMap((el) => el.getAnimations());
            for (const a of anims) {
              a.pause();
              a.currentTime = at;
            }
            return anims.length;
          }, ms);
        expect(await hold(90)).toBeGreaterThanOrEqual(4);
        await evidence2(page, `morph-out-${theme}-${width}x${height}`);
        await hold(260);
        await evidence2(page, `morph-in-${theme}-${width}x${height}`);
        await page.evaluate(() => {
          for (const el of document.querySelectorAll('.mr-tk-ghost, .mr-takeover > *')) for (const a of el.getAnimations()) a.finish();
        });
        await expect(page.locator('.mr-tk-ghost')).toHaveCount(0);
        await page.waitForTimeout(100);
        await evidence2(page, `morph-done-${theme}-${width}x${height}`);
      }
      expect(errors()).toEqual([]);
    });
  }

  // P1-B02: every delivery state gives the card the same box and foot; the green card says what happened (the
  // restoring change) instead of a bare "pipeline" chip; the person on the alert reads at ≥ 32 px at 1920.
  test('the card keeps one height through every delivery state; the person is ≥ 32 px; the green card names the fix (1920, P1-B02)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openPresenter(page, 'dark', 1920, 1080);
    const takeover = page.locator('.mr-takeover');
    const t0 = await pageNow(page);
    const at = (s: number) => new Date(t0 + s * 1000).toISOString();
    const fixtures: { name: string; deliveries: Incident['deliveries'] }[] = [
      { name: 'none yet', deliveries: [] },
      { name: 'sent', deliveries: [{ endpointId: 'ep_slack', status: 200, at: at(2) }] },
      { name: 'retrying', deliveries: [{ endpointId: 'ep_slack', status: 502, at: at(2) }] },
      { name: 'no response', deliveries: [{ endpointId: 'ep_slack', status: 0, at: at(2) }] },
      { name: 'blocked', deliveries: [{ endpointId: 'ep_slack', status: 403, at: at(2), error: 'host_not_authorized' }] },
      { name: 'failed', deliveries: [{ endpointId: 'ep_slack', status: 400, at: at(2) }] },
    ];
    await publishIncidents(page, [regression(t0, { deliveries: [] })]);
    await expect(takeover).toHaveAttribute('data-mode', 'alert');
    await settled(page);
    const boxes: { name: string; card: number; foot: number; bodyScroll: number; footScroll: number; top: number }[] = [];
    for (const f of fixtures) {
      await publishIncidents(page, [regression(t0, { deliveries: f.deliveries })]);
      if (f.deliveries.length > 0) await expect(takeover.locator('.mr-tk-delivery')).toBeVisible();
      await page.waitForTimeout(250); // the line's 200 ms fade
      boxes.push({
        name: f.name,
        ...(await takeover.evaluate((card) => {
          const foot = card.querySelector('.mr-tk-foot')!;
          const body = card.querySelector('.mr-tk-body')!;
          return {
            card: card.getBoundingClientRect().height,
            top: card.getBoundingClientRect().top,
            foot: foot.getBoundingClientRect().height,
            bodyScroll: body.scrollHeight - body.clientHeight,
            footScroll: foot.scrollHeight - foot.clientHeight,
          };
        })),
      });
    }
    for (const b of boxes) {
      expect(b.card, `${b.name}: card height`).toBeCloseTo(boxes[0].card, 0);
      expect(b.top, `${b.name}: card top`).toBeCloseTo(boxes[0].top, 0);
      expect(b.foot, `${b.name}: foot height`).toBeCloseTo(boxes[0].foot, 0);
      expect(b.bodyScroll, `${b.name}: body fits`).toBeLessThanOrEqual(0);
      expect(b.footScroll, `${b.name}: foot fits`).toBeLessThanOrEqual(0);
    }
    // The person on the alert: ≥ 32 px at 1920, never the smallest type on the card.
    expect(await fontPx(page, '.mr-takeover [data-callout="author"]')).toBeGreaterThanOrEqual(32);
    expect(await fontPx(page, '.mr-takeover [data-callout="author"]')).toBeGreaterThanOrEqual(await fontPx(page, '.mr-takeover .mr-tk-message'));
    // The git glyph sits on the hash-and-person line, not between two lines.
    const glyph = (await takeover.locator('.mr-tk-commit > svg').boundingBox())!;
    const byLine = (await takeover.locator('.mr-tk-commit-text').boundingBox())!;
    expect(glyph.y + glyph.height / 2).toBeGreaterThanOrEqual(byLine.y);
    expect(glyph.y + glyph.height / 2).toBeLessThanOrEqual(byLine.y + byLine.height);
    // The dismiss button matches the title's scale (Capra's large icon button).
    const dismiss = (await takeover.getByRole('button', { name: 'Dismiss' }).boundingBox())!;
    expect(dismiss.height).toBeGreaterThanOrEqual(40);
    await evidence2(page, 'alert-dark-1920x1080');

    // The restore lands on the timeline and the incident closes: the green card names the change that fixed it.
    const restore = {
      hash: '9b1c2f3d4e',
      message: 'demo: restore the trim on mrd_pay_sample',
      author: 's.koelpin',
      committedAt: at(40),
      deployedAt: at(45),
      groupId: 'default',
      files: [],
      source: 'demo' as const,
    };
    await patchSnapshot(page, { timeline: [restore] });
    await publishIncidents(page, [regression(t0, { closedAt: at(96), recoveredTo: 0.75, deliveries: fixtures[1].deliveries })]);
    await expect(takeover).toHaveAttribute('data-mode', 'recovery');
    await settled(page);
    await expect(takeover.locator('.mr-tk-chip')).toHaveCount(0);
    await expect(takeover).not.toContainText(/^pipeline$/m);
    await expect(takeover.locator('.mr-tk-commit-text')).toHaveText('Restored in 9b1c2f3 by s.koelpin');
    await expect(takeover.locator('.mr-tk-message')).toHaveText('"demo: restore the trim on mrd_pay_sample"');
    expect(await takeover.evaluate((card) => card.getBoundingClientRect().height)).toBeCloseTo(boxes[0].card, 0);
    expect(await coveredBy(page)).toEqual([]);
    expect(await contrastFailures(page, '.mr-takeover')).toEqual([]);
    await page.waitForTimeout(400);
    await evidence2(page, 'recovery-restored-dark-1920x1080');
    expect(errors()).toEqual([]);
  });

  // P2-W15: the drop, drawn on the card — the ratio minute by minute, the diamond at the deploy, the loss shaded.
  test('the takeover draws the drop: an .mr-rw chart whose diamond sits at the deploy; the green card draws the way back (1920, P2-W15)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openPresenter(page, 'dark', 1920, 1080);
    const takeover = page.locator('.mr-takeover');
    const t0 = await pageNow(page);
    const snap = await page.evaluate(() => (window as unknown as { __MR_PRESENTER__: Hook }).__MR_PRESENTER__.store.getState().snapshot!);
    const windowEnd = Date.parse(snap.windowEnd);
    const inc = regression(t0);
    const deployMs = Date.parse(inc.commit!.deployedAt!);
    await patchSnapshot(page, { flows: [payFlow(windowEnd, deployMs)] });
    await publishIncidents(page, [inc]);
    await expect(takeover).toHaveAttribute('data-mode', 'alert');
    await settled(page);
    const watch = takeover.locator('.mr-tk-ratio .mr-rw');
    await expect(watch.locator('svg')).toBeVisible();
    // The diamond's x is the deploy's place in the window.
    const pos = await watch.evaluate((el) => {
      const svg = el.querySelector('svg')!;
      const d = el.querySelector<SVGPathElement>('.mr-rw-diamond')!;
      const box = d.getBBox();
      return { x: box.x + box.width / 2, width: svg.width.baseVal.value, start: Number(el.getAttribute('data-start-ms')), end: Number(el.getAttribute('data-end-ms')) };
    });
    const expected = 6 + ((deployMs - pos.start) / (pos.end - pos.start)) * (pos.width - 12);
    expect(pos.x).toBeCloseTo(expected, 0);
    expect(deployMs).toBeGreaterThan(pos.start);
    await expect(watch.locator('.mr-rw-lost')).toHaveCount(1);
    // It fits the fixed card: the chart is kept, nothing clipped, nothing the audience needs covered.
    expect(await takeover.evaluate((card) => (card.querySelector<HTMLElement>('.mr-tk-body')!.dataset.watch ?? ''))).toBe('');
    expect(await coveredBy(page)).toEqual([]);
    await evidence2(page, 'watch-alert-dark-1920x1080');
    // The change recovers: the green card draws the drop and the way back.
    const closedAt = windowEnd - 20_000;
    await patchSnapshot(page, { flows: [payFlow(windowEnd, deployMs, windowEnd - 60_000)] });
    await publishIncidents(page, [regression(t0, { closedAt: new Date(closedAt).toISOString(), recoveredTo: 0.75 })]);
    await expect(takeover).toHaveAttribute('data-mode', 'recovery');
    await expect(takeover.locator('.mr-tk-ratio .mr-rw svg')).toBeVisible();
    await page.waitForTimeout(500);
    await evidence2(page, 'watch-recovery-dark-1920x1080');
    expect(errors()).toEqual([]);
  });

  test('the full incident card draws the same chart (the gallery, P2-W15)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoApp(page, '/?present=1&gallery=incidents');
    await expect(page.locator('[data-gallery="incidents"]')).toBeVisible();
    await page.waitForFunction(() => '__MR_PRESENTER__' in window || document.querySelector('.mr-inc--full') !== null);
    // The gallery's regression deployed 210 s ago; the store's snapshot gets the flow's minutes.
    const now = await pageNow(page);
    await page.evaluate(
      ({ flow, end }) => {
        const w = window as unknown as { __MR_STORE__?: { getState(): { snapshot: Snapshot | null }; setState(p: unknown): void } };
        const h = (window as unknown as { __MR_PRESENTER__?: Hook }).__MR_PRESENTER__;
        const store = (h?.store ?? w.__MR_STORE__) as unknown as { getState(): { snapshot: Snapshot | null }; setState(p: unknown): void };
        const snap = store.getState().snapshot;
        store.setState({ snapshot: { ...(snap ?? {}), windowEnd: new Date(end).toISOString(), flows: [flow] } });
      },
      { flow: payFlow(now, now - 210_000), end: now },
    );
    const full = page.locator('.mr-inc--full[data-incident-id="inc_7f3a01"]');
    await expect(full.locator('.mr-rw svg')).toBeVisible();
    await expect(full.locator('.mr-rw-diamond')).toHaveCount(1);
    await expect(full.locator('.mr-rw-value--before')).toHaveText('75%');
    await evidence2(page, 'watch-full-card-dark-1440x900', { selector: '.mr-inc--full[data-incident-id="inc_7f3a01"]' });
    await setTheme(page, 'light');
    await evidence2(page, 'watch-full-card-light-1440x900', { selector: '.mr-inc--full[data-incident-id="inc_7f3a01"]' });
    expect(errors()).toEqual([]);
  });

  // P2-W03: the money the drop has cost, counting in red on the alert card; frozen on the green card.
  test('the lost counter reads ~$1.66 for $2,386 a day deployed 60 s ago and grows; the green card freezes it (P2-W03)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await openPresenter(page, 'dark', 1920, 1080);
    const takeover = page.locator('.mr-takeover');
    const t0 = await pageNow(page);
    const commit = { ...regression(t0).commit!, committedAt: new Date(t0 - 69_000).toISOString(), deployedAt: new Date(t0 - 60_000).toISOString() };
    const big = regression(t0, { impactPerDayM: 238_600_000, commit, caughtInSec: 59 });
    await publishIncidents(page, [big]);
    await expect(takeover).toHaveAttribute('data-mode', 'alert');
    const counter = takeover.getByTestId('lost-counter');
    await expect(counter).toBeVisible();
    await expect(counter.locator('.mr-tk-lost-label')).toHaveText('Lost since the deploy');
    const value = async () => Number(await counter.locator('[data-value-m]').getAttribute('data-value-m'));
    const first = await value();
    const since = (await pageNow(page)) - (t0 - 60_000);
    expect(first).toBeGreaterThanOrEqual(165_000); // ≥ $1.65
    expect(first).toBeLessThanOrEqual(Math.ceil((238_600_000 * since) / 86_400_000) + 3_000);
    // It grows (about 2.76 ¢ a second), in the incident red, with its cents.
    await expect.poll(value, { timeout: 5_000 }).toBeGreaterThan(first + 2_000);
    const red = await counter.locator('.mr-tk-lost-figure').evaluate((el) => getComputedStyle(el).color);
    expect(red).toBe(await resolvedColor(page, 'var(--mr-color-incident-high)'));
    await expect(counter.locator('.mr-meter-cents')).toBeVisible();
    await settled(page);
    // It fits the card's figures column (nothing clipped, the card still fits).
    const fit = await takeover.evaluate((card) => {
      const body = card.querySelector<HTMLElement>('.mr-tk-body')!;
      return { lost: body.dataset.lost ?? '', scroll: body.scrollHeight - body.clientHeight };
    });
    expect(fit).toEqual({ lost: '', scroll: 0 });
    expect(await coveredBy(page)).toEqual([]);
    await evidence2(page, 'lost-live-dark-1920x1080');
    // The incident recovers 120 s after the deploy: $2,386 a day × 120 s = $3.31, frozen, in the default ink.
    await publishIncidents(page, [{ ...big, closedAt: new Date(t0 + 60_000).toISOString(), recoveredTo: 0.75 }]);
    await expect(takeover).toHaveAttribute('data-mode', 'recovery');
    await expect(takeover.getByTestId('lost-counter')).toHaveCount(0);
    await expect(takeover.getByTestId('lost-frozen')).toHaveText('Cost $3.31 before it recovered');
    const ink = await takeover.getByTestId('lost-frozen').locator('.mr-tk-lost-figure').evaluate((el) => getComputedStyle(el).color);
    expect(ink).not.toBe(red);
    await page.waitForTimeout(500);
    await evidence2(page, 'lost-frozen-dark-1920x1080');
    expect(errors()).toEqual([]);
  });

  test('the lost counter under reduced motion steps once a second instead of rolling (P2-W03)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openPresenter(page, 'dark', 1440, 900);
    const t0 = await pageNow(page);
    await publishIncidents(page, [regression(t0, { impactPerDayM: 238_600_000 })]);
    const counter = page.getByTestId('lost-counter');
    await expect(counter).toBeVisible();
    await expect(counter.locator('.mr-meter-wheel')).toHaveCount(0);
    const read = async () => Number(await counter.locator('[data-value-m]').getAttribute('data-value-m'));
    const a = await read();
    await expect.poll(read, { timeout: 4_000 }).toBeGreaterThan(a);
  });

  for (const [width, height] of EVIDENCE_SIZES) {
    test(`evidence: the polished alert and green cards, both themes (${width}x${height}, P1-B02)`, async ({ page }) => {
      test.skip(!shooting(), 'evidence is written by the chromium project');
      const errors = trackConsoleErrors(page);
      for (const theme of ['dark', 'light'] as const) {
        await openPresenter(page, theme, width, height);
        const takeover = page.locator('.mr-takeover');
        const t0 = await pageNow(page);
        const at = (s: number) => new Date(t0 + s * 1000).toISOString();
        const delivered = [{ endpointId: 'ep_slack', status: 200, at: at(2) }];
        await publishIncidents(page, [regression(t0, { deliveries: delivered })]);
        await settled(page);
        await page.waitForTimeout(300);
        if (width <= 720) {
          // A phone: the card sits between the savers and the QR, and the vote ask is never under it.
          expect(await coveredBy(page)).toEqual([]);
          const card = (await takeover.boundingBox())!;
          const qr = (await page.locator('.mr-pv-qr').boundingBox())!;
          expect(card.y + card.height).toBeLessThanOrEqual(qr.y);
          await expect(page.locator('[data-callout="qr"]')).toBeVisible();
          // …and it was brought on screen whole.
          expect(card.y).toBeGreaterThanOrEqual(0);
          expect(card.y + card.height).toBeLessThanOrEqual(height + 0.5);
        }
        await evidence2(page, `alert-${theme}-${width}x${height}`);
        await patchSnapshot(page, {
          timeline: [
            { hash: '9b1c2f3d4e', message: 'demo: restore the trim on mrd_pay_sample', author: 's.koelpin', committedAt: at(40), deployedAt: at(45), groupId: 'default', files: [], source: 'demo' },
          ],
        });
        await publishIncidents(page, [regression(t0, { closedAt: at(96), recoveredTo: 0.75, deliveries: [...delivered, { endpointId: 'ep_slack', status: 200, at: at(97) }] })]);
        await expect(takeover).toHaveAttribute('data-mode', 'recovery');
        await page.waitForTimeout(500);
        await evidence2(page, `recovery-${theme}-${width}x${height}`);
        await page.keyboard.press('Escape');
        await expect(takeover).toHaveCount(0);
      }
      expect(errors()).toEqual([]);
    });
  }

  test('an alert already open when the presenter opens does not take over; a medium one never does', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoApp(page, '/?present=1');
    await page.waitForFunction(() => '__MR_PRESENTER__' in window);
    const now = await pageNow(page);
    // The baseline snapshot already carries an open high incident.
    await page.evaluate(
      ({ snap }) => {
        const h = (window as unknown as { __MR_PRESENTER__: Hook }).__MR_PRESENTER__;
        h.stop();
        h.store.setState({ snapshot: snap, source: 'live', errors: {} });
      },
      {
        snap: snapshotAt(now, [regression(now - 600_000, { id: 'inc_old001' })]),
      },
    );
    await page.waitForTimeout(300);
    await expect(page.locator('.mr-takeover')).toHaveCount(0);
    // A new MEDIUM regression (no commit found) stays off the stage.
    await publishIncidents(page, [
      regression(now - 600_000, { id: 'inc_old001' }),
      regression(now, {
        id: 'inc_med001',
        severity: 'medium',
        cause: 'unknown',
        commit: undefined,
      }),
    ]);
    await page.waitForTimeout(300);
    await expect(page.locator('.mr-takeover')).toHaveCount(0);
    // …until a timeline refresh names the commit and upgrades it to high.
    await publishIncidents(page, [regression(now - 600_000, { id: 'inc_old001' }), regression(now, { id: 'inc_med001' })]);
    await expect(page.locator('.mr-takeover')).toBeVisible();
    // The old incident closing shows its recovery after the alert is dismissed. Closed the way incidents were
    // before D47 (`after` holding the reading at close): the recovery is still read from it.
    await page.keyboard.press('Escape');
    await publishIncidents(page, [
      regression(now - 600_000, {
        id: 'inc_old001',
        closedAt: new Date(now).toISOString(),
        after: 0.74,
      }),
      regression(now, { id: 'inc_med001' }),
    ]);
    await expect(page.locator('.mr-takeover')).toHaveAttribute('data-mode', 'recovery');
    await expect(page.locator('.mr-tk-title')).toHaveText('Recovered · savings back to 74% · closed itself.');
    await expect(page.locator('.mr-tk-before')).toHaveText('50%'); // the last open version the presenter saw
    await expect(page.locator('.mr-tk-after')).toHaveText('74%');
  });
});

// ─── Incident card family + Slack message (dev gallery) ──────────────────────

test.describe('incident card and Slack message', () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const [width, height] of [
      [1920, 1080],
      [1440, 900],
      [390, 844],
    ] as const) {
      test(`render every state (${theme}, ${width})`, async ({ page }) => {
        const errors = trackConsoleErrors(page);
        await page.setViewportSize({ width, height });
        await gotoApp(page, '/?present=1&gallery=incidents');
        await setTheme(page, theme);
        const full = page.locator('[data-shot="incident-card"] .mr-inc');
        await expect(full).toHaveCount(3);

        // Full card: title, money line, commit + author callouts, cause, delivery, demo note.
        const reg = full.first();
        await expect(reg.locator('.mr-inc-title')).toHaveText('Savings dropped: Payments API sampling');
        await expect(reg.locator('[data-callout="per-day"]')).toHaveText('$25 a day · $9,125 a year if left');
        await expect(reg.locator('[data-callout="commit"]')).toContainText('a1f3c9e');
        await expect(reg.locator('[data-callout="author"]')).toHaveText('s.koelpin');
        await expect(reg.getByText('change naming this pipeline')).toBeVisible();
        await expect(reg.getByText(/^Sent to Slack ✓ \d{1,2}:\d{2} [AP]M$/)).toBeVisible();
        await expect(reg.getByText('Caught in 2:50')).toBeVisible();
        await expect(reg.getByText('1-minute confirmation (demo profile). Default is 3.')).toBeVisible();
        await expect(reg.getByRole('link', { name: 'View in Ledger' })).toHaveAttribute(
          'href',
          /\/ledger\?object=pipe:default:mrd_pay_sample$/,
        );

        // Unknown cause, delivery failing: the clock is still counting.
        const spike = full.nth(1);
        await expect(spike.locator('.mr-inc-title')).toHaveText('Cost spike: Payments API');
        await expect(spike.getByText('No configuration change found nearby')).toBeVisible();
        await expect(spike.getByText('Delivery failed (503). Retrying.')).toBeVisible();
        await expect(spike.locator('.mr-inc-caught')).toHaveAttribute('data-live', 'true');

        // Closed (D47): the drop it kept as the big figures, where it recovered to beside them, the recovery line.
        const closedFull = full.nth(2);
        await expect(closedFull).toHaveAttribute('data-tone', 'recovered');
        await expect(closedFull.locator('.mr-inc-ratio-row')).toHaveText('75%→50%recovered to 74%');
        await expect(closedFull.getByText(/^Ratio fell from 75% to 50% at \d{1,2}:\d{2} [AP]M$/)).toBeVisible();
        await expect(closedFull.getByText('Recovered · savings back to 74% · closed itself.')).toBeVisible();

        // Compact: nearby change with its chip, a mute, a recovery, a blocked host, a recovery from before D47.
        const compact = page.locator('[data-shot="incident-card-compact"] .mr-inc');
        await expect(compact).toHaveCount(5);
        await expect(compact.nth(1)).toContainText('nearby change');
        await expect(compact.nth(1)).toContainText('muted after a demo change · 6 min');
        // D47: the drop it kept, then where it recovered to — never an arrow pointing up under "Savings dropped".
        await expect(compact.nth(2)).toContainText('Recovered · savings back to 74% · closed itself.');
        await expect(compact.nth(2).locator('.mr-inc-line').first()).toHaveText('75% → to 50%·recovered to 74%·$25 a day above normal while it lasted · 5 min');
        await expect(compact.nth(3)).toContainText('Delivery blocked: host not authorized.');
        await expect(compact.nth(4)).toContainText('Recovered · savings back to 72% · closed itself.');
        await expect(compact.nth(4).locator('.mr-inc-line').first()).toHaveText('Recovered to 72%·$25 a day above normal while it lasted · 5 min');
        await expect(compact.nth(4).locator('.mr-inc-arrow-inline')).toHaveCount(0);

        // Slack messages: header, field grid, one button, the receipt in a code block.
        const slack = page.locator('[data-shot="slack-message"] .mr-slack');
        await expect(slack).toHaveCount(2);
        await expect(slack.first().locator('.mr-slack-header')).toHaveText('Savings dropped: Payments API sampling');
        await expect(slack.first().locator('.mr-slack-glyph--red')).toHaveCount(1);
        await expect(slack.first().locator('.mr-slack-field')).toHaveCount(6);
        await expect(slack.first().locator('.mr-slack-button')).toHaveText('Open in Ledger');
        await expect(slack.nth(1).locator('[data-callout="receipt-total"]')).toContainText('Saved by Cribl, last week');
        await expect(slack.nth(1).locator('.mr-slack-pre')).toContainText('Windows event trimming ...');

        // No horizontal page scroll at any width; the receipt block never overflows its message.
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        const pre = slack.nth(1).locator('.mr-slack-pre');
        expect(await pre.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        expect(await contrastFailures(page, '.mr-gallery')).toEqual([]);

        await shoot(page, `incident-card-${theme}-${width}`);
        await shoot(page, `slack-message-${theme}-${width}`, { selector: '[data-shot="slack-message"]' });

        // The card's "Show the Slack message" expansion renders the same message.
        await reg.getByRole('button', { name: 'Show the Slack message' }).click();
        await expect(reg.locator('.mr-slack')).toBeVisible();
        await expect(reg.locator('.mr-slack-header')).toHaveText('Savings dropped: Payments API sampling');
        expect(errors()).toEqual([]);
      });
    }
  }
});
