// src/views/Settings/shared.tsx — the components every Settings section shares: the section card, its save
// bar, and the "reading your destinations" wait. Hooks and helpers live in ./hooks.ts.
//
// Dirty state (EPIC_AUDIT P1-G07): every SaveBar reports whether its section has unsaved changes to the
// Settings frame (SettingsFrameContext in ./hooks.ts, provided by ./index.tsx), which marks the section in the
// rail, keeps a dirty section mounted when the member switches to another one, and guards the page against
// unloading. The card's footer sticks to the bottom of the viewport while its bar is dirty or shows a failed
// save (Settings.css), and a failed save keeps its line in the bar until the next attempt.

import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { Button } from '@capra/core';
import { LoadingBlock } from '../../components/common/Loading.tsx';
import { t, tn } from '../../copy/en.ts';
import { SettingsFailuresContext, SettingsFrameContext } from './hooks.ts';

/** The id of the SectionCard a SaveBar sits in. */
const SectionIdContext = createContext<string | null>(null);

// ─── Section card ────────────────────────────────────────────────────────────

export interface SectionCardProps {
  id: string;
  title: string;
  description?: ReactNode;
  /** Right side of the header (counts, a secondary action). */
  aside?: ReactNode;
  children: ReactNode;
  /** The save bar, or any footer. */
  footer?: ReactNode;
  /** Extra class on the body (layout variants). */
  bodyClassName?: string;
}

export function SectionCard({ id, title, description, aside, children, footer, bodyClassName }: SectionCardProps) {
  const headingId = `mr-set-${id}-title`;
  return (
    <SectionIdContext.Provider value={id}>
      <section className="mr-set-card" aria-labelledby={headingId} data-section={id}>
        <header className="mr-set-card-head">
          <div className="mr-set-card-heading">
            <h2 id={headingId} className="mr-set-card-title">
              {title}
            </h2>
            {description ? <p className="mr-set-card-desc">{description}</p> : null}
          </div>
          {aside ? <div className="mr-set-card-aside">{aside}</div> : null}
        </header>
        <div className={bodyClassName ? `mr-set-card-body ${bodyClassName}` : 'mr-set-card-body'}>{children}</div>
        {footer ? <footer className="mr-set-card-foot">{footer}</footer> : null}
      </section>
    </SectionIdContext.Provider>
  );
}

// ─── Save bar ────────────────────────────────────────────────────────────────

export interface SaveBarProps {
  /** Changed fields/rows. */
  dirty: number;
  /** Fields with an inline error (only the ones on show). */
  errors: number;
  saving: boolean;
  /** Writes are possible (hydrated, live data). */
  writable: boolean;
  onSave: () => void;
  onDiscard: () => void;
  /** Shown when nothing is dirty (e.g. the price-version note). */
  note?: ReactNode;
  /**
   * A failed save's line ("Couldn't save (403). Try again."). By default the Settings frame supplies the one
   * this section's last save left, kept until the next Save press.
   */
  failure?: string | null;
  /** The primary button's label when it is not "Save changes" (P2-W09: "Start the meter" on a never-priced workspace). */
  saveLabel?: string;
  /** Said instead of "N unsaved changes" while dirty (P2-W09: what the first save will start). */
  dirtyNote?: ReactNode;
}

export function SaveBar({ dirty, errors, saving, writable, onSave, onDiscard, note, failure: failureProp, saveLabel, dirtyNote }: SaveBarProps) {
  const section = useContext(SectionIdContext);
  const registry = useContext(SettingsFrameContext);
  const failures = useContext(SettingsFailuresContext);
  const failure = failureProp ?? (section ? failures[section] : undefined) ?? null;
  const isDirty = dirty > 0;
  useEffect(() => {
    if (section && registry) registry.setDirty(section, isDirty);
  }, [section, registry, isDirty]);
  useEffect(
    () => () => {
      if (section && registry) registry.setDirty(section, false);
    },
    [section, registry],
  );

  let status: ReactNode;
  if (errors > 0) status = <span className="mr-set-status mr-set-status--error">{tn('settings.fixErrors', errors)}</span>;
  else if (failure)
    status = (
      <span className="mr-set-status mr-set-status--error" data-testid="save-failure">
        {failure}
      </span>
    );
  else if (isDirty) status = <span className="mr-set-status mr-set-status--dirty">{dirtyNote ?? tn('settings.unsaved', dirty)}</span>;
  else status = <span className="mr-set-status">{note ?? t('settings.noChanges')}</span>;
  return (
    <div className="mr-set-savebar" data-dirty={isDirty ? 'true' : undefined} data-failure={failure ? 'true' : undefined}>
      <div className="mr-set-savebar-status" aria-live="polite">
        {status}
      </div>
      <div className="mr-set-savebar-actions">
        <Button variant="tertiary" disabled={dirty === 0 || saving} onPress={onDiscard}>
          {t('settings.discard')}
        </Button>
        <Button
          variant="primary"
          pending={saving}
          disabled={!writable || dirty === 0}
          onPress={() => {
            // A new attempt: the last failure's line goes until this one reports.
            if (section && registry) registry.savePressed(section);
            onSave();
          }}
        >
          {saveLabel ?? t('settings.save')}
        </Button>
      </div>
    </div>
  );
}

// ─── Waiting for the first sweep ─────────────────────────────────────────────

/** A fresh install has no inventory until the first sweep (~3 s after hydration): a designed wait, not "empty". */
export function WaitingForInventory({ action }: { action?: ReactNode }) {
  return (
    <div className="mr-set-waiting" data-state="waiting">
      <LoadingBlock loading rows={3} title={false} />
      <div className="mr-set-waiting-copy">
        <p className="mr-set-waiting-title">{t('settings.prices.waitingTitle')}</p>
        <p className="mr-set-muted">{t('settings.prices.waitingBody')}</p>
      </div>
      {action}
    </div>
  );
}
