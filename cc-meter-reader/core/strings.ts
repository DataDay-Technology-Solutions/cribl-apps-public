// core/strings.ts — every user-facing word core/ writes into something a person reads outside the App: the weekly
// and period receipts (core/receipt.ts) and the notification payloads — Slack Block Kit, ServiceNow, the plain-text
// alert (core/payloads.ts). EPIC_AUDIT P1-F05: these lived as literals in those modules and drifted from en.ts
// ('Open alerts: none' there, 'Open alerts: 0' in en.ts, '1 (…)' in the README).
//
// core/ must stay importable without src/ (the runner and the Enterprise backend build from core/ alone), so the
// words live here, as plain constants, and src/copy/en.ts re-exports this module: the copy file stays the one index
// of user-facing text without core importing the UI. Templates take `{name}` placeholders, filled by fill().
// tests/unit/receipt-strings.test.ts fails on any quoted phrase left in receipt.ts or payloads.ts.

/** Fills `{name}` placeholders; an unknown name is left as written. */
export function fill(template: string, values: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}

/** Singular or plural by count. */
export function plural(n: number, forms: { one: string; other: string }): string {
  return n === 1 ? forms.one : forms.other;
}

export const RECEIPT_STRINGS = {
  weeklyTitle: 'Meter Reader — weekly receipt',
  periodTitle: 'Meter Reader — receipt',
  savedLastWeek: 'Saved by Cribl, last week',
  savedFor: 'Saved by Cribl, {period}',
  saved: 'Saved by Cribl',
  wouldHavePaid: 'Would have paid {amount}',
  paid: 'Paid {amount}',
  savedPct: '{pct} saved',
  vs: 'vs. {what}: {sign}{pct}%',
  priorWeek: 'prior week',
  openAlertsNone: 'Open alerts: none',
  openAlertsList: 'Open alerts: {n} ({titles})',
  openAlertsCount: 'Open alerts: {n}',
  openThisWeek: 'Open this week on the Receipt:',
  /** WeeklyReceipt.sentLate: nothing was metering at Monday 12:00 UTC, so the week's first sweep sent it. */
  sentLate: 'Sent late: nothing was metering at Monday 12:00 UTC, so it went out with the first metering since.',
  /** a flow with no pipeline and no route */
  otherLine: 'Other',
  topSaversRates: 'Top savers, per day at current rates',
  perDaySuffix: '/day',
  netAfterCribl: 'Net after Cribl {amount}',
  netAfterCriblYear: 'Net after Cribl {amount} a year',
  paidForItself: 'Paid for itself {multiple}',
  annualizedFrom: 'annualized from {basis}',
  lastDays: { one: 'the last {n} day', other: 'the last {n} days' },
  todaySoFar: 'today so far',
  asOf: 'as of {date}',
  rangeRate: '≈ {amount} a day at this rate',
  periods: {
    mtd: 'month to date',
    today: 'today',
    '30d': 'last 30 days',
    annualized: 'annualized run rate',
  },
  // P1-F02: measured (bytes dropped) vs assumed (credited at another destination's price).
  divertedTag: ' (diverted)',
  byReduction: 'Saved by reduction {amount}',
  byDiversion: 'by diversion {amount}',
  // P0-23: the Basis block.
  basis: 'Basis',
  basisPrice: '{label}: {price}',
  typicalList: 'typical list',
  presetTypicalList: '{preset} typical list',
  customPrice: 'custom price',
  creditedUnpriced: 'credited $0 until {label} has a price',
  creditedAt: "credited at {label}'s {price}",
  neverSavings: 'never counted as savings',
  morePriced: { one: 'and {n} more priced destination', other: 'and {n} more priced destinations' },
  noMoney: 'No destination carried money',
  unpricedExcluded: { one: '{n} destination unpriced, excluded', other: '{n} destinations unpriced, excluded' },
  metered: 'Metered {metered} of {expected} {unit} ({pct})',
  meteredUnder1: 'under 1%',
  units: { minute: 'minute', minutes: 'minutes', day: 'day', days: 'days' },
  // P2-W13: Copy receipt for a comparison (receiptTextForComparison).
  comparisonTitle: 'Meter Reader — receipt comparison',
  thisRange: 'This range',
  comparedPerDay: "Compared per day, at each window's own rate:",
  comparedPerDayWhy: 'they were metered for different lengths.',
  aDaySuffix: ' a day',
  nothingToCompare: 'Nothing was metered to compare with.',
  // A comparison window with nothing metered: its money is unknown, never $0 (review W2, P0-18's class).
  notMetered: 'not metered',
  change: 'Change',
  windowWouldHavePaid: '{name}: would have paid {amount}',
  windowPaid: '  paid {amount} · {pct} saved',
} as const;

export const PAYLOAD_STRINGS = {
  testTitle: 'Meter Reader test notification',
  eventTitle: 'Meter Reader {event}',
  testPrefix: 'Test: ',
  recoveredPrefix: 'Recovered: ',
  newNormalPrefix: 'New normal: ',
  closedPrefix: 'Closed: ',
  // P1-F07: what a member did with it.
  memberClosed: {
    accepted: 'Accepted as the new normal: ',
    muted: 'Muted: ',
    excluded: 'Alerts stopped: ',
  },
  closedBy: ' by {by}',
  closedAsNewNormal: 'Closed as the new normal',
  recovered: 'Recovered',
  /** Core-10 (M9): the plain text's close word for a below-floor close. */
  closed: 'Closed',
  weeklyFallback: '{glyph} Meter Reader weekly receipt · {label} · Saved by Cribl {amount}',
  weeklyHeader: '{glyph} Weekly receipt · {label}',
  /** Founder-build r3 core-2: the bell's weekly line for a week metered in part ('metered 71% of the week'). */
  weeklyCoverage: 'metered {pct} of the week',
  openReceipt: 'Open the Receipt',
  openLedger: 'Open in Ledger',
  openLedgerAt: 'Open in Ledger: {link}',
  incidentFallback: '{glyph} {title} · {money}',
  // The money line of every alert channel (the bell, a notification target, Slack, ServiceNow), worded by the rule the
  // incident card follows (src/copy/en.ts incidents.impact, D62; rules round 2 carried it to the channels): only an
  // open regression is projected to a year, as what it costs if left; a spike is a day while it lasts; a recovered
  // incident is a day while it lasted, for how long and what it came to; good news keeps its year; budget pace, none.
  impact: {
    open: '{perDay} a day · {perYear} a year if left',
    spike: '{perDay} a day above normal while it lasts',
    closed: '{perDay} a day above normal while it lasted · {duration} · ≈ {realized} in all',
    closedNoDuration: '{perDay} a day above normal while it lasted',
    perDayPerYear: '{perDay} a day · {perYear} a year',
    overBudget: '{perDay} a day over budget',
    // Founder-build r1 core-10 (M9, D26/D47): closed by the dollar floor, not recovered — the ratio is still down.
    belowFloor: 'fell under the {floor}/day floor; savings still at {after}',
  },
  demoProfile: ' · 1-minute confirmation (demo profile). Default is 3.',
  noChange: 'No configuration change found nearby',
  nearby: ' (nearby change; it may not be the cause)',
  perHour: '{amount}/hour',
  pctOfBudget: '{pct}% of budget',
  caughtIn: 'caught in {duration}',
  caughtOnCatchUp: 'caught on catch-up',
  caughtOnCatchUpAfter: 'caught on catch-up, {duration} after the change',
  // The Slack field grid.
  fields: {
    commit: 'Commit',
    by: 'By',
    openFor: 'Open for',
    extraPerDay: 'Extra per day',
    wasCostingExtra: 'Was costing extra per day',
    perYear: 'Per year',
    perYearIfLeft: 'Per year if left',
    lostWhileOpen: 'Lost while open',
    costWhileOpen: 'Extra cost while open',
    baseline: 'Baseline',
    peak: 'Peak',
    now: 'Now',
    overBudgetPerDay: 'Over budget per day',
    peakProjection: 'Peak projection',
    projected: 'Projected',
    threshold: 'Threshold',
    savingPerDay: 'Saving per day',
    before: 'Before',
    after: 'After',
    lostPerDay: 'Lost per day',
    wasLosingPerDay: 'Was losing per day',
    recoveredTo: 'Recovered to',
  },
  // The plain-text alert (ServiceNow's description, logs).
  plain: {
    ratio: 'Savings ratio {drop}{back} · {money}',
    cost: 'Cost {rise}{back} · {money}',
    budget: '{pace}{back} · {perDay} a day over',
    before: '{value} before',
    recoveredTo: ' · recovered to {value}',
    projected: 'Projected {value}',
    threshold: 'Threshold {pct}%',
    commit: 'Commit {hash} "{message}" by {author}',
    opened: 'Opened {at}',
    closed: ' · {closed} {at}',
  },
  servicenowWeekly: 'Meter Reader weekly receipt {label}',
  // "Send a test alert": the SPEC 12.1 example incident every test payload carries. Founder-build r1 core-11 (m8,
  // #14): neutral names — a release's test alert quotes no demo-rig object (no "mrd_", no "demo:").
  testSample: {
    label: 'Example pipeline',
    commitMessage: 'Example: a pipeline change',
    objectId: 'example_pipeline',
    outputId: 'example_destination',
  },
} as const;

/**
 * A commit author as every surface prints it (founder-build r1 core-4, contract C5: core/humanize.ts displayAuthor is
 * the one author function; src/lib/author.ts delegates to it). The same words src/copy/en.ts `commits.apiClient` and
 * `commits.unknownAuthor` carry (tests/unit/r1-core-author.test.ts holds them equal).
 */
export const AUTHOR_STRINGS = {
  /** An API credential's commit, unnamed: the client id's last four characters, never the id. */
  apiClient: 'API client ··{tail}',
  unknownAuthor: 'unknown author',
} as const;

/**
 * The builder's signature: Meter Reader is signed by the person who built it wherever a builder signs his work. One
 * name for every surface, so none can drift: the App's credits (src/copy/en.ts `credit.*`, filled with `builder` by
 * src/components/common/Credit.tsx; the report card's footer, `report.doc.credit`, filled by core/report.ts), the last
 * line of every receipt (Copy receipt, the weekly receipt) and every alert message (Slack's context line, the bell,
 * ServiceNow, a Cribl notification target).
 */
export const CREDIT_STRINGS = {
  builder: 'Steve Koelpin',
  /** The sign-off on a receipt and on an alert message. */
  signature: 'Meter Reader by Steve Koelpin',
} as const;

/**
 * Founder-build r2 core-6 (FINDINGS_R2 #2, contract C3): the Report card's words for an alert that closed without
 * recovering, in the channels' M9/m15 wording (PAYLOAD_STRINGS: the floor's "Closed", a member's "Accepted as the new
 * normal" / "Muted" / "Alerts stopped", P1-F06's "New normal"), so the CFO document never calls one "Recovered". The
 * money lines are PAYLOAD_STRINGS.impact's: belowFloor for the floor, open ("… a year if left") for a member's close.
 */
export const REPORT_STRINGS = {
  status: {
    belowFloor: 'Closed',
    accepted: 'Accepted as the new normal',
    muted: 'Muted',
    excluded: 'Alerts stopped',
    newNormal: 'New normal',
  },
  /** The protection summary when nothing is open but not every alert recovered. */
  summaryNoneOpen: '{alerts} · none open',
  /** The Protection KPI's line for the same case. */
  kpiNoneOpen: '{amount} a day above normal when caught, none open',
  /**
   * R2 core-7 (FINDINGS_R2 #3, contract C4): beside every figure built on the list-price estimate of the Cribl cost
   * (Settings' criblCostEstimate) — the payback multiple, the ROI and the net — in every renderer.
   */
  estimateLabel: '(estimate at list price)',
  csv: {
    /** R2 core-7: the column that says the Cribl cost behind the report is the list-price estimate. */
    criblCostIsEstimateHeader: 'cribl_cost_is_estimate',
    yes: 'true',
    no: 'false',
    /** IC-13: the last row of a sample card's CSV (the record column reads 'note'); no comma, so the row stays plain. */
    noteRecord: 'note',
    sampleNote: 'SAMPLE DATA: the Meter Reader tour workspace (not a live workspace)',
  },
} as const;

/** Every user-facing word core/ writes into a receipt or a notification (re-exported by src/copy/en.ts). */
export const CORE_STRINGS = { receipt: RECEIPT_STRINGS, payload: PAYLOAD_STRINGS, credit: CREDIT_STRINGS, author: AUTHOR_STRINGS, report: REPORT_STRINGS } as const;
