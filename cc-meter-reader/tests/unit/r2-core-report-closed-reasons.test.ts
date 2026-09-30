// tests/unit/r2-core-report-closed-reasons.test.ts — founder-build r2 core-6, the Report half of FINDINGS_R2 #2 (contract
// C3; probe AA/r2/2/zz-r2m-belowfloor.test.ts, evidence belowfloor.txt).
//
// The Report card called every closed alert "Recovered": a regression the $5/day floor closed (savings still at 25%) and
// one a member accepted as the new normal both read "Recovered · $61 a day above normal while it lasted · 4 h from alert
// to recovery", the summary "1 alert caught · all recovered" and the KPI "…, now recovered", while the card, the bell
// and Slack said "fell under the $5/day floor; savings still at 25%" and "$61 a day · $22,265 a year if left". Now
// protectionFor derives recovered | belowFloor | accepted | muted | excluded | newNormal | open with the channels'
// words (core/strings.ts); "all recovered" and "now recovered" count only recovered rows.

import { describe, expect, it } from "vitest";
import type { Incident } from "../../core/types.ts";
import { buildReportCard, type ReportCard } from "../../core/report.ts";
import { renderReportHtml } from "../../core/report-html.ts";
import { renderReportEmail } from "../../core/report-email.ts";
import { renderReportCsv } from "../../core/report-csv.ts";
import { renderReportPdf } from "../../core/report-pdf.ts";
import { REPORT_STRINGS } from "../../core/strings.ts";
import { liveInput } from "./report-fixture.ts";

const input = liveInput({ kind: "mtd" }, { criblCostCentsPerMonth: 3_500_000 });
const sweep = Date.parse(input.snapshot.sweepAt);

function inc(id: string, extra: Partial<Incident>): Incident {
  return {
    id,
    type: "regression",
    severity: "high",
    objectKey: "pipe:default:win_trim",
    label: "Windows trim",
    outputId: "siem",
    openedAt: new Date(sweep - 5 * 3600_000).toISOString(),
    closedAt: new Date(sweep - 3600_000).toISOString(),
    before: 0.75,
    after: 0.25,
    impactPerDayM: 6_100_000,
    cause: "unknown",
    notes: [],
    deliveries: [],
    ...extra,
  } as Incident;
}

const floor = inc("inc_floor1", { notes: ["below-floor"] });
const accepted = inc("inc_accpt1", {
  closedReason: "accepted",
  closedBy: "Sam",
});
const muted = inc("inc_muted1", { closedReason: "muted", closedBy: "Sam" });
const recovered = inc("inc_recov1", { recoveredTo: 0.74 });

function card(
  incidents: Incident[],
  settings: Partial<typeof input.settings> & {
    thresholds?: { regressionMinCentsPerDay?: number };
  } = {},
): ReportCard {
  return buildReportCard({
    ...input,
    settings: { ...input.settings, ...settings },
    snapshot: { ...input.snapshot, incidents },
  });
}

/** Every string the PDF shows (Tj operands, unescaped). */
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

function everySurface(c: ReportCard): Record<string, string> {
  const email = renderReportEmail(c);
  return {
    html: renderReportHtml(c),
    pdf: pdfText(c),
    csv: renderReportCsv(c),
    emailHtml: email.html,
    emailText: email.text,
  };
}

describe('r2 core-6 · the Report never calls a below-floor or member close "Recovered"', () => {
  for (const [name, i] of [
    ["below floor", floor],
    ["accepted", accepted],
    ["muted", muted],
  ] as const) {
    it(`${name}: no "recover" on any surface (HTML, PDF, CSV, email)`, () => {
      const c = card([i]);
      for (const [surface, text] of Object.entries(everySurface(c)))
        expect(text, surface).not.toMatch(/recover/i);
      expect(c.protection.summary).not.toMatch(/recover/i);
      for (const k of c.kpis)
        for (const l of k.lines ?? []) expect(l).not.toMatch(/recover/i);
      expect(c.protection.rows[0].impactText).not.toMatch(/while it lasted/);
    });
  }

  it('below floor: the row reads the M9 words (the floor and where savings stand), status "Closed"', () => {
    const row = card([floor]).protection.rows[0];
    expect(row.status).toBe("belowFloor");
    expect(row.statusText).toBe(REPORT_STRINGS.status.belowFloor);
    expect(row.impactText).toBe(
      "fell under the $5/day floor; savings still at 25%",
    );
    // A workspace's own floor.
    expect(
      card([floor], { thresholds: { regressionMinCentsPerDay: 2_000 } })
        .protection.rows[0].impactText,
    ).toBe("fell under the $20/day floor; savings still at 25%");
  });

  it('accepted and muted: the open impact, "a year if left", as the card and the channels print it', () => {
    const a = card([accepted]).protection.rows[0];
    expect(a.status).toBe("accepted");
    expect(a.statusText).toBe("Accepted as the new normal");
    expect(a.impactText).toBe("$61 a day · $22,265 a year if left");
    const m = card([muted]).protection.rows[0];
    expect(m.status).toBe("muted");
    expect(m.statusText).toBe("Muted");
    expect(m.impactText).toMatch(/a year if left$/);
  });

  it('the summary and the KPI say "none open", not "all recovered", when a close was not a recovery', () => {
    const c = card([floor, accepted]);
    expect(c.protection.openCount).toBe(0);
    expect(c.protection.summary).toBe("2 alerts caught · none open");
    const kpi = c.kpis.find((k) => k.label === input.copy.kpi.protection)!;
    expect(kpi.lines!.join(" | ")).toMatch(/none open/);
  });

  it("a genuinely recovered row still reads Recovered, with how long it lasted; all-recovered wording unchanged", () => {
    const c = card([recovered]);
    const row = c.protection.rows[0];
    expect(row.status).toBe("recovered");
    expect(row.statusText).toBe("Recovered");
    expect(row.impactText).toMatch(
      /while it lasted · 4\sh from alert to recovery/,
    );
    expect(row.measure).toMatch(/recovered to 74%/);
    expect(c.protection.summary).toMatch(/all recovered/);
    const kpi = c.kpis.find((k) => k.label === input.copy.kpi.protection)!;
    expect(kpi.lines!.join(" | ")).toMatch(/now recovered/);
  });

  it('mixed: one recovered and one accepted — the recovered row keeps its words; nothing says "all recovered"', () => {
    const c = card([recovered, accepted]);
    expect(c.protection.summary).not.toMatch(/all recovered/);
    expect(
      c.protection.rows.find((r) => r.id === "inc_recov1")!.statusText,
    ).toBe("Recovered");
    expect(
      c.protection.rows.find((r) => r.id === "inc_accpt1")!.statusText,
    ).toBe("Accepted as the new normal");
  });
});
