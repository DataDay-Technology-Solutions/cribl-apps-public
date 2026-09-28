// src/views/Settings/AlertsSection.tsx — alert thresholds (SPEC 5 schema + validation, PRD 7, SPEC 9).
// Regression points 5–50, minutes, commit window and the $/day floor (D26); spike σ / minutes / minimum $ per
// hour; budget warn and alert %; baseline memory 1 h / 6 h / 24 h / 7 d (α = 2/(N+1)), re-notify cooldown,
// warm-up and recovery minutes; the good-news toggle; objects left out of metering (settings.excludedObjectKeys,
// picked from the snapshot's flows). The demo profile notice shows while demo mode + profile are on (stored
// thresholds stay untouched).
//
// EPIC_AUDIT P1-G09: the floor, recovery, warm-up and excluded objects have fields; Good news takes one column.
// P1-G07: every changed field carries the leading-edge dirty marker (data-dirty).

import { useMemo, type ReactNode } from 'react';
import { Alert, SelectField, Switch, Tag, TextField, type Key } from '@capra/core';
import { isDemoProfile } from '../../../core/detector.ts';
import { t } from '../../copy/en.ts';
import { IS_DEMO_BUILD } from '../../lib/env.ts';
import { shallowEqual, useAppState } from '../../state/react.tsx';
import { alertsDirtyFields, alertsDraftFrom, apiClientKeys, applyAlerts, excludableLabel, excludableObjects, MEMORY_OPTIONS, type AlertsDraft, type MemoryKey } from './model.ts';
import { apiClientFallback } from '../../lib/author.ts';
import { SaveBar, SectionCard } from './shared.tsx';
import { errorCount, useCurrentSettings, useSaveSettings, useSectionDraft, useWritable } from './hooks.ts';

type NumField = Exclude<keyof AlertsDraft, 'memory' | 'goodNewsEnabled' | 'excludedObjectKeys' | 'clientNames'>;

/** thresholds field that carries a draft field's error (the dollar fields are stored as cents). */
const ERROR_FIELD: Record<NumField, string> = {
  regressionPoints: 'thresholds.regressionPoints',
  regressionMinutes: 'thresholds.regressionMinutes',
  regressionCommitWindowMin: 'thresholds.regressionCommitWindowMin',
  regressionFloorPerDay: 'thresholds.regressionMinCentsPerDay',
  spikeSigma: 'thresholds.spikeSigma',
  spikeMinutes: 'thresholds.spikeMinutes',
  spikeMinPerHour: 'thresholds.spikeMinCentsPerHour',
  budgetWarnPct: 'thresholds.budgetWarnPct',
  budgetAlertPct: 'thresholds.budgetAlertPct',
  cooldownMinutes: 'thresholds.cooldownMinutes',
  warmupSamples: 'thresholds.warmupSamples',
  recoveryMinutes: 'thresholds.recoveryMinutes',
};

function Group({ title, hint, children, id }: { title: string; hint?: string; children: ReactNode; id: string }) {
  return (
    <fieldset className="mr-al-group" data-group={id}>
      <legend className="mr-al-legend">{title}</legend>
      {hint ? <p className="mr-set-caption mr-al-hint">{hint}</p> : null}
      <div className="mr-al-fields">{children}</div>
    </fieldset>
  );
}

export function AlertsSection() {
  const writable = useWritable();
  const demoProfile = useAppState((s) => IS_DEMO_BUILD && isDemoProfile(s.settings));
  const view = useAppState((s) => ({ flows: s.snapshot?.flows, labels: s.settings.humanize, snapshot: s.snapshot }), shallowEqual);
  const section = useSectionDraft<AlertsDraft>(alertsDraftFrom);
  const currentSettings = useCurrentSettings();
  const { save, saving } = useSaveSettings();
  const { errors } = applyAlerts(currentSettings(), section.draft);

  const d = section.draft;
  const dirtyFields = new Set(alertsDirtyFields(d, section.stored));
  const dirtyMark = (field: keyof AlertsDraft) => (dirtyFields.has(field) ? 'true' : undefined);
  const options = useMemo(() => excludableObjects(view.flows, d.excludedObjectKeys, view.labels), [view.flows, d.excludedObjectKeys, view.labels]);
  // The API clients the snapshot's commits name, and any already named (usefulness review, round 2).
  const clients = useMemo(() => apiClientKeys(view.snapshot, section.stored.clientNames), [view.snapshot, section.stored.clientNames]);

  const num = (field: NumField, label: string, unit: string, opts: { leading?: string } = {}) => {
    const error = errors[ERROR_FIELD[field]];
    return (
      <div className="mr-al-field" key={field} data-dirty={dirtyMark(field)}>
        <TextField
          label={label}
          leadingSlot={opts.leading ? <span className="mr-pt-affix">{opts.leading}</span> : undefined}
          trailingSlot={<span className="mr-set-unit">{unit}</span>}
          inputMode="decimal"
          autoComplete="off"
          value={d[field]}
          disabled={!writable}
          appearance={error ? 'danger' : 'default'}
          helperText={error}
          onChange={(value) => section.setDraft((prev) => ({ ...prev, [field]: value }))}
          data-testid={`alerts-${field}`}
        />
      </div>
    );
  };

  const onSave = async () => {
    const { next, errors: e } = applyAlerts(currentSettings(), section.draft);
    if (errorCount(e) > 0) return;
    await save(next);
  };

  const exclude = (key: Key | null) => {
    if (key === null) return;
    const k = String(key);
    section.setDraft((prev) => (prev.excludedObjectKeys.includes(k) ? prev : { ...prev, excludedObjectKeys: [...prev.excludedObjectKeys, k] }));
  };
  const include = (key: string) => section.setDraft((prev) => ({ ...prev, excludedObjectKeys: prev.excludedObjectKeys.filter((k) => k !== key) }));

  const goodNewsLabelId = 'mr-al-goodnews-label';
  const noObjects = options.length === 0 && d.excludedObjectKeys.length === 0;

  return (
    <SectionCard
      id="alerts"
      title={t('settings.groups.alerts')}
      description={t('settings.alerts.description')}
      footer={
        <SaveBar
          dirty={dirtyFields.size}
          errors={errorCount(errors)}
          saving={saving}
          writable={writable}
          onSave={() => void onSave()}
          onDiscard={section.discard}
        />
      }
    >
      {demoProfile ? (
        <div data-state="demo-profile">
          <Alert appearance="info" layout="inline">
            {t('demoProfile.notice')}
          </Alert>
        </div>
      ) : null}
      <div className="mr-al-grid">
        <Group id="regression" title={t('settings.alerts.regressionTitle')} hint={t('settings.alerts.regressionHint')}>
          {num('regressionPoints', t('settings.alerts.regressionPoints'), t('settings.units.points'))}
          {num('regressionMinutes', t('settings.alerts.regressionMinutes'), t('settings.units.minutes'))}
          {num('regressionCommitWindowMin', t('settings.alerts.commitWindow'), t('settings.units.minutes'))}
          {num('regressionFloorPerDay', t('settings.alerts.regressionFloor'), t('settings.units.perDay'), { leading: t('settings.units.dollar') })}
        </Group>
        <Group id="spike" title={t('settings.alerts.spikeTitle')} hint={t('settings.alerts.spikeHint')}>
          {num('spikeSigma', t('settings.alerts.spikeSigma'), t('settings.units.sigma'))}
          {num('spikeMinutes', t('settings.alerts.spikeMinutes'), t('settings.units.minutes'))}
          {num('spikeMinPerHour', t('settings.alerts.spikeMinPerHour'), t('settings.units.perHour'), { leading: t('settings.units.dollar') })}
        </Group>
        <Group id="budget" title={t('settings.alerts.budgetTitle')} hint={t('settings.alerts.budgetHint')}>
          {num('budgetWarnPct', t('settings.alerts.budgetWarn'), t('settings.units.percentOfBudget'))}
          {num('budgetAlertPct', t('settings.alerts.budgetAlert'), t('settings.units.percentOfBudget'))}
        </Group>
        <Group id="goodnews" title={t('settings.alerts.goodNewsTitle')}>
          <div className="mr-al-toggle" data-dirty={dirtyMark('goodNewsEnabled')}>
            <span className="mr-switch">
              <Switch
                aria-labelledby={goodNewsLabelId}
                checked={d.goodNewsEnabled}
                disabled={!writable}
                onChange={(e) => section.setDraft((prev) => ({ ...prev, goodNewsEnabled: e.target.checked }))}
              />
            </span>
            <div className="mr-al-toggle-copy">
              <span id={goodNewsLabelId} className="mr-al-toggle-label">
                {t('settings.alerts.goodNews')}
              </span>
              <span className="mr-set-caption">{t('settings.alerts.goodNewsHint')}</span>
            </div>
          </div>
        </Group>
        <Group id="baseline" title={t('settings.alerts.baselineTitle')} hint={t('settings.alerts.baselineHint')}>
          <div className="mr-al-field" data-dirty={dirtyMark('memory')}>
            <SelectField
              label={t('settings.alerts.memory')}
              items={MEMORY_OPTIONS.map((o) => ({ id: o.key, label: t(o.labelKey) }))}
              value={d.memory}
              disabled={!writable}
              onChange={(key: Key | null) => {
                if (key !== null) section.setDraft((prev) => ({ ...prev, memory: String(key) as MemoryKey }));
              }}
            />
          </div>
          {num('cooldownMinutes', t('settings.alerts.cooldown'), t('settings.units.minutes'))}
          {num('warmupSamples', t('settings.alerts.warmup'), t('settings.units.minutes'))}
          {num('recoveryMinutes', t('settings.alerts.recovery'), t('settings.units.minutes'))}
        </Group>
        {clients.length > 0 ? (
          <Group id="clients" title={t('settings.alerts.clientsTitle')} hint={t('settings.alerts.clientsHint')}>
            {clients.map((key) => (
              <div className="mr-al-field" key={key} data-dirty={(d.clientNames[key] ?? '').trim() !== (section.stored.clientNames[key] ?? '').trim() ? 'true' : undefined}>
                <TextField
                  label={apiClientFallback(key)}
                  placeholder={t('settings.alerts.clientsPlaceholder')}
                  autoComplete="off"
                  value={d.clientNames[key] ?? ''}
                  disabled={!writable}
                  appearance={errors.humanize ? 'danger' : 'default'}
                  helperText={errors.humanize}
                  onChange={(value) => section.setDraft((prev) => ({ ...prev, clientNames: { ...prev.clientNames, [key]: value } }))}
                  data-testid={`alerts-client-${key.slice(key.indexOf(':') + 1)}`}
                />
              </div>
            ))}
          </Group>
        ) : null}
        <Group id="excluded" title={t('settings.alerts.excludedTitle')} hint={t('settings.alerts.excludedHint')}>
          <div className="mr-al-excluded" data-dirty={dirtyMark('excludedObjectKeys')}>
            <div className="mr-al-exclude-picker" data-testid="alerts-exclude-picker">
              <SelectField
                label={t('settings.alerts.excludedAdd')}
                // A helper line, not a placeholder: Capra's placeholder text is 3.8:1 on the field (PRD 8.8 wants 4.5:1).
                helperText={t('settings.alerts.excludedPickerHint')}
                items={options.map((o) => ({ id: o.key, label: o.label }))}
                value={null}
                canSearch={options.length > 8}
                disabled={!writable || options.length === 0}
                onChange={exclude}
              />
            </div>
            {d.excludedObjectKeys.length > 0 ? (
              <ul className="mr-al-chips" data-testid="alerts-excluded" aria-label={t('settings.alerts.excludedTitle')}>
                {d.excludedObjectKeys.map((key) => (
                  <li key={key} data-object-key={key}>
                    <Tag onDelete={writable ? () => include(key) : undefined}>{excludableLabel(key, view.labels)}</Tag>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mr-set-caption" data-testid="alerts-excluded-none">
                {noObjects ? t('settings.alerts.excludedWaiting') : t('settings.alerts.excludedNone')}
              </p>
            )}
          </div>
        </Group>
      </div>
    </SectionCard>
  );
}
