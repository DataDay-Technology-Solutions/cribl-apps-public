// src/views/Settings/CostSection.tsx — Cribl cost per month (optional; PRD 6 "Gross headline; optional net").
// The preview is SPEC 8's net and payback for the month to date, printed as a small receipt with dot
// leaders (DESIGN_BRIEF 1: the receipt motif), recomputed as the member types.

import { useState } from 'react';
import { Button, TextField } from '@capra/core';
import { dayOfMonth, daysInMonth, fromIso } from '../../../core/time.ts';
import { t } from '../../copy/en.ts';
import { formatMoney, formatMultiple } from '../../lib/format.ts';
import { shallowEqual, useAppState } from '../../state/react.tsx';
import type { Settings } from '../../../core/types.ts';
import { applyCost, centsToDollarText, costDraftFrom, costPreview, criblCostSuggestion, parseDollarsToCents } from './model.ts';
import { centsToMc, fmtBytes, mcToDollarInput } from '../../../core/format.ts';
import { netSpanWords } from '../Receipt/text.ts';
import { SaveBar, SectionCard } from './shared.tsx';
import { errorCount, useCurrentSettings, useSaveSettings, useSectionDraft, useWritable } from './hooks.ts';

function ReceiptLine({ label, value, tone, testId }: { label: string; value: string; tone?: 'saved' | 'total'; testId?: string }) {
  return (
    <div className="mr-cost-line" data-tone={tone} data-testid={testId}>
      <span className="mr-cost-label">{label}</span>
      <span className="mr-cost-leader" aria-hidden="true" />
      <span className="mr-cost-value mr-num">{value}</span>
    </div>
  );
}

/** The savings goal field's draft (P2-W20): dollars per month as typed; '' clears it. */
const goalDraftFrom = (settings: Settings): string => centsToDollarText(settings.savingsGoalCentsPerMonth);

/** Applies the goal draft; returns the error text when it does not parse. */
function applyGoal(current: Settings, draft: string): { next: Settings; error?: string } {
  const parsed = parseDollarsToCents(draft, t('settings.cost.fieldGoal'));
  if (!parsed.ok) return { next: current, error: parsed.error };
  const next: Settings = { ...current };
  if (parsed.cents === undefined || parsed.cents === 0) delete next.savingsGoalCentsPerMonth;
  else next.savingsGoalCentsPerMonth = parsed.cents;
  return { next };
}

export function CostSection() {
  const writable = useWritable();
  const view = useAppState(
    (s) => ({ headline: s.snapshot?.headline, sweepAt: s.snapshot?.sweepAt, since: s.snapshot?.collectingSince, tz: s.settings.displayTimezone, snapshot: s.snapshot }),
    shallowEqual,
  );
  const section = useSectionDraft<string>(costDraftFrom);
  const goal = useSectionDraft<string>(goalDraftFrom);
  const goalError = applyGoal({} as Settings, goal.draft).error;
  const currentSettings = useCurrentSettings();
  const { save, saving } = useSaveSettings();
  const [nowMs] = useState(() => Date.now());

  const { errors } = applyCost(currentSettings(), section.draft);
  const error = errors.criblCostCentsPerMonth;
  const parsed = parseDollarsToCents(section.draft, t('settings.cost.fieldCost'));
  const cents = parsed.ok ? parsed.cents : undefined;
  // Prorated to the minutes metered this month, like the Receipt's net (core/net.ts), when the snapshot says them.
  const sweepAtMs = view.sweepAt ? fromIso(view.sweepAt) : Number.NaN;
  const sinceMs = view.since ? fromIso(view.since) : Number.NaN;
  const span = Number.isFinite(sweepAtMs) ? { sweepAtMs, collectingSinceMs: Number.isFinite(sinceMs) ? sinceMs : undefined } : undefined;
  const preview = costPreview(view.headline, cents, nowMs, view.tz, span);
  // What this workspace's ingest costs at Cribl's list price: offered, never stored until an admin saves it.
  const suggestion = criblCostSuggestion(view.snapshot);
  const suggestedText = suggestion ? centsToDollarText(suggestion.centsPerMonth) : '';
  const suggestedAmount = suggestion ? formatMoney(centsToMc(suggestion.centsPerMonth)) : '';

  const onSave = async () => {
    // saved at exactly the suggestion, the cost is flagged as an estimate (the Receipt and the report say so)
    const { next, errors: e } = applyCost(currentSettings(), section.draft, suggestion?.centsPerMonth);
    if (errorCount(e) > 0) return;
    const withGoal = applyGoal(next, goal.draft);
    if (withGoal.error) return;
    await save(withGoal.next);
  };

  let previewBody;
  if (!view.headline) previewBody = <p className="mr-set-muted">{t('settings.cost.previewNoData')}</p>;
  else if (!preview) previewBody = <p className="mr-set-muted">{t('settings.cost.previewEmpty')}</p>;
  else
    previewBody = (
      <>
        <div className="mr-cost-receipt" data-testid="cost-preview">
          <ReceiptLine label={t('settings.cost.savedMtd')} value={formatMoney(preview.savedMtdM)} tone="saved" />
          <ReceiptLine label={t('settings.cost.proratedCost')} value={`−${formatMoney(preview.proratedM)}`} />
          <div className="mr-cost-rule" aria-hidden="true" />
          <ReceiptLine label={t('settings.cost.net')} value={formatMoney(preview.netM)} tone="total" testId="cost-net" />
          {preview.paybackX !== undefined ? (
            <ReceiptLine label={t('settings.cost.payback')} value={t('settings.cost.paybackValue', { multiple: formatMultiple(preview.paybackX) })} testId="cost-payback" />
          ) : null}
        </div>
        <p className="mr-set-caption" data-testid="cost-basis">
          {preview.minutes !== undefined
            ? t('settings.cost.basisMetered', { span: netSpanWords(preview.minutes) })
            : t('settings.cost.basis', { day: dayOfMonth(nowMs, view.tz), days: daysInMonth(nowMs, view.tz) })}
        </p>
      </>
    );

  return (
    <SectionCard
      id="cost"
      title={t('settings.groups.criblCost')}
      description={t('settings.cost.description')}
      bodyClassName="mr-cost"
      footer={
        <SaveBar
          dirty={(section.dirty ? 1 : 0) + (goal.dirty ? 1 : 0)}
          errors={(error ? 1 : 0) + (goalError ? 1 : 0)}
          saving={saving}
          writable={writable}
          onSave={() => void onSave()}
          onDiscard={() => {
            section.discard();
            goal.discard();
          }}
        />
      }
    >
      <div className="mr-cost-field mr-stack-lg" data-dirty={section.dirty || goal.dirty ? 'true' : undefined}>
        <TextField
          label={t('settings.cost.label')}
          leadingSlot={<span className="mr-pt-affix">$</span>}
          trailingSlot={<span className="mr-set-unit">{t('settings.units.perMonth')}</span>}
          inputMode="decimal"
          autoComplete="off"
          placeholder={t('settings.cost.placeholder')}
          value={section.draft}
          disabled={!writable}
          appearance={error ? 'danger' : 'default'}
          helperText={error ?? t('settings.cost.clearHint')}
          onChange={(value) => section.setDraft(value)}
          data-testid="cost-input"
        />
        {suggestion ? (
          <div className="mr-cost-suggest" data-testid="cost-suggestion">
            <p className="mr-set-caption mr-cost-suggest-line">
              {t('settings.cost.suggest', {
                volume: fmtBytes(suggestion.bytesInPerDay),
                list: `$${mcToDollarInput(suggestion.listMcPerGb)}`,
                amount: suggestedAmount,
              })}
            </p>
            <p className="mr-set-caption">{t('settings.cost.suggestSource')}</p>
            {section.draft.trim() !== suggestedText ? (
              <Button variant="secondary" size="sm" disabled={!writable} onPress={() => section.setDraft(suggestedText)}>
                {t('settings.cost.suggestUse', { amount: suggestedAmount })}
              </Button>
            ) : (
              <p className="mr-set-caption" data-testid="cost-suggestion-estimate">
                {t('settings.cost.suggestAsEstimate')}
              </p>
            )}
          </div>
        ) : null}
        <TextField
          label={t('settings.cost.goalLabel')}
          leadingSlot={<span className="mr-pt-affix">$</span>}
          trailingSlot={<span className="mr-set-unit">{t('settings.units.perMonth')}</span>}
          inputMode="decimal"
          autoComplete="off"
          placeholder={t('settings.cost.placeholder')}
          value={goal.draft}
          disabled={!writable}
          appearance={goalError ? 'danger' : 'default'}
          helperText={goalError ?? t('settings.cost.goalHint')}
          onChange={(value) => goal.setDraft(value)}
          data-testid="goal-input"
        />
      </div>
      <div className="mr-cost-preview">
        <p className="mr-set-subhead">{t('settings.cost.previewTitle')}</p>
        {previewBody}
      </div>
    </SectionCard>
  );
}
