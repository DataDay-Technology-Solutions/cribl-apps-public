// tests/e2e/r3-core-weekly-first-install.spec.ts — founder-build r3 core-2 (FINDINGS_R3 #1, major; AA/r3/0 probes
// zz-r3f0-coldpath.spec.ts and zz-r3f0-judgepath.spec.ts, evidence P1-f89-mon1510-chromium-kv.json, P6-f89-chromium.txt).
//
// On the release build, a fresh install between Monday 12:00 UTC and Tuesday 12:00 UTC posted "Weekly receipt ·
// Sep 21–27, 2026 · Saved by Cribl $147" to the Cribl bell from the ~14 h its first sweep back-filled (the cold path at
// Mon 15:10Z), and "$40" on the judge path (tour → See your own number → Start the meter) at Mon 8:10 PM CDT (Tue
// 01:10Z): a receipt for a week the workspace never metered, exactly when judges install. Now the first metering
// sweep records meta.meteringStartedAt, and the automatic receipt goes out only for a week that ended after it. The
// Sunday and Tuesday-afternoon cold paths were already quiet (controls). A workspace that metered last week still gets
// its receipt from the open tab (the positive control). Mock, release build, the config's America/Chicago zone.

import { expect, test, type Page } from "@playwright/test";
import { bellMessages, gotoApp, kvGet, navigateInApp, resetMock, trackConsoleErrors, waitForHydration } from "./helpers/index.ts";

const DAY = 86_400_000;

async function sweepAtMs(page: Page): Promise<number> {
  const s = JSON.parse((await kvGet(page, "snapshot").catch(() => null)) ?? "null") as { sweepAt?: string } | null;
  return s?.sweepAt ? Date.parse(s.sweepAt) : 0;
}

async function meta(page: Page): Promise<{ meteringStartedAt?: string; collectingSince?: string; lastWeeklySentAt?: string } | null> {
  return JSON.parse((await kvGet(page, "meta")) ?? "null");
}

/** Waits for the next sweep after fast-forwarding the page clock by `ms`. */
async function nextSweep(page: Page, ms = 60_000): Promise<void> {
  const before = await sweepAtMs(page);
  await page.clock.fastForward(ms);
  await expect.poll(() => sweepAtMs(page), { timeout: 60_000 }).toBeGreaterThan(before);
}

/** The release cold path: no KV → suggested prices → Start the meter → the Receipt, then two more sweeps. */
async function coldPath(page: Page, at: string): Promise<void> {
  await page.clock.install({ time: new Date(at) });
  await gotoApp(page, "/first-run");
  await resetMock(page);
  await gotoApp(page, "/");
  await page.goto("/settings/prices", { waitUntil: "domcontentloaded" });
  await waitForHydration(page);
  await page.getByRole("button", { name: /^Use suggested prices/ }).click({ timeout: 40_000 });
  await page.locator('section[data-section="prices"]').getByRole("button", { name: "Start the meter" }).click();
  await expect(page.getByText("The meter is running.", { exact: false }).first()).toBeVisible();
  await navigateInApp(page, "/");
  await expect.poll(() => sweepAtMs(page), { timeout: 120_000 }).toBeGreaterThan(0);
  // Each timed tick sweeps, then (when due) sends the week's receipt: give it two more.
  await nextSweep(page, 3 * 60_000);
  await nextSweep(page);
  await page.waitForTimeout(1_500);
}

const weekly = (items: { id: string; title: string }[]) => items.filter((m) => m.id.startsWith("meter-reader-receipt-") || /^Weekly receipt/.test(m.title));

for (const [name, at, finding] of [
  ["Mon 15:10Z (the finding: a day back-filled into last week)", "2026-09-28T15:10:00Z", true],
  ["Sun 15:10Z (control)", "2026-09-27T15:10:00Z", false],
  ["Tue 15:10Z (control)", "2026-09-29T15:10:00Z", false],
] as const) {
  test(`cold path at ${name}: no weekly receipt reaches the bell for a week never metered`, async ({ page }) => {
    test.setTimeout(300_000);
    const errors = trackConsoleErrors(page, [/Outdated Optimize Dep/]);
    await coldPath(page, at);
    // The symptom first (red on f8953da at Mon 15:10Z: "Weekly receipt · Sep 21–27, 2026 · Saved by Cribl $147").
    expect(weekly(await bellMessages(page))).toEqual([]);
    const m = await meta(page);
    expect(m?.meteringStartedAt, "the first metering sweep records when metering started").toBeDefined();
    expect(Math.abs(Date.parse(m!.meteringStartedAt!) - Date.parse(at))).toBeLessThan(10 * 60_000);
    if (finding) expect(Date.parse(m!.collectingSince!)).toBeLessThan(Date.parse("2026-09-28T12:00:00Z")); // the old rule's trigger
    expect(m?.lastWeeklySentAt).toBeUndefined();
    expect(errors()).toEqual([]);
  });
}

test("the judge path at Tue 01:10Z (Mon 8:10 PM CDT): tour → See your own number → Start the meter posts no weekly receipt", async ({ page }) => {
  test.setTimeout(300_000);
  const errors = trackConsoleErrors(page, [/Outdated Optimize Dep/]);
  await page.clock.install({ time: new Date("2026-09-29T01:10:00Z") });
  await gotoApp(page, "/first-run");
  await resetMock(page);
  await gotoApp(page, "/first-run");
  await page.getByTestId("first-run").getByRole("button", { name: "Tour with sample data" }).click();
  const band = page.locator('[data-callout="sample-band"]');
  await expect(band).toBeVisible();
  await page.clock.fastForward(160_000);
  await expect(page.locator("html")).toHaveAttribute("data-mr-tour", "finished", { timeout: 15_000 });
  await page.getByRole("button", { name: "Close", exact: true }).first().click({ timeout: 2_000 }).catch(() => undefined);
  await band.getByRole("button", { name: "See your own number" }).click();
  await expect(page).toHaveURL(/\/settings\/prices$/);
  await expect(page.getByText(/^Filled \d+ suggested prices?\. Review/).first()).toBeVisible({ timeout: 40_000 });
  await page.locator('section[data-section="prices"]').getByRole("button", { name: "Start the meter" }).click();
  await expect(page.getByText("The meter is running.", { exact: false }).first()).toBeVisible();
  await expect.poll(() => sweepAtMs(page), { timeout: 120_000 }).toBeGreaterThan(0);
  await navigateInApp(page, "/");
  await expect(page.getByTestId("receipt-hero")).toBeVisible({ timeout: 30_000 });
  await nextSweep(page, 3 * 60_000);
  await page.waitForTimeout(1_500);
  // The tour's own "Weekly receipt ready" toast is the sample's, on screen only; the Cribl bell gets nothing.
  expect(weekly(await bellMessages(page))).toEqual([]);
  expect((await meta(page))?.meteringStartedAt).toBeDefined();
  expect(errors()).toEqual([]);
});

test("positive control: a workspace that metered last week still gets its receipt from the open tab", async ({ page }) => {
  test.setTimeout(300_000);
  const errors = trackConsoleErrors(page, [/Outdated Optimize Dep/]);
  await coldPath(page, "2026-09-28T15:10:00Z");
  expect(weekly(await bellMessages(page))).toEqual([]);
  // Back-date when metering started to before the reported week (as a workspace metering for weeks has it). A sweep
  // that read meta before this write may put the old value back: write until a sweep carries it.
  const since = new Date(Date.parse("2026-09-28T15:10:00Z") - 8 * DAY).toISOString();
  await expect
    .poll(
      async () => {
        const m = await meta(page);
        if (m?.meteringStartedAt === since) return true;
        await page.evaluate(async (body) => {
          await fetch("/mock-api/v1/kvstore/meta", { method: "PUT", headers: { "content-type": "text/plain" }, body });
        }, JSON.stringify({ ...m, meteringStartedAt: since }));
        await nextSweep(page);
        return (await meta(page))?.meteringStartedAt === since;
      },
      { timeout: 120_000, intervals: [500] },
    )
    .toBe(true);
  await nextSweep(page);
  await expect.poll(async () => weekly(await bellMessages(page)).map((m) => m.title), { timeout: 60_000 }).toEqual(["Weekly receipt · Sep 21–27, 2026"]);
  expect((await meta(page))?.lastWeeklySentAt).toBeDefined();
  expect(errors()).toEqual([]);
});
