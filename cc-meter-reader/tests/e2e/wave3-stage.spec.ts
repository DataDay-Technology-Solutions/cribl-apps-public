// tests/e2e/wave3-stage.spec.ts — wave 3, the stage and the Story (W3-STAGE-1…4) on the in-browser emulator.
//
//   W3-STAGE-1  while an open regression names a saver, its line keeps its own figure and carries the drop as a red
//               chip (the hero chip's figure, to the dollar); it turns plain once the incident closes — on the
//               Story's presenter beats and on the live stage.
//   W3-STAGE-2  the Story's saver names use the stage's label rule and wrap to a second line rather than end in an
//               ellipsis, the leader on the last line, the amounts on one right edge, the frame unchanged.
//   W3-STAGE-3  the dollar map's "what the pipeline removed" dot sits on the hatched saved wedge at every width.
//   W3-STAGE-4  the Story's alert beat at 1280×720: the card whole inside the frame and clear of the caption, the
//               "who deployed it" dot beside the author.
//
// Each size runs on one project (1920 on chromium-1920, 1440 and 1280×720 on chromium, 390 on mobile), so the
// default three-project run covers every size once. Evidence: tests/report/screens/wave3-stage-*.png.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { Incident, Settings, Snapshot, StoryDoc } from '../../core/types.ts';
import { storyIncident } from '../../src/story/select.ts';
import { beatStarts, positionAt } from '../../src/story/timeline.ts';
import { gotoApp, setTheme, trackConsoleErrors, type Theme } from './helpers/index.ts';

const DOC = JSON.parse(readFileSync(fileURLToPath(new URL('../../demo/sample/story.json', import.meta.url)), 'utf8')) as StoryDoc;
const STARTS = beatStarts(DOC);
const INCIDENT = storyIncident(DOC)!;
const SCREENS = 'tests/report/screens';
const MC = 100_000;
/** The minus sign the stage writes before a drop (U+2212, as the hero chip's). */
const MINUS = '−';
const dollars = (m: number): string => `$${Math.round(m / MC).toLocaleString('en-US')}`;

interface Size {
  width: number;
  height: number;
  project: string;
}
const SIZES: Size[] = [
  { width: 1920, height: 1080, project: 'chromium-1920' },
  { width: 1440, height: 900, project: 'chromium' },
  { width: 1280, height: 720, project: 'chromium' },
  { width: 390, height: 844, project: 'mobile' },
];
const sizeName = (s: Size): string => (s.width === 1280 ? '1280x720' : String(s.width));
const onlyOn = (info: TestInfo, s: Size): void => test.skip(info.project.name !== s.project, `${sizeName(s)} runs on ${s.project}`);

async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${SCREENS}/wave3-stage-${name}.png`, fullPage: false });
}

// ─── The Story ───────────────────────────────────────────────────────────────

const STORY = '.mr-story[data-ready="true"]';
const LIVE = 'main .mr-st-scene:not([data-leaving])';
const beatIndex = (id: string): number => DOC.beats.findIndex((b) => b.id === id);
/** Late in a beat: its actions have landed and its chips have faded in. */
const lateIn = (id: string): number => STARTS[beatIndex(id)] + DOC.beats[beatIndex(id)].seconds - 0.3;

async function openStory(page: Page, s: Size, theme: Theme): Promise<void> {
  await page.setViewportSize({ width: s.width, height: s.height });
  await gotoApp(page, '/?story=1');
  await page.locator(STORY).waitFor();
  await page.waitForFunction(() => '__MR_STORY__' in window);
  await setTheme(page, theme);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

async function showAt(page: Page, sec: number): Promise<void> {
  const expected = positionAt(DOC, sec);
  await page.evaluate((x) => {
    const api = (window as unknown as { __MR_STORY__: { pause(): void; seek(n: number): void } }).__MR_STORY__;
    api.pause();
    api.seek(x);
  }, sec);
  await expect(page.locator('.mr-story')).toHaveAttribute('data-beat', expected.beat.id);
  await page.waitForFunction(() => document.querySelector('.mr-st-scene[data-leaving]') === null, undefined, { timeout: 5_000 });
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity), undefined, {
    timeout: 5_000,
  });
}

test.describe('W3-STAGE-1: the Story names the drop on the saver it took it from', () => {
  for (const s of SIZES) {
    test(`the alert beat's Payments line carries the hero chip's drop; restore and after are plain (${sizeName(s)})`, async ({ page }, info) => {
      onlyOn(info, s);
      const errors = trackConsoleErrors(page);
      await openStory(page, s, 'light');
      const row = page.locator(`${LIVE} .mr-st-pv-item[data-key="${INCIDENT.objectKey}"]`);
      const drops = page.locator(`${LIVE} .mr-st-pv-drop`);

      // The hook: the same line, plain; remember where it sits.
      await showAt(page, lateIn('hook'));
      await expect(row).toHaveCount(1);
      await expect(drops).toHaveCount(0);
      const keysAtHook = await page.locator(`${LIVE} .mr-st-pv-item`).evaluateAll((els) => els.map((el) => el.getAttribute('data-key')));

      // The alert: the line keeps its own figure and its place, and carries the incident's $ a day as a red chip.
      await showAt(page, lateIn('alert'));
      const perDay = dollars(INCIDENT.impactPerDayM);
      expect(perDay).toBe('$1,250');
      await expect(row).toHaveAttribute('data-drop-m', String(INCIDENT.impactPerDayM));
      await expect(row.locator('.mr-st-pv-drop')).toHaveText(`${MINUS}${perDay}`);
      await expect(drops).toHaveCount(1);
      // To the dollar with the hero chip ("−$1,250 / day").
      const chip = page.locator(`${LIVE} .mr-st-pv-delta[data-tone="loss"]`);
      await expect(chip).toHaveText(`${MINUS}${perDay} / day`);
      // Its own figure stays (the last hour's rate, never less the impact) and a screen reader hears the drop.
      await expect(row.locator('.mr-st-pv-item-amount .mr-num')).toHaveText(/^\$\d{1,3}(,\d{3})*$/);
      await expect(row.locator('.mr-visually-hidden')).toHaveText(`Down ${perDay} a day while the alert is open.`);
      const keysAtAlert = await page.locator(`${LIVE} .mr-st-pv-item`).evaluateAll((els) => els.map((el) => el.getAttribute('data-key')));
      expect(keysAtAlert.indexOf(INCIDENT.objectKey)).toBe(keysAtHook.indexOf(INCIDENT.objectKey));

      if (s.width > 720) {
        // Shown, in its row, and the amounts still one right-aligned column.
        await expect(row.locator('.mr-st-pv-drop')).toBeVisible();
        const geo = await page.evaluate((live) => {
          const rows = [...document.querySelectorAll(`${live} .mr-st-pv-item`)];
          return {
            rights: rows.map((r) => r.querySelector('.mr-st-pv-item-amount')!.getBoundingClientRect().right),
            chipInRow: rows.every((r) => {
              const c = r.querySelector('.mr-st-pv-drop');
              if (!c) return true;
              const a = c.getBoundingClientRect();
              const b = r.getBoundingClientRect();
              return a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
            }),
          };
        }, LIVE);
        expect(Math.max(...geo.rights) - Math.min(...geo.rights)).toBeLessThanOrEqual(1);
        expect(geo.chipInRow).toBe(true);
      } else {
        // A phone gives the alert beat to the card: the savers are not drawn (Story.css), but the line still carries it.
        await expect(page.locator(`${LIVE} .mr-st-pv-savers`)).toBeHidden();
      }

      // The restore beat and every beat after it: no line carries a drop.
      for (let i = beatIndex('restore'); i < DOC.beats.length; i++) {
        await showAt(page, lateIn(DOC.beats[i].id));
        await expect(drops).toHaveCount(0);
      }
      expect(errors()).toEqual([]);
    });
  }

  for (const s of SIZES.filter((x) => x.width !== 1280)) {
    for (const theme of ['light', 'dark'] as const) {
      test(`evidence: the alert beat's savers with the drop (${theme}, ${sizeName(s)})`, async ({ page }, info) => {
        onlyOn(info, s);
        await openStory(page, s, theme);
        await showAt(page, lateIn('alert'));
        await shot(page, `savers-${theme}-${sizeName(s)}`);
      });
    }
  }
});

interface SaverFit {
  rows: number;
  clipped: string[];
  rights: number[];
  leaderOffLastLine: string[];
  twoLinesMax: string[];
  spill: number;
  scroll: number;
  inner: number;
}

/** Every drawn saver line on the scene: clipped names, the amounts' right edges, where the leader sits, the frame. */
async function saverFit(page: Page): Promise<SaverFit> {
  return page.evaluate((live) => {
    const rows = [...document.querySelectorAll<HTMLElement>(`${live} .mr-st-pv-item`)].filter((el) => el.getBoundingClientRect().height > 0);
    const clipped: string[] = [];
    const leaderOffLastLine: string[] = [];
    const twoLinesMax: string[] = [];
    for (const row of rows) {
      const label = row.querySelector<HTMLElement>('.mr-st-pv-item-label')!;
      const name = label.textContent ?? '';
      const cs = getComputedStyle(label);
      const hides = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
      if (label.scrollWidth > label.clientWidth + 0.5 || cs.textOverflow === 'ellipsis' || (hides && label.scrollHeight > label.clientHeight + 0.5) || /…$|\.\.\.$/.test(name))
        clipped.push(name);
      const lh = parseFloat(getComputedStyle(label).lineHeight);
      const lb = label.getBoundingClientRect();
      if (Math.round(lb.height / lh) > 2) twoLinesMax.push(name);
      const leader = row.querySelector<HTMLElement>('.mr-st-pv-leader')!.getBoundingClientRect();
      // The leader's dots sit on the name's last line: inside the label's last line box.
      if (leader.bottom < lb.bottom - lh || leader.bottom > lb.bottom + 1) leaderOffLastLine.push(name);
      // The dots start where the name's last line ends (leaderReach.ts), not past a wrapped box's empty end.
      const range = document.createRange();
      range.selectNodeContents(label);
      const lines = [...range.getClientRects()].filter((r) => r.width > 0);
      const lastBottom = Math.max(...lines.map((r) => r.bottom));
      const lastRight = Math.max(...lines.filter((r) => r.bottom >= lastBottom - 1).map((r) => r.right));
      const reach = parseFloat(row.querySelector<HTMLElement>('.mr-st-pv-leader')!.style.getPropertyValue('--mr-lead-reach') || '0');
      const fontPx = parseFloat(getComputedStyle(row).fontSize);
      if (leader.left - reach - lastRight > 0.6 * fontPx) leaderOffLastLine.push(`${name} (dots start ${Math.round(leader.left - reach - lastRight)} px after the words)`);
    }
    const stage = document.querySelector('main.mr-st-stage')!.getBoundingClientRect();
    const blocks = [...document.querySelectorAll(`main .mr-st-scene > *, main .mr-takeover, main .mr-st-panel`)].map((el) => el.getBoundingClientRect());
    return {
      rows: rows.length,
      clipped,
      rights: rows.map((r) => r.querySelector('.mr-st-pv-item-amount')!.getBoundingClientRect().right),
      leaderOffLastLine,
      twoLinesMax,
      spill: Math.max(0, ...blocks.filter((b) => b.height > 0).map((b) => b.bottom - stage.bottom)),
      scroll: document.documentElement.scrollHeight,
      inner: window.innerHeight,
    };
  }, LIVE);
}

test.describe("W3-STAGE-2: the Story's saver names read whole", () => {
  for (const s of SIZES) {
    test(`no saver name is clipped or ellipsized; one right edge; the frame holds (${sizeName(s)})`, async ({ page }, info) => {
      onlyOn(info, s);
      await openStory(page, s, 'light');
      for (const id of ['hook', 'alert', 'restore']) {
        await showAt(page, lateIn(id));
        const fit = await saverFit(page);
        // A phone gives the card beats to the card (Story.css); the hook still lists all five.
        const expected = s.width <= 720 && id !== 'hook' ? 0 : 5;
        expect(fit.rows, `${id}: saver lines drawn`).toBe(expected);
        expect(fit.clipped, `${id}: clipped names`).toEqual([]);
        expect(fit.twoLinesMax, `${id}: names past two lines`).toEqual([]);
        expect(fit.leaderOffLastLine, `${id}: leaders off the name's last line`).toEqual([]);
        if (fit.rows > 0) expect(Math.max(...fit.rights) - Math.min(...fit.rights), `${id}: the amounts' right edge`).toBeLessThanOrEqual(1);
        expect(fit.scroll, `${id}: the page scrolls`).toBe(fit.inner);
        expect(fit.spill, `${id}: the scene spills past the stage`).toBeLessThanOrEqual(0.5);
      }
    });
  }

  for (const s of SIZES) {
    for (const theme of ['light', 'dark'] as const) {
      test(`evidence: the hook's savers, whole (${theme}, ${sizeName(s)})`, async ({ page }, info) => {
        onlyOn(info, s);
        await openStory(page, s, theme);
        await showAt(page, lateIn('hook'));
        await shot(page, `story-savers-hook-${theme}-${sizeName(s)}`);
        if (s.width > 720) {
          await showAt(page, lateIn('alert'));
          await shot(page, `story-savers-alert-${theme}-${sizeName(s)}`);
        }
      });
    }
  }
});

/** The alert beat's latest second with the author's callout up (every callout of the beat placed by then). */
function authorSecond(): number {
  const i = beatIndex('alert');
  for (let t = STARTS[i] + DOC.beats[i].seconds - 0.3; t > STARTS[i]; t -= 0.1) if (positionAt(DOC, t).callouts.some((c) => c.target === 'author')) return t;
  throw new Error('the alert beat has no author callout');
}

test.describe('W3-STAGE-4: the Story alert beat at 1280x720', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`the card fits whole, clears the caption, and "who deployed it" points at the author (${theme})`, async ({ page }, info) => {
      const s = SIZES.find((x) => x.width === 1280)!;
      onlyOn(info, s);
      const errors = trackConsoleErrors(page);
      await openStory(page, s, theme);
      await showAt(page, authorSecond());
      await page.waitForFunction(() => [...document.querySelectorAll('.mr-st-callout')].every((el) => el.getAttribute('data-placed') === 'true'), undefined, { timeout: 5_000 });
      // One re-measure after everything settled (Callouts.tsx measures every 250 ms).
      await page.waitForTimeout(400);
      const m = await page.evaluate((live) => {
        const card = document.querySelector<HTMLElement>(`${live} .mr-takeover`)!;
        const c = card.getBoundingClientRect();
        const caption = document.querySelector('.mr-st-caption')!.getBoundingClientRect();
        const author = document.querySelector(`${live} [data-callout="author"]`)!.getBoundingClientRect();
        const dot = document.querySelector('.mr-st-leader[data-target="author"] circle')!;
        const cx = Number(dot.getAttribute('cx'));
        const cy = Number(dot.getAttribute('cy'));
        const dx = Math.max(author.left - cx, 0, cx - author.right);
        const dy = Math.max(author.top - cy, 0, cy - author.bottom);
        const border = parseFloat(getComputedStyle(card).borderBottomWidth);
        return {
          cardBottom: c.bottom,
          border,
          inner: window.innerHeight,
          scroll: document.documentElement.scrollHeight,
          overflow: card.scrollHeight - card.clientHeight,
          gap: caption.top - c.bottom,
          captionText: document.querySelector('.mr-st-caption')!.textContent,
          dotFromAuthor: Math.hypot(dx, dy),
          dotInsideCard: cx >= c.left && cx <= c.right && cy >= c.top && cy <= c.bottom,
          author: { left: author.left, top: author.top, right: author.right, bottom: author.bottom },
          dot: { cx, cy },
        };
      }, LIVE);
      info.annotations.push({ type: 'W3-STAGE-4 measures', description: JSON.stringify(m) });
      expect(m.border, 'the card has a bottom border').toBeGreaterThan(0);
      expect(m.cardBottom, "the card's bottom border is inside the frame").toBeLessThanOrEqual(m.inner);
      expect(m.scroll, 'the page scrolls').toBe(m.inner);
      expect(m.overflow, "the card's content overflows it").toBeLessThanOrEqual(0);
      expect(m.gap, 'the caption clears the card by 8 px').toBeGreaterThanOrEqual(8);
      // The dot sits just off the author's words (the layout's air + the dot's radius), never adrift.
      expect(m.dotFromAuthor, 'the author dot is beside the author').toBeLessThanOrEqual(16);
      await shot(page, `story-alert-${theme}-1280x720`);
      expect(errors()).toEqual([]);
    });
  }
});

/** The flow beat's latest second with the "what the pipeline removed" callout up. */
function flowSavedSecond(): number {
  const i = beatIndex('flow');
  for (let t = STARTS[i] + DOC.beats[i].seconds - 0.3; t > STARTS[i]; t -= 0.1) if (positionAt(DOC, t).callouts.some((c) => c.target === 'flow-saved')) return t;
  throw new Error('the flow beat has no flow-saved callout');
}

test.describe('W3-STAGE-3: the flow beat\'s saved callout points at a hatched saved wedge', () => {
  for (const s of SIZES) {
    for (const theme of ['light', 'dark'] as const) {
      test(`the dot lands on the plate's own hatched wedge (${theme}, ${sizeName(s)})`, async ({ page }, info) => {
        onlyOn(info, s);
        const errors = trackConsoleErrors(page);
        await openStory(page, s, theme);
        await showAt(page, flowSavedSecond());
        await page.waitForFunction(() => [...document.querySelectorAll('.mr-st-callout')].every((el) => el.getAttribute('data-placed') === 'true'), undefined, { timeout: 5_000 });
        await page.waitForTimeout(400);
        await shot(page, `story-flow-${theme}-${sizeName(s)}`);
        const hit = await page.evaluate((live) => {
          const dot = document.querySelector('.mr-st-leader[data-target="flow-saved"] circle');
          if (!dot) return { found: false } as const;
          const cx = Number(dot.getAttribute('cx'));
          const cy = Number(dot.getAttribute('cy'));
          const layer = document.querySelector<HTMLElement>('.mr-st-callouts')!;
          layer.style.visibility = 'hidden';
          const probe = (x: number, y: number) => document.elementFromPoint(x, y);
          const at = probe(cx, cy);
          // The dot's whole disc: its four compass points (the radius less its stroke) are wedge too.
          const rim = [
            [3, 0],
            [-3, 0],
            [0, 3],
            [0, -3],
          ].map(([dx, dy]) => probe(cx + dx, cy + dy));
          layer.style.visibility = '';
          const plate = document.querySelector(`${live} [data-callout="flow-saved"]`);
          const ribbon = plate?.getAttribute('data-label')?.replace(/^saved:/, '') ?? '';
          return {
            found: true,
            cls: at?.getAttribute('class') ?? at?.tagName ?? null,
            wedge: at?.classList.contains('mr-flow-wedge') ?? false,
            hatched: (at?.getAttribute('fill') ?? '').startsWith('url(#mr-flow-hatch'),
            wedgeOf: at?.getAttribute('data-wedge') ?? null,
            plateLabel: plate?.getAttribute('data-label') ?? null,
            ribbon,
            rim: rim.map((el) => el?.classList.contains('mr-flow-wedge') ?? false),
            dot: { cx, cy },
          } as const;
        }, LIVE);
        info.annotations.push({ type: 'W3-STAGE-3 hit', description: JSON.stringify(hit) });
        const cover = await page.evaluate((live) => {
          const label = document.querySelector('.mr-st-callout[data-target="flow-saved"]')!;
          const l = label.getBoundingClientRect();
          const out: string[] = [];
          // The label hides none of the map's money (plates) and none of its words.
          for (const el of document.querySelectorAll(`${live} .mr-flow-svg text`)) {
            const r = el.getBoundingClientRect();
            if (Math.min(l.right, r.right) - Math.max(l.left, r.left) > 0.5 && Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top) > 0.5) out.push(el.textContent ?? '');
          }
          return { hides: out, ok: label.getAttribute('data-ok'), clean: label.getAttribute('data-clean') };
        }, LIVE);
        info.annotations.push({ type: 'W3-STAGE-3 label', description: JSON.stringify(cover) });
        expect(cover.hides, 'the label hides none of the map\'s words').toEqual([]);
        expect(hit.found, 'the flow-saved leader is drawn').toBe(true);
        if (!hit.found) return;
        expect(hit.wedge, `the dot's centre is on ${hit.cls}, not a saved wedge`).toBe(true);
        expect(hit.hatched, 'the wedge is hatched').toBe(true);
        expect(hit.wedgeOf, "the wedge is the one the plate labels").toBe(hit.ribbon);
        expect(hit.rim, 'the whole dot sits on the wedge').toEqual([true, true, true, true]);
        expect(errors()).toEqual([]);
      });
    }
  }
});

// ─── The live stage ──────────────────────────────────────────────────────────

interface Hook {
  store: {
    getState(): { settings: Settings; snapshot: Snapshot | null };
    setState(p: Record<string, unknown>): void;
  };
  stop(): void;
}

/** Real snapshots key savers by route (core/snapshot.ts); the demo's trim break is keyed by its pipeline. */
const SAVERS = [
  { route: 'mrd_win_security', pipeline: 'mrd_win_xml_pack', label: 'Windows event trimming', perDay: 1_340 },
  { route: 'mrd_pan_traffic', pipeline: 'mrd_pan_pack', label: 'Firewall duplicate suppression', perDay: 912 },
  { route: 'mrd_k8s', pipeline: 'mrd_k8s_noise', label: 'Kubernetes noise filter', perDay: 640 },
  { route: 'mrd_payments_api', pipeline: 'mrd_pay_sample', label: 'Payments API sampling', perDay: 3_764 },
  { route: 'mrd_cdn', pipeline: 'mrd_cdn_agg', label: 'CDN log aggregation', perDay: 121 },
].sort((a, b) => b.perDay - a.perDay);
const PAY_KEY = 'route:default:mrd_payments_api';

function snapshotAt(now: number): Snapshot {
  const perDayM = SAVERS.reduce((sum, x) => sum + x.perDay, 0) * MC;
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
    topSavers: SAVERS.map((x) => ({
      objectKey: `route:default:${x.route}`,
      label: x.label,
      savedPerDayM: x.perDay * MC,
      ratio: 0.6,
      groupId: 'default',
      pipelineId: x.pipeline,
    })),
    unpricedOutputIds: [],
    openIncidents: 0,
    incidents: [],
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

function regression(now: number, over: Partial<Incident> = {}): Incident {
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    id: 'inc_w3_stage',
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
    impactPerDayM: 1_250 * MC,
    caughtInSec: 170,
    notes: ['demo-profile'],
    deliveries: [],
    ...over,
  };
}

async function openPresenter(page: Page, s: Size, theme: Theme): Promise<void> {
  await page.setViewportSize({ width: s.width, height: s.height });
  await gotoApp(page, '/?present=1');
  await page.waitForFunction(() => '__MR_PRESENTER__' in window);
  await setTheme(page, theme);
  const now = await page.evaluate(() => Date.now());
  await page.evaluate(
    ({ snap }) => {
      const h = (window as unknown as { __MR_PRESENTER__: Hook }).__MR_PRESENTER__;
      h.stop();
      const { settings } = h.store.getState();
      h.store.setState({
        snapshot: snap,
        source: 'live',
        errors: {},
        prices: { schemaVersion: 1, updatedAt: new Date(0).toISOString(), versions: [] },
        settings: { ...settings, presenter: { ...settings.presenter, headlinePeriod: 'annualized' } },
      });
    },
    { snap: snapshotAt(now) },
  );
  await expect(page.locator('.mr-pv-item')).toHaveCount(5);
}

async function publishIncidents(page: Page, incidents: Incident[]): Promise<void> {
  await page.evaluate((incs) => {
    const h = (window as unknown as { __MR_PRESENTER__: Hook }).__MR_PRESENTER__;
    const snap = h.store.getState().snapshot;
    if (!snap) throw new Error('no snapshot on stage');
    h.store.setState({ snapshot: { ...snap, incidents: incs, openIncidents: incs.filter((i) => !i.closedAt).length } });
  }, incidents);
}

test.describe('W3-STAGE-1: the live stage names the drop on the saver it took it from', () => {
  for (const s of SIZES.filter((x) => x.width !== 1280)) {
    for (const theme of ['light', 'dark'] as const) {
      test(`the named saver's chip is the takeover card's $ a day, gone after recovery (${theme}, ${sizeName(s)})`, async ({ page }, info) => {
        onlyOn(info, s);
        const errors = trackConsoleErrors(page);
        await openPresenter(page, s, theme);
        const row = page.locator(`.mr-pv-item[data-key="${PAY_KEY}"]`);
        const drops = page.locator('.mr-pv-drop');
        await expect(drops).toHaveCount(0);
        const before = await page.locator('.mr-pv-item').evaluateAll((els) => els.map((el) => el.getAttribute('data-key')));

        // A regression keyed by the pipeline (the demo's trim break) lands on the route that carries it.
        const t0 = await page.evaluate(() => Date.now());
        await publishIncidents(page, [regression(t0)]);
        const takeover = page.locator('.mr-takeover');
        await expect(takeover).toHaveAttribute('data-mode', 'alert');
        const cardPerDay = (await takeover.locator('[data-callout="per-day"] .mr-num').first().textContent())!;
        expect(cardPerDay).toBe('$1,250');
        await expect(row.locator('.mr-pv-drop')).toHaveText(`${MINUS}${cardPerDay}`);
        await expect(drops).toHaveCount(1);
        await expect(row).toHaveAttribute('data-amount', '$3,764');
        await expect(row.locator('.mr-visually-hidden')).toHaveText(`Down ${cardPerDay} a day while the alert is open.`);
        expect(await page.locator('.mr-pv-item').evaluateAll((els) => els.map((el) => el.getAttribute('data-key')))).toEqual(before);
        if (s.width > 720) {
          await expect(row.locator('.mr-pv-drop')).toBeVisible();
          // The amounts stay one right-aligned column.
          const rights = await page.locator('.mr-pv-item-amount').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().right));
          expect(Math.max(...rights) - Math.min(...rights)).toBeLessThanOrEqual(1);
          // The card never covers the line (BEAUTY F1).
          const covered = await page.evaluate(() => {
            const c = document.querySelector('.mr-takeover')!.getBoundingClientRect();
            const r = document.querySelector('.mr-pv-drop')!.getBoundingClientRect();
            return Math.min(c.right, r.right) - Math.max(c.left, r.left) > 0.5 && Math.min(c.bottom, r.bottom) - Math.max(c.top, r.top) > 0.5;
          });
          expect(covered).toBe(false);
        }
        await page.waitForTimeout(600);
        if (s.width !== 1280) await shot(page, `pv-savers-${theme}-${sizeName(s)}`);

        // Recovery: the incident closes itself; the line turns plain.
        await publishIncidents(page, [regression(t0, { closedAt: new Date(t0 + 60_000).toISOString(), recoveredTo: 0.75 })]);
        await expect(takeover).toHaveAttribute('data-mode', 'recovery');
        await expect(drops).toHaveCount(0);
        await expect(row.locator('.mr-visually-hidden')).toHaveCount(0);
        expect(errors()).toEqual([]);
      });
    }
  }
});
