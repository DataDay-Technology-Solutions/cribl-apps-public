// r2 core-7 (FINDINGS_R2 #3, contract C4; evidence AA/r2/0/A1-*): after "Use the list-price estimate", the Report card
// said "subtracts the Cribl cost an admin entered ($4,385 a month…)" and printed "Cribl paid for itself 1.8×", "ROI 81%"
// and the net with no estimate label. Now its methodology names the estimate (Cribl's published list price on the
// ingest Meter Reader measured) and the payback, ROI and net each read "(estimate at list price)". Mock, release build.

import { expect, test, type Page } from "@playwright/test";
import {
  gotoApp,
  kvGet,
  resetMock,
  seedPrices,
  trackConsoleErrors,
  waitForHydration,
} from "./helpers/index.ts";

const TRACER_IN_SANDBOX =
  /^Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed/;
const LABEL = "(estimate at list price)";

async function srcdoc(page: Page): Promise<string> {
  const raw =
    (await page.getByTestId("report-preview").getAttribute("srcdoc")) ?? "";
  return raw
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

test('"Use the list-price estimate": the Report names the estimate and labels its payback, ROI and net', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = trackConsoleErrors(page, [
    TRACER_IN_SANDBOX,
    /Outdated Optimize Dep/,
  ]);
  await gotoApp(page, "/first-run");
  await resetMock(page);
  await seedPrices(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForHydration(page);
  await expect
    .poll(async () => (await kvGet(page, "snapshot")) !== null, {
      timeout: 60_000,
    })
    .toBe(true);
  await page.goto("/report?report=mtd", { waitUntil: "domcontentloaded" });
  await waitForHydration(page);

  const checks = page.getByTestId("report-checks");
  await checks
    .getByRole("button", { name: "Use the list-price estimate" })
    .click();
  await expect
    .poll(
      async () =>
        JSON.parse((await kvGet(page, "settings")) ?? "{}").criblCostEstimate,
      { timeout: 15_000 },
    )
    .toBe(true);

  // The methodology: the estimate's own line, never "the Cribl cost an admin entered".
  await expect
    .poll(() => srcdoc(page), { timeout: 20_000 })
    .toContain("Net after Cribl subtracts an estimate of the Cribl cost");
  const doc = await srcdoc(page);
  expect(doc).not.toContain("the Cribl cost an admin entered");
  expect(doc).toContain("Cribl's published list price");
  // The label beside the payback ("Every $1 of Cribl saved …"), the ROI and the net.
  expect(doc).toMatch(
    /Every \$1 of Cribl saved \$[\d,.]+ \(estimate at list price\)/,
  );
  expect(doc).toMatch(/ROI [\d,.]+% \(net ÷ cost\) \(estimate at list price\)/);
  expect(doc).toMatch(
    /Net after Cribl −?\$[\d,]+, month to date \(estimate at list price\)/,
  );
  expect(doc.split(LABEL).length - 1).toBeGreaterThanOrEqual(3);
  expect(errors()).toEqual([]);
});
