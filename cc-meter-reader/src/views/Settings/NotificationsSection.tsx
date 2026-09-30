// src/views/Settings/NotificationsSection.tsx — Where to send alerts (SPEC 5, 12, 12.5, 17; PRD 7;
// DECISIONS D23, D57).
//
// Two channels a member edits (core/delivery.ts):
//   • Cribl notifications (bell) — its own row at the top, on by default, nothing to set up. Stored in
//     settings only once the member changes it.
//   • Cribl notification target — a list endpoint storing only a target id. The id is typed; the list
//     (GET /notification-targets) is fetched only when the member presses "Load targets", whose note says
//     why: Cribl returns every target's full configuration, webhook URLs included, to the browser. The
//     App keeps only id/type/description. The relay a target needs is created by a confirmed "Connect"
//     (AGENTS.md), never automatically.
// Direct webhooks are not stored in any build (D57, hackathon rule 4.5: a webhook URL is a credential). The
// runner sends them from URLs in its own .env; the "Direct webhooks" note names the ones it reported in
// meta.deliveryWebhooks (names and hosts only).
// Up to 10 list endpoints. "Send a test alert" goes through the delivery router per channel
// (core/delivery.ts) and shows the exact result inline; a saved endpoint's `lastTest` is recorded on the
// stored settings (merged at write time, the member's other edits untouched). Removing a saved endpoint is
// confirmed, saved at once, reported. Below the list: the weekly receipt, with "Send the last 7 days now".
//
// EPIC_AUDIT WP-G2: a new endpoint shows no error until a field is left or Save is pressed (P1-G05); the section
// waits for the saved settings before it says anything about the list, the empty list is one compact line under
// the bell, and one description line precedes the first control (P1-G06).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@capra/core';
import { PaperPlane, Plus } from '@capra/icons';
import { createFetchHttp, type FetchLike } from '../../../core/http.ts';
import type { Settings } from '../../../core/types.ts';
import { createFetchWebhookSender } from '../../../core/adapters/webhook.ts';
import { RELAY_SAVED_SEARCH_ID, ensureRelay, listTargets, pickableTargets, relayNotificationId, relayState } from '../../../core/adapters/cribl-notify.ts';
import { linkBaseFrom, workspaceFromUrl } from '../../../core/runtime.ts';
import { t } from '../../copy/en.ts';
import { ConfirmModal } from '../../components/common/ConfirmModal.tsx';
import { LoadingBlock } from '../../components/common/Loading.tsx';
import {
  BellRow,
  CHANNEL_COPY,
  EndpointEditor,
  MAX_ENDPOINTS,
  applyEndpoints,
  bellDirty,
  bellFromSettings,
  cc,
  countEndpointErrors,
  createEndpointId,
  draftsFromSettings,
  endpointDirtyCount,
  endpointsDirty,
  isSaved,
  newEndpointDraft,
  visibleEndpointErrors,
  type BellDraft,
  type CriblChannelProps,
  type EndpointDraft,
  type EndpointField,
  type RelayView,
  type TargetsView,
  type TestResult,
  type TouchedFields,
} from '../../components/EndpointEditor/index.ts';
import { apiBaseUrl } from '../../lib/env.ts';
import { shallowEqual, useActions, useAppState } from '../../state/react.tsx';
import { SaveBar, SectionCard } from './shared.tsx';
import { reportWrite, useCurrentSettings, useSaveSettings, useWritable } from './hooks.ts';
import { WeeklyReceiptBlock } from './WeeklyReceiptBlock.tsx';

/** Where the test posts from (the payload's workspace and Ledger link), resolved once. */
function testOrigin(): { workspace: string; linkBase: string } {
  try {
    const abs = new URL(apiBaseUrl(), window.location.href).href;
    return { workspace: workspaceFromUrl(abs), linkBase: linkBaseFrom(abs, window.CRIBL_BASE_PATH) };
  } catch {
    return { workspace: '', linkBase: '' };
  }
}

/** CRIBL_API_URL for the Cribl channels ('' outside Cribl, where every call then fails visibly instead of throwing on render). */
function criblApiBase(): string {
  try {
    return apiBaseUrl();
  } catch {
    return '';
  }
}

/** Target ids typed by hand are checked once typing pauses. */
const RELAY_CHECK_DELAY_MS = 600;

export function NotificationsSection() {
  const writable = useWritable();
  const { saveSettings } = useActions();
  const stored = useAppState((s) => s.settings);
  const load = useAppState((s) => ({ hydrated: s.hasHydrated, live: s.source === 'live', phase: s.status.hydrate.phase }), shallowEqual);
  // Nothing about the list is said before the saved settings arrive (P1-G06): a workspace with three endpoints
  // must never read "No endpoints yet" first.
  const loading = load.live && !load.hydrated && load.phase !== 'error';
  const tz = stored.displayTimezone;
  const runnerWebhooks = useAppState((s) => s.meta?.deliveryWebhooks);
  // The sample tour's endpoints read as connected (founder-build r1 ui-7, m1): its alerts were handed to Cribl, and a
  // sample never asks the Leader about a relay.
  const sample = useAppState((s) => s.source !== 'live');
  const currentSettings = useCurrentSettings();
  const { save, saving } = useSaveSettings();

  // The list and the bell are drafts of their own; they follow the store until edited.
  const [drafts, setDrafts] = useState<EndpointDraft[]>(() => draftsFromSettings(stored));
  const [bell, setBell] = useState<BellDraft>(() => bellFromSettings(stored));
  const [baseline, setBaseline] = useState<Settings>(stored);
  if (baseline !== stored) {
    // Settings changed underneath (a save here or in another section): untouched drafts follow.
    setBaseline(stored);
    if (!bellDirty(bell, baseline)) setBell(bellFromSettings(stored));
    if (!endpointsDirty(drafts, baseline)) setDrafts(draftsFromSettings(stored));
    else {
      // Keep edits, refresh what the store owns for saved endpoints (lastTest after a test).
      setDrafts((list) =>
        list.map((d) => {
          const e = stored.notifications.find((n) => n.id === d.id);
          return e?.lastTest ? { ...d, lastTest: e.lastTest } : d;
        }),
      );
    }
  }

  // Which fields the member has left, per draft, and whether a Save attempt revealed every error (P1-G05).
  const [touched, setTouched] = useState<TouchedFields>({});
  const [revealAll, setRevealAll] = useState(false);
  const touch = useCallback(
    (id: string, field: EndpointField) =>
      setTouched((prev) => (prev[id]?.includes(field) ? prev : { ...prev, [id]: [...(prev[id] ?? []), field] })),
    [],
  );
  const resetValidation = () => {
    setTouched({});
    setRevealAll(false);
  };
  /** The draft id "Add endpoint" just created: its card scrolls into view and takes focus once rendered. */
  const added = useRef<string | null>(null);
  useEffect(() => {
    const id = added.current;
    if (!id) return;
    added.current = null;
    const el = document.querySelector<HTMLElement>(`[data-endpoint-id="${CSS.escape(id)}"]`);
    if (el) {
      el.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      el.focus({ preventScroll: true });
    }
  }, [drafts]);

  const [removing, setRemoving] = useState<EndpointDraft | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const origin = useMemo(() => testOrigin(), []);
  const sender = useMemo(() => createFetchWebhookSender(window.fetch as unknown as FetchLike), []);
  const http = useMemo(() => createFetchHttp({ fetch: window.fetch as unknown as FetchLike, baseUrl: criblApiBase() }), []);
  const testContext = useMemo(() => ({ ...origin, tz }), [origin, tz]);

  // ── Cribl notification targets: listed only when the member presses "Load targets" ──
  const [targets, setTargets] = useState<TargetsView>({ status: 'idle', targets: [] });
  const [relays, setRelays] = useState<Record<string, RelayView>>({});
  const loadingTargets = useRef(false);
  const loadTargets = useCallback(() => {
    if (loadingTargets.current) return;
    loadingTargets.current = true;
    setTargets({ status: 'loading', targets: [] });
    void listTargets(http)
      .then((r) =>
        setTargets(r.ok ? { status: 'ok', targets: pickableTargets(r.targets) } : { status: 'error', targets: [], errorStatus: r.status }),
      )
      .finally(() => {
        loadingTargets.current = false;
      });
  }, [http]);

  // Relay state for each chosen target id not checked yet (typed ids once typing pauses).
  const chosenIds = [...new Set(drafts.filter((d) => d.channel === 'cribl-target').map((d) => d.criblTargetId.trim()))].filter((id) => id !== '');
  const unchecked = chosenIds.filter((id) => !relays[id]).join('\n');
  useEffect(() => {
    if (!unchecked || sample) return;
    const ids = unchecked.split('\n');
    const known = new Set(targets.targets.map((tg) => tg.id));
    const delay = ids.every((id) => known.has(id)) ? 0 : RELAY_CHECK_DELAY_MS;
    const timer = setTimeout(() => {
      setRelays((prev) => ({ ...prev, ...Object.fromEntries(ids.map((id) => [id, { status: 'checking' } as RelayView])) }));
      for (const id of ids) {
        void relayState(http, id).then((s) => {
          const view: RelayView =
            s.state === 'ready' ? { status: 'ready' } : s.state === 'missing' ? { status: 'missing' } : { status: 'error', errorStatus: s.status };
          setRelays((prev) => ({ ...prev, [id]: view }));
        });
      }
    }, delay);
    return () => clearTimeout(timer);
  }, [unchecked, targets.targets, http, sample]);

  const cribl: CriblChannelProps = useMemo(
    () => ({
      http,
      targets,
      relayFor: (id: string) => (sample ? { status: 'ready' } : (relays[id] ?? { status: 'unknown' })),
      onConnect: (id: string) => setConnecting(id),
      onLoadTargets: loadTargets,
    }),
    [http, targets, relays, loadTargets, sample],
  );

  const { errors: allErrors, listError } = applyEndpoints(currentSettings(), drafts, bell);
  const errors = visibleEndpointErrors(drafts, allErrors, touched, revealAll);
  const dirtyCount = endpointDirtyCount(drafts, stored) + (bellDirty(bell, stored) ? 1 : 0);
  // The save bar counts only the errors on show: a fresh endpoint reads "1 unsaved change", not "Fix 2 fields".
  const fieldErrorCount = countEndpointErrors(errors) + (listError ? 1 : 0);
  const atLimit = drafts.length >= MAX_ENDPOINTS;
  const storedById = useMemo(() => new Map(draftsFromSettings(stored).map((d) => [d.id, d])), [stored]);
  const isDraftDirty = (d: EndpointDraft): boolean => {
    const saved = storedById.get(d.id);
    return !saved || endpointsDirty([d], { ...stored, notifications: stored.notifications.filter((n) => n.id === d.id) });
  };

  const update = useCallback((index: number, draft: EndpointDraft) => setDrafts((list) => list.map((d, i) => (i === index ? draft : d))), []);

  const add = () => {
    if (atLimit) return;
    const id = createEndpointId();
    added.current = id;
    setDrafts((list) => [...list, newEndpointDraft(id)]);
  };

  const requestRemove = (draft: EndpointDraft) => {
    if (!isSaved(draft)) setDrafts((list) => list.filter((d) => d.id !== draft.id));
    else setRemoving(draft);
  };

  const confirmRemove = async () => {
    const target = removing;
    if (!target) return;
    const current = currentSettings();
    const next: Settings = { ...current, notifications: current.notifications.filter((n) => n.id !== target.id) };
    const result = await saveSettings(next);
    if (!result.ok) throw new Error(result.error?.message ?? t('settings.saveFailed', { status: result.error?.status || '—' }));
    setDrafts((list) => list.filter((d) => d.id !== target.id));
  };

  const confirmConnect = async () => {
    const id = connecting;
    if (!id) return;
    const r = await ensureRelay(http, id);
    if (!r.ok) throw new Error(cc(CHANNEL_COPY.target.connectFailed, { status: r.status || '—', detail: r.detail ?? '' }).trim());
    setRelays((prev) => ({ ...prev, [id]: { status: 'ready' } }));
    await persistConnected(id);
  };

  /**
   * Founder-build r1 ui-5 (FINDINGS_R1 M1): a Connect that succeeded stores the endpoints it connected at once, so a
   * member who goes on to Send a test alert and leaves never loses them (the documented steps never said Save). An
   * empty Name becomes the target's id. Only those endpoints are written: the other drafts and the bell keep their
   * edits as drafts. When one still has an error (a Name that is a web address), it stays a draft whose relay line says
   * to save; a refused write is reported and leaves the draft as it was.
   */
  const persistConnected = async (targetId: string) => {
    if (!writable) return;
    const connected = drafts
      .filter((d) => d.criblTargetId.trim() === targetId && !(d.saved && d.savedTargetId === targetId))
      .map((d) => (d.name.trim() === '' ? { ...d, name: targetId } : d));
    if (connected.length === 0) return;
    const byId = new Map(connected.map((d) => [d.id, d]));
    const current = currentSettings();
    const storedList = draftsFromSettings(current);
    const list = [...storedList.map((d) => byId.get(d.id) ?? d), ...connected.filter((d) => !storedList.some((x) => x.id === d.id))];
    const { next, errors: e, listError: le } = applyEndpoints(current, list, bellFromSettings(current));
    // The empty Name is filled in the draft either way, so the card shows what would be stored.
    setDrafts((ds) => ds.map((d) => (byId.has(d.id) && d.name.trim() === '' ? { ...d, name: targetId } : d)));
    if (le || list.some((d, i) => byId.has(d.id) && e[i] !== undefined)) return;
    const outcome = await saveSettings(next);
    if (!outcome.ok) {
      reportWrite(outcome, { bar: false });
      return;
    }
    setDrafts((ds) => ds.map((d) => (byId.has(d.id) ? { ...byId.get(d.id)!, saved: true, savedTargetId: targetId } : d)));
  };

  const recordTest = async (draft: EndpointDraft, result: TestResult) => {
    // Only a saved endpoint tested as saved (the same target) gets `lastTest` (SPEC 5); nothing else is written.
    if (!isSaved(draft) || !writable) return;
    const current = currentSettings();
    const i = current.notifications.findIndex(
      (n) => n.id === draft.id && n.criblTargetId === draft.criblTargetId.trim() && n.criblTargetId === draft.savedTargetId,
    );
    if (i < 0) return;
    const lastTest = { at: result.at, status: result.status, hostAuthorized: true };
    const notifications = current.notifications.map((n, j) => (j === i ? { ...n, lastTest } : n));
    const outcome = await saveSettings({ ...current, notifications });
    // Not a save the member pressed: toast a failure, but leave the save bar alone.
    if (!outcome.ok) reportWrite(outcome, { bar: false });
  };

  const onSave = async () => {
    const { next, errors: e, listError: le } = applyEndpoints(currentSettings(), drafts, bell);
    if (Object.keys(e).length > 0 || le) {
      // Invalid input never writes (SPEC 5): show every error, then move focus to the first one.
      setRevealAll(true);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('section[data-section="notifications"] [aria-invalid="true"]')?.focus());
      return;
    }
    const ok = await save(next);
    if (ok) {
      setDrafts(draftsFromSettings(next));
      setBell(bellFromSettings(next));
      resetValidation();
    }
  };

  return (
    <SectionCard
      id="notifications"
      title={t('settings.groups.notifications')}
      // One description line before the first control (P1-G06).
      description={<span data-testid="channels-intro">{t('settings.notify.description')}</span>}
      aside={
        // The one "Add endpoint" (secondary): Save changes stays the page's single primary action.
        <Button variant="secondary" leadingIcon={Plus} disabled={!writable || atLimit || loading} onPress={add}>
          {t('settings.notify.add')}
        </Button>
      }
      footer={
        <SaveBar
          dirty={dirtyCount}
          errors={fieldErrorCount}
          saving={saving}
          writable={writable}
          onSave={() => void onSave()}
          onDiscard={() => {
            setDrafts(draftsFromSettings(stored));
            setBell(bellFromSettings(stored));
            resetValidation();
          }}
        />
      }
    >
      {loading ? (
        <div className="mr-nt-loading" data-testid="notifications-loading" aria-busy="true">
          <LoadingBlock loading rows={4} />
        </div>
      ) : (
        <>
          <div className="mr-nt-list">
            <BellRow
              bell={bell}
              disabled={!writable}
              onChange={setBell}
              http={http}
              sender={sender}
              testContext={testContext}
              dirty={bellDirty(bell, stored)}
            />
          </div>

          {drafts.length === 0 ? (
            <div className="mr-nt-empty" data-testid="endpoints-empty">
              <span className="mr-nt-empty-icon" aria-hidden="true">
                <PaperPlane size="sm" />
              </span>
              <div className="mr-nt-empty-copy">
                <p className="mr-nt-empty-title">{t(bell.enabled ? 'settings.notify.emptyTitle' : 'settings.notify.emptyTitleBellOff')}</p>
                <p className="mr-set-caption">{t('settings.notify.emptyBody')}</p>
              </div>
            </div>
          ) : (
            <div className="mr-nt-list">
              {drafts.map((draft, index) => (
                <EndpointEditor
                  key={draft.id}
                  draft={draft}
                  index={index}
                  errors={errors[index]}
                  disabled={!writable}
                  onChange={(d) => update(index, d)}
                  onRemove={() => requestRemove(draft)}
                  onTouch={(field) => touch(draft.id, field)}
                  dirty={isDraftDirty(draft)}
                  runtime={stored.runtime}
                  testContext={testContext}
                  sender={sender}
                  onTested={(result) => void recordTest(draft, result)}
                  cribl={cribl}
                />
              ))}
            </div>
          )}
          {atLimit ? <p className="mr-set-caption">{t('settings.notify.limit')}</p> : null}
          {listError ? <p className="mr-set-error">{listError}</p> : null}

          <div className="mr-nt-direct" data-testid="runner-webhooks">
            <h3 className="mr-nt-weekly-title">{t('settings.notify.runnerWebhooks.title')}</h3>
            {runnerWebhooks && runnerWebhooks.length > 0 ? (
              <>
                <p className="mr-set-caption">{t('settings.notify.runnerWebhooks.some')}</p>
                <ul className="mr-nt-direct-list">
                  {runnerWebhooks.map((w) => (
                    <li key={w.id} className="mr-set-caption" data-testid="runner-webhook">
                      {t('settings.notify.runnerWebhooks.line', { name: w.name, host: w.host })}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="mr-set-caption">{t('settings.notify.runnerWebhooks.none')}</p>
            )}
          </div>

          <WeeklyReceiptBlock />
        </>
      )}

      <ConfirmModal
        isOpen={removing !== null}
        title={t('settings.notify.removeTitle', { name: removing?.name.trim() || t('settings.notify.unnamed') })}
        body={CHANNEL_COPY.target.removeBody}
        affects={
          removing
            ? [
                {
                  label: removing.name.trim() || t('settings.notify.unnamed'),
                  id: removing.savedTargetId,
                  action: CHANNEL_COPY.target.removeAction,
                },
              ]
            : []
        }
        irreversible={false}
        confirmText={t('settings.notify.remove')}
        onConfirm={confirmRemove}
        onClose={() => setRemoving(null)}
        successMessage={t('settings.notify.removed')}
      />

      <ConfirmModal
        isOpen={connecting !== null}
        title={cc(CHANNEL_COPY.target.connectTitle, { target: connecting ?? '' })}
        body={CHANNEL_COPY.target.connectBody}
        affects={
          connecting
            ? [
                { label: CHANNEL_COPY.target.searchLabel, id: RELAY_SAVED_SEARCH_ID, action: CHANNEL_COPY.target.searchAction },
                { label: CHANNEL_COPY.target.notificationLabel, id: relayNotificationId(connecting), action: cc(CHANNEL_COPY.target.notificationAction, { target: connecting }) },
              ]
            : []
        }
        danger={false}
        confirmText={CHANNEL_COPY.target.connectConfirm}
        onConfirm={confirmConnect}
        onClose={() => setConnecting(null)}
        successMessage={CHANNEL_COPY.target.connected}
      />
    </SectionCard>
  );
}
