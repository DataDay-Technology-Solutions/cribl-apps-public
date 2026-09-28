// src/views/Flow/FlowScreen.tsx — the Flow view (/flow, PRD 8.2) and the What-if view (/whatif, DESIGN_BRIEF
// 5.9) share one screen: a header (title, subtitle, worker-group selector), the What-if calculator when it is
// on, and the Flow map — live, or morphing to the projected after-state.
//
// Every state is designed (PRD 8.8 item 7), each in the map's own two-card frame over a grey Sankey (P1-I07):
// loading, unreadable snapshot (ErrorNotice; a rate limit counts down to the next read), no sweep yet, nothing
// priced ("Set a price to see dollars on this map"), priced but no traffic in the group.

import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, SelectField, type Key } from '@capra/core';
import { EmptyBlock } from '../../components/common/EmptyBlock.tsx';
import { Page } from '../../components/Shell/Page.tsx';
import { ErrorNotice } from '../../components/common/ErrorNotice.tsx';
import { FlowMap } from '../../components/FlowDiagram/FlowMap.tsx';
import { isDrawable, ribbonId, type WeightBy } from '../../components/FlowDiagram/layout.ts';
import { WhatIfPanel } from '../../components/WhatIf/WhatIfPanel.tsx';
import { WhatIfSkeleton } from '../../components/WhatIf/WhatIfSkeleton.tsx';
import { useWhatIf } from '../../components/WhatIf/useWhatIf.ts';
import { t } from '../../copy/en.ts';
import { hrefWithStickyParams, useAppParams } from '../../lib/params.ts';
import { useShortcut } from '../../lib/shortcuts.ts';
import { useStageScale } from '../../components/FlowDiagram/hooks.ts';
import { useAppState } from '../../state/react.tsx';
import { FlowStage } from './FlowStage.tsx';
import { FlowStateFrame } from './FlowStates.tsx';
import { WhatIfBar } from './WhatIfBar.tsx';
import { whatIfBasisLine } from './whatIfBasis.ts';
import { groupsOf } from './groups.ts';
import './FlowScreen.css';

export type FlowScreenMode = 'flow' | 'whatif';

export function FlowScreen({ mode }: { mode: FlowScreenMode }) {
  const navigate = useNavigate();
  const [params, setParams] = useAppParams();
  const [search, setSearch] = useSearchParams();
  const snapshot = useAppState((s) => s.snapshot);
  const prices = useAppState((s) => s.prices);
  const humanize = useAppState((s) => s.settings.humanize);
  const displayTimezone = useAppState((s) => s.settings.displayTimezone);
  const phase = useAppState((s) => s.status.hydrate.phase);
  const snapshotError = useAppState((s) => s.errors.snapshot);
  const lastOkAt = useAppState((s) => s.status.live.lastOkAt);
  // A 429 counts down to the tab's next read (DESIGN_BRIEF 6), as the Receipt does; read only while rate limited.
  const nextPollAt = useAppState((s) => (s.errors.snapshot?.kind === 'rate-limited' ? s.status.live.nextPollAt : undefined));
  const backoffUntil = useAppState((s) => (s.errors.snapshot?.kind === 'rate-limited' ? s.status.live.backoffUntil : undefined));
  const nextSweepAt = nextPollAt !== undefined && Number.isFinite(nextPollAt) ? nextPollAt : backoffUntil;

  const groups = useMemo(() => groupsOf(snapshot), [snapshot]);
  const groupId = params.group && groups.includes(params.group) ? params.group : (groups[0] ?? 'default');
  const whatIfOn = mode === 'whatif' || search.get('whatif') === '1';
  const model = useWhatIf(snapshot, groupId);

  const groupFlows = useMemo(() => (snapshot ? snapshot.flows.filter((f) => f.groupId === groupId) : []), [snapshot, groupId]);
  const colorOrder = useMemo(() => (snapshot ? [...new Set(snapshot.destinations.map((d) => d.outputId))].sort() : []), [snapshot]);
  const projecting = whatIfOn && model.projectedFlows !== null;
  const mapFlows = projecting ? model.projectedFlows! : groupFlows;
  // P2-W02: ?weight=bytes draws the map the way Cribl Insights does; dollars is the default and the What-if's only
  // width (its calculator is in dollars). The URL holds it, so it survives a reload and a shared link.
  const weightBy: WeightBy = mode === 'flow' && !projecting && search.get('weight') === 'bytes' ? 'bytes' : 'dollars';
  const setWeightBy = (next: WeightBy) =>
    setSearch(
      (current) => {
        const params = new URLSearchParams(current);
        if (next === 'bytes') params.set('weight', 'bytes');
        else params.delete('weight');
        return params;
      },
      { replace: true },
    );

  // The What-if morph and the bytes ↔ dollars toggle are user-initiated and ease over 400 ms; a new snapshot re-scales.
  const morphKey = `${whatIfOn}|${model.stream?.key ?? ''}|${model.treatmentKey}|${model.dropPct}|${projecting}|${weightBy}`;

  // P2-W10: ?stage=1 (or F) puts the map on stage — the whole viewport, labels at projector size, the receipt as a
  // strip. P or Escape comes back (above the Shell's P, which would open the presenter's own stage on '/').
  const stage = mode === 'flow' && !whatIfOn && search.get('stage') === '1';
  const stageScale = useStageScale(stage);
  const setStage = (on: boolean) =>
    setSearch(
      (current) => {
        const params = new URLSearchParams(current);
        if (on) {
          params.set('stage', '1');
          params.delete('whatif');
        } else params.delete('stage');
        return params;
      },
      { replace: true },
    );
  useShortcut('P', () => setStage(false), stage, 2);
  useShortcut('Escape', () => setStage(false), stage, 2);
  useShortcut('F', () => setStage(true), mode === 'flow' && !stage);
  // back from the stage, the keyboard lands on the button that opened it
  const wasStage = useRef(stage);
  useEffect(() => {
    if (wasStage.current && !stage) document.querySelector<HTMLElement>('[data-testid="flow-stage-enter"] button')?.focus();
    wasStage.current = stage;
  }, [stage]);

  const title = mode === 'whatif' ? t('whatif.title') : t('flow.title');
  const subtitle = mode === 'whatif' ? t('whatif.subtitle') : weightBy === 'bytes' ? t('flow.subtitleBytes') : t('flow.subtitle');
  const ledgerHref = hrefWithStickyParams('/ledger', search);
  // the full calculator, on this stream and treatment
  const calculatorHref = (() => {
    const href = new URLSearchParams(hrefWithStickyParams('/whatif', search).split('?')[1] ?? '');
    for (const key of ['stream', 'treatment', 'drop']) {
      const value = search.get(key);
      if (value !== null) href.set(key, value);
    }
    const query = href.toString();
    return query ? `/whatif?${query}` : '/whatif';
  })();
  const pricesHref = hrefWithStickyParams('/settings/prices', search);

  const anyDrawable = snapshot ? snapshot.flows.some(isDrawable) : false;
  const groupDrawable = groupFlows.some(isDrawable);

  // Nothing is priced: the meter waits for prices (no sweep runs before them), so this state comes first.
  const unpriced = (
    <FlowStateFrame state="unpriced" testId="flow-empty-unpriced">
      <EmptyBlock title={t(mode === 'whatif' ? 'whatif.empty' : 'flow.empty')} description={t(mode === 'whatif' ? 'whatif.emptyBody' : 'flow.emptyBody')} ghost={false} size="lg">
        <Button variant="primary" onPress={() => navigate(pricesHref)}>
          {t('flow.setPrices')}
        </Button>
      </EmptyBlock>
    </FlowStateFrame>
  );

  let body: ReactNode;
  if (!snapshot && (phase === 'idle' || phase === 'loading')) {
    // the What-if's own skeleton on /whatif (P1-J04); the map's frame on /flow (P1-I07)
    body = mode === 'whatif' ? <WhatIfSkeleton /> : <FlowStateFrame state="loading" />;
  } else if (snapshotError && !snapshot) {
    body = (
      <FlowStateFrame state="error">
        <ErrorNotice error={snapshotError} section={t('flow.title')} lastGoodAt={lastOkAt} nextSweepAt={nextSweepAt} layout="inline" />
      </FlowStateFrame>
    );
  } else if (!snapshot && prices === null) {
    body = unpriced;
  } else if (!snapshot) {
    body = (
      <FlowStateFrame state="no-data">
        <EmptyBlock title={t('empty.noData')} description={t('empty.noDataBody')} ghost={false} size="lg" />
      </FlowStateFrame>
    );
  } else if (!anyDrawable && (prices === null || (snapshot.destinations.length > 0 && snapshot.destinations.every((d) => d.unpriced || d.milliCentsPerGb === 0)))) {
    // (No destinations at all is a workspace with no traffic yet, not an unpriced one: OQ-09.)
    body = unpriced;
  } else if (!groupDrawable) {
    body = (
      <FlowStateFrame state="no-traffic">
        <EmptyBlock title={t('flow.noTrafficTitle', { group: groupId })} description={t('flow.noTrafficBody')} ghost={false} size="lg" />
      </FlowStateFrame>
    );
  } else {
    body = (
      <>
        {snapshotError ? <ErrorNotice error={snapshotError} section={t('flow.title')} lastGoodAt={lastOkAt} nextSweepAt={nextSweepAt} layout="inline" /> : null}
        {/* /whatif is the calculator; on /flow the What-if is one compact bar over the same map (P1-I06) */}
        {mode === 'whatif' ? <WhatIfPanel model={model} humanizeOverrides={humanize} headingId="mr-flowview-title" /> : null}
        {mode === 'flow' && whatIfOn ? <WhatIfBar model={model} humanizeOverrides={humanize} calculatorHref={calculatorHref} /> : null}
        <FlowMap
          flows={mapFlows}
          groupId={groupId}
          colorOrder={colorOrder}
          humanize={humanize}
          projection={projecting}
          liveFlows={projecting ? groupFlows : undefined}
          focusRibbonId={projecting && model.stream ? ribbonId(model.stream.flow) : undefined}
          focusCaption={projecting && mode === 'flow' ? whatIfBasisLine(model) : undefined}
          morphKey={morphKey}
          ledgerHref={ledgerHref}
          settingsHref={pricesHref}
          unpricedOutputIds={snapshot.unpricedOutputIds}
          weightBy={weightBy}
          onWeightBy={mode === 'flow' && !projecting ? setWeightBy : undefined}
          incidents={snapshot.incidents}
          destinations={snapshot.destinations}
          timeZone={displayTimezone}
          pinObject={params.object}
          stage={
            stage
              ? {
                  scale: stageScale,
                  header: (
                    <header className="mr-flowstage-head">
                      <p className="mr-flowstage-eyebrow">{t('flow.stage.eyebrow', { group: groupId })}</p>
                      <p className="mr-flowstage-subtitle" data-testid="flow-subtitle">
                        {subtitle}
                      </p>
                    </header>
                  ),
                  footer: (
                    <div className="mr-flowstage-leave" data-testid="flow-stage-leave">
                      <Button variant="tertiary" size="sm" onPress={() => setStage(false)} aria-keyshortcuts="P Escape">
                        {t('flow.stage.leave')}
                      </Button>
                    </div>
                  ),
                }
              : undefined
          }
        />
      </>
    );
  }

  if (stage) return <FlowStage label={t('flow.stage.aria', { group: groupId })}>{body}</FlowStage>;

  const groupItems = groups.map((g) => ({ id: g, label: g }));
  // The one page frame (Shell Page, BEAUTY F7): title, subtitle and the actions row come from it.
  return (
    <Page
      className="mr-flowview"
      title={title}
      titleId="mr-flowview-title"
      subtitle={<span data-testid="flow-subtitle">{subtitle}</span>}
      data-testid={mode === 'whatif' ? 'whatif-view' : 'flow-view'}
      data-group={groupId}
      actions={
        <div className="mr-flowview-actions">
          {groups.length > 1 ? (
            <div className="mr-flowview-group">
              <SelectField
                label={t('flow.group')}
                layout="horizontal"
                size="sm"
                items={groupItems}
                value={groupId}
                onChange={(k: Key | null) => k !== null && setParams({ group: String(k) })}
              />
            </div>
          ) : groups.length === 1 ? (
            <span className="mr-flowview-group-static">{t('flow.groupStatic', { group: groupId })}</span>
          ) : null}
          {mode === 'flow' && snapshot && anyDrawable ? (
            // P2-W10: the map on stage (F)
            <span className="mr-flowview-present" data-testid="flow-stage-enter">
              <Button variant="secondary" size="sm" onPress={() => setStage(true)} aria-keyshortcuts="F">
                {t('flow.stage.enter')}
              </Button>
            </span>
          ) : null}
          {mode === 'flow' && snapshot && anyDrawable ? (
            // One toggle (P1-I06): the same secondary button at rest and on, its state in aria-pressed and a pressed
            // style, never a 14 px link that turns into an outlined button with another name.
            <span className="mr-flowview-whatif" data-testid="flow-whatif-toggle">
              <Button
                variant="secondary"
                size="sm"
                onPress={() =>
                  setSearch(
                    (current) => {
                      const next = new URLSearchParams(current);
                      if (whatIfOn) next.delete('whatif');
                      else next.set('whatif', '1');
                      return next;
                    },
                    { replace: true },
                  )
                }
                aria-pressed={whatIfOn}
              >
                {t('flow.whatIfToggle')}
              </Button>
            </span>
          ) : null}
        </div>
      }
    >
      {body}
    </Page>
  );
}
