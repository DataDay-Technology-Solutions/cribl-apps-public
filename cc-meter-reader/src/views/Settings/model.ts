// src/views/Settings/model.ts — pure logic behind the Settings sections (SPEC 5 schema + validation,
// SPEC 8 net/payback, SPEC 9.2 baseline memory, PRD 7 budget pace, SPEC 13 routes).
//
// Every section edits a string draft (what was typed), turns it into Settings with `apply*`, and lets
// core/settings.validateSettings produce the SPEC 17 copy. A section's save merges ONLY its own fields
// onto the settings the store holds at save time, so saving Alerts never clobbers unsaved Budgets edits.

import type { DestinationFigures, FlowFigures, Headline, ObjectKey, Settings, Snapshot, Thresholds } from '../../../core/types.ts';
import { DEFAULT_THRESHOLDS, validateSettings } from '../../../core/settings.ts';
import { flowObjectKeys, parseObjectKey } from '../../../core/flows.ts';
import { humanizeObjectKey } from '../../../core/humanize.ts';
import { alphaForMemoryMinutes } from '../../../core/baseline.ts';
import { centsToMc, mcToCents, mcToDollarInput, parseDollarsToMc } from '../../../core/format.ts';
import { dayOfMonth, daysInMonth, localMonthStartMs } from '../../../core/time.ts';
import { budgetPace as corePace } from '../../../core/pricing.ts';
import { meteredSpan, netOfCribl } from '../../../core/net.ts';
import { t, type CopyKey } from '../../copy/en.ts';
import { API_CLIENT_LABEL_PREFIX, apiClientKey } from '../../lib/author.ts';

// ─── Sections and routes ─────────────────────────────────────────────────────

export type SectionId = 'prices' | 'budgets' | 'cost' | 'alerts' | 'notifications' | 'demo' | 'runtime';

/** Sections in nav order; `demo` is listed only in the demo build (the caller filters). */
export const SECTION_ORDER: readonly SectionId[] = ['prices', 'budgets', 'cost', 'alerts', 'notifications', 'demo', 'runtime'];

/** Sections with their own route in src/router.tsx (SPEC 13); the rest ride `/settings?section=`. */
const PATH_SECTIONS: Partial<Record<SectionId, string>> = {
  prices: '/settings/prices',
  notifications: '/settings/notifications',
  // Demo build only: the inline flag keeps the demo route string out of the release bundle (SPEC 16).
  ...(import.meta.env?.VITE_MR_BUILD === 'demo' ? { demo: '/settings/demo' } : {}),
};

export const SECTION_LABEL_KEYS: Record<SectionId, CopyKey> = {
  prices: 'settings.groups.prices',
  budgets: 'settings.groups.budgets',
  cost: 'settings.groups.criblCost',
  alerts: 'settings.groups.alerts',
  notifications: 'settings.groups.notifications',
  demo: 'settings.groups.demo',
  runtime: 'settings.runtimeGroup',
};

function isSectionId(v: string | null | undefined): v is SectionId {
  return !!v && (SECTION_ORDER as readonly string[]).includes(v);
}

/**
 * The section a location shows: the last path segment (`/settings/prices`) or `?section=` (`/settings?section=alerts`),
 * defaulting to Prices. Sections not in `available` (Demo in the release build) fall back to Prices too.
 */
export function resolveSection(pathname: string, search: URLSearchParams, available: readonly SectionId[]): SectionId {
  const last = pathname.replace(/\/+$/, '').split('/').pop();
  const fromPath = isSectionId(last) ? last : undefined;
  const fromQuery = search.get('section');
  const candidate = fromPath ?? (isSectionId(fromQuery) ? fromQuery : undefined);
  return candidate && available.includes(candidate) ? candidate : 'prices';
}

/** In-app location of a section, keeping the sticky `group` / `period` params (src/lib/params.ts). */
export function sectionHref(section: SectionId, current: URLSearchParams): string {
  const next = new URLSearchParams();
  for (const key of ['group', 'period']) {
    const v = current.get(key);
    if (v !== null) next.set(key, v);
  }
  const path = PATH_SECTIONS[section];
  if (!path) next.set('section', section);
  const query = next.toString();
  return `${path ?? '/settings'}${query ? `?${query}` : ''}`;
}

// ─── Shared parsing ──────────────────────────────────────────────────────────

/** Section errors keyed by settings path ('budgets.<id>', 'thresholds.regressionPoints', …). */
export type FieldErrors = Record<string, string>;

/** Dollars (up to 2 decimals shown) for a cents amount: 250000 → '2500', 12345 → '123.45'. */
export function centsToDollarText(cents: number | undefined): string {
  if (cents === undefined || !Number.isFinite(cents)) return '';
  const text = mcToDollarInput(centsToMc(cents));
  return text.endsWith('.00') ? text.slice(0, -3) : text;
}

/** Parses a typed dollar amount to whole cents. '' → undefined (cleared). */
export function parseDollarsToCents(text: string, field: string): { ok: true; cents: number | undefined } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, cents: undefined };
  const parsed = parseDollarsToMc(trimmed);
  if (!parsed.ok) {
    if (parsed.error.includes('decimal')) return { ok: false, error: t('settings.errors.decimals', { field }) };
    if (parsed.error.includes('large')) return { ok: false, error: t('settings.errors.tooLarge', { field }) };
    return { ok: false, error: t('errors.fieldNumber', { field }) };
  }
  return { ok: true, cents: mcToCents(parsed.value) };
}

/** Parses a typed plain number ('15', '2.5'); rejects blanks, signs, units and junk. */
export function parseNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+(?:\.\d+)?$|^\.\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

function sectionErrors(next: Settings, prefix: (field: string) => boolean): FieldErrors {
  const out: FieldErrors = {};
  for (const e of validateSettings(next).errors) if (prefix(e.field) && out[e.field] === undefined) out[e.field] = e.message;
  return out;
}

// ─── Budgets (PRD 7 "Budget pace") ───────────────────────────────────────────

/** outputId → dollars per month as typed. */
export type BudgetDraft = Record<string, string>;

export function budgetDraftFrom(settings: Settings, outputIds: readonly string[]): BudgetDraft {
  const out: BudgetDraft = {};
  for (const id of outputIds) out[id] = centsToDollarText(settings.budgets?.[id]?.centsPerMonth);
  return out;
}

/** Settings with these budgets (an emptied field removes that budget); errors keyed `budgets.<outputId>`. */
export function applyBudgets(current: Settings, draft: BudgetDraft): { next: Settings; errors: FieldErrors } {
  const budgets: Settings['budgets'] = { ...(current.budgets ?? {}) };
  const errors: FieldErrors = {};
  for (const [outputId, text] of Object.entries(draft)) {
    const parsed = parseDollarsToCents(text, t('settings.budgets.fieldBudget'));
    if (!parsed.ok) {
      errors[`budgets.${outputId}`] = parsed.error;
      continue;
    }
    if (parsed.cents === undefined) delete budgets[outputId];
    else budgets[outputId] = { centsPerMonth: parsed.cents };
  }
  const next: Settings = { ...current, budgets };
  return { next, errors: { ...sectionErrors(next, (f) => f.startsWith('budgets.')), ...errors } };
}

export interface BudgetPace {
  /** paid so far this month (millicents) */
  mtdPaidM: number;
  /** projected month-end spend at the current pace (millicents) */
  projectedM: number;
  /** projected ÷ budget (a ratio), when a budget is set */
  ratio?: number;
  /** 'ok' | 'warn' (≥ warn %) | 'alert' (≥ alert %) */
  level: 'none' | 'ok' | 'warn' | 'alert';
}

/**
 * The same projection the detector uses (core/pricing.ts budgetPace, P0-17): paid MTD ÷ the minutes metered this
 * month × minutes in the month, in the display timezone. Undefined before anything was paid this month.
 */
export function budgetPace(
  dest: Pick<DestinationFigures, 'mtdPaidM' | 'mtdMinutes'> | undefined,
  budgetCents: number | undefined,
  nowMs: number,
  tz: string,
  thresholds: Pick<Thresholds, 'budgetWarnPct' | 'budgetAlertPct'>,
): BudgetPace | undefined {
  const mtdPaidM = Math.max(0, dest?.mtdPaidM ?? 0);
  if (!(mtdPaidM > 0)) return undefined;
  const projectedM = Math.round(corePace({ paidMtdM: mtdPaidM, nowMs, tz, meteredMinutes: dest?.mtdMinutes }).projectedM);
  if (budgetCents === undefined || !(budgetCents > 0)) return { mtdPaidM, projectedM, level: 'none' };
  const ratio = projectedM / (budgetCents * 1000);
  const pct = ratio * 100;
  const level = pct >= thresholds.budgetAlertPct ? 'alert' : pct >= thresholds.budgetWarnPct ? 'warn' : 'ok';
  return { mtdPaidM, projectedM, ratio, level };
}

// ─── Cribl cost (SPEC 8 "Net") ───────────────────────────────────────────────

export function costDraftFrom(settings: Settings): string {
  return centsToDollarText(settings.criblCostCentsPerMonth);
}

/**
 * The cost as saved. `estimateCents` is the list-price suggestion on screen (criblCostSuggestion): a cost saved at
 * exactly that figure is flagged as an estimate (core's Settings.criblCostEstimate, usefulness review, round 2), so
 * the Receipt and the report keep saying so; any other figure is a contract cost and clears the flag.
 */
export function applyCost(current: Settings, draft: string, estimateCents?: number): { next: Settings; errors: FieldErrors } {
  const parsed = parseDollarsToCents(draft, t('settings.cost.fieldCost'));
  if (!parsed.ok) return { next: current, errors: { criblCostCentsPerMonth: parsed.error } };
  const next: Settings & { criblCostEstimate?: true } = { ...current };
  if (parsed.cents === undefined) delete next.criblCostCentsPerMonth;
  else next.criblCostCentsPerMonth = parsed.cents;
  if (parsed.cents !== undefined && parsed.cents > 0 && estimateCents !== undefined && parsed.cents === estimateCents) next.criblCostEstimate = true;
  else delete next.criblCostEstimate;
  return { next, errors: sectionErrors(next, (f) => f === 'criblCostCentsPerMonth') };
}

export interface CostPreview {
  savedMtdM: number;
  /** the month's cost prorated to today (millicents) */
  proratedM: number;
  netM: number;
  /** undefined when the prorated cost is 0 */
  paybackX?: number;
  /** The minutes metered this month the cost is prorated to, when the snapshot's span is known (core/net.ts). */
  minutes?: number;
}

/**
 * SPEC 8: netMtdM = mtdM − round(cost × 1000 × dayOfMonth / daysInMonth); payback = mtdM ÷ that. With the
 * snapshot's span (its sweep, and when collecting began) the cost is prorated to the minutes metered this month
 * instead — the Receipt's net (core/net.ts meteredSpan) — so a workspace metering since the 26th is not charged
 * 26 days of Cribl against one day of savings, and the two screens print the same net.
 */
export function costPreview(
  headline: Pick<Headline, 'mtdM'> | undefined,
  costCents: number | undefined,
  nowMs: number,
  tz: string,
  span?: { sweepAtMs: number; collectingSinceMs?: number },
): CostPreview | undefined {
  if (!headline || costCents === undefined || !Number.isFinite(costCents) || costCents < 0) return undefined;
  if (span && Number.isFinite(span.sweepAtMs)) {
    const { minutes } = meteredSpan(localMonthStartMs(span.sweepAtMs, tz), span.sweepAtMs, span.collectingSinceMs);
    const net = netOfCribl(headline.mtdM, minutes, costCents);
    if (!net) return { savedMtdM: headline.mtdM, proratedM: 0, netM: headline.mtdM, minutes };
    const preview: CostPreview = { savedMtdM: headline.mtdM, proratedM: net.costM, netM: net.netM, minutes };
    if (net.paybackX !== undefined) preview.paybackX = net.paybackX;
    return preview;
  }
  const proratedExact = (costCents * 1000 * dayOfMonth(nowMs, tz)) / daysInMonth(nowMs, tz);
  const proratedM = Math.round(proratedExact);
  const preview: CostPreview = { savedMtdM: headline.mtdM, proratedM, netM: headline.mtdM - proratedM };
  if (proratedExact > 0) preview.paybackX = headline.mtdM / proratedExact;
  return preview;
}

// ─── Alerts (SPEC 5 thresholds, SPEC 9.2 memory picker) ──────────────────────

export type MemoryKey = '1h' | '6h' | '24h' | '7d';
export const MEMORY_OPTIONS: readonly { key: MemoryKey; minutes: number; labelKey: CopyKey }[] = [
  { key: '1h', minutes: 60, labelKey: 'settings.alerts.memory1h' },
  { key: '6h', minutes: 360, labelKey: 'settings.alerts.memory6h' },
  { key: '24h', minutes: 1440, labelKey: 'settings.alerts.memory24h' },
  { key: '7d', minutes: 10_080, labelKey: 'settings.alerts.memory7d' },
];

/** The picker option nearest a stored α (log distance): 0.0014 → '24h' (2/1441 ≈ 0.00139). */
export function memoryKeyForAlpha(alpha: number): MemoryKey {
  if (!(alpha > 0)) return '24h';
  let best: MemoryKey = '24h';
  let bestDist = Number.POSITIVE_INFINITY;
  for (const o of MEMORY_OPTIONS) {
    const dist = Math.abs(Math.log(alpha) - Math.log(alphaForMemoryMinutes(o.minutes)));
    if (dist < bestDist) {
      bestDist = dist;
      best = o.key;
    }
  }
  return best;
}

export interface AlertsDraft {
  regressionPoints: string;
  regressionMinutes: string;
  regressionCommitWindowMin: string;
  /** dollars per day a regression must cost to open (stored as cents, D26) */
  regressionFloorPerDay: string;
  spikeSigma: string;
  spikeMinutes: string;
  /** dollars per hour (stored as cents) */
  spikeMinPerHour: string;
  budgetWarnPct: string;
  budgetAlertPct: string;
  cooldownMinutes: string;
  /** minutes a new object learns before it can alert (thresholds.warmupSamples, one sample per metered minute) */
  warmupSamples: string;
  /** clean minutes before an open alert closes itself */
  recoveryMinutes: string;
  memory: MemoryKey;
  goodNewsEnabled: boolean;
  /** objects left out of metering and alerts (settings.excludedObjectKeys), in the order they were added */
  excludedObjectKeys: readonly ObjectKey[];
  /** API clients' names by label key ("client:1r2s" → "GitOps pipeline"), kept in settings.humanize (src/lib/author.ts) */
  clientNames: Readonly<Record<string, string>>;
}

/** Numeric threshold fields the Alerts draft edits as plain numbers. */
export const NUMERIC_ALERT_FIELDS = [
  'regressionPoints',
  'regressionMinutes',
  'regressionCommitWindowMin',
  'spikeSigma',
  'spikeMinutes',
  'budgetWarnPct',
  'budgetAlertPct',
  'cooldownMinutes',
  'warmupSamples',
  'recoveryMinutes',
] as const satisfies readonly (keyof Thresholds & keyof AlertsDraft)[];

const numText = (n: number): string => (Number.isFinite(n) ? String(n) : '');

export function alertsDraftFrom(settings: Settings): AlertsDraft {
  const th = settings.thresholds;
  return {
    regressionPoints: numText(th.regressionPoints),
    regressionMinutes: numText(th.regressionMinutes),
    regressionCommitWindowMin: numText(th.regressionCommitWindowMin),
    // Optional in stored settings (D26): the detector's default applies until it is set.
    regressionFloorPerDay: centsToDollarText(th.regressionMinCentsPerDay ?? DEFAULT_THRESHOLDS.regressionMinCentsPerDay),
    spikeSigma: numText(th.spikeSigma),
    spikeMinutes: numText(th.spikeMinutes),
    spikeMinPerHour: centsToDollarText(th.spikeMinCentsPerHour),
    budgetWarnPct: numText(th.budgetWarnPct),
    budgetAlertPct: numText(th.budgetAlertPct),
    cooldownMinutes: numText(th.cooldownMinutes),
    warmupSamples: numText(th.warmupSamples),
    recoveryMinutes: numText(th.recoveryMinutes),
    memory: memoryKeyForAlpha(th.ewmaAlpha),
    goodNewsEnabled: settings.goodNewsEnabled,
    excludedObjectKeys: [...(settings.excludedObjectKeys ?? [])],
    clientNames: clientNamesFrom(settings.humanize),
  };
}

/** The API clients' names settings.humanize holds ("client:<last four>" keys). */
export function clientNamesFrom(humanize: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(humanize ?? {})) if (k.startsWith(API_CLIENT_LABEL_PREFIX)) out[k] = v;
  return out;
}

/**
 * The API clients the snapshot's commits name, as label keys, plus any a member already named; in the order first
 * seen (the change timeline, newest first, then the alerts' commits).
 */
export function apiClientKeys(snapshot: Pick<Snapshot, 'timeline' | 'incidents'> | null | undefined, named: Readonly<Record<string, string>>): string[] {
  const keys = new Set<string>();
  for (const c of snapshot?.timeline ?? []) {
    const k = apiClientKey(c.author);
    if (k) keys.add(k);
  }
  for (const i of snapshot?.incidents ?? []) {
    const k = apiClientKey(i.commit?.author);
    if (k) keys.add(k);
  }
  for (const k of Object.keys(named)) keys.add(k);
  return [...keys];
}

/** The Alerts draft fields that differ from the stored draft (the save bar's count and each field's marker). */
export function alertsDirtyFields(draft: AlertsDraft, stored: AlertsDraft): (keyof AlertsDraft)[] {
  const names = (x: Readonly<Record<string, string>>) =>
    JSON.stringify(
      Object.entries(x)
        .map(([k, v]) => [k, v.trim()])
        .filter(([, v]) => v !== '')
        .sort(),
    );
  return (Object.keys(draft) as (keyof AlertsDraft)[]).filter((k) =>
    k === 'excludedObjectKeys'
      ? draft[k].join('\n') !== stored[k].join('\n')
      : k === 'clientNames'
        ? names(draft[k]) !== names(stored[k])
        : draft[k] !== stored[k],
  );
}

/** Plain-words field names for the SPEC 17 "Couldn't save: {field} …" copy (matching core/settings.ts). */
const ALERT_FIELD_NAMES: Record<string, string> = {
  regressionPoints: 'regression points',
  regressionMinutes: 'regression minutes',
  regressionCommitWindowMin: 'commit window',
  regressionFloorPerDay: 'minimum regression per day',
  spikeSigma: 'spike sigma',
  spikeMinutes: 'spike minutes',
  spikeMinPerHour: 'minimum spike per hour',
  budgetWarnPct: 'budget warning percent',
  budgetAlertPct: 'budget alert percent',
  cooldownMinutes: 'cooldown minutes',
  warmupSamples: 'warm-up samples',
  recoveryMinutes: 'recovery minutes',
};

/**
 * Settings with these thresholds; errors keyed `thresholds.<field>` (the Alerts inputs). α is rewritten only
 * when the member picked a different memory than the stored α maps to — an untouched picker never nudges
 * 0.0014 to 2/1441.
 */
export function applyAlerts(current: Settings, draft: AlertsDraft): { next: Settings; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const thresholds: Thresholds = { ...current.thresholds };
  for (const field of NUMERIC_ALERT_FIELDS) {
    const n = parseNumber(draft[field]);
    if (n === undefined) errors[`thresholds.${field}`] = t('errors.fieldNumber', { field: ALERT_FIELD_NAMES[field] });
    else thresholds[field] = n;
  }
  const spike = parseDollarsToCents(draft.spikeMinPerHour, ALERT_FIELD_NAMES.spikeMinPerHour);
  if (!spike.ok) errors['thresholds.spikeMinCentsPerHour'] = spike.error;
  else if (spike.cents === undefined) errors['thresholds.spikeMinCentsPerHour'] = t('errors.fieldNumber', { field: ALERT_FIELD_NAMES.spikeMinPerHour });
  else thresholds.spikeMinCentsPerHour = spike.cents;
  // The regression floor (D26) is optional in core validation, so it is checked here: dollars, 0 or more.
  const floor = parseDollarsToCents(draft.regressionFloorPerDay, ALERT_FIELD_NAMES.regressionFloorPerDay);
  if (!floor.ok) errors['thresholds.regressionMinCentsPerDay'] = floor.error;
  else if (floor.cents === undefined) errors['thresholds.regressionMinCentsPerDay'] = t('errors.fieldNumber', { field: ALERT_FIELD_NAMES.regressionFloorPerDay });
  else thresholds.regressionMinCentsPerDay = floor.cents;

  if (draft.memory !== memoryKeyForAlpha(current.thresholds.ewmaAlpha)) {
    const option = MEMORY_OPTIONS.find((o) => o.key === draft.memory);
    if (option) thresholds.ewmaAlpha = alphaForMemoryMinutes(option.minutes);
  }

  // API clients' names: the "client:" labels are replaced by the draft's non-blank ones; every other label stands.
  const humanize: Record<string, string> = {};
  for (const [k, v] of Object.entries(current.humanize ?? {})) if (!k.startsWith(API_CLIENT_LABEL_PREFIX)) humanize[k] = v;
  for (const [k, v] of Object.entries(draft.clientNames ?? {})) if (k.startsWith(API_CLIENT_LABEL_PREFIX) && v.trim() !== '') humanize[k] = v.trim();

  const next: Settings = {
    ...current,
    thresholds,
    goodNewsEnabled: draft.goodNewsEnabled,
    excludedObjectKeys: [...new Set(draft.excludedObjectKeys)],
    humanize,
  };
  // (a name is a label: core/settings.ts refuses a URL or a token there, as 'humanize')
  const validated = sectionErrors(next, (f) => f.startsWith('thresholds.') || f === 'humanize');
  // A parse error on a field wins over a range error computed from its old value.
  return { next, errors: { ...validated, ...errors } };
}

export interface ExcludableObject {
  key: ObjectKey;
  kind: 'in' | 'route' | 'pipe' | 'out';
  /** 'Pipeline · Payments API sampling' (the group added when two groups share a name) */
  label: string;
}

const KIND_ORDER = { in: 0, route: 1, pipe: 2, out: 3 } as const;

/** One object's picker label: kind and humanized name (core/humanize.ts), plus its group when names collide. */
export function excludableLabel(key: ObjectKey, labels?: Record<string, string>, withGroup = false): string {
  const parts = parseObjectKey(key);
  if (!parts) return humanizeObjectKey(key, labels);
  const label = humanizeObjectKey(key, labels) || parts.id;
  const kind = t(`settings.alerts.objectKinds.${parts.kind}`);
  return withGroup ? t('settings.alerts.excludedOptionGroup', { kind, label, group: parts.groupId }) : t('settings.alerts.excludedOption', { kind, label });
}

/**
 * The objects the snapshot's flows touch (sources, routes, pipelines, destinations), minus those already left
 * out, sorted by kind then label: what "Leave out" offers. Reads only the snapshot in the store (no API call).
 */
export function excludableObjects(flows: readonly FlowFigures[] | undefined, excluded: readonly ObjectKey[], labels?: Record<string, string>): ExcludableObject[] {
  const keys = new Set<ObjectKey>();
  for (const f of flows ?? []) {
    const k = flowObjectKeys(f);
    for (const key of [k.input, k.route, k.pipeline, k.output]) if (key) keys.add(key);
  }
  const skip = new Set(excluded);
  const parsed = [...keys].filter((k) => !skip.has(k)).map((key) => ({ key, parts: parseObjectKey(key) }));
  const plain = new Map<string, number>();
  for (const { key } of parsed) {
    const l = excludableLabel(key, labels);
    plain.set(l, (plain.get(l) ?? 0) + 1);
  }
  return parsed
    .filter((p): p is { key: ObjectKey; parts: NonNullable<typeof p.parts> } => p.parts !== null)
    .map(({ key, parts }) => {
      const l = excludableLabel(key, labels);
      return { key, kind: parts.kind, label: (plain.get(l) ?? 0) > 1 ? excludableLabel(key, labels, true) : l };
    })
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.label.localeCompare(b.label));
}

export function draftsEqual<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─── Cribl cost: a suggestion at the published list price (usefulness review, round 1) ──────────────────────

// The suggestion itself lives with the Receipt's byte figure (Receipt/model.ts), built on core/presets.ts
// suggestCriblCost: one list-price formula for Settings, the Receipt's estimate and the Report card's check.
export { criblCostSuggestion, type CriblCostSuggestion } from '../Receipt/model.ts';
