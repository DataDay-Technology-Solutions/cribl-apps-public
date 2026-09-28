// src/components/PriceTable/model.ts — the Prices page's pure logic (SPEC 5, 6, 8; PRD 6).
//
// Rows: every destination the snapshot would count (the same filter core/snapshot.ts applies: enabled,
// not the built-in `default` forwarder, internal types only when opted in), from the inventory, plus
// any destination the snapshot knows that the inventory missed. Status comes from
// core/pricing.effectivePrices — the function the Receipt's "N destinations are unpriced" uses — so the
// two screens can never disagree.
//
// Drafts are strings (what the member typed). A SUGGESTION IS NOT A PRICE (SPEC 6): an unpriced row
// shows its auto-suggested preset and the preset's value as a placeholder, and is written only when it
// holds a value ("one click per destination", PRD 6). A row that already has a stored price cannot be
// emptied: price versions are append-only (core/pricing.appendPriceVersion), so it would be an error.

import type { Counterfactual, InventoryDoc, PresetConfidence, PresetId, PresetSource, PriceEntry, PricesDoc, Snapshot } from '../../../core/types.ts';
import { effectivePrices, outputPriceKey, priceEntryAt, priceHistory, type PriceChange } from '../../../core/pricing.ts';
import { PRESETS, isCustomPrice, isFreeOutput, presetById, presetNote, suggestPresetFor } from '../../../core/presets.ts';
import { isInternalOutput } from '../../../core/flows.ts';
import { humanize } from '../../../core/humanize.ts';
import { mcToDollarInput, parseDollarsToMc } from '../../../core/format.ts';
import { t } from '../../copy/en.ts';

/** A destination the Prices page lists. */
export interface Destination {
  groupId: string;
  outputId: string;
  type: string;
  /** The output's description when the inventory has one ("… Priced with the splunk_cloud preset …", P0-04). */
  description?: string;
}

/** One row of the Prices table: the destination plus what is stored for it now. */
export interface PriceRow extends Destination {
  /** `${groupId}:${outputId}` — the byOutputId key every save writes (core/pricing.outputPriceKey). */
  key: string;
  /** Humanized name (settings.humanize overrides win). */
  name: string;
  /** Preset auto-suggested from the destination's description, type and id (SPEC 6, P0-04: core/presets.suggestPresetFor). */
  suggestedPreset: PresetId;
  /** The price entry in force now, if any. */
  stored?: PriceEntry;
  /** Status badge: no entry, or a $0 fallback on a type that is not genuinely free. */
  unpriced: boolean;
  /** P2-W24: every change to this destination's price, oldest first, with who saved it. */
  history?: PriceChange[];
}

/**
 * The picker's "Custom price" choice (P1-G01): the member's own rate with no vendor preset behind it. A
 * draft on it saves an entry with no `preset`; it is never a PresetId, so core never sees it.
 */
export const CUSTOM_PRESET = 'custom';
/** What the preset picker holds: a vendor preset, Internal / free, or Custom price. */
export type DraftPreset = PresetId | typeof CUSTOM_PRESET;

/** What the member is editing for one row. */
export interface PriceDraft {
  preset: DraftPreset;
  /** dollars per GB as typed ('' = no price) */
  price: string;
  /** 'same' | 'none' | `other:<outputId>` */
  counterfactual: string;
  /** optional committed dollars per GB */
  committed: string;
}

export interface PriceFieldErrors {
  price?: string;
  committed?: string;
}

// ─── Destinations ────────────────────────────────────────────────────────────

/** Mirrors core/snapshot.ts: skip disabled outputs, the `default` forwarder, and internal types unless opted in. */
export function isListedOutput(output: { type?: string; disabled?: boolean }, includeInternal: boolean): boolean {
  if (output.disabled) return false;
  const type = (output.type ?? '').toLowerCase();
  if (type === 'default') return false;
  if (!includeInternal && isInternalOutput({ type })) return false;
  return true;
}

/**
 * Every destination to price: the inventory's outputs (filtered like the snapshot), plus destinations
 * the snapshot reports that the inventory does not list. Sorted by group, then id — stable across sweeps.
 */
export function listDestinations(inventory: InventoryDoc | null | undefined, snapshot: Snapshot | null | undefined, includeInternal: boolean): Destination[] {
  const byKey = new Map<string, Destination>();
  for (const [groupId, group] of Object.entries(inventory?.byGroup ?? {})) {
    for (const o of group.outputs ?? []) {
      if (!o || typeof o.id !== 'string' || !isListedOutput(o, includeInternal)) continue;
      const dest: Destination = { groupId, outputId: o.id, type: o.type ?? 'unknown' };
      if (typeof o.description === 'string' && o.description !== '') dest.description = o.description;
      byKey.set(outputPriceKey(groupId, o.id), dest);
    }
  }
  for (const d of snapshot?.destinations ?? []) {
    const key = outputPriceKey(d.groupId, d.outputId);
    if (byKey.has(key)) continue;
    if (!isListedOutput({ type: d.type }, includeInternal) && d.type !== 'unknown') continue;
    byKey.set(key, { groupId: d.groupId, outputId: d.outputId, type: d.type });
  }
  return [...byKey.values()].sort((a, b) => (a.groupId === b.groupId ? a.outputId.localeCompare(b.outputId) : a.groupId.localeCompare(b.groupId)));
}

/** Rows with their stored price and status at `nowMs`. */
export function buildRows(destinations: Destination[], prices: PricesDoc | null | undefined, nowMs: number, labels?: Record<string, string>): PriceRow[] {
  const doc: PricesDoc = prices ?? { schemaVersion: 1, updatedAt: '', versions: [] };
  return destinations.map((d) => {
    const stored = priceEntryAt(doc, d.groupId, d.outputId, nowMs);
    // The same output facts the snapshot prices with (core/snapshot.ts), so the badge and the Receipt agree.
    const output = { type: d.type, id: d.outputId, description: d.description };
    const row: PriceRow = {
      ...d,
      key: outputPriceKey(d.groupId, d.outputId),
      name: humanize(d.outputId, labels) || d.outputId,
      suggestedPreset: suggestPresetFor(output),
      // A row priced itself reads priced even when its counterfactual has no price yet (P1-F01: that shows in its picker).
      unpriced: unpricedItself(effectivePrices(doc, d.groupId, d.outputId, nowMs, output)),
    };
    if (stored) row.stored = stored;
    const history = priceHistory(doc, d.groupId, d.outputId);
    if (history.length > 0) row.history = history;
    return row;
  });
}

// ─── Counterfactual keys ─────────────────────────────────────────────────────

export function counterfactualKey(cf: Counterfactual | undefined): string {
  if (!cf || cf.kind === 'same') return 'same';
  if (cf.kind === 'none') return 'none';
  return `other:${cf.outputId}`;
}

export function parseCounterfactualKey(key: string): Counterfactual {
  if (key === 'none') return { kind: 'none' };
  if (key.startsWith('other:') && key.length > 'other:'.length) return { kind: 'other', outputId: key.slice('other:'.length) };
  return { kind: 'same' };
}

export interface Option {
  id: string;
  label: string;
}

const unpricedItself = (e: { unpriced: boolean; counterfactualUnpriced: boolean }): boolean => e.unpriced && !e.counterfactualUnpriced;

/**
 * "This destination" / every OTHER destination in the same group (pricing never crosses groups) / "Nowhere".
 * A destination with no stored price is captioned "(no price yet)": crediting diverted data at it counts $0 (P1-F01).
 */
export function counterfactualOptions(row: Destination, rows: readonly PriceRow[]): Option[] {
  const others = rows
    .filter((r) => r.groupId === row.groupId && r.outputId !== row.outputId)
    .map((r) => ({ id: `other:${r.outputId}`, label: r.stored ? r.name : t('settings.prices.cfNoPrice', { name: r.name }) }));
  return [{ id: 'same', label: t('settings.prices.cfSame') }, ...others, { id: 'none', label: t('settings.prices.cfNone') }];
}

/** Dollar text for a preset's typical value: splunk_cloud → '2.25' ('0.00' for Custom price, which has none). */
export function presetDollars(id: DraftPreset): string {
  return mcToDollarInput(presetById(id)?.milliCentsPerGb ?? 0);
}

/** A range endpoint in dollars: at least 2 and at most 4 decimals, trailing zeros dropped (1.1 → '$1.10', 0.0169 → '$0.0169'). */
export function usdPerGb(dollars: number): string {
  const fixed = Math.max(0, dollars).toFixed(4).replace(/0+$/, '');
  const [whole, frac = ''] = fixed.split('.');
  return `$${whole}.${frac.padEnd(2, '0')}`;
}

/** Everything the picker and its info popover say about one preset (SPEC 6: a starting point, clearly labelled). */
export interface PresetInfo {
  id: PresetId;
  label: string;
  /** '$2.25' — always the value picking the preset fills in ('$0' for a free preset). */
  typical: string;
  /** '$1.47', '$4.85'; both '$0.00' for a free preset. */
  low: string;
  high: string;
  free: boolean;
  /** The option's accessible text: 'Splunk Cloud · typical $2.25 / GB · range $1.47–$4.85'. */
  option: string;
  /** The option's second line: 'typical $2.25 / GB · range $1.47–$4.85' ('No destination charge' when free). */
  caption: string;
  basis: string;
  confidence: PresetConfidence;
  sources: readonly PresetSource[];
}

export function presetInfo(id: PresetId): PresetInfo {
  const preset = presetById(id);
  const note = presetNote(id);
  const label = preset?.label ?? id;
  const [lo, hi] = note?.rangeUsd ?? [0, 0];
  const free = (preset?.milliCentsPerGb ?? 0) === 0 && hi === 0;
  const typical = free ? '$0' : `$${presetDollars(id)}`;
  const low = usdPerGb(lo);
  const high = usdPerGb(hi);
  const option = free
    ? t('settings.prices.presetOptionFree', { preset: label, typical })
    : t('settings.prices.presetOption', { preset: label, typical, low, high });
  const caption = free ? t('settings.prices.presetRangeFree') : t('settings.prices.presetOptionCaption', { typical, low, high });
  return { id, label, typical, low, high, free, option, caption, basis: note?.basis ?? '', confidence: note?.confidence ?? 'estimate', sources: note?.sources ?? [] };
}

/**
 * A picker option (P0-20): the preset's name over a caption with its typical price and range, never a
 * wrapped sentence. `label` is the option's whole accessible text (name · caption); the closed picker shows
 * `name` (its textValue).
 */
export interface PresetOption extends Option {
  name: string;
  caption: string;
  free: boolean;
}

/** Presets for the picker, in SPEC 6 order, each with its typical price and range. */
export function presetOptions(): PresetOption[] {
  return PRESETS.map((p) => {
    const info = presetInfo(p.id);
    return { id: p.id, label: info.option, name: info.label, caption: info.caption, free: info.free };
  });
}

/** One labelled group of the picker. */
export interface PresetOptionGroup {
  id: 'listed' | 'other';
  label: string;
  options: PresetOption[];
}

/**
 * The picker's groups (P0-20): every vendor's typical list price first, then, under their own header,
 * the choices that are not a vendor's price (Internal / free).
 */
export function presetOptionGroups(): PresetOptionGroup[] {
  const all = presetOptions();
  const name = t('settings.prices.customPreset');
  const caption = t('settings.prices.customPresetCaption');
  // Custom price, then Internal / free last (P0-20, P1-G01).
  const custom: PresetOption = { id: CUSTOM_PRESET, name, caption, label: t('settings.prices.customPresetOption', { preset: name, caption }), free: false };
  return [
    { id: 'listed', label: t('settings.prices.presetGroupListed'), options: all.filter((o) => !o.free) },
    { id: 'other', label: t('settings.prices.presetGroupOther'), options: [custom, ...all.filter((o) => o.free)] },
  ];
}

/** The line under a row's picker: '$2.25 typical · $1.47–$4.85' ('No destination charge' when free). */
export function presetNoteLine(id: DraftPreset): string {
  if (id === CUSTOM_PRESET) return t('settings.prices.customNoteNoPreset');
  const info = presetInfo(id);
  return info.free ? t('settings.prices.presetRangeFree') : t('settings.prices.presetNote', { typical: info.typical, low: info.low, high: info.high });
}

/** The draft's price in millicents when it parses, else undefined (empty or invalid). */
function draftPriceMc(draft: PriceDraft): number | undefined {
  const text = draft.price.trim();
  if (text === '') return undefined;
  const p = parseDollarsToMc(text);
  return p.ok ? p.value : undefined;
}

/**
 * Whether the row holds the member's own rate (P1-G01): Custom price, or a vendor preset with a price that is
 * not the preset's typical (core/presets.isCustomPrice, the rule Show the math applies once it is saved).
 */
export function isCustomDraft(draft: PriceDraft): boolean {
  if (draft.preset === CUSTOM_PRESET) return true;
  const mc = draftPriceMc(draft);
  return mc !== undefined && isCustomPrice({ preset: draft.preset, milliCentsPerGb: mc });
}

/**
 * The line under a row's picker for what the row holds now (P1-G01): a typed contract rate reads
 * 'Custom price · typical $2.25' under its vendor, never the preset's own range as if it were the price.
 */
export function rowNoteLine(draft: PriceDraft): string {
  if (draft.preset !== CUSTOM_PRESET && isCustomDraft(draft)) {
    const info = presetInfo(draft.preset);
    return info.free ? t('settings.prices.customNoteNoPreset') : t('settings.prices.customNote', { typical: info.typical });
  }
  return presetNoteLine(draft.preset);
}

// ─── Drafts ──────────────────────────────────────────────────────────────────

/**
 * The preset a never-priced row starts on: its suggestion, except that Internal / free is offered only to a
 * destination that is genuinely free (P0-04, P1-G01). A paid type nothing matched (a webhook) starts on Custom
 * price, so its row never says "No destination charge" above an empty price.
 */
function startingPreset(row: PriceRow): DraftPreset {
  if (row.suggestedPreset !== 'internal') return row.suggestedPreset;
  return isFreeOutput({ type: row.type, id: row.outputId, description: row.description }) ? 'internal' : CUSTOM_PRESET;
}

/** The draft a row starts from: the stored entry, or the suggestion with an empty price. */
export function initialDraft(row: PriceRow): PriceDraft {
  const s = row.stored;
  if (!s) return { preset: startingPreset(row), price: '', counterfactual: 'same', committed: '' };
  return {
    // A stored price with no preset is a custom one (P1-G01).
    preset: s.preset ?? CUSTOM_PRESET,
    price: mcToDollarInput(s.milliCentsPerGb),
    counterfactual: counterfactualKey(s.counterfactual),
    committed: s.committedMilliCentsPerGb !== undefined ? mcToDollarInput(s.committedMilliCentsPerGb) : '',
  };
}

export function initialDrafts(rows: readonly PriceRow[]): Record<string, PriceDraft> {
  return Object.fromEntries(rows.map((r) => [r.key, initialDraft(r)]));
}

/**
 * Picking a preset fills the price with its typical value (the member edits it to the contract rate).
 * Picking Custom price keeps whatever is typed: it is the member's own rate (P1-G01).
 */
export function applyPreset(draft: PriceDraft, preset: DraftPreset): PriceDraft {
  if (preset === CUSTOM_PRESET) return { ...draft, preset };
  return { ...draft, preset, price: presetDollars(preset) };
}

/**
 * Typing a price (P1-G01). On Internal / free a rate above $0 is not free any more, so the picker moves to
 * Custom price instead of reading "Internal / free · No destination charge" above $1.80. On a vendor preset the
 * vendor stays (it still says what the destination is) and the row note says the rate is custom.
 */
export function editPrice(draft: PriceDraft, price: string): PriceDraft {
  const next = { ...draft, price };
  const mc = draftPriceMc(next);
  if (draft.preset !== CUSTOM_PRESET && presetInfo(draft.preset).free && mc !== undefined && mc > 0) next.preset = CUSTOM_PRESET;
  return next;
}

/**
 * Whether "Use suggested prices" fills this row: never priced, nothing typed, and a suggestion worth money.
 * A $0 suggestion (Internal / free) is never filled or counted (P0-04): a free sink needs no price, and a $0
 * fill on a destination that does cost money would read as priced at nothing.
 */
function isSuggestable(row: PriceRow, draft: PriceDraft | undefined): boolean {
  const d = draft ?? initialDraft(row);
  return !row.stored && d.price.trim() === '' && (presetById(d.preset)?.milliCentsPerGb ?? 0) > 0;
}

/** "Use suggested prices": fills every empty, never-priced row whose suggestion is worth money with that preset's value. Returns the rows it filled. */
export function fillSuggested(rows: readonly PriceRow[], drafts: Record<string, PriceDraft>): { drafts: Record<string, PriceDraft>; filled: string[] } {
  const next = { ...drafts };
  const filled: string[] = [];
  for (const row of rows) {
    const d = next[row.key] ?? initialDraft(row);
    if (!isSuggestable(row, d)) continue;
    next[row.key] = applyPreset(d, d.preset);
    filled.push(row.key);
  }
  return { drafts: next, filled };
}

/** Rows a "Use suggested prices" click would fill (never a $0 suggestion). */
export function suggestableCount(rows: readonly PriceRow[], drafts: Record<string, PriceDraft>): number {
  return rows.filter((r) => isSuggestable(r, drafts[r.key])).length;
}

/** The price field's placeholder: the preset's typical value, or a dash when it has none to offer ('0.00' reads as a price). */
export function pricePlaceholder(preset: DraftPreset): string {
  return (presetById(preset)?.milliCentsPerGb ?? 0) > 0 ? presetDollars(preset) : t('settings.prices.noSuggestedPrice');
}

/**
 * Parses a dollar field. The inline error is short (P1-G03: the price field is ~104 px wide at 1440, and the
 * full "Couldn't save: price must be a number of 0 or more." wrapped four lines under it); the save bar
 * carries the "Fix 1 field to save." half of the message.
 */
function parseField(text: string, namedField?: string): { ok: true; value: number } | { ok: false; error: string } {
  const parsed = parseDollarsToMc(text);
  if (parsed.ok) return parsed;
  // A value with no field of its own on the page (the committed rate, P0-19) keeps the long form that names it.
  if (namedField !== undefined) {
    if (parsed.error.includes('decimal')) return { ok: false, error: t('settings.errors.decimals', { field: namedField }) };
    if (parsed.error.includes('large')) return { ok: false, error: t('settings.errors.tooLarge', { field: namedField }) };
    return { ok: false, error: t('errors.fieldNumber', { field: namedField }) };
  }
  if (parsed.error.includes('decimal')) return { ok: false, error: t('settings.prices.priceErrorDecimals') };
  if (parsed.error.includes('large')) return { ok: false, error: t('settings.prices.priceErrorTooLarge') };
  return { ok: false, error: t('settings.prices.priceErrorNumber') };
}

/**
 * What a never-priced row carries beyond its suggestion other than a price: a counterfactual, or a committed
 * rate kept from an import. Neither can be saved without a price (P0-19: such an edit is a change the Save
 * bar counts, and the price field says what it needs, never a silent no-op).
 */
function hasNonPriceEdit(draft: PriceDraft): boolean {
  return draft.counterfactual !== 'same' || draft.committed.trim() !== '';
}

/**
 * SPEC 5 / 17 inline errors for one row. An empty price is fine on an untouched never-priced row (it stays
 * unpriced), an error on a priced one (a price cannot be removed, only changed), and an error on a
 * never-priced row whose other fields were edited (they are saved only with a price).
 */
export function validateDraft(row: PriceRow, draft: PriceDraft): PriceFieldErrors {
  const errors: PriceFieldErrors = {};
  const price = draft.price.trim();
  if (price === '') {
    if (row.stored) errors.price = t('settings.prices.priceErrorNumber');
    else if (hasNonPriceEdit(draft)) errors.price = t('settings.prices.priceNeeded');
  } else {
    const p = parseField(price);
    if (!p.ok) errors.price = p.error;
  }
  const committed = draft.committed.trim();
  if (committed !== '') {
    const c = parseField(committed, t('settings.prices.fieldCommitted'));
    if (!c.ok) errors.committed = c.error;
  }
  return errors;
}

/** The entry a valid draft writes, or null when the row is not written (empty, never priced). */
export function draftToEntry(draft: PriceDraft): PriceEntry | null {
  const price = draft.price.trim();
  if (price === '') return null;
  const p = parseDollarsToMc(price);
  if (!p.ok) return null;
  const entry: PriceEntry = { milliCentsPerGb: p.value };
  // Custom price stores no preset (P1-G01); every other choice names its preset.
  if (draft.preset !== CUSTOM_PRESET) entry.preset = draft.preset;
  entry.counterfactual = parseCounterfactualKey(draft.counterfactual);
  const committed = draft.committed.trim();
  if (committed !== '') {
    const c = parseDollarsToMc(committed);
    if (c.ok) entry.committedMilliCentsPerGb = c.value;
  }
  return entry;
}

function sameCounterfactual(a: Counterfactual | undefined, b: Counterfactual | undefined): boolean {
  return counterfactualKey(a) === counterfactualKey(b);
}

/** Whether the draft differs from what is stored (drafts that write nothing are never dirty). */
export function isDirty(row: PriceRow, draft: PriceDraft): boolean {
  const s = row.stored;
  // A never-priced row changes when it gets a price (valid or not) or another field is edited (P0-19: every
  // visible field counts); its suggested preset alone is not a change.
  if (!s) return draft.price.trim() !== '' || hasNonPriceEdit(draft);
  const entry = draftToEntry(draft);
  if (!entry) return true; // emptied or invalid: a change the Save button must account for
  return (
    entry.milliCentsPerGb !== s.milliCentsPerGb ||
    (entry.committedMilliCentsPerGb ?? -1) !== (s.committedMilliCentsPerGb ?? -1) ||
    !sameCounterfactual(entry.counterfactual, s.counterfactual) ||
    (entry.preset ?? '') !== (s.preset ?? '')
  );
}

export interface PriceChanges {
  /** entries to append (only changed rows), keyed `${groupId}:${outputId}` */
  entries: Record<string, PriceEntry>;
  /** inline errors by row key (only rows with an error) */
  errors: Record<string, PriceFieldErrors>;
  /** dirty rows, valid or not */
  dirty: string[];
}

/** Everything a Save needs: what to write, what blocks it, how many rows changed. */
export function collectChanges(rows: readonly PriceRow[], drafts: Record<string, PriceDraft>): PriceChanges {
  const entries: Record<string, PriceEntry> = {};
  const errors: Record<string, PriceFieldErrors> = {};
  const dirty: string[] = [];
  const listed = new Set(rows.map((r) => `${r.groupId}:${r.outputId}`));
  for (const row of rows) {
    const draft = drafts[row.key];
    if (!draft || !isDirty(row, draft)) continue;
    dirty.push(row.key);
    const e = validateDraft(row, draft);
    if (e.price || e.committed) {
      errors[row.key] = e;
      continue;
    }
    const entry = draftToEntry(draft);
    if (!entry) continue;
    if (entry.counterfactual?.kind === 'other' && !listed.has(`${row.groupId}:${entry.counterfactual.outputId}`)) {
      entry.counterfactual = { kind: 'same' };
    }
    entries[row.key] = entry;
  }
  return { entries, errors, dirty };
}

/** Letters and digits only, lower case: 'Google SecOps' and 'google_secops' compare equal. */
function idWords(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The mono line under a destination's name (P1-G03): 'type · group', led by the id only when the name does not
 * already say it ('mrd_siem_prod · devnull · default' under 'SIEM (prod)'; 'devnull · default' under 'DevNull'),
 * so the group is no longer cut off on the sample workspace's long ids at 1440.
 */
export function destinationMeta(d: { name: string; outputId: string; type: string; groupId: string }): string {
  return idWords(d.name) === idWords(d.outputId)
    ? t('settings.prices.metaTypeGroup', { type: d.type, group: d.groupId })
    : t('settings.prices.meta', { id: d.outputId, type: d.type, group: d.groupId });
}

/** Counts for the card header: listed and unpriced destinations. */
export function rowCounts(rows: readonly PriceRow[]): { total: number; unpriced: number } {
  return { total: rows.length, unpriced: rows.filter((r) => r.unpriced).length };
}

// ─── The vendor-tile preset picker (P2-W24) ──────────────────────────────────

/** One tile: a vendor monogram in the destination ramp, the name, and the typical $/GB. */
export interface PresetTile {
  id: DraftPreset;
  name: string;
  /** 'typical $2.25 / GB', 'No destination charge', 'Not a list price' */
  caption: string;
  /** the option's whole accessible name: 'Splunk Cloud · typical $2.25 / GB · range $1.47–$4.85' */
  label: string;
  monogram: string;
  /** 1–6: which of the destination ramp's colours the monogram wears */
  tone: number;
}

export interface PresetTileGroups {
  /** The row's suggestion, pinned first (only a paid preset; never Internal / free). */
  suggested?: PresetTile;
  /** Every other vendor's typical list price. */
  listed: PresetTile[];
  /** Custom price, then Internal / free last. */
  other: PresetTile[];
}

const norm2 = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Whether a tile answers the search: its name, id, destination types or monogram contain every word typed. */
function tileMatches(id: DraftPreset, name: string, monogram: string, query: string): boolean {
  const q = norm2(query);
  if (q === '') return true;
  const hay = norm2([name, id, monogram, ...(presetById(id)?.matchTypes ?? [])].join(' '));
  return q.split(' ').every((w) => hay.includes(w));
}

/** The picker's tiles for a row (P2-W24): its suggestion first, the vendors, then Custom price and Internal / free. */
export function presetTiles(suggested: PresetId, query = ''): PresetTileGroups {
  const tiles: PresetTile[] = PRESETS.map((p, i) => {
    const info = presetInfo(p.id);
    return {
      id: p.id,
      name: info.label,
      caption: info.free ? t('settings.prices.presetRangeFree') : t('settings.prices.presetTileCaption', { typical: info.typical }),
      label: info.option,
      monogram: p.monogram ?? info.label.slice(0, 2).toUpperCase(),
      tone: (i % 6) + 1,
    };
  });
  const customName = t('settings.prices.customPreset');
  const customCaption = t('settings.prices.customPresetCaption');
  const custom: PresetTile = {
    id: CUSTOM_PRESET,
    name: customName,
    caption: customCaption,
    label: t('settings.prices.customPresetOption', { preset: customName, caption: customCaption }),
    monogram: '$',
    tone: 0,
  };
  const matches = (tile: PresetTile) => tileMatches(tile.id, tile.name, tile.monogram, query);
  const paid = tiles.filter((tile) => !presetInfo(tile.id as PresetId).free);
  const pinned = suggested !== 'internal' ? paid.find((tile) => tile.id === suggested) : undefined;
  const groups: PresetTileGroups = {
    listed: paid.filter((tile) => tile !== pinned && matches(tile)),
    other: [custom, ...tiles.filter((tile) => presetInfo(tile.id as PresetId).free)].filter(matches),
  };
  if (pinned && matches(pinned)) groups.suggested = pinned;
  return groups;
}

/** The tile for the picker's closed trigger. */
export function presetTileFor(id: DraftPreset): PresetTile | undefined {
  const all = presetTiles('internal');
  return [...all.listed, ...all.other].find((tile) => tile.id === id);
}

/** The history the row's disclosure lists, newest first. */
export function historyNewestFirst(row: Pick<PriceRow, 'history'>): NonNullable<PriceRow['history']> {
  return [...(row.history ?? [])].reverse();
}
