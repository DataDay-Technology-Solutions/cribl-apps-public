// r2 core-10 (IC-4, major): real reducing traffic at a small volume printed "$0" in every whole-dollar field
// (ops/certification/offline/evidence/walkF: a Datagen at ≈ 0.5 GB/day, 50 % dropped, DevNull at $2.25 → "$0" for
// Today, 30 days, the day's rate, would have paid, paid, the top saver, the destination row). fmtDollars now prints a
// non-zero amount under half a dollar as "< $1" (footMoney keeps such a figure exact, so a footed field prints it too).
// Same money here on the mock: the rig's traffic priced at a fraction of a cent per GB saves ≈ $0.30 a day. Mock,
// release build. The trend axis prints cents under a dollar since r3 ui-4, and compact figures "< $1" since r3 core-8.
//
// Founder-build r3 core-7 (FINDINGS_R3 #9, #10; AA/r3/0 P4, AA/r3/2 tiny-footrows): Show the math's month-to-date rows
// and a destination's statement printed "$1 − $1 = $0" through footColumn (no "< $1" guard), and in the $1 band
// (70 % saved, AA/r3/0 zz-r3f0-dollarband: R3_SCALE=0.01 R3_ONLY=mrd_analytics) the hero printed "You paid $0" beside
// $0.27 of real spend (footMoney footed paid to $0). Both now open and scan those too.

import { expect, test, type Page } from "@playwright/test";
import {
  gotoApp,
  kvGet,
  navigateInApp,
  resetMock,
  seedPrices,
  trackConsoleErrors,
  waitForHydration,
} from "./helpers/index.ts";

const TINY_PRICES = {
  schemaVersion: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
  versions: [
    {
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      byOutputId: {
        mrd_siem_prod: { milliCentsPerGb: 170, preset: "custom" },
        mrd_analytics: { milliCentsPerGb: 170, preset: "custom" },
        mrd_archive_s3: { milliCentsPerGb: 3, preset: "custom" },
        devnull: { milliCentsPerGb: 0, preset: "internal" },
      },
    },
  ],
};

/** Every visible text node that prints a whole-dollar "$0" (not "$0.30", not a price per GB). */
async function zeroDollarFields(page: Page, rootSelector = "main"): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    const root = document.querySelector(sel) ?? document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent ?? "";
      if (!/\$0(?![\d.,])/.test(text)) continue;
      const el = n.parentElement;
      if (!el || el.closest('[aria-hidden="true"]')) continue;
      // r3 ui handoff (after core H3): a trend axis with whole days has one real zero, its bottom tick; every other tick
      // of a sub-dollar axis reads cents (ui-4, src/lib/format.ts formatAxisMoney), so any other "$0" on it is a defect.
      if (
        el.closest(".mr-trend-ylabel") &&
        text.trim() === "$0" &&
        [...(el.closest("svg")?.querySelectorAll(".mr-trend-ylabel") ?? [])].filter((t) => t.textContent?.trim() === "$0").length === 1
      )
        continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const context = (
        el.closest("p, li, tr, dd, section, div")?.textContent ?? text
      )
        .replace(/\s+/g, " ")
        .trim();
      if (/\/ ?GB/.test(context) && !/saved|paid/i.test(context)) continue; // a price, not money
      if (/priced at \$0\b/.test(context)) continue; // a destination's price, not money it saved
      out.push(context.slice(0, 160));
    }
    return out;
  }, rootSelector);
}

/** Opens the hero's Show the math. */
async function openMath(page: Page) {
  await page.locator(".mr-hero-actions").getByRole("button", { name: "Show the math" }).click();
  const drawer = page.getByTestId("math-drawer");
  await expect(drawer).toBeVisible();
  await page.waitForTimeout(300);
  return drawer;
}

/** Closes whatever dialog is open (Show the math, a statement) and waits for it to go. */
async function closeDialog(page: Page, testId: string) {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(testId)).toHaveCount(0);
}

/** A destination's statement: its this-month would have paid / paid / saved, as printed. */
async function statementThisMonth(page: Page, outputId: string): Promise<Record<string, string>> {
  await page.locator(`.mr-wmg-row:has(.mr-wmg-name[title="${outputId}"])`).getByTestId("open-statement").click();
  const st = page.getByTestId("statement");
  await expect(st).toBeVisible();
  const out: Record<string, string> = {};
  for (const row of ["whpM", "paidM", "savedM"]) out[row] = (await st.locator(`tr[data-row="${row}"] td[data-col="this"]`).innerText()).trim();
  await closeDialog(page, "statement");
  return out;
}

test('small-volume traffic: no money field on the Receipt or Flow reads "$0" while it saves money', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors = trackConsoleErrors(page, [/Outdated Optimize Dep/]);
  await gotoApp(page, "/first-run");
  await resetMock(page);
  await seedPrices(page, TINY_PRICES);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForHydration(page);
  await expect
    .poll(async () => (await kvGet(page, "snapshot")) !== null, {
      timeout: 60_000,
    })
    .toBe(true);
  const snap = JSON.parse((await kvGet(page, "snapshot"))!) as {
    headline: { mtdM: number; todayM: number };
  };
  // The money really is small, and really is savings.
  expect(snap.headline.mtdM).toBeGreaterThan(0);
  expect(snap.headline.mtdM).toBeLessThan(50_000);

  const found: Record<string, string[]> = {};
  for (const period of ["mtd", "today", "30d", "annualized"]) {
    await navigateInApp(page, `/?period=${period}`);
    await expect(page.getByTestId("receipt-hero")).toBeVisible({
      timeout: 30_000,
    });
    await page.waitForTimeout(2_500); // the hero's roll-up lands
    found[`receipt ${period}`] = await zeroDollarFields(page);
  }
  // R3 core-7 (#10): Show the math's month-to-date rows and the sentence under them, and each destination's statement.
  await navigateInApp(page, "/?period=mtd");
  await expect(page.getByTestId("receipt-hero")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2_500);
  const drawer = await openMath(page);
  expect(await drawer.getByTestId("math-dest-mtd").count()).toBeGreaterThan(1);
  found["show the math"] = await zeroDollarFields(page, '[data-testid="math-drawer"]');
  await closeDialog(page, "math-drawer");
  const statements: Record<string, Record<string, string>> = {};
  for (const id of ["mrd_siem_prod", "mrd_analytics"]) statements[id] = await statementThisMonth(page, id);
  found.statements = Object.entries(statements)
    .filter(([, m]) => Object.values(m).includes("$0"))
    .map(([id, m]) => `${id}: ${m.whpM} − ${m.paidM} = ${m.savedM}`);
  await navigateInApp(page, "/flow");
  // Integrator r3: the statements above leave the pointer where their dialogs closed. On WebKit that spot is over the
  // Palo Alto firewall band, so the side card shows that passthrough flow, which truly saves $0 a day (a real zero, not
  // money printed as $0). Park the pointer so the scan reads the map as it opens.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(2_500);
  found.flow = await zeroDollarFields(page);
  expect(found).toEqual({
    "receipt mtd": [],
    "receipt today": [],
    "receipt 30d": [],
    "receipt annualized": [],
    "show the math": [],
    statements: [],
    flow: [],
  });
  expect(await page.getByText("< $1").count()).toBeGreaterThan(0);
  expect(errors()).toEqual([]);
});

// R3 core-7 (#9): the $1 band. Only mrd_analytics priced, at 1 % of its list ($0.015/GB), 70 % saved: month to date
// $0.90 would have paid − $0.27 paid = $0.63 saved printed "You would have paid $1 · You paid $0" (AA/r3/0 P4). Pinned
// to the probe's clock (Mon 15:10Z) so the money lands in the band.
const BAND_PRICES = {
  schemaVersion: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
  versions: [
    {
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      byOutputId: {
        mrd_siem_prod: { milliCentsPerGb: 0, preset: "custom" },
        mrd_analytics: { milliCentsPerGb: 1_500, preset: "custom" },
        mrd_archive_s3: { milliCentsPerGb: 0, preset: "custom" },
        devnull: { milliCentsPerGb: 0, preset: "internal" },
      },
    },
  ],
};

test('the $1 band (70 % saved): the hero never prints "You paid $0" beside real spend; Show the math and the statement agree', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = trackConsoleErrors(page, [/Outdated Optimize Dep/]);
  await page.clock.install({ time: new Date("2026-09-28T15:10:00Z") });
  await gotoApp(page, "/first-run");
  await resetMock(page);
  await seedPrices(page, BAND_PRICES);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForHydration(page);
  await expect.poll(async () => (await kvGet(page, "snapshot")) !== null, { timeout: 60_000 }).toBe(true);
  const snap = JSON.parse((await kvGet(page, "snapshot"))!) as { headline: { whpMtdM: number; paidMtdM: number; mtdM: number } };
  // The money really is in the band: under $2 would have paid, real spend under a dollar, real savings.
  expect(snap.headline.whpMtdM).toBeGreaterThan(50_000);
  expect(snap.headline.whpMtdM).toBeLessThan(200_000);
  expect(snap.headline.paidMtdM).toBeGreaterThan(0);
  expect(snap.headline.mtdM).toBeGreaterThan(0);
  const found: Record<string, string[]> = {};
  for (const period of ["mtd", "today", "30d", "annualized"]) {
    await navigateInApp(page, `/?period=${period}`);
    await expect(page.getByTestId("receipt-hero")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2_500);
    found[`hero ${period}`] = await zeroDollarFields(page, '[data-testid="receipt-hero"]');
  }
  await navigateInApp(page, "/?period=mtd");
  await expect(page.getByTestId("receipt-hero")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2_500);
  const drawer = await openMath(page);
  const reconcile = await drawer.getByTestId("math-reconcile").innerText();
  const analyticsBlock = drawer.locator("li.mr-math-dest").filter({ has: page.locator(".mr-math-dest-name", { hasText: /analytics/i }) });
  await expect(analyticsBlock).toHaveCount(1);
  const analyticsRow = (await analyticsBlock.getByTestId("math-dest-mtd").innerText()).replace(/\s+/g, " ");
  await closeDialog(page, "math-drawer");
  const statement = await statementThisMonth(page, "mrd_analytics");
  found["show the math"] = [reconcile, analyticsRow].filter((t) => /\$0(?![\d.,])/.test(t));
  found.statement = Object.values(statement).includes("$0") ? [`${statement.whpM} − ${statement.paidM} = ${statement.savedM}`] : [];
  expect(found).toEqual({ "hero mtd": [], "hero today": [], "hero 30d": [], "hero annualized": [], "show the math": [], statement: [] });
  // The drawer's analytics row and the statement print one month to date.
  expect(analyticsRow).toContain(`${statement.whpM} − ${statement.paidM} = ${statement.savedM}`);
  expect(errors()).toEqual([]);
});
