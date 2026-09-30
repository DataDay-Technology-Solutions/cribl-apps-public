// r3 ui-8 (FINDINGS_R3 #14, r3/5 F4, pre-existing): at 320 px Capra's toast is 360 px wide and right-aligned in the
// 16 px gutter, so its left 56 px sat off-screen ("arget connected") on every engine (WCAG 1.4.10 reflow). At 375 px and
// below the toast is the viewport less the two 16 px gutters; at 390 and 1440 it is unchanged (360 px).
// Probe: app-assurance r3/5/specs/zz-r3f5-toast.spec.ts (toast320/), OUT/SK2_R3F5_TOAST320.md.

import { expect, test, type Page } from "@playwright/test";
import {
  gotoApp,
  resetMock,
  seedPrices,
  waitForHydration,
} from "./helpers/index.ts";

const card = (page: Page) =>
  page.locator('section[data-section="notifications"]');

/** Connects a Cribl notification target in Settings: the "Target connected" toast (the BO-17 path). */
async function connectToast(page: Page): Promise<void> {
  await gotoApp(page, "/first-run");
  await resetMock(page);
  await seedPrices(page);
  await page.goto("/settings/notifications", { waitUntil: "domcontentloaded" });
  await waitForHydration(page);
  await expect(card(page)).toBeVisible();
  await card(page).getByRole("button", { name: "Add endpoint" }).click();
  await page
    .getByTestId("endpoint-0-target")
    .getByRole("textbox")
    .fill("mrd_slack_finops");
  const relay = page.getByTestId("endpoint-0-relay");
  await expect(relay).toHaveAttribute("data-relay", "missing", {
    timeout: 10_000,
  });
  await relay.getByRole("button", { name: "Connect" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Connect" })
    .click();
  await expect(page.locator("[data-mr-toast]").first()).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(700); // the entrance has landed
}

async function toastBox(page: Page) {
  return page.evaluate(() => {
    const body = document.querySelector("[data-mr-toast]") as HTMLElement;
    const toast = body.closest(
      '[role="status"], [role="alert"]',
    ) as HTMLElement;
    const r = toast.getBoundingClientRect();
    // The first line of its words: where the reader starts.
    let textLeft = Number.POSITIVE_INFINITY;
    const walker = document.createTreeWalker(toast, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const rr of Array.from(range.getClientRects()))
        textLeft = Math.min(textLeft, rr.left);
    }
    return {
      vw: window.innerWidth,
      left: r.left,
      right: r.right,
      width: r.width,
      textLeft,
      text: (toast.textContent ?? "").trim().slice(0, 60),
    };
  });
}

for (const width of [320, 360] as const)
  test(`${width} × 640: the whole toast is on screen, inside the 16 px gutters`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 640 });
    await connectToast(page);
    const box = await toastBox(page);
    expect(box.text).toContain("Target connected");
    expect(box.left, "the toast starts on screen").toBeGreaterThanOrEqual(0);
    expect(box.right, "and ends on screen").toBeLessThanOrEqual(box.vw);
    expect(box.left, "inside the left gutter").toBeGreaterThanOrEqual(16 - 0.5);
    expect(box.right, "inside the right gutter").toBeLessThanOrEqual(
      box.vw - 16 + 0.5,
    );
    expect(box.textLeft, "its first word is readable").toBeGreaterThanOrEqual(
      0,
    );
  });

for (const [width, height] of [
  [390, 844],
  [1440, 900],
] as const) {
  test(`${width} × ${height}: the toast is unchanged (360 px, on screen)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await connectToast(page);
    const box = await toastBox(page);
    expect(box.width).toBeCloseTo(360, 0);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(box.vw);
  });
}
