// src/views/Settings/BudgetsSection.tsx — Budgets per destination ($ / month) with the current pace
// (PRD 7 "Budget pace", PRD 8.4). The preview uses the detector's projection (paid MTD ÷ elapsed minutes
// × minutes in the month, display timezone), so what this page shows is what would fire.

import { useMemo, useState } from 'react';
import { TextField } from '@capra/core';
import type { DestinationFigures } from '../../../core/types.ts';
import { humanize } from '../../../core/humanize.ts';
import { t } from '../../copy/en.ts';
import { LoadingBlock } from '../../components/common/Loading.tsx';
import { EmptyBlock } from '../../components/common/EmptyBlock.tsx';
import { destinationMeta, listDestinations } from '../../components/PriceTable/model.ts';
import { formatMoney, formatPct } from '../../lib/format.ts';
import { shallowEqual, useAppState } from '../../state/react.tsx';
import { applyBudgets, budgetDraftFrom, budgetPace, parseDollarsToCents, type BudgetDraft } from './model.ts';
import { SaveBar, SectionCard, WaitingForInventory } from './shared.tsx';
import { errorCount, isWaitingForInventory, useCurrentSettings, useInventory, useSaveSettings, useSectionDraft, useWritable } from './hooks.ts';
import { SweepNowButton } from './SweepNowButton.tsx';

export function BudgetsSection() {
  const writable = useWritable();
  const view = useAppState(
    (s) => ({
      snapshot: s.snapshot,
      includeInternal: s.settings.includeInternal,
      labels: s.settings.humanize,
      tz: s.settings.displayTimezone,
      warn: s.settings.thresholds.budgetWarnPct,
      alert: s.settings.thresholds.budgetAlertPct,
      live: s.source === 'live',
      hydrated: s.hasHydrated,
    }),
    shallowEqual,
  );
  const inv = useInventory();
  const destinations = useMemo(
    () => listDestinations(view.live ? inv.inventory : null, view.snapshot, view.includeInternal),
    [view.live, inv.inventory, view.snapshot, view.includeInternal],
  );
  const outputIds = useMemo(() => [...new Set(destinations.map((d) => d.outputId))], [destinations]);
  const idsKey = outputIds.join('|');
  const section = useSectionDraft<BudgetDraft>((s) => budgetDraftFrom(s, outputIds), [idsKey]);
  const currentSettings = useCurrentSettings();
  const { save, saving } = useSaveSettings();
  const [nowMs] = useState(() => Date.now());

  const figures = useMemo(() => {
    const map = new Map<string, DestinationFigures>();
    for (const d of view.snapshot?.destinations ?? []) map.set(d.outputId, d);
    return map;
  }, [view.snapshot]);

  const { errors } = applyBudgets(currentSettings(), section.draft);
  const dirtyCount = outputIds.filter((id) => (section.draft[id] ?? '') !== (section.stored[id] ?? '')).length;

  const onSave = async () => {
    const { next, errors: e } = applyBudgets(currentSettings(), section.draft);
    if (errorCount(e) > 0) return;
    await save(next);
  };

  let body;
  if (!view.hydrated) body = <LoadingBlock loading rows={3} />;
  else if (isWaitingForInventory(inv, view.live, destinations.length)) body = <WaitingForInventory action={<SweepNowButton variant="secondary" />} />;
  else if (destinations.length === 0)
    body = <EmptyBlock title={t('settings.prices.emptyTitle')} description={t('settings.prices.emptyBody')} illustration="EmptySuitcase" />;
  else
    body = (
      <div className="mr-bud" role="table" aria-label={t('settings.groups.budgets')}>
        <div className="mr-bud-head" role="row">
          <span role="columnheader">{t('settings.prices.colDestination')}</span>
          <span role="columnheader">{t('settings.budgets.colBudget')}</span>
          <span role="columnheader">{t('settings.budgets.colPace')}</span>
        </div>
        {outputIds.map((outputId) => {
          const dest = destinations.find((d) => d.outputId === outputId);
          const name = humanize(outputId, view.labels) || outputId;
          const text = section.draft[outputId] ?? '';
          const parsed = parseDollarsToCents(text, t('settings.budgets.fieldBudget'));
          const budgetCents = parsed.ok ? parsed.cents : undefined;
          const pace = budgetPace(figures.get(outputId), budgetCents, nowMs, view.tz, { budgetWarnPct: view.warn, budgetAlertPct: view.alert });
          const error = errors[`budgets.${outputId}`];
          return (
            <div
              className="mr-bud-row"
              role="row"
              key={outputId}
              data-testid={`budget-row-${outputId}`}
              data-dirty={text !== (section.stored[outputId] ?? '') ? 'true' : undefined}
            >
              <div className="mr-bud-dest" role="cell">
                <span className="mr-pt-name">{name}</span>
                <span className="mr-pt-meta">{destinationMeta({ name, outputId, type: dest?.type ?? '', groupId: dest?.groupId ?? '' })}</span>
              </div>
              <div className="mr-bud-field" role="cell">
                <span className="mr-pt-cell-label mr-bud-cell-label" aria-hidden="true">
                  {t('settings.budgets.colBudget')}
                </span>
                <TextField
                  aria-label={`${t('settings.budgets.colBudget')}, ${name}`}
                  leadingSlot={<span className="mr-pt-affix">$</span>}
                  trailingSlot={<span className="mr-set-unit">{t('settings.units.perMonth')}</span>}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder={t('settings.budgets.placeholder')}
                  value={text}
                  disabled={!writable}
                  appearance={error ? 'danger' : 'default'}
                  helperText={error}
                  onChange={(value) => section.setDraft((d) => ({ ...d, [outputId]: value }))}
                  data-testid={`budget-input-${outputId}`}
                />
              </div>
              <div className="mr-bud-pace" role="cell" data-level={pace?.level ?? 'none'}>
                {pace ? (
                  <>
                    <span className="mr-bud-pace-line mr-num">{t('settings.budgets.pace', { amount: formatMoney(pace.projectedM) })}</span>
                    {pace.ratio !== undefined ? (
                      <div
                        className="mr-bud-bar"
                        role="meter"
                        aria-label={t('settings.budgets.paceAria')}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(pace.ratio * 100)}
                        aria-valuetext={t('settings.budgets.paceOfBudget', { pct: formatPct(pace.ratio) })}
                      >
                        <span className="mr-bud-bar-fill" style={{ inlineSize: `${Math.min(100, pace.ratio * 100)}%` }} />
                      </div>
                    ) : null}
                    <span className="mr-set-caption mr-num">
                      {pace.ratio !== undefined
                        ? `${t('settings.budgets.paceOfBudget', { pct: formatPct(pace.ratio) })} · ${t('settings.budgets.mtd', { amount: formatMoney(pace.mtdPaidM) })}`
                        : t('settings.budgets.mtd', { amount: formatMoney(pace.mtdPaidM) })}
                    </span>
                  </>
                ) : (
                  <span className="mr-set-caption">{t('settings.budgets.noSpend')}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );

  return (
    <SectionCard
      id="budgets"
      title={t('settings.groups.budgets')}
      description={t('settings.budgets.description')}
      footer={
        destinations.length > 0 ? (
          <SaveBar
            dirty={dirtyCount}
            errors={errorCount(errors)}
            saving={saving}
            writable={writable}
            onSave={() => void onSave()}
            onDiscard={section.discard}
            note={t('settings.budgets.thresholds', { warn: view.warn, alert: view.alert })}
          />
        ) : undefined
      }
    >
      {body}
    </SectionCard>
  );
}
