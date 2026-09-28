// src/components/IncidentCard/IncidentActions.tsx — what a member can do with an open alert (EPIC_AUDIT P1-F07):
//
//   Accept as the new normal   the change was deliberate: close the alert, re-seat the object's baseline at the level
//                              it holds now (core/incidents.ts acceptIntoBaselines), so it stops alerting — confirmed
//   Mute for 24 hours          close it and open nothing on the object until tomorrow (settings.mutes)
//   Leave out of metering      a test pipeline or lab source: settings.excludedObjectKeys, the same list Settings →
//                              Alerts edits — confirmed, since its dollars leave every total
//
// Every write is App KV (settings, the incident's doc, baselines, the snapshot) under the sweep lock
// (core/incidents.ts runIncidentAction); nothing touches Cribl configuration, so the release build offers it.
// Offered only on live data, after hydration, off the presenter stage, and only where the card is inside the app's
// providers (unit tests and the dev gallery render the card without them, and without this menu).

import { useState } from 'react';
import { IconButton, Menu, Modal } from '@capra/core';
import { EllipsisVertical } from '@capra/icons';
import type { Incident, Settings } from '../../../core/types.ts';
import { MEMBER_MUTE_MS, closeInSnapshot, currentReading, incidentActions, runIncidentAction, type IncidentAction } from '../../../core/incidents.ts';
import { createFetchKvStore, createKvDocs, type KvDocs } from '../../../core/kv.ts';
import { detectCodec } from '../../../core/codec.ts';
import { fmtDollars, fmtPct } from '../../../core/format.ts';
import { toIso } from '../../../core/time.ts';
import { t } from '../../copy/en.ts';
import { apiBaseUrl } from '../../lib/env.ts';
import { useOptionalServices, useOptionalStoreApi } from '../../state/react.tsx';
import { muteEndParts, objectKindWord } from './model.ts';

let kv: KvDocs | null = null;
/** The App's KV, as the runtime builds it (src/state/runtime.ts): the platform fetch to CRIBL_API_URL. */
function kvDocs(): KvDocs {
  kv ??= createKvDocs({
    kv: createFetchKvStore({ fetch: window.fetch as unknown as Parameters<typeof createFetchKvStore>[0]['fetch'], baseUrl: apiBaseUrl() }),
    codec: detectCodec(),
    clock: { now: () => Date.now() },
  });
  return kv;
}

/** "Steve Koelpin" from getCriblUser(), else the username; '' outside Cribl. */
async function memberName(): Promise<string> {
  try {
    const user = (await window.getCriblUser?.()) as { username?: string; firstName?: string; lastName?: string } | undefined;
    const full = [user?.firstName, user?.lastName].filter((x) => typeof x === 'string' && x.trim()).join(' ').trim();
    return full || user?.username || '';
  } catch {
    return '';
  }
}

const lockOwner = (): string =>
  `action:${typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;

/** The level an accept would learn, in the incident's own units: '49%' or '$12 / hour'. */
function levelText(incident: Incident, reading: number | undefined): string | undefined {
  const level = reading ?? incident.after;
  if (!Number.isFinite(level)) return undefined;
  return incident.type === 'spike' ? `${fmtDollars(level)}${t('units.perHour')}` : fmtPct(level);
}

/** Settings with this action's mute or exclusion added (expired mutes pruned). */
function settingsFor(action: IncidentAction, settings: Settings, objectKey: string, by: string, nowMs: number): Settings | null {
  if (action === 'exclude') {
    if (settings.excludedObjectKeys.includes(objectKey)) return null;
    return { ...settings, excludedObjectKeys: [...settings.excludedObjectKeys, objectKey] };
  }
  if (action === 'mute') {
    const mutes: NonNullable<Settings['mutes']> = {};
    for (const [k, m] of Object.entries(settings.mutes ?? {})) if (Date.parse(m.until) > nowMs) mutes[k] = m;
    mutes[objectKey] = { until: toIso(nowMs + MEMBER_MUTE_MS), ...(by ? { by } : {}) };
    return { ...settings, mutes };
  }
  return null;
}

export function IncidentActions({ incident, tz, label, nowMs }: { incident: Incident; tz?: string; label: string; nowMs: number }) {
  const store = useOptionalStoreApi();
  const services = useOptionalServices();
  const [note, setNote] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const [busy, setBusy] = useState(false);
  const actions = incidentActions(incident);
  const state = store?.getState();
  if (!store || !services || !state || actions.length === 0) return null;
  if (state.source !== 'live' || !state.hasHydrated || state.presenter) return null;

  const kind = objectKindWord(incident.objectKey);
  const reading = incident.type === 'budget' ? undefined : currentReading(state.snapshot, incident);
  const level = levelText(incident, reading);

  const run = async (action: IncidentAction): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const nowMs = Date.now();
      const by = await memberName();
      const current = store.getState().settings;
      const nextSettings = settingsFor(action, current, incident.objectKey, by, nowMs);
      if (nextSettings) {
        const saved = await services.actions.saveSettings(nextSettings);
        if (!saved.ok) {
          setNote({ text: t('incidents.actions.failed', { error: saved.error?.message ?? saved.reason }), tone: 'error' });
          return;
        }
      }
      const res = await runIncidentAction(kvDocs(), {
        action,
        incident,
        by,
        owner: lockOwner(),
        nowMs,
        reading,
        warmupSamples: current.thresholds.warmupSamples,
        mutedUntil: nextSettings?.mutes?.[incident.objectKey]?.until,
      });
      if (res.ok) {
        // The stored snapshot is patched too, but polling keeps the copy it has until a new sweep writes one
        // (src/state/live.ts isSameSnapshot): this tab reads the close now, other tabs at their next load or sweep.
        const mutedUntil = nextSettings?.mutes?.[incident.objectKey]?.until;
        store.setState((s) => (s.snapshot ? { snapshot: closeInSnapshot(s.snapshot, res.incident, action === 'mute' && mutedUntil ? { mutedUntil } : {}) } : {}));
      } else {
        // A mute or exclusion is already saved: the detector closes the alert on the next sweep.
        if (res.reason === 'locked') setNote({ text: t(nextSettings ? 'incidents.actions.pending' : 'incidents.actions.locked'), tone: nextSettings ? 'info' : 'error' });
        else if (res.reason === 'closed') setNote({ text: t('incidents.actions.alreadyClosed'), tone: 'info' });
        else setNote({ text: t('incidents.actions.failed', { error: res.error ?? res.reason }), tone: 'error' });
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmThen = (action: 'accept' | 'exclude'): void => {
    Modal.confirm({
      title: action === 'accept' ? t('incidents.actions.acceptTitle') : t('incidents.actions.excludeTitle', { label }),
      content: (
        <span className="mr-inc-confirm" data-testid={`incident-confirm-${action}`}>
          {action === 'accept'
            ? t('incidents.actions.acceptBody', { level: level ?? t('common.dash'), kind })
            : t('incidents.actions.excludeBody', { kind })}
        </span>
      ),
      confirmButtonText: action === 'accept' ? t('incidents.actions.acceptConfirm') : t('incidents.actions.excludeConfirm'),
      cancelButtonText: t('incidents.actions.cancel'),
      onConfirm: () => {
        void run(action);
      },
    });
  };

  const muteUntil = muteEndParts(nowMs + MEMBER_MUTE_MS, tz);
  return (
    <span className="mr-inc-actions" data-testid="incident-actions">
      {note ? (
        <span className={`mr-inc-action-note mr-inc-action-note--${note.tone}`} role="status">
          {note.text}
        </span>
      ) : null}
      <Menu
        trigger={
          <IconButton icon={EllipsisVertical} aria-label={t('incidents.actions.menu')} size="sm" variant="tertiary" disabled={busy} data-testid="incident-actions-trigger" />
        }
        // Each item's description wraps inside the menu's 256 px instead of losing its end ("…1:24" without "AM").
        contentProps={{ className: 'mr-inc-actions-menu' }}
      >
        {actions.includes('accept') ? (
          <Menu.Item
            label={t('incidents.actions.accept')}
            description={level ? t('incidents.actions.acceptHint', { level }) : t('incidents.actions.acceptHintPlain')}
            onPress={() => confirmThen('accept')}
          />
        ) : null}
        <Menu.Item label={t('incidents.actions.mute')} description={t('incidents.actions.muteHint', muteUntil)} onPress={() => void run('mute')} />
        <Menu.Divider />
        <Menu.Item
          label={t('incidents.actions.exclude')}
          description={t('incidents.actions.excludeHint')}
          variant="danger"
          onPress={() => confirmThen('exclude')}
        />
      </Menu>
    </span>
  );
}
