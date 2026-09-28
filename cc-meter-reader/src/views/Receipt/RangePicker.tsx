// src/views/Receipt/RangePicker.tsx — the hero's period toggle with its fifth item, Custom, and the range picker
// it opens (DESIGN_BRIEF 5.1 item 1; core/range.ts): a Capra Popover with the quick picks (1 h · 6 h · 24 h ·
// 7 days · 30 days), an exact window (From / To in the display timezone), a preview of what Apply will sum,
// Apply and Cancel.
//
// Anchoring: a Capra Popover opens from the Capra Button inside its trigger, and every button in a
// ToggleButtonGroup is a press target of its own, so the trigger is an IconButton hidden just past the group's
// right end (out of the tab order; the popover positions itself against it) and Custom is the only visible
// affordance. Pressing Custom opens the picker; pressing it again while it is selected — which react-aria reports
// as an empty selection, since the group allows one — re-opens it. Escape and an outside click close it
// (react-aria's overlay), and focus returns to where it was (its FocusScope restores focus).
//
// Placement (P1-H09): the hero's figure sits under the toggle's left half and the card's right half is empty, so
// on a desktop the popover drops from the toggle's right end (where the anchor is) into that empty half, never
// over the number; on a phone (≤ 640 px) a measured cross-axis offset moves it to the hero card's left edge and
// the panel takes the card's width, so it spans the card under the toggle. react-aria keeps a popover
// overlapping its anchor on the cross axis, which is why the anchor itself sits at the right end rather than an
// offset carrying the popover there. Measured when it opens and again on every resize while it is open.
//
// The read budget (api-budget F2): the preview also says how many history documents Apply will read — the same
// hybrid plan the reader makes (core/range.ts planRangeReads with the sweep's cursor), so a 30-day pick reads 4,
// not 31.
//
// The window is entered as wall time in the display timezone with native `datetime-local` inputs inside Capra
// TextFields — the Capra date range field takes `@internationalized/date` values, which this app does not
// depend on — and stored in the URL as UTC minutes (`?range=<from>Z..<to>Z`). The fields are never empty: they
// open showing the window Apply would use (the active range, or the last 6 h), and a quick pick fills them with
// its own window, so what is shown is always what Apply does (WebKit paints an empty datetime-local as the
// current time). A pre-filled field keeps the instant it was filled from until it is edited, so re-applying an
// unchanged window never shifts it — the same wall time occurs twice on a fall-back night.
//
// Compare with… (P2-W13): a Capra SelectField under the window — nothing, the previous period, the same window a
// week earlier (for windows of 7 days or less), or one of the recent commits in the change timeline, which fills
// the window with the 24 h after its deploy. The preview then says what both windows sum (the current one as the
// comparison reads it, aligned when the older window needs whole hours or days) and how many documents the two
// reads take together; a comparison that can't be made (core/range.ts planComparison) says why and Apply waits.

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useNow } from '../../lib/ticker.ts';
import { Button, IconButton, Popover, SelectField, TextField, ToggleButtonGroup, type Key } from '@capra/core';
import { CalendarOutlined } from '@capra/icons';
import type { HeadlinePeriod } from '../../../core/types.ts';
import {
  RELATIVE_PRESETS,
  WEEK_MS,
  commitAfterWindow,
  planComparison,
  planRangeReads,
  presetKeyOf,
  resolveRange,
  type CompareSpec,
  type ComparisonPlan,
  type ComparisonRefusal,
  type RangeSpec,
  type RelativePresetKey,
} from '../../../core/range.ts';
import { canonicalZoneName, formatLocalDateTime, formatLocalDateTimeInput, parseLocalDateTimeInput } from '../../../core/time.ts';
import { t, tn } from '../../copy/en.ts';
import { PERIOD_ORDER } from './model.ts';
import { rangePreview, rangePreviewLine } from './text.ts';
import { comparePreviewLine, refusalText, shortHash } from './compareText.ts';

/** A recent commit the picker offers to compare before and after (from the snapshot's change timeline). */
export interface PickerCommit {
  hash: string;
  message: string;
  /** When it changed the data: deployed, else committed (core/range.ts commitAtMs). */
  atMs: number;
}

/** The select's keys: nothing, the previous period, a week earlier, or `commit:<hash>`. */
type CompareKey = 'none' | 'prev' | 'week' | `commit:${string}`;
const COMMIT_MESSAGE_MAX = 40;

function compareKeyOf(vs: CompareSpec | undefined): CompareKey {
  if (!vs) return 'none';
  return vs.kind === 'commit' ? `commit:${vs.hash}` : vs.kind;
}
function compareSpecOf(key: string): CompareSpec | undefined {
  if (key === 'prev' || key === 'week') return { kind: key };
  if (key.startsWith('commit:')) return { kind: 'commit', hash: key.slice('commit:'.length) };
  return undefined;
}
const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

export type ToggleKey = HeadlinePeriod | 'custom';

const TOGGLE_LABEL: Record<ToggleKey, () => string> = {
  mtd: () => t('meter.periodToggle.mtd'),
  today: () => t('meter.periodToggle.today'),
  '30d': () => t('meter.periodToggle.30d'),
  annualized: () => t('meter.periodToggle.annualized'),
  custom: () => t('meter.periodToggle.custom'),
};

const QUICK_LABEL: Record<RelativePresetKey, () => string> = {
  '1h': () => t('meter.range.quick.1h'),
  '6h': () => t('meter.range.quick.6h'),
  '24h': () => t('meter.range.quick.24h'),
  '7d': () => t('meter.range.quick.7d'),
  '30d': () => t('meter.range.quick.30d'),
};

/** The window the fields open with when no range is active. */
const DEFAULT_DRAFT_HOURS = 6;
/**
 * The Receipt's phone layout (Receipt.css): at and below it the picker spans the hero card. Asked of matchMedia,
 * the same test the stylesheet makes — a phone's innerWidth grows while a popover overflows it.
 */
const PHONE_QUERY = '(max-width: 640px)';
/** The popover surface's border, left + right: the panel is the card's width less this on a phone. */
const POPOVER_BORDER_PX = 2;

/** Where the popover goes relative to its anchor (just past the toggle's right end), and how wide the panel is. */
interface PanelLayout {
  crossOffset: number;
  /** A phone: the panel's width (the hero card's, less the popover border); otherwise its CSS width. */
  width?: number;
}

/** Measures the placement against the live layout: at the anchor on a desktop, the card's left edge on a phone. */
function measureLayout(root: HTMLElement): PanelLayout {
  const card = root.closest('.mr-hero')?.getBoundingClientRect();
  const anchor = root.querySelector('.mr-range-anchor button')?.getBoundingClientRect();
  if (!card || !anchor || !window.matchMedia(PHONE_QUERY).matches) return { crossOffset: 0 };
  return { crossOffset: card.left - anchor.left, width: Math.max(0, card.width - POPOVER_BORDER_PX) };
}

/** How many history documents a spec's read plans, or undefined when it reads none (a future window). */
function plannedReads(spec: RangeSpec, nowMs: number, collectingSinceMs: number | undefined, meteredThroughMs: number | undefined): number | undefined {
  const resolved = resolveRange(spec, nowMs, collectingSinceMs);
  if (resolved.future) return undefined;
  return planRangeReads(resolved.fromMs, resolved.toMs, nowMs, meteredThroughMs).keys.length;
}

export interface RangeControlProps {
  period: HeadlinePeriod;
  /** The active custom range, if any: the toggle then shows Custom selected. */
  range?: RangeSpec;
  onPeriod: (period: HeadlinePeriod) => void;
  onApplyRange: (spec: RangeSpec, vs?: CompareSpec) => void;
  /** ?vs= — what the active range is compared with (the picker opens showing it). */
  vs?: CompareSpec;
  /** Recent commits to compare before and after, newest first. */
  commits?: readonly PickerCommit[];
  /** Display timezone the exact window is entered in. */
  tz: string;
  /**
   * A fixed clock, for the inputs' upper bound and the preview (tests pin it); omitted, the picker reads the live
   * clock when it opens and applies, and its panel ticks on its own while open (the Receipt view does not, P1-B05).
   */
  nowMs?: number;
  /** When collecting began (the preview clips to it, as the read will). */
  collectingSinceMs?: number;
  /** The sweep's cursor (meta.meteredThrough): the preview's read count plans the same hybrid read the reader will. */
  meteredThroughMs?: number;
  /** Sample data: Custom is disabled (the hint beside the toggle is the card's, described by `customHintId`). */
  customDisabled?: boolean;
  customHintId?: string;
}

interface Draft {
  preset?: RelativePresetKey;
  from: string;
  to: string;
  /** The instants the fields were filled from; dropped for a field once it is edited. */
  fromMs?: number;
  toMs?: number;
  /** What the window is compared with (P2-W13). */
  vs?: CompareSpec;
}

function filledDraft(fromMs: number, toMs: number, tz: string, preset?: RelativePresetKey): Draft {
  return { ...(preset ? { preset } : {}), from: formatLocalDateTimeInput(fromMs, tz), to: formatLocalDateTimeInput(toMs, tz), fromMs, toMs };
}

/** The draft a spec opens with: its own window in the fields (a relative one resolved against the clock). */
function draftFor(range: RangeSpec | undefined, tz: string, nowMs: number, collectingSinceMs: number | undefined, vs?: CompareSpec): Draft {
  const withVs = (d: Draft): Draft => (vs && range ? { ...d, vs } : d);
  if (range?.kind === 'absolute') return withVs(filledDraft(range.fromMs, range.toMs, tz));
  const spec: RangeSpec = range ?? { kind: 'relative', hours: DEFAULT_DRAFT_HOURS };
  const r = resolveRange(spec, nowMs, collectingSinceMs);
  return withVs(filledDraft(r.fromMs, r.toMs, tz, presetKeyOf(range)));
}

type DraftStatus = 'ok' | 'incomplete' | 'invalid';

/** The spec a draft means, or why it means none yet. */
function specOf(draft: Draft, tz: string): { spec?: RangeSpec; status: DraftStatus } {
  if (draft.preset) {
    const preset = RELATIVE_PRESETS.find((p) => p.key === draft.preset);
    return preset ? { spec: { kind: 'relative', hours: preset.hours }, status: 'ok' } : { status: 'incomplete' };
  }
  if (!draft.from || !draft.to) return { status: 'incomplete' };
  const fromMs = draft.fromMs ?? parseLocalDateTimeInput(draft.from, tz);
  const toMs = draft.toMs ?? parseLocalDateTimeInput(draft.to, tz);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return { status: 'incomplete' };
  if (fromMs >= toMs) return { status: 'invalid' };
  return { spec: { kind: 'absolute', fromMs, toMs }, status: 'ok' };
}

interface PanelProps {
  draft: Draft;
  onDraft: (next: Draft) => void;
  onApply: () => void;
  onCancel: () => void;
  tz: string;
  /** A fixed clock (tests); omitted, the open panel ticks once a second on its own. */
  nowMs?: number;
  collectingSinceMs: number | undefined;
  meteredThroughMs: number | undefined;
  labelId: string;
  /** A phone: the panel spans the hero card (PanelLayout.width). */
  width?: number;
  commits: readonly PickerCommit[];
}

/** The comparison a draft plans (undefined when it compares with nothing, or has no window yet). */
function draftComparison(
  spec: RangeSpec | undefined,
  vs: CompareSpec | undefined,
  commits: readonly PickerCommit[],
  nowMs: number,
  collectingSinceMs: number | undefined,
  meteredThroughMs: number | undefined,
): ComparisonPlan | ComparisonRefusal | undefined {
  if (!spec || !vs) return undefined;
  const commit = vs.kind === 'commit' ? commits.find((c) => c.hash.toLowerCase().startsWith(vs.hash) || vs.hash.startsWith(c.hash.toLowerCase())) : undefined;
  return planComparison(spec, vs, { nowMs, collectingSinceMs, foldedThroughMs: meteredThroughMs, ...(commit ? { commit: { hash: commit.hash, atMs: commit.atMs } } : {}) });
}

function RangePanel({ draft, onDraft, onApply, onCancel, tz, nowMs: fixedNowMs, collectingSinceMs, meteredThroughMs, labelId, width, commits }: PanelProps) {
  const tick = useNow();
  const nowMs = fixedNowMs ?? tick;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { spec, status } = specOf(draft, tz);
  const max = formatLocalDateTimeInput(nowMs, tz);
  const cmp = draftComparison(spec, draft.vs, commits, nowMs, collectingSinceMs, meteredThroughMs);
  // With a comparison the preview describes the window as the comparison reads it (aligned when it must be).
  const previewSpec: RangeSpec | undefined = cmp?.ok ? { kind: 'absolute', ...cmp.current } : spec;
  const preview = previewSpec ? rangePreviewLine(rangePreview(previewSpec, nowMs, collectingSinceMs, tz)) : undefined;
  const reads = cmp?.ok ? cmp.reads : spec && !cmp ? plannedReads(spec, nowMs, collectingSinceMs, meteredThroughMs) : undefined;
  // "A week earlier" compares windows of 7 days or less.
  const resolved = spec ? resolveRange(spec, nowMs, collectingSinceMs) : undefined;
  const weekTooLong = resolved !== undefined && resolved.toMs - resolved.fromMs > WEEK_MS;

  const pickCompare = (key: string): void => {
    const vs = compareSpecOf(key);
    if (vs?.kind === 'commit') {
      // A commit fills the window with the 24 h after its deploy (or up to now).
      const commit = commits.find((c) => c.hash === vs.hash);
      const after = commit ? commitAfterWindow(commit.atMs, nowMs) : undefined;
      if (after) {
        onDraft({ ...filledDraft(after.fromMs, after.toMs, tz), vs });
        return;
      }
    }
    onDraft({ ...draft, vs });
  };
  const compareItems = [
    { id: 'none', label: t('meter.range.compare.none') },
    { id: 'prev', label: t('meter.range.compare.prev') },
    { id: 'week', label: t(weekTooLong ? 'meter.range.compare.weekTooLong' : 'meter.range.compare.week') },
    ...(commits.length > 0
      ? [
          {
            id: 'commits',
            label: t('meter.range.compare.commitsTitle'),
            children: commits.map((c) => ({
              id: `commit:${c.hash}`,
              label: t('meter.range.compare.commitItem', { hash: shortHash(c.hash), message: clip(c.message, COMMIT_MESSAGE_MAX), time: formatLocalDateTime(c.atMs, tz) }),
            })),
          },
        ]
      : []),
  ];

  // Focus the first quick pick once the popover has positioned itself, so the keyboard lands inside.
  useEffect(() => {
    const frame = requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>('button')?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const pickPreset = (next: RelativePresetKey): void => {
    const r = resolveRange({ kind: 'relative', hours: RELATIVE_PRESETS.find((p) => p.key === next)?.hours ?? 1 }, nowMs, collectingSinceMs);
    // A quick pick keeps a period comparison; a commit's comparison belongs to the window after that commit.
    const vs = draft.vs?.kind === 'commit' ? undefined : draft.vs;
    onDraft({ ...filledDraft(r.fromMs, r.toMs, tz, next), ...(vs ? { vs } : {}) });
  };

  return (
    <div
      ref={rootRef}
      className="mr-range-panel"
      role="dialog"
      aria-labelledby={labelId}
      data-testid="range-picker"
      data-layout={width !== undefined ? 'card' : 'toggle-end'}
      style={width !== undefined ? { width } : undefined}
    >
      <p id={labelId} className="mr-range-panel-title">
        {t('meter.range.pickerLabel')}
      </p>
      <ToggleButtonGroup
        aria-label={t('meter.range.quickLabel')}
        size="sm"
        selectionMode="single"
        selectedKeys={new Set<Key>(draft.preset ? [draft.preset] : [])}
        onSelectionChange={(keys) => {
          const next = [...keys][0];
          if (typeof next === 'string' && RELATIVE_PRESETS.some((p) => p.key === next)) pickPreset(next as RelativePresetKey);
        }}
        items={RELATIVE_PRESETS.map((p) => ({ key: p.key, text: QUICK_LABEL[p.key]() }))}
      />
      <p className="mr-range-panel-sub">{t('meter.range.absoluteTitle')}</p>
      <div className="mr-range-fields">
        <TextField
          label={t('meter.range.from')}
          type="datetime-local"
          step={60}
          max={max}
          size="sm"
          value={draft.from}
          onChange={(value) => onDraft({ from: value, to: draft.to, toMs: draft.toMs, vs: draft.vs })}
          data-testid="range-from"
        />
        <TextField
          label={t('meter.range.to')}
          type="datetime-local"
          step={60}
          max={max}
          size="sm"
          value={draft.to}
          onChange={(value) => onDraft({ from: draft.from, to: value, fromMs: draft.fromMs, vs: draft.vs })}
          data-testid="range-to"
        />
      </div>
      <p className="mr-range-panel-note" data-invalid={status === 'ok' ? 'false' : 'true'} data-testid="range-note">
        {status === 'invalid' ? t('meter.range.invalid') : status === 'incomplete' ? t('meter.range.incomplete') : t('meter.range.timezoneNote', { tz: canonicalZoneName(tz) })}
      </p>
      <div className="mr-range-compare" data-testid="range-compare">
        <SelectField
          label={t('meter.range.compare.label')}
          size="sm"
          items={compareItems}
          value={compareKeyOf(draft.vs)}
          disabledKeys={weekTooLong && draft.vs?.kind !== 'week' ? ['week'] : []}
          onChange={(key) => pickCompare(typeof key === 'string' ? key : 'none')}
        />
      </div>
      {preview ? (
        <p className="mr-range-panel-preview" data-testid="range-preview">
          {preview}
          {cmp?.ok ? (
            <>
              {' '}
              <span data-testid="range-compare-preview">{comparePreviewLine(cmp, tz)}</span>
            </>
          ) : null}
        </p>
      ) : null}
      {cmp && !cmp.ok ? (
        <p className="mr-range-panel-note" data-invalid="true" data-testid="range-compare-refused">
          {refusalText(cmp, tz, collectingSinceMs, nowMs)}
        </p>
      ) : null}
      {preview && reads !== undefined ? (
        <p className="mr-range-panel-reads" data-testid="range-reads">
          {cmp?.ok ? tn('meter.range.compare.reads', reads) : tn('meter.range.reads', reads)}
        </p>
      ) : null}
      <div className="mr-range-panel-actions">
        <Button variant="tertiary" size="sm" onPress={onCancel}>
          {t('meter.range.cancel')}
        </Button>
        <Button variant="primary" size="sm" disabled={spec === undefined || (cmp !== undefined && !cmp.ok)} onPress={onApply}>
          {t('meter.range.apply')}
        </Button>
      </div>
    </div>
  );
}

/** The five-item period toggle and the custom range picker it opens. */
export function RangeControl({ period, range, vs, commits = [], onPeriod, onApplyRange, tz, nowMs, collectingSinceMs, meteredThroughMs, customDisabled = false, customHintId }: RangeControlProps) {
  // The live clock when none is pinned, read only when the picker opens or applies (never on a render).
  const clock = (): number => nowMs ?? Date.now();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftFor(range, tz, clock(), collectingSinceMs, vs));
  const [layout, setLayout] = useState<PanelLayout>({ crossOffset: 0 });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const labelId = useId();
  const selected: ToggleKey = range || open ? 'custom' : period;

  const measure = useCallback(() => {
    if (rootRef.current) setLayout(measureLayout(rootRef.current));
  }, []);

  // While open, a resize (a rotated phone, a zoom) moves the toggle and the card: place the popover again.
  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, measure]);

  const openPicker = () => {
    if (customDisabled) return;
    setDraft(draftFor(range, tz, clock(), collectingSinceMs, vs));
    measure();
    setOpen(true);
  };
  const apply = () => {
    const { spec } = specOf(draft, tz);
    if (!spec) return;
    const cmp = draftComparison(spec, draft.vs, commits, clock(), collectingSinceMs, meteredThroughMs);
    if (cmp && !cmp.ok) return;
    setOpen(false);
    if (draft.vs) onApplyRange(spec, draft.vs);
    else onApplyRange(spec);
  };

  return (
    <div ref={rootRef} className="mr-hero-toggle" data-testid="period-toggle" data-open={open ? 'true' : 'false'}>
      <ToggleButtonGroup
        aria-label={t('meter.periodToggle.ariaLabel')}
        // Capra's sanctioned override: on a very narrow card (320 px) the five items wrap into two rows (Receipt.css).
        FORCE__className="mr-hero-period-group"
        size="sm"
        selectionMode="single"
        selectedKeys={new Set<Key>([selected])}
        onSelectionChange={(keys) => {
          const next = [...keys][0];
          // An empty set is the selected item pressed again: Custom re-opens its picker, a period stays put.
          if (next === undefined) {
            if (selected === 'custom') openPicker();
            return;
          }
          if (next === 'custom') openPicker();
          else if (typeof next === 'string' && (PERIOD_ORDER as readonly string[]).includes(next)) onPeriod(next as HeadlinePeriod);
        }}
        items={[
          ...PERIOD_ORDER.map((p) => ({ key: p, text: TOGGLE_LABEL[p]() })),
          { key: 'custom', text: TOGGLE_LABEL.custom(), disabled: customDisabled },
        ]}
      />
      <Popover
        // A switch between the desktop and phone placements while open (a rotation) mounts the popover afresh:
        // react-aria freezes a popover's position once the visual viewport's scale moves, and a phone zooms out
        // the moment the old placement overflows its new width.
        key={layout.width !== undefined ? 'card' : 'toggle-end'}
        placement="bottomLeft"
        offsets={[8, layout.crossOffset]}
        removeContentPadding
        isOpen={open}
        onOpenChange={(next) => {
          if (next) openPicker();
          else setOpen(false);
        }}
        content={
          open ? (
            <RangePanel
              draft={draft}
              onDraft={setDraft}
              onApply={apply}
              onCancel={() => setOpen(false)}
              tz={tz}
              nowMs={nowMs}
              collectingSinceMs={collectingSinceMs}
              meteredThroughMs={meteredThroughMs}
              labelId={labelId}
              width={layout.width}
              commits={commits}
            />
          ) : null
        }
      >
        {/* The popover's anchor: hidden just past the group's right end, out of the tab order (Custom is the control). */}
        <span className="mr-range-anchor">
          <IconButton
            icon={CalendarOutlined}
            aria-label={t('meter.range.openPicker')}
            size="sm"
            variant="tertiary"
            excludeFromTabOrder
            disabled={customDisabled}
            aria-describedby={customDisabled ? customHintId : undefined}
          />
        </span>
      </Popover>
    </div>
  );
}
