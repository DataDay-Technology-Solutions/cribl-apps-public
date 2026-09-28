// src/views/Report/index.tsx — the Report card view (`/report`, opened from the Receipt's "Report card" button):
// a one-page savings summary an admin or a sales engineer hands to leadership (DESIGN_BRIEF 5.10).
//
//   Left (4 col): the period (MTD · Today · 30 days, plus the Receipt's custom range when one is active on live
//   data), "Prepared for" and "Note" (never saved anywhere), then the actions: Download PDF, Download HTML,
//   Copy for email, Download CSV, with "Before you send it" above them: what the reader of the document can't
//   act on and the sender can (list prices, no Cribl cost, destinations with no price).
//   Right (8 col): the preview — the very HTML file the download writes, in a sandboxed iframe with no
//   permissions at all (sandbox=""), so what is shown is what is sent.
//   390 px: one column, controls first.
//
// The document is built by core/report.ts from the snapshot the Receipt shows (its figures reconcile to the
// Receipt for the same period), rendered by core/report-{pdf,html,email,csv}.ts. The view pins the snapshot it
// opened with: a report is a document, so the preview never reloads under the reader while a sweep lands;
// a one-line notice offers "Update figures" when newer ones arrive. Sample data works too and is
// marked as a sample on every page. Nothing is written anywhere: no KV, no browser storage.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { Button, ButtonLink, TextArea, TextField, ToggleButtonGroup, type Key } from '@capra/core';
import { ChevronLeft, CopyOutlined, Download, FileLines } from '@capra/icons';
import type { Snapshot } from '../../../core/types.ts';
import { buildReportCard, type ReportCard, type ReportPeriod } from '../../../core/report.ts';
import { renderReportPdf } from '../../../core/report-pdf.ts';
import { renderReportHtml } from '../../../core/report-html.ts';
import { renderReportEmail } from '../../../core/report-email.ts';
import { renderReportCsv } from '../../../core/report-csv.ts';
import { fromIso, isValidTimeZone } from '../../../core/time.ts';
import { t } from '../../copy/en.ts';
import { InlineNotice } from '../../components/common/InlineNotice.tsx';
import { notify } from '../../components/common/notify.tsx';
import { Page } from '../../components/Shell/Page.tsx';
import { BUILD, versionLabel } from '../../lib/env.ts';
import { formatTimeOfDay } from '../../lib/format.ts';
import { hrefWithStickyParams, useAppParams } from '../../lib/params.ts';
import { shallowEqual, useAppState } from '../../state/react.tsx';
import type { DataSource } from '../../state/store.ts';
import { rangeCaption } from '../Receipt/text.ts';
import { useRange } from '../Receipt/useRange.ts';
import { copyForEmail, downloadFile } from './download.ts';
import {
  FILE_TYPES,
  PRESET_CHOICES,
  REPORT_COPY,
  rangeable,
  reportChecks,
  reportChoice,
  reportFileName,
  reportWorkspace,
  viewerDisplayName,
  type ReportChoice,
  type ReportFileKind,
} from './model.ts';
import { criblCostSuggestion } from '../Receipt/model.ts';
import './Report.css';

const CHOICE_LABEL: Record<ReportChoice, () => string> = {
  mtd: () => t('report.view.period.mtd'),
  today: () => t('report.view.period.today'),
  '30d': () => t('report.view.period.30d'),
  range: () => t('report.view.period.range'),
};

/** Resolves getCriblUser() once (the platform memoizes it); undefined outside Cribl or while it loads. */
function useViewerName(): string | undefined {
  const [name, setName] = useState<string | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const get = typeof window !== 'undefined' ? window.getCriblUser : undefined;
    if (typeof get !== 'function') return;
    get()
      .then((user) => {
        if (alive) setName(viewerDisplayName(user));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return name;
}

/** The value after it has stopped changing for `ms` (typing into a field rebuilds the preview once, not per key). */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

const NOTE_MAX = 400;
const FOR_MAX = 80;

function ReportContent({ snapshot: latest, source }: { snapshot: Snapshot; source: DataSource }) {
  // The figures the report is built from, until the reader asks for the newer ones.
  const [snapshot, setSnapshot] = useState(latest);
  const newer = latest.sweepAt !== snapshot.sweepAt ? latest : undefined;
  const [params] = useAppParams();
  const [search, setSearch] = useSearchParams();
  const { search: rawSearch } = useLocation();
  const view = useAppState(
    (s) => ({
      prices: s.prices,
      tzSetting: s.settings.displayTimezone,
      defaultPeriod: s.settings.headlinePeriodDefault,
      criblCost: s.settings.criblCostCentsPerMonth,
      labels: s.settings.humanize,
      owner: s.meta?.lastSweepOwner,
    }),
    shallowEqual,
  );
  const tz = view.tzSetting && isValidTimeZone(view.tzSetting) ? view.tzSetting : 'UTC';
  const live = source === 'live';
  const choice = reportChoice({ period: params.period, range: params.range, report: search.get('report') }, source, view.defaultPeriod);
  const rangeSpec = rangeable(source) && choice === 'range' ? params.range : undefined;
  const { state: rangeState, result: rangeResult } = useRange(rangeSpec, rangeSpec !== undefined, snapshot.sweepAt);
  const viewer = useViewerName();

  const [preparedFor, setPreparedFor] = useState('');
  const [note, setNote] = useState('');
  const settledFor = useSettled(preparedFor, 300);
  const settledNote = useSettled(note, 300);

  const rangePending = choice === 'range' && !rangeResult && rangeState.status !== 'error';
  const rangeFailed = choice === 'range' && !rangeResult && rangeState.status === 'error';

  // A failed range read falls back to month to date (the notice says so); a pending one waits.
  const period: ReportPeriod | undefined = useMemo(() => {
    if (choice !== 'range') return { kind: choice };
    if (rangeResult && rangeSpec) {
      return { kind: 'range', figures: rangeResult.figures, caption: rangeCaption(rangeResult.figures, rangeResult.resolved, rangeSpec, snapshot, tz) };
    }
    return rangeFailed ? { kind: 'mtd' } : undefined;
  }, [choice, rangeResult, rangeSpec, rangeFailed, snapshot, tz]);

  const buildCard = useCallback(
    (forText: string, noteText: string): ReportCard | undefined => {
      if (!period) return undefined;
      return buildReportCard({
        snapshot,
        prices: view.prices,
        settings: { criblCostCentsPerMonth: view.criblCost, humanize: view.labels },
        period,
        nowMs: Date.now(),
        tz,
        copy: REPORT_COPY,
        source: live ? 'live' : 'sample',
        appVersion: versionLabel(),
        build: BUILD,
        ...(viewer ? { viewer } : {}),
        workspace: reportWorkspace(source, typeof window !== 'undefined' ? window.CRIBL_API_URL : undefined),
        ...(view.owner ? { lastSweepOwner: view.owner } : {}),
        preparedFor: forText,
        note: noteText,
      });
    },
    [period, snapshot, view.prices, view.criblCost, view.labels, tz, live, viewer, source, view.owner],
  );

  const card = useMemo(() => buildCard(settledFor, settledNote), [buildCard, settledFor, settledNote]);
  const html = useMemo(() => (card ? renderReportHtml(card) : ''), [card]);

  /** The card the actions use: the preview's, unless the fields changed since it was built (then a fresh one). */
  const currentCard = useCallback((): ReportCard | undefined => {
    if (settledFor === preparedFor && settledNote === note) return card;
    return buildCard(preparedFor, note);
  }, [card, buildCard, settledFor, settledNote, preparedFor, note]);

  const onDownload = useCallback(
    (kind: ReportFileKind) => {
      const c = currentCard();
      if (!c) return;
      const name = reportFileName(c.fileBase, kind);
      const data = kind === 'pdf' ? renderReportPdf(c) : kind === 'html' ? (c === card ? html : renderReportHtml(c)) : renderReportCsv(c);
      if (downloadFile(data, name, FILE_TYPES[kind])) notify.success(t('report.view.downloaded', { file: name }));
      else notify.error(t('report.view.downloadFailed'));
    },
    [currentCard, card, html],
  );

  const onCopy = useCallback(async () => {
    const c = currentCard();
    if (!c) return;
    const { html: mailHtml, text } = renderReportEmail(c);
    const result = await copyForEmail(mailHtml, text);
    if (result === 'html') notify.success(t('report.view.copied'));
    else if (result === 'text') notify.success(t('report.view.copiedText'));
    else notify.error(t('report.view.copyFailed'));
  }, [currentCard]);

  const choices: ReportChoice[] = [...PRESET_CHOICES, ...(rangeable(source) && params.range ? (['range'] as const) : [])];
  const onChoice = (keys: Set<Key>) => {
    const next = [...keys][0];
    if (typeof next !== 'string' || next === choice) return;
    setSearch(
      (current) => {
        const q = new URLSearchParams(current);
        q.set('report', next);
        return q;
      },
      { replace: true },
    );
  };

  const disabled = !card;
  const checks = card ? reportChecks(card, criblCostSuggestion(snapshot)) : [];
  const backHref = hrefWithStickyParams('/', new URLSearchParams(rawSearch));
  const sweepMs = fromIso(snapshot.sweepAt);

  return (
    <Page
      className="mr-report-view"
      title={t('report.view.title')}
      subtitle={t('report.view.subtitle')}
      actions={
        <ButtonLink href={backHref} variant="tertiary" size="sm" leadingIcon={ChevronLeft}>
          {t('report.view.back')}
        </ButtonLink>
      }
      data-testid="report-view"
      data-source={source}
      data-period={card?.period.kind ?? choice}
      data-swept={Number.isFinite(sweepMs) ? snapshot.sweepAt : undefined}
    >
      <div className="mr-report-layout">
        <section className="mr-panel mr-report-controls" aria-label={t('report.view.actionsLabel')}>
          <div className="mr-report-field">
            <span className="mr-report-label" id="mr-report-period-label">
              {t('report.view.periodLabel')}
            </span>
            <ToggleButtonGroup
              aria-labelledby="mr-report-period-label"
              size="sm"
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={new Set<Key>([choice])}
              onSelectionChange={onChoice}
              items={choices.map((c) => ({ key: c, text: CHOICE_LABEL[c]() }))}
            />
            {card?.period.kind === 'range' ? <p className="mr-type-caption mr-report-range">{t('report.view.rangeHint', { words: card.period.span })}</p> : null}
          </div>
          <div className="mr-report-field" data-testid="report-prepared-for">
            <TextField label={t('report.view.preparedFor')} placeholder={t('report.view.preparedForPlaceholder')} value={preparedFor} onChange={(v) => setPreparedFor(v.slice(0, FOR_MAX))} />
          </div>
          <div className="mr-report-field" data-testid="report-note">
            <TextArea label={t('report.view.note')} placeholder={t('report.view.notePlaceholder')} value={note} onChange={(v) => setNote(v.slice(0, NOTE_MAX))} autoSize={{ minRows: 2, maxRows: 5 }} />
            <p className="mr-type-caption">{t('report.view.fieldsHint')}</p>
          </div>
          {checks.length > 0 ? (
            <div className="mr-report-checks" data-testid="report-checks">
              <p className="mr-report-label" id="mr-report-checks-label">
                {t('report.view.checksLabel')}
              </p>
              <ul aria-labelledby="mr-report-checks-label">
                {checks.map((c) => (
                  <li key={c} className="mr-type-caption">
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="mr-report-actions" role="group" aria-label={t('report.view.actionsLabel')}>
            <Button variant="primary" leadingIcon={Download} onPress={() => onDownload('pdf')} disabled={disabled} block>
              {t('report.view.downloadPdf')}
            </Button>
            <Button variant="secondary" leadingIcon={FileLines} onPress={() => onDownload('html')} disabled={disabled} block>
              {t('report.view.downloadHtml')}
            </Button>
            <Button variant="secondary" leadingIcon={CopyOutlined} onPress={() => void onCopy()} disabled={disabled} block>
              {t('report.view.copyEmail')}
            </Button>
            <Button variant="secondary" leadingIcon={Download} onPress={() => onDownload('csv')} disabled={disabled} block>
              {t('report.view.downloadCsv')}
            </Button>
          </div>
          {!live ? (
            <InlineNotice variant="inline" data-testid="report-sample-note">
              {t('report.view.sampleNote')}
            </InlineNotice>
          ) : null}
          {rangePending ? (
            <InlineNotice variant="inline" data-testid="report-range-loading">
              {t('report.view.rangeLoading')}
            </InlineNotice>
          ) : null}
          {rangeFailed ? (
            <InlineNotice variant="inline" data-testid="report-range-failed">
              {t('report.view.rangeFailed')}
            </InlineNotice>
          ) : null}
        </section>

        <section className="mr-report-preview" aria-label={t('report.view.previewLabel')}>
          <p className="mr-type-caption mr-report-preview-caption">{t('report.view.previewCaption')}</p>
          {newer ? (
            <InlineNotice action={{ label: t('report.view.update'), onClick: () => setSnapshot(newer) }} data-testid="report-newer">
              {t('report.view.newer', { time: formatTimeOfDay(newer.sweepAt, tz) })}
            </InlineNotice>
          ) : null}
          {html ? (
            <iframe className="mr-report-frame" title={t('report.view.previewLabel')} sandbox="" srcDoc={html} data-testid="report-preview" />
          ) : (
            <div className="mr-report-frame mr-report-frame--empty" aria-busy="true" data-testid="report-preview-pending" />
          )}
        </section>
      </div>
    </Page>
  );
}

/** Before the first snapshot: the same layout, the actions off, one sentence saying why. */
function ReportUnavailable({ reason }: { reason: string }) {
  const { search } = useLocation();
  return (
    <Page
      className="mr-report-view"
      title={t('report.view.title')}
      subtitle={t('report.view.subtitle')}
      actions={
        <ButtonLink href={hrefWithStickyParams('/', new URLSearchParams(search))} variant="tertiary" size="sm" leadingIcon={ChevronLeft}>
          {t('report.view.back')}
        </ButtonLink>
      }
      data-testid="report-view"
      data-state="unavailable"
    >
      <div className="mr-report-layout">
        <section className="mr-panel mr-report-controls">
          <InlineNotice variant="inline" data-testid="report-unavailable">
            {reason}
          </InlineNotice>
          <div className="mr-report-actions" role="group" aria-label={t('report.view.actionsLabel')}>
            <Button variant="primary" leadingIcon={Download} disabled block>
              {t('report.view.downloadPdf')}
            </Button>
            <Button variant="secondary" leadingIcon={FileLines} disabled block>
              {t('report.view.downloadHtml')}
            </Button>
            <Button variant="secondary" leadingIcon={CopyOutlined} disabled block>
              {t('report.view.copyEmail')}
            </Button>
            <Button variant="secondary" leadingIcon={Download} disabled block>
              {t('report.view.downloadCsv')}
            </Button>
          </div>
        </section>
        <section className="mr-report-preview" aria-label={t('report.view.previewLabel')}>
          <div className="mr-report-frame mr-report-frame--empty" />
        </section>
      </div>
    </Page>
  );
}

export default function ReportView() {
  const view = useAppState((s) => ({ snapshot: s.snapshot, phase: s.status.hydrate.phase, source: s.source }), shallowEqual);
  // Keyed by the data source: entering or leaving sample data starts a new report from its own snapshot.
  if (view.snapshot) return <ReportContent key={view.source} snapshot={view.snapshot} source={view.source} />;
  if (view.phase === 'idle' || view.phase === 'loading') return <ReportUnavailable reason={t('report.view.unavailable')} />;
  return <ReportUnavailable reason={t('report.view.waiting')} />;
}
