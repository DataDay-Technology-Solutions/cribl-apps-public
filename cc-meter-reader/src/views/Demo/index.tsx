// src/views/Demo/index.tsx — the Demo Console (`/demo`; PRD 8.7, DESIGN_BRIEF 5.7, SPEC 11 / 13 / 17).
// DEMO BUILD ONLY: src/router.tsx imports this chunk inside an inline `VITE_MR_BUILD === 'demo'` branch,
// so the release bundle contains none of it.
//
// Phone-first (390 px): the status line is pinned at the top with a one-line "Projector: $… · no alert" strip
// under it, one column, every button ≥ 48 px, the incident card fits without scrolling, and the payoff lever
// sits in a bar at the bottom under the thumb: Break the trim, then the countdown to the alert, then Restore
// (EPIC_AUDIT P2-W18). When an alert lands while the console is open the phone buzzes once and the status line
// flashes for 1.2 s. On a laptop the content lays out in columns with key hints on the levers (the lever keys
// work on every view once the runtime is installed; see src/demo/install.ts), and the status line sits in the
// header row to the right of the title (BEAUTY F15): two columns (Tools under Scenes) from 1024 px, three
// (Tools on its own) from 1440 px, so every lever and tool is above the fold of a 1440 × 900 laptop (P1-L02).
//
// Every lever and scene start asks first (src/demo/actions.tsx). A scene another console left in demo/state
// is never resumed on mount (REVIEW-3a #8): the console asks "Resume / Abandon and restore", and a scene
// that has not moved for 30 minutes is shown as abandoned, with nothing restored automatically.
//
// Page frame: the Shell's <Page> (BEAUTY F7) — the same width, left edge and h1 as every other tab. The status
// line is a direct child of the page (not inside its title row), so it can stay pinned on phones; on desktop
// DemoConsole.css places it in the title row's right-hand column.

import { useCallback, useLayoutEffect, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Skeleton } from '@capra/core';
import { t } from '../../copy/en.ts';
import { IS_DEMO_BUILD } from '../../lib/env.ts';
import { useNow } from '../../lib/ticker.ts';
import { useAppParams } from '../../lib/params.ts';
import { notify } from '../../components/common/notify.tsx';
import { ErrorNotice } from '../../components/common/ErrorNotice.tsx';
import { Page } from '../../components/Shell/Page.tsx';
import { deriveDataStatus } from '../../components/Shell/status.ts';
import { shallowEqual, useActions, useAppState } from '../../state/react.tsx';
import { useClientStatus, useDemoRuntime, useRunnerState } from '../../demo/install.ts';
import { focusIncident, nextAlert, projectorLine, rateState, remoteLever, stageTakeover, streamStates, trimLever, trimState } from '../../demo/derive.ts';
import { abandonItems, alertEta } from '../../demo/confirm.ts';
import { RIG_GROUP_ID } from '../../../core/demo/rig-ids.ts';
import { leftScene, type SceneName } from '../../demo/scenes.ts';
import { StatusBar } from './StatusBar.tsx';
import { AlertSlot, BottomBar, LeftScenePrompt, LeversPanel, ProjectorStrip, ScenesPanel, ToolsPanel } from './panels.tsx';
import { useIncidentCue } from './useIncidentCue.ts';
import { LeverLedger } from './LeverLedger.tsx';
import { ProjectorPanel } from './ProjectorPanel.tsx';
import { leverLedger } from '../../demo/ledger.ts';
import './DemoConsole.css';

export default function DemoView() {
  if (!IS_DEMO_BUILD) return null;
  return <DemoGate />;
}

/**
 * Nothing about demo mode is known until settings are hydrated: show the console's shape meanwhile (never a
 * false "Demo mode is off"), and the settings read error if hydration failed.
 */
function DemoGate() {
  const gate = useAppState((s) => ({ hydrated: s.hasHydrated, phase: s.status.hydrate.phase, error: s.errors.settings }), shallowEqual);
  const { refresh } = useActions();
  if (gate.hydrated) return <DemoConsole />;
  if (gate.phase === 'error' && gate.error) {
    return (
      <Page className="mr-demo" title={t('demo.title')} data-testid="demo-console-error">
        <ErrorNotice error={gate.error} section={t('nav.settings')} onRetry={() => void refresh()} />
      </Page>
    );
  }
  return <DemoSkeleton />;
}

/** Static (no shimmer) placeholder in the console's own layout. */
function DemoSkeleton() {
  return (
    <Page className="mr-demo" title={t('demo.title')} aria-busy="true" aria-label={t('common.loading')} data-testid="demo-loading">
      <div className="mr-demo-status">
        <Skeleton title={{ width: '45%' }} paragraph={{ rows: 1, width: ['70%'] }} />
      </div>
      <div className="mr-demo-grid">
        <div className="mr-demo-col mr-demo-col--main">
          <div className="mr-demo-panel">
            <Skeleton title paragraph={{ rows: 2 }} />
          </div>
          <div className="mr-demo-panel">
            <Skeleton title paragraph={{ rows: 4 }} />
          </div>
        </div>
        <div className="mr-demo-col mr-demo-col--side">
          <div className="mr-demo-panel">
            <Skeleton title paragraph={{ rows: 5 }} />
          </div>
        </div>
        <div className="mr-demo-col mr-demo-col--tools">
          <div className="mr-demo-panel">
            <Skeleton title paragraph={{ rows: 4 }} />
          </div>
        </div>
      </div>
    </Page>
  );
}

function DemoConsole() {
  const runtime = useDemoRuntime();
  const { client, runner, actions: demo } = runtime;
  const app = useActions();
  const navigate = useNavigate();
  const [, setParams] = useAppParams();
  const now = useNow();
  const clientStatus = useClientStatus(client);
  const runnerState = useRunnerState(runner);

  const view = useAppState(
    (s) => ({
      snapshot: s.snapshot,
      demoState: s.demoState,
      settings: s.settings,
      source: s.source,
      hasHydrated: s.hasHydrated,
      lastSweepAt: s.snapshot?.sweepAt ?? s.meta?.lastSweepAt,
    }),
    shallowEqual,
  );
  const dataStatus = useAppState((s) => deriveDataStatus(s, now));

  const enabled = view.settings.demo.enabled;
  const live = view.source === 'live';
  const remote = remoteLever(view.demoState, now, clientStatus.busy);
  const leversDisabled = !enabled || !live || !view.hasHydrated || clientStatus.busy || Boolean(remote);
  // The scene this tab drives (it started it, or a person chose Resume) — else one left in demo/state, which
  // waits for a person's choice: nothing here adopts it on mount.
  const persisted = view.demoState?.scene;
  const scene = runnerState.owned ? runnerState.scene : null;
  const left = !scene && live && persisted && !runner.isEnded(persisted.startedAt) ? leftScene(persisted, now) : undefined;
  const streams = streamStates(view.demoState, view.snapshot);
  const trim = trimState(view.demoState, view.snapshot);
  const rate = rateState(view.demoState);
  const focus = focusIncident(view.snapshot, now);
  const next = nextAlert(view.demoState, view.snapshot, now);
  const lever = trimLever(view.demoState, view.snapshot, now);
  const projector = projectorLine(view.snapshot, view.settings.presenter?.headlinePeriod, now);
  const takeover = stageTakeover(view.snapshot, now);
  const flash = useIncidentCue(view.snapshot);
  const eta = alertEta(view.demoState);
  const lag = eta.sec;
  const openAlerts = view.snapshot?.incidents.filter((i) => !i.closedAt).length ?? view.snapshot?.openIncidents ?? 0;
  // The last five levers: the shared timeline (every device's levers) plus this tab's own, at once.
  const ledger = leverLedger(view.snapshot?.timeline, clientStatus.recent, view.snapshot?.incidents);

  const onReplay = useCallback(
    async (on: boolean) => {
      // A replay on screen blocks settings writes (sample data is never written back); step out of it first.
      if (!on && view.source !== 'live') app.clearSample();
      const current = view.settings;
      const result = await app.saveSettings({
        ...current,
        demo: { ...current.demo, replayMode: on },
      });
      if (!result.ok)
        notify.error(
          t('demo.replaySaveFailed', {
            reason: result.error?.message ?? result.reason,
          }),
        );
    },
    [app, view.settings, view.source],
  );

  const onStart = useCallback((name: SceneName) => void demo.startScene(name), [demo]);
  useStickyTop();
  // The incident card carries the demo-profile note; only the 3-minute default earns a line under the title.
  const subtitle: ReactNode = (
    <>
      <span className="mr-demo-subtitle-text">{t('demo.subtitle')}</span>
      {view.settings.demo.profile ? null : <span className="mr-demo-profile">{t('demo.profileOff')}</span>}
    </>
  );

  return (
    <Page className="mr-demo" title={t('demo.title')} subtitle={subtitle} data-testid="demo-console">
      {/* A direct child of the page, so it stays pinned on phones (sticky) and sits beside the title on desktop. */}
      <StatusBar
        dataStatus={dataStatus}
        lastSweepAt={view.lastSweepAt}
        openAlerts={openAlerts}
        client={clientStatus}
        remote={remote}
        nowMs={now}
        flash={flash}
        onCancelRetry={() => client.cancelRetry()}
      />
      {live ? <ProjectorStrip line={projector} /> : null}

      {!enabled ? (
        <div className="mr-demo-panel mr-demo-off" data-testid="demo-off">
          <p className="mr-demo-off-title">{t('demo.disabledTitle')}</p>
          <p className="mr-type-caption">{t('demo.disabledOff')}</p>
          <div className="mr-demo-actions-1">
            <Button variant="primary" size="xl" onPress={() => void navigate('/settings/demo')}>
              {t('demo.openSettings')}
            </Button>
          </div>
        </div>
      ) : !live ? (
        <div className="mr-demo-panel mr-demo-off" data-testid="demo-sample">
          <p className="mr-type-caption">{t('demo.sampleOff')}</p>
        </div>
      ) : null}

      {left ? (
        <LeftScenePrompt
          left={left}
          nowMs={now}
          restores={abandonItems(left.scene, {
            demoState: view.demoState,
            weeklyEndpoints: [],
            groupId: RIG_GROUP_ID,
          })}
          disabled={!enabled || clientStatus.busy || Boolean(remote)}
          onResume={() => demo.resumeScene()}
          onAbandon={() => void demo.abortScene()}
          onDismiss={() => void demo.dismissScene()}
        />
      ) : null}

      <div className="mr-demo-grid">
        <div className="mr-demo-col mr-demo-col--main">
          {/* What the room sees, on the laptop (the phone has the one-line strip under the status). */}
          {live ? (
            <ProjectorPanel
              snapshot={view.snapshot}
              settings={view.settings}
              scene={view.demoState?.scene}
              takeover={takeover}
              next={next}
              eta={eta}
              nowMs={now}
            />
          ) : null}
          <AlertSlot focus={focus} next={next} measuredLagSec={lag} eta={eta} nowMs={now} />
          <ScenesPanel
            scene={scene}
            owned={runnerState.owned}
            aborting={runnerState.aborting}
            {...(runnerState.failed ? { failed: runnerState.failed } : {})}
            {...(trim.brokenAtMs !== undefined ? { brokenAtMs: trim.brokenAtMs } : {})}
            measuredLagSec={lag}
            nowMs={now}
            blocked={leversDisabled || Boolean(left)}
            onStart={onStart}
            onAbort={() => void demo.abortScene()}
          />
        </div>
        <div className="mr-demo-col mr-demo-col--side">
          <LeversPanel
            streams={streams}
            trim={trim}
            lever={lever}
            rate={rate}
            eta={eta}
            disabled={leversDisabled}
            onApply={(key) => void demo.applyPack(key)}
            onRevert={(key) => void demo.revertPack(key)}
            onAggressive={() => void demo.applyPack('windows_workstations', 'aggressive')}
            onRevertAll={() => void demo.revertAll()}
            onBreak={() => void demo.breakTrim()}
            onRestore={() => void demo.restore()}
            onSpike={() => void demo.spike()}
            onCalm={() => void demo.calm()}
          />
        </div>
        <div className="mr-demo-col mr-demo-col--tools">
          <ToolsPanel
            disabled={leversDisabled}
            replayOn={view.settings.demo.replayMode}
            replayDisabled={!view.hasHydrated || !enabled}
            onReset={() => void demo.resetAll()}
            onResetBaselines={() => void demo.resetBaselines()}
            onWeekly={() => void demo.weekly()}
            onReplay={(on) => void onReplay(on)}
            onPresenter={() => void navigate('/?present=1')}
            onTour={() => void navigate('/first-run')}
            onStory={() => setParams({ story: true })}
            onStoryLive={() => setParams({ story: 'live' })}
          />
        </div>
      </div>

      {live ? <LeverLedger entries={ledger} tz={view.settings.displayTimezone} labels={view.settings.humanize} /> : null}

      <BottomBar lever={lever} disabled={leversDisabled} onBreak={() => void demo.breakTrim()} onRestore={() => void demo.restore()} />
    </Page>
  );
}

/**
 * The status line pins just under the shell's sticky tab bar: measure the bar (it wraps on narrow frames)
 * and hand its height to CSS as --mr-demo-sticky-top.
 */
function useStickyTop() {
  useLayoutEffect(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="demo-console"]');
    const header = document.querySelector<HTMLElement>('.mr-shell-header');
    if (!root) return;
    const apply = () => root.style.setProperty('--mr-demo-sticky-top', `${header ? header.getBoundingClientRect().height : 0}px`);
    apply();
    if (!header || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(apply);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
}
