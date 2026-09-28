// src/components/Shell/DiagPanel.tsx — a small read-only diagnostics overlay (?diag=1, or Shift+D).
//
// The App runs in a cross-origin sandboxed iframe, so an operator (or a support screenshot) can't see its
// console. This panel prints what the App knows about its own state — hydration, where data comes from,
// the last sweep and who ran it, how far the meter has got, the Leader-call budget, the last API/KV errors —
// so one screenshot (or one "Copy diagnostics" paste) explains a blank or stuck screen at 3 a.m. It writes
// nothing, calls nothing, and shows no secrets (the API URL is reduced to its host).
//
// EPIC_AUDIT P1-A08: the rows an SRE asks for first (metered through, sweep errors and the rate-limit streak,
// the last lock holder and the delivery owner, runner freshness, groups known vs metered, the KV's dated keys,
// this tab's Leader calls in the last minute); the last sweep result as fields, not sliced JSON; the last
// sweep row flagged when it is over 3 minutes old; a Copy button (plain text) and a Close button that also
// drops ?diag from the URL; a bottom sheet with its own scroll on phones; focusable, so it scrolls by keyboard.
// What the UI does not read (the KV lock document's expiry, a sweep's held minutes) it does not invent.
// W3-LS-3: "not metered" (the gaps no sweep could meter, P1-E04, in hours with their dates) and "back-off" (the
// rate-limit window: skipped until, limited since, the streak, P1-E01) appear only while there is something to say,
// and Copy diagnostics carries them like every other row.

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, IconButton } from '@capra/core';
import { CloseOutlined, CopyOutlined } from '@capra/icons';
import { t } from '../../copy/en.ts';
import { copyText } from '../../lib/dom.ts';
import { useShortcut } from '../../lib/shortcuts.ts';
import { useAppState } from '../../state/react.tsx';
import { diagRows, diagText } from './diagRows.ts';

export function DiagPanel() {
  const [search, setSearch] = useSearchParams();
  const [open, setOpen] = useState(() => new URLSearchParams(window.location.search).get('diag') === '1');
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const close = () => {
    setOpen(false);
    if (search.has('diag')) {
      setSearch(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete('diag');
          return next;
        },
        { replace: true },
      );
    }
  };

  // Through the shell's one keyboard map (P0-05): Shift+D exactly — never ⌘⇧D or Ctrl+Shift+D, never in a
  // text field, select or dialog — and, while open, Escape closes the panel first (priority 1: above the
  // stage's Escape, whichever opened last).
  const show = () => {
    setNow(Date.now());
    setOpen(true);
  };
  useShortcut('Shift+D', () => (open ? close() : show()));
  useShortcut('Escape', close, open, 1);
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const s = useAppState((st) => st);
  if (!open) return null;

  const w = window as { CRIBL_API_URL?: string; CRIBL_BASE_PATH?: string };
  const rows = diagRows(s, now, { apiUrl: w.CRIBL_API_URL, basePath: w.CRIBL_BASE_PATH });
  const copy = async () => {
    setCopied((await copyText(diagText(rows, Date.now()))) ? 'ok' : 'failed');
  };

  return (
    // Focusable so its own scroll (a bottom sheet on phones) works by keyboard.
    <aside className="mr-diag" aria-label={t('diag.label')} data-testid="diag-panel" tabIndex={0}>
      <div className="mr-diag-head">
        <div className="mr-diag-title">{t('diag.title')}</div>
        <div className="mr-diag-actions">
          <Button variant="tertiary" size="sm" leadingIcon={CopyOutlined} onPress={() => void copy()} data-testid="diag-copy">
            {copied === 'ok' ? t('diag.copied') : copied === 'failed' ? t('diag.copyFailed') : t('diag.copy')}
          </Button>
          <IconButton icon={CloseOutlined} aria-label={t('diag.close')} variant="tertiary" appearance="neutral" size="sm" onPress={close} />
        </div>
      </div>
      <dl>
        {rows.map((row) => (
          <div key={row.key} className="mr-diag-row" data-key={row.key} data-state={row.state}>
            <dt>{row.key}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
