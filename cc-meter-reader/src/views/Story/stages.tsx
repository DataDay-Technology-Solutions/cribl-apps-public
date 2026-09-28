// src/views/Story/stages.tsx — what each Story beat puts on the stage (PRD 8.9), composed from the app's own
// pieces (imported, never forked): the Meter, the receipt bar, the How-it-works strip, the incident card
// (TakeoverCard), the Slack message renderer, the QR. Every figure comes from the store the tour engine
// drives, so the screen shows exactly what the captions (formatted from the same fixture) say.
//
// The stage is a pure function of (story document, position, store): nothing here keeps its own memory
// of what happened, so a loop, a seek (video capture, tests) or a resize always draws the right frame.

import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { CheckOutlined, ClockOutlined, Gauge, GitAlt, Hashtag } from '@capra/icons';
import type { Commit, HeadlinePeriod, Incident, Settings, Snapshot, StoryDoc, TopSaver } from '../../../core/types.ts';
import { canonicalPayload, slackPayload } from '../../../core/payloads.ts';
import { fmtDollars, fmtDuration, footMoney } from '../../../core/format.ts';
import { askQrUrl } from '../../../core/settings.ts';
import { t } from '../../copy/en.ts';
import { commitAuthor } from '../../lib/author.ts';
import { Credit } from '../../components/common/Credit.tsx';
import { FlowDiagram } from '../../components/FlowDiagram/FlowDiagram.tsx';
// The map's own stylesheet (FlowMap imports it; the story draws the diagram without the product module around it).
import '../../components/FlowDiagram/FlowDiagram.css';
import { COMPACT_BELOW, computeFlowLayout, type FlowLayout } from '../../components/FlowDiagram/layout.ts';
import { layoutText } from '../../components/FlowDiagram/text.ts';
import { HowItWorks } from '../../components/HowItWorks/HowItWorks.tsx';
import { formatClockTime, impactFigures, isDelivered, renderTemplate, shortHash } from '../../components/IncidentCard/index.ts';
import { TakeoverCard } from '../../components/IncidentTakeover/TakeoverCard.tsx';
import { Meter } from '../../components/Meter/Meter.tsx';
import { QrBlock } from '../../components/QrBlock/QrBlock.tsx';
import { ReceiptBar } from '../../components/ReceiptBar/ReceiptBar.tsx';
import { SlackPreview } from '../../components/SlackPreview/SlackPreview.tsx';
import { useAppState } from '../../state/react.tsx';
import type { StoryPosition } from '../../story/timeline.ts';
import { flowOf, storyCommit, storyFlowGroup, storyIncident } from '../../story/select.ts';
import type { TourEngine } from '../../tour/engine.ts';
import { periodBasis } from '../Presenter/basis.ts';
import { periodFigure } from '../Presenter/heroValue.ts';
import { useLeaderReach } from '../Presenter/leaderReach.ts';
import { saverDrops, saverLabel, stageSaverLabels } from '../Presenter/savers.ts';
import { PERIOD_CAPTION } from '../Receipt/text.ts';
import { RatioWatch } from './RatioWatch.tsx';
import { wedgeSpot } from './wedgeSpot.ts';

export interface StageProps {
  doc: StoryDoc;
  pos: StoryPosition;
  engine: TourEngine | null;
  reducedMotion: boolean;
}

const ms = (iso: string | undefined): number => (iso ? Date.parse(iso) : Number.NaN);

function useStoryData(): { snapshot: Snapshot | null; settings: Settings } {
  const snapshot = useAppState((s) => s.snapshot);
  const settings = useAppState((s) => s.settings);
  return { snapshot, settings };
}

// ─── Title ───────────────────────────────────────────────────────────────────

function TitleStage() {
  return (
    <div className="mr-st-title">
      <span className="mr-st-emblem" aria-hidden="true">
        <Gauge size="xl" aria-hidden />
      </span>
      <h1 className="mr-st-title-text">{t('story.title')}</h1>
      <p className="mr-st-title-credit">
        <Credit copyKey="credit.storyTitle" testId="story-credit" />
      </p>
    </div>
  );
}

// ─── The presenter (hook, alert, restore) ────────────────────────────────────
//
// These beats ARE the presenter view (P1-C02): its headline period (the annualized run rate by default) at
// its size, its basis words, its top five savers with dot leaders; the incident card below, full width.
// The month to date stays on the receipt beat, where the receipt's own lines add up to it.

/**
 * The presenter's lines, named by the stage's own label rule (W3-STAGE-2, stageSaverLabels): the pipeline alone
 * when that tells the savers apart. A name still too long for its line wraps to a second one, its leader on the
 * last (Story.css), never an ellipsis. W3-STAGE-1: the open regression's drop as a red chip at the end of the named
 * saver's leader (saverDrops): the line keeps its own figure, and its place, until the incident closes.
 */
function SaversList({ savers, labels, incidents }: { savers: readonly TopSaver[]; labels: Record<string, string>; incidents: readonly Incident[] }) {
  const drops = saverDrops(savers, incidents);
  const names = stageSaverLabels(savers, labels);
  const listRef = useRef<HTMLOListElement | null>(null);
  useLeaderReach(listRef, '.mr-st-pv-item-label', '.mr-st-pv-leader');
  return (
    <ol ref={listRef} className="mr-st-pv-list">
      {savers.map((s, i) => {
        const drop = drops.get(s.objectKey);
        const perDay = drop !== undefined ? fmtDollars(drop) : '';
        return (
          <li key={s.objectKey} className="mr-st-pv-item" data-key={s.objectKey} data-drop-m={drop}>
            <span className="mr-st-pv-item-label" title={saverLabel(s, labels)}>
              {names[i]}
            </span>
            <span className="mr-st-pv-leader" aria-hidden="true" />
            {drop !== undefined ? (
              <span className="mr-st-pv-drop mr-num" aria-hidden="true" title={t('presenter.saverDropTitle', { perDay })}>
                {t('presenter.saverDrop', { perDay })}
              </span>
            ) : null}
            <span className="mr-st-pv-item-amount">
              <span className="mr-num">{fmtDollars(s.savedPerDayM)}</span>
              <span className="mr-st-pv-unit">{t('units.perDay')}</span>
              {drop !== undefined ? <span className="mr-visually-hidden">{t('presenter.saverDropHidden', { perDay })}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The hero's savings-rate chip (P2-W12): down while the story's alert is open, back once it recovers. */
interface RateDelta {
  tone: 'loss' | 'back';
  text: string;
  title: string;
}

function PresenterBand({ snapshot, settings, ratePerSecM, delta }: { snapshot: Snapshot; settings: Settings; ratePerSecM: number; delta: RateDelta | null }) {
  // The presenter's period (settings, default the annualized run rate) and its own figure arithmetic
  // (src/views/Presenter/heroValue.ts): a running total ticks at the sweep's rate, the run rate does not.
  // `?period=` is the Receipt's toggle and is deliberately not read: the loop plays the same frame anywhere.
  const period: HeadlinePeriod = settings.presenter?.headlinePeriod ?? 'annualized';
  const figure = periodFigure(snapshot.headline, period);
  const basis = periodBasis(period, snapshot.headline);
  const amount = fmtDollars(figure.valueM);
  const labels = settings.humanize ?? {};
  const savers = (snapshot.topSavers ?? []).filter((s) => s.savedPerDayM > 0).slice(0, 5);
  // The presenter's fit: ~0.6 em per character of the whole-dollar figure, at least eight.
  const fit = { '--mr-st-hero-chars': String(Math.max(amount.length, 8)) } as CSSProperties;
  return (
    <div className="mr-st-pv-band">
      <section className="mr-st-pv-hero" data-period={period} data-rate-m={ratePerSecM.toFixed(3)} style={fit}>
        <p className="mr-st-pv-label">{t('meter.caption')}</p>
        <Meter
          valueM={figure.valueM}
          ratePerSecM={figure.accrue ? ratePerSecM : 0}
          anchorMs={ms(snapshot.sweepAt)}
          size="presenter"
          label={t('presenter.heroMeterLabel', { period: basis })}
        />
        <div className="mr-st-pv-basisrow">
          <p className="mr-st-pv-basis">{basis}</p>
          {/*
            Always laid out (hidden until the alert), so nothing on the band moves when it lands (P1-C01); keyed by
            tone, so the green one arrives as its own chip.
          */}
          <span
            key={delta?.tone ?? 'none'}
            className="mr-st-pv-delta mr-num"
            data-tone={delta?.tone ?? 'none'}
            title={delta?.title}
            aria-hidden={delta ? undefined : true}
          >
            {delta?.text ?? '\u00a0'}
          </span>
        </div>
      </section>
      {savers.length > 0 ? (
        <section className="mr-st-pv-savers">
          <p className="mr-st-pv-label">{t('presenter.topSavers')}</p>
          <SaversList savers={savers} labels={labels} incidents={snapshot.incidents ?? []} />
        </section>
      ) : null}
    </div>
  );
}

/** Seconds in a day: a $ / day impact is this many times its per-second rate. */
const DAY_SEC = 86_400;

function HeroStage({ doc, pos, engine }: StageProps) {
  const { snapshot, settings } = useStoryData();
  const id = storyIncident(doc)?.id;
  const incident = snapshot?.incidents.find((i) => i.id === id);
  if (!snapshot) return null;
  // P2-W12: the number tells the incident. The savings rate is the story's own (the base snapshot's, the one the
  // hook opened on) less the open regression's $ a day; a Meter on a running period slows by exactly that, and
  // the chip beside the basis says it: red while the alert is open, green once it has closed itself.
  const baseRate = engine?.current()?.snapshot.ratePerSecM ?? snapshot.ratePerSecM;
  const open = !!incident && !incident.closedAt;
  const impact = incident?.impactPerDayM ?? 0;
  const ratePerSecM = Math.max(0, baseRate - (open ? impact / DAY_SEC : 0));
  const perDay = incident ? impactFigures(incident).perDay : '';
  const delta: RateDelta | null =
    incident && impact > 0
      ? open
        ? { tone: 'loss', text: t('story.rateDrop', { perDay }), title: t('story.rateDropTitle', { perDay }) }
        : { tone: 'back', text: t('story.rateBack', { perDay }), title: t('story.rateBackTitle', { perDay }) }
      : null;
  const mode = incident?.closedAt ? 'recovery' : 'alert';
  // Only what this beat makes happen moves onto the screen: the alert slides up in the beat that opens
  // it, the green card in the beat that closes it; a card that was already up is simply there.
  const animate = pos.beat.actions.some((a) => a.action === (mode === 'alert' ? 'incident.open' : 'incident.close'));
  // A beat that brings the card in lays out for it from its first frame (P1-C01): the Meter and the savers
  // hold their place and the card slides into room that was already there, as it does on the presenter.
  const cardBeat = !!incident || pos.beat.actions.some((a) => a.action === 'incident.open' || a.action === 'incident.close');
  return (
    <div className="mr-st-pv" data-card={cardBeat ? 'true' : 'false'}>
      <PresenterBand snapshot={snapshot} settings={settings} ratePerSecM={ratePerSecM} delta={delta} />
      {cardBeat ? (
        <div className="mr-st-card">
          {/* Keyed by mode: the green recovery slides in as its own card, as on the presenter view. */}
          {/* Neither the drawn drop nor the live lost counter in Story (D52): its beats draw the drop themselves, and the
              story's compressed clock would make a wall-clock counter jump as the card turns green. */}
          {incident ? <TakeoverCard key={mode} incident={incident} mode={mode} placement="inline" animate={animate} lostCounter={false} /> : null}
        </div>
      ) : null}
    </div>
  );
}

// ─── The Meter (the receipt beat) ────────────────────────────────────────────

function HeroFigure({ snapshot }: { snapshot: Snapshot }) {
  const h = snapshot.headline;
  const basis = PERIOD_CAPTION.mtd();
  return (
    <div className="mr-st-figure">
      <p className="mr-st-kicker">{t('meter.caption')}</p>
      {/*
        Static whole dollars (P1-C04): the caption under it says this figure ("Saved by Cribl: $544,974."), formatted
        from the same snapshot at generation time, and the receipt bar adds up to it. A ticking meter ran $45 past
        both by the end of the loop.
      */}
      <Meter
        valueM={h.mtdM}
        ratePerSecM={0}
        anchorMs={ms(snapshot.sweepAt)}
        size="presenter"
        label={t('presenter.heroMeterLabel', { period: basis })}
      />
      <p className="mr-st-basis">{basis}</p>
    </div>
  );
}

// ─── How it works ────────────────────────────────────────────────────────────

function HowStage({ pos }: StageProps) {
  const step = Math.min(3, Math.floor(pos.progress * 4));
  return (
    <div className="mr-st-how">
      <HowItWorks activeStep={step} />
    </div>
  );
}

// ─── The dollar map ──────────────────────────────────────────────────────────
//
// P2-W11: the one picture that answers "isn't this just Insights?" — the Flow view's own map (FlowDiagram, never
// forked) of the group it opens on, priced at each destination, with the pipeline's cut hatched in green. The
// map is laid out at a design width and drawn larger on a wide stage, so its 14 px labels read as ~20 px on a
// projector; it fills the room the stage leaves. Two callouts point into it: a ribbon's $ / day plate while the
// caption says what the destination charges, then that ribbon's saved wedge while it says what the cut is worth.

/** The width the map is laid out at before it is scaled up to the stage (its labels are sized for it). */
const FLOW_DESIGN_WIDTH = 1080;
/** How much larger than laid out the map may be drawn. */
const FLOW_MAX_SCALE = 1.5;
/** Flows a phone's compact map draws (the rest fold into "smaller flows"). */
const FLOW_PHONE_FLOWS = 6;

function useBoxSize(ref: RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      const next = { w: Math.floor(r.width), h: Math.floor(r.height) };
      setSize((p) => (p.w === next.w && p.h === next.h ? p : next));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/**
 * The ribbon the callouts point at: the story's own pipeline when the map draws both of its plates (the flow
 * that breaks a minute later), else the one saving the most that does (a thin ribbon carries no plate,
 * layout.ts). Its "$ / day" plate, then the "$ saved" plate that sits on its hatched wedge.
 */
function calloutPlates(layout: FlowLayout, svg: SVGSVGElement, preferKey: string | undefined): { plate: Element; saved: Element; wedge: Element | null } | null {
  const ranked = layout.ribbons
    .filter((r) => !r.folded)
    .sort((a, b) => Number(b.flow.key === preferKey) - Number(a.flow.key === preferKey) || b.flow.savedPerDayM - a.flow.savedPerDayM);
  const plateOf = (ownerId: string, kind: 'whp' | 'saved'): Element | null => {
    const label = layout.labels.find((l) => l.ownerId === ownerId && l.kind === kind && l.plate);
    return label ? svg.querySelector(`g[data-label="${CSS.escape(label.id)}"]`) : null;
  };
  for (const r of ranked) {
    const plate = plateOf(r.id, 'whp');
    const saved = plateOf(r.id, 'saved');
    if (plate && saved) return { plate, saved, wedge: svg.querySelector(`path.mr-flow-wedge[data-wedge="${CSS.escape(r.id)}"]`) };
  }
  return null;
}

function FlowStage({ doc }: StageProps) {
  const { snapshot, settings } = useStoryData();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const size = useBoxSize(frameRef);
  const group = useMemo(() => (snapshot ? storyFlowGroup(snapshot) : undefined), [snapshot]);
  const colorOrder = useMemo(() => (snapshot ? [...new Set(snapshot.destinations.map((d) => d.outputId))].sort() : []), [snapshot]);
  const text = useMemo(() => layoutText(settings.humanize), [settings.humanize]);
  const scale = size.w > 0 ? Math.min(FLOW_MAX_SCALE, Math.max(1, size.w / FLOW_DESIGN_WIDTH)) : 1;
  const layout = useMemo(() => {
    if (!group || size.w <= 0 || size.h <= 0) return null;
    const width = size.w / scale;
    // A phone's map stacks its labels over the nodes (compact): fewer, larger rows read at arm's length.
    const maxFlows = width < COMPACT_BELOW ? FLOW_PHONE_FLOWS : undefined;
    return computeFlowLayout(group.flows, { width, maxHeight: size.h / scale, text, colorOrder, ...(maxFlows ? { maxFlows } : {}) });
  }, [group, size.w, size.h, scale, text, colorOrder]);
  const incident = storyIncident(doc);
  const preferKey = group && incident ? flowOf(group.flows, incident.objectKey)?.key : undefined;
  // W3-STAGE-3: the saved callout's dot, on the wedge its plate labels (wedgeSpot.ts) — as an offset from the plate's
  // box, found once per layout (hit-testing is not free) and re-applied on every render with the ids.
  const dotRef = useRef<{ layout: FlowLayout; dot: string | null } | null>(null);
  // The callout ids go on the map's own plate and wedge (FlowDiagram draws them; the story only names them).
  useLayoutEffect(() => {
    const svg = frameRef.current?.querySelector('svg');
    if (!svg || !layout) return;
    for (const el of svg.querySelectorAll('[data-callout]')) {
      el.removeAttribute('data-callout');
      el.removeAttribute('data-callout-dot');
    }
    const picked = calloutPlates(layout, svg, preferKey);
    if (!picked) return;
    picked.plate.setAttribute('data-callout', 'flow-plate');
    picked.saved.setAttribute('data-callout', 'flow-saved');
    if (dotRef.current?.layout !== layout) {
      const spot = picked.wedge ? wedgeSpot(picked.wedge, picked.saved) : null;
      const box = picked.saved.getBoundingClientRect();
      dotRef.current = { layout, dot: spot ? `${(spot.x - box.left).toFixed(1)},${(spot.y - box.top).toFixed(1)}` : null };
    }
    if (dotRef.current.dot) picked.saved.setAttribute('data-callout-dot', dotRef.current.dot);
  });
  if (!snapshot || !group) return null;
  const fit = layout ? ({ '--mr-st-flow-w': `${layout.width * scale}px`, '--mr-st-flow-h': `${Math.round(layout.height) * scale}px` } as CSSProperties) : undefined;
  return (
    <section className="mr-st-panel mr-st-flow" data-group={group.groupId}>
      <header className="mr-st-watch-head">
        <div className="mr-st-watch-title">
          <h2 className="mr-st-h2">{t('flow.groupStatic', { group: group.groupId })}</h2>
          <p className="mr-st-sub">{t('flow.subtitle')}</p>
        </div>
        <p className="mr-st-flow-total">
          <span className="mr-st-flow-total-label">{t('flow.card.saved')}</span>
          <span className="mr-num mr-st-flow-total-figure">{fmtDollars(group.savedPerDayM)}</span>
          <span className="mr-st-pv-unit">{t('units.perDay')}</span>
        </p>
      </header>
      <div className="mr-st-flow-frame" ref={frameRef} style={fit}>
        {layout ? (
          <FlowDiagram
            layout={layout}
            selection={null}
            pinned={false}
            onHover={() => undefined}
            onPin={() => undefined}
            ariaLabel={t('flow.mapAria', { group: group.groupId })}
            tweenMs={0}
          />
        ) : null}
      </div>
    </section>
  );
}

// ─── The Meter and the receipt bar ───────────────────────────────────────────

function ReceiptStage() {
  const { snapshot } = useStoryData();
  if (!snapshot) return null;
  const h = snapshot.headline;
  // The percentage names its basis the Receipt's way (hover and screen reader): a share of dollars, month to date.
  const basis = t('receipt.savedPctBasis', { period: PERIOD_CAPTION.mtd() });
  // The bar adds up to the Meter above it in whole dollars, as the captions say it (core/format.ts footMoney):
  // would have paid and saved as printed, paid their difference.
  const paidShownM = footMoney({ whpM: h.whpMtdM, paidM: h.paidMtdM, savedM: h.mtdM }).paidM;
  return (
    <div className="mr-st-receipt-frame">
      <span className="mr-st-receipt-shadow" aria-hidden="true" />
      <section className="mr-st-panel mr-st-receipt">
        <HeroFigure snapshot={snapshot} />
        <div className="mr-st-rbar">
          <ReceiptBar whpM={h.whpMtdM} paidM={paidShownM} savedM={h.mtdM} ratio={h.ratioMtd} basis={basis} />
        </div>
      </section>
    </div>
  );
}

// ─── A change ships · watching ───────────────────────────────────────────────

/**
 * The shipped commit as this play shows it: the engine moves every timestamp onto the wall clock, so the
 * document's own copy (fixture time) is only the key; the times come from the rebased script step.
 */
function shownCommit(engine: TourEngine | null, hash: string): Commit | undefined {
  const step = engine?.current()?.script.find((s) => s.action === 'commit' && (s.payload as Commit | null)?.hash === hash);
  return step ? (step.payload as Commit) : undefined;
}

function WatchStage({ doc, pos, engine, reducedMotion }: StageProps) {
  const { snapshot, settings } = useStoryData();
  const incident = storyIncident(doc);
  const shipped = storyCommit(doc);
  if (!snapshot || !incident || !shipped) return null;
  const flow = flowOf(snapshot.flows, incident.objectKey);
  const landed = snapshot.timeline.find((c) => c.hash === shipped.hash);
  const change = landed ?? shownCommit(engine, shipped.hash);
  const tz = settings.displayTimezone;
  const changeMs = ms(change?.deployedAt ?? change?.committedAt);
  // The scene's later beat ("watching"): the after-the-change minutes draw in over its first half.
  const watching = pos.runStart !== pos.index;
  const reveal = !watching ? 0 : reducedMotion ? 1 : Math.min(1, Math.max(0, (pos.tInBeat - 0.4) / (pos.beat.seconds * 0.55)));
  const label = incident.label || flow?.pipelineId || '';
  const commit = landed ?? null;
  // P2-W12: while it watches, a clock runs from the deploy to the moment the alert lands: the fixture's own
  // caught-in, told over the beat, at 2:51 on its last frame, the figure the card, the Slack message and the
  // summary then carry. Reduced motion: the final figure.
  const caught = incident.caughtInSec ?? 0;
  const clockP = !watching ? 0 : reducedMotion ? 1 : Math.min(1, Math.max(0, pos.tInBeat / Math.max(0.1, pos.beat.seconds - 0.1)));
  const clock = watching && caught > 0 ? fmtDuration(Math.floor(clockP * caught)) : null;
  return (
    <section className="mr-st-panel mr-st-watch">
      <header className="mr-st-watch-head">
        <div className="mr-st-watch-title">
          <h2 className="mr-st-h2">{label}</h2>
          <p className="mr-st-sub">{t('ledger.timeline.legendRatio')}</p>
        </div>
        <div className="mr-st-watch-meta">
          {commit ? (
            <p className="mr-st-commit" data-landed="true">
              <GitAlt size="md" aria-hidden />
              <span className="mr-st-commit-text">
                {renderTemplate(t('incidents.commitShort'), {
                  hash: <code className="mr-st-hash">{shortHash(commit.hash)}</code>,
                  message: <span className="mr-st-commit-message">{commit.message}</span>,
                  author: <span className="mr-st-commit-author">{commitAuthor(commit.author)}</span>,
                })}
              </span>
              <span className="mr-st-commit-when">{t('incidents.deployedAt', { time: formatClockTime(changeMs, tz, true) })}</span>
            </p>
          ) : null}
          {clock !== null ? (
            <p className="mr-st-watch-clock" data-done={clockP >= 1 ? 'true' : 'false'}>
              <ClockOutlined size="md" aria-hidden />
              <span>
                {renderTemplate(t('story.watchClock'), {
                  duration: <span className="mr-num mr-st-watch-clock-time">{clock}</span>,
                })}
              </span>
            </p>
          ) : null}
        </div>
      </header>
      <RatioWatch
        values={flow?.sparkline ?? []}
        endMs={ms(snapshot.windowEnd)}
        changeMs={changeMs}
        landed={!!landed}
        reveal={reveal}
        baseline={incident.before}
        lossLabel={t('story.watchLoss', { perDay: impactFigures(incident).perDay })}
        tz={tz}
        label={t('ledger.timeline.legendRatio')}
      />
    </section>
  );
}

// ─── Slack ───────────────────────────────────────────────────────────────────

function channelName(settings: Settings, endpointId: string | undefined): string | undefined {
  return settings.notifications.find((e) => e.id === endpointId)?.name;
}

function SlackFrame({ channel, children }: { channel?: string; children: ReactNode }) {
  return (
    <div className="mr-st-slack">
      {channel ? (
        <p className="mr-st-slack-channel">
          <Hashtag size="sm" aria-hidden />
          <span>{channel}</span>
        </p>
      ) : null}
      {children}
    </div>
  );
}

function SlackStage({ doc }: StageProps) {
  const { snapshot, settings } = useStoryData();
  const id = storyIncident(doc)?.id;
  const incident: Incident | undefined = snapshot?.incidents.find((i) => i.id === id);
  const tz = settings.displayTimezone;
  const labels = settings.humanize;
  const delivery = incident?.deliveries.find(isDelivered);
  const message = useMemo(
    () =>
      incident
        ? slackPayload(canonicalPayload('incident.opened', { incident, workspace: '', linkBase: '', labels, sentAt: delivery?.at }), { tz, labels })
        : null,
    [incident, delivery?.at, tz, labels],
  );
  if (!incident || !message) return null;
  return (
    <SlackFrame channel={channelName(settings, delivery?.endpointId)}>
      <SlackPreview message={message} time={formatClockTime(ms(delivery?.at ?? incident.openedAt), tz)} />
    </SlackFrame>
  );
}

// ─── Monday's receipt ────────────────────────────────────────────────────────

/** "Mon 7:00 AM": the automatic send (Monday 12:00 UTC, DECISIONS D12b) in the display timezone. */
function mondaySend(periodEndIso: string, tz: string): string {
  const end = ms(periodEndIso);
  if (!Number.isFinite(end)) return '';
  const d = new Date(end);
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12);
  try {
    return new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz }).format(at);
  } catch {
    return formatClockTime(at, tz);
  }
}

/**
 * P2-W12: Monday's receipt prints a line at a time from PRINT_START, one per PRINT_STEP, its total last — done by
 * about 4.5 s for the receipt's fifteen lines (the builder's sign-off included), before the "saved last week"
 * callout at 4.6 s (src/story/beats.ts). The step was 0.35 s for thirteen lines; the sign-off's two lines keep the
 * same finish by printing a little faster.
 */
const PRINT_START = 0.3;
const PRINT_STEP = 0.3;

function WeeklyStage({ engine, pos, reducedMotion }: StageProps) {
  const { settings } = useStoryData();
  const tz = settings.displayTimezone;
  const receipt = engine?.weeklyReceipt();
  if (!receipt) return null;
  const message = slackPayload(canonicalPayload('receipt.weekly', { receipt, workspace: '', linkBase: '', sentAt: receipt.periodEnd }), { tz });
  const channel = settings.notifications.find((e) => e.weeklyReceipt && e.enabled)?.name;
  return (
    <SlackFrame channel={channel}>
      <SlackPreview
        message={message}
        time={mondaySend(receipt.periodEnd, tz)}
        callout="slack-receipt"
        revealLines={reducedMotion ? undefined : Math.max(0, Math.floor((pos.tInBeat - PRINT_START) / PRINT_STEP) + 1)}
      />
    </SlackFrame>
  );
}

// ─── Summary ─────────────────────────────────────────────────────────────────

function SummaryStage({ doc, pos, reducedMotion }: StageProps) {
  const caughtIn = fmtDuration(storyIncident(doc)?.caughtInSec ?? 0);
  const lines = [t('story.summary.line1'), t('story.summary.line2', { caughtIn }), t('story.summary.line3'), t('story.summary.line4')];
  // One line a second (all at once under reduced motion).
  const shown = reducedMotion ? lines.length : Math.min(lines.length, Math.floor(pos.tInBeat / 0.9) + 1);
  return (
    <div className="mr-st-summary">
      <p className="mr-st-kicker">
        <Credit copyKey="credit.signature" testId="story-summary-credit" />
      </p>
      <ol className="mr-st-summary-list">
        {lines.map((line, i) => (
          <li key={i} className="mr-st-summary-line" data-shown={i < shown ? 'true' : 'false'} style={{ '--mr-st-i': i } as CSSProperties}>
            <span className="mr-st-check" aria-hidden="true">
              <CheckOutlined size="md" aria-hidden />
            </span>
            <span>{line}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ─── The ask ─────────────────────────────────────────────────────────────────
//
// The payoff, once more, over the code (P1-C05): the figure the hook opened on, at the presenter's period and in
// its words, where the name used to sit a third time (the wordmark and the caption already say it).

function AskStage() {
  const { snapshot, settings } = useStoryData();
  // D58: the code goes where the ask's words do (the Cribl Innovators Network), unless a member set another link.
  const url = askQrUrl(settings.presenter?.qrUrl);
  const period: HeadlinePeriod = settings.presenter?.headlinePeriod ?? 'annualized';
  const figure = snapshot ? periodFigure(snapshot.headline, period) : null;
  return (
    <div className="mr-st-ask">
      {snapshot && figure ? (
        <div className="mr-st-ask-payoff">
          <p className="mr-st-kicker">{t('meter.caption')}</p>
          <p className="mr-st-ask-figure mr-num">{fmtDollars(figure.valueM)}</p>
          <p className="mr-st-ask-basis">{periodBasis(period, snapshot.headline)}</p>
        </div>
      ) : null}
      <div className="mr-st-ask-qr">
        <QrBlock url={url} layout="stack" showUrl />
      </div>
    </div>
  );
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

export function Stage(props: StageProps) {
  switch (props.pos.beat.view) {
    case 'title':
      return <TitleStage />;
    case 'how':
      return <HowStage {...props} />;
    case 'receipt':
      return <ReceiptStage />;
    case 'flow':
      return <FlowStage {...props} />;
    case 'ledger':
      return <WatchStage {...props} />;
    case 'slack':
      return <SlackStage {...props} />;
    case 'receipt-weekly':
      return <WeeklyStage {...props} />;
    case 'summary':
      return <SummaryStage {...props} />;
    case 'ask':
      return <AskStage />;
    case 'presenter':
    default:
      return <HeroStage {...props} />;
  }
}
