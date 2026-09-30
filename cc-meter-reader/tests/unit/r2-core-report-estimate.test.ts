// tests/unit/r2-core-report-estimate.test.ts — founder-build r2 core-7 (contract C4): FINDINGS_R2 #3 (the Report card
// after "Use the list-price estimate"), IC-13 (the sample CSV's marker). Evidence AA/r2/0/A1-*.
//
// #3: `cribl.estimate` was set and nothing read it: the methodology said "subtracts the Cribl cost an admin entered
// ($4,385 a month…)" and "Cribl paid for itself 1.8×", "ROI 81%" and the net carried no estimate label. Now the
// methodology prints en.ts's `criblCostEstimate` line, and net, payback and ROI read "(estimate at list price)" in every
// renderer (HTML, PDF, email HTML and text); the CSV carries a `cribl_cost_is_estimate` column.
// IC-13: a sample card's CSV ends with a `note,SAMPLE DATA: …` row (the header stays row 1); a live card's has none.

import { describe, expect, it } from "vitest";
import { buildReportCard, type ReportCard } from "../../core/report.ts";
import { renderReportHtml } from "../../core/report-html.ts";
import { renderReportEmail } from "../../core/report-email.ts";
import { renderReportCsv } from "../../core/report-csv.ts";
import { renderReportPdf } from "../../core/report-pdf.ts";
import { REPORT_STRINGS } from "../../core/strings.ts";
import { COPY, liveInput, sampleInput, TOUR } from "./report-fixture.ts";

const LABEL = "(estimate at list price)";

function pdfText(c: ReportCard): string {
  const bytes = renderReportPdf(c);
  let file = "";
  for (const b of bytes) file += String.fromCharCode(b);
  const out: string[] = [];
  const re = /\(((?:\\.|[^\\)])*)\) Tj/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(file)))
    out.push(
      m[1].replace(/\\([0-7]{3}|.)/g, (_, x: string) =>
        x.length === 3 ? String.fromCharCode(parseInt(x, 8)) : x,
      ),
    );
  return out.join(" ").replace(/\s+/g, " ");
}
const unescape = (html: string): string =>
  html
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

const withCost = (cents: number | undefined, estimate: boolean): ReportCard => {
  const input = liveInput({ kind: "mtd" }, { criblCostCentsPerMonth: cents });
  return buildReportCard({
    ...input,
    settings: {
      ...input.settings,
      criblCostCentsPerMonth: cents,
      ...(estimate ? { criblCostEstimate: true as const } : {}),
    },
  });
};
const estimated = withCost(438_500, true);
const contract = withCost(438_500, false);

describe("r2 core-7 · #3: the list-price estimate is labelled wherever its figures print", () => {
  it("the label is a core string", () => {
    expect(REPORT_STRINGS.estimateLabel).toBe(LABEL);
  });

  it('methodology: the estimate line (Cribl’s published list price), never "an admin entered"', () => {
    const line = estimated.methodology.find((l) =>
      l.includes("Net after Cribl subtracts"),
    )!;
    expect(line).toContain("an estimate of the Cribl cost ($4,385 a month");
    expect(line).not.toContain("an admin entered");
    expect(
      contract.methodology.find((l) => l.includes("Net after Cribl subtracts")),
    ).toContain("the Cribl cost an admin entered ($4,385 a month");
  });

  it("the KPI tile: payback, ROI and net each carry the label; a contract cost carries none", () => {
    const tile = estimated.kpis.find((k) => k.label === COPY.kpi.roi)!;
    // Each line wraps in every renderer (a label beside the big value would be cut to fit in the PDF's tile).
    expect(tile.unit).toBeUndefined();
    expect(
      tile.lines.find((l) => l.startsWith("Every $1 of Cribl saved")),
    ).toContain(LABEL); // the payback
    expect(tile.lines.find((l) => l.startsWith("ROI "))).toContain(LABEL);
    expect(tile.lines.find((l) => l.startsWith("Net after Cribl"))).toContain(
      LABEL,
    );
    const plain = contract.kpis.find((k) => k.label === COPY.kpi.roi)!;
    expect(plain.unit).toBeUndefined();
    expect(plain.lines.join(" ")).not.toContain(LABEL);
  });

  for (const [name, render] of [
    ["HTML", (c: ReportCard) => unescape(renderReportHtml(c))],
    ["PDF", pdfText],
    ["email HTML", (c: ReportCard) => unescape(renderReportEmail(c).html)],
    [
      "email text",
      (c: ReportCard) => renderReportEmail(c).text.replace(/\s+/g, " "),
    ],
  ] as const) {
    it(`${name}: the label beside net, payback and ROI, and the estimate methodology`, () => {
      const text = render(estimated);
      const tile = estimated.kpis.find((k) => k.label === COPY.kpi.roi)!;
      expect(text).toContain(tile.value);
      expect(text).toContain(LABEL);
      expect(
        (text.match(/\(estimate at list price\)/g) ?? []).length,
      ).toBeGreaterThanOrEqual(name === "PDF" || name === "email text" ? 2 : 3);
      expect(text).toContain("an estimate of the Cribl cost");
      expect(text).not.toContain("the Cribl cost an admin entered");
      expect(render(contract)).not.toContain(LABEL);
    });
  }

  it("CSV: a cribl_cost_is_estimate column, true for the estimate, false for a contract cost, empty with none", () => {
    const rows = (c: ReportCard) =>
      renderReportCsv(c).replace(/^﻿/, "").trimEnd().split("\r\n");
    const [header, ...body] = rows(estimated);
    const cols = header.split(",");
    expect(cols.at(-1)).toBe("cribl_cost_is_estimate");
    for (const r of body) expect(r.split(",").at(-1)).toBe("true");
    for (const r of rows(contract).slice(1))
      expect(r.split(",").at(-1)).toBe("false");
    const none = withCost(undefined, false);
    for (const r of rows(none).slice(1)) expect(r.split(",").at(-1)).toBe("");
  });
});

describe("r2 core-7 · IC-13: the sample card’s CSV says it is sample data", () => {
  it("a sample card’s CSV ends with a note row; the header stays row 1", () => {
    const csv = renderReportCsv(buildReportCard(sampleInput({ kind: "mtd" })));
    const lines = csv.replace(/^﻿/, "").trimEnd().split("\r\n");
    expect(lines[0].startsWith("Record,Name,")).toBe(true);
    const last = lines.at(-1)!;
    expect(last.startsWith("note,SAMPLE DATA: ")).toBe(true);
    expect(last).toContain(REPORT_STRINGS.csv.sampleNote);
    // The note row has as many fields as the header (a rectangular table; the note holds no comma).
    expect(REPORT_STRINGS.csv.sampleNote).not.toMatch(/[",;]/);
    expect(last.split(",").length).toBe(lines[0].split(",").length);
    expect(lines.filter((l) => l.startsWith("note,"))).toHaveLength(1);
    void TOUR;
  });

  it("a live card’s CSV has no note row", () => {
    const csv = renderReportCsv(contract);
    expect(csv).not.toContain("SAMPLE DATA");
    expect(csv.split("\r\n").some((l) => l.startsWith("note,"))).toBe(false);
  });
});
