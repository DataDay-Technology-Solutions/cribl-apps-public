// src/components/IncidentsRail/IncidentsRail.tsx — open and recent alerts with delivery status (PRD 8.3,
// DESIGN_BRIEF 5.4). Right of the change timeline on desktop, below it on phones. Each alert renders as the
// shared compact IncidentCard (src/components/IncidentCard), the same card the Receipt's Alerts card uses.
// "Show in table" sits in each card's own footer and selects the alert's object in the Ledger (?object=).
// The demo-profile note ("1-minute confirmation …") is said once, under the rail's caption, not in every card.
// Beside the timeline the rail is as tall as the timeline card, and its alerts scroll inside it past a cap
// (Ledger.css); the header stays put.

import { Button } from '@capra/core';
import { CircleCheck } from '@capra/icons';
import type { Incident } from '../../../core/types.ts';
import { t, tn } from '../../copy/en.ts';
import { formatInt } from '../../lib/format.ts';
import { DEMO_PROFILE_NOTE, IncidentCard, hasNote } from '../IncidentCard/index.ts';
import { partitionIncidents } from './model.ts';
import './IncidentsRail.css';

export interface IncidentsRailProps {
  /** snapshot.incidents: open + closed in the last 24 h, newest first */
  incidents: readonly Incident[];
  /** how many flows the detector watches (empty-state copy) */
  flowsWatched: number;
  /** "Show in table" — the Ledger selects and scrolls to the object */
  onSelectObject?: (objectKey: string) => void;
  /** the currently selected object (its alert is marked) */
  selectedObject?: string;
  /** the snapshot could not be read (P1-K06): no check mark and no "No open alerts" claim — it can't be known */
  unavailable?: boolean;
}

function RailItem({
  incident,
  selected,
  onSelectObject,
}: {
  incident: Incident;
  selected: boolean;
  onSelectObject?: (key: string) => void;
}) {
  return (
    <li className={`mr-rail-item${selected ? ' is-selected' : ''}`} data-incident={incident.id}>
      <IncidentCard
        incident={incident}
        variant="compact"
        showLedgerLink={false}
        showDemoNote={false}
        headingLevel="h4"
        action={
          onSelectObject ? (
            <Button variant="tertiary" size="sm" onPress={() => onSelectObject(incident.objectKey)}>
              {t('ledger.rail.showInTable')}
            </Button>
          ) : undefined
        }
      />
    </li>
  );
}

export function IncidentsRail({ incidents, flowsWatched, onSelectObject, selectedObject, unavailable = false }: IncidentsRailProps) {
  const { open, recent } = partitionIncidents(incidents);
  const demoProfile = incidents.some((i) => hasNote(i, DEMO_PROFILE_NOTE));
  return (
    <section className="mr-rail mr-panel" aria-labelledby="mr-rail-title" data-testid="incidents-rail">
      <header className="mr-rail-head">
        <div className="mr-rail-titles">
          <h2 id="mr-rail-title" className="mr-rail-title">
            {t('ledger.rail.title')}
            {open.length > 0 ? (
              <span className="mr-rail-count mr-num">
                {open.length}
                <span className="mr-visually-hidden"> {t('ledger.rail.countSuffix')}</span>
              </span>
            ) : null}
          </h2>
          <p className="mr-rail-caption">{t('ledger.rail.caption')}</p>
          {demoProfile ? (
            <p className="mr-rail-note" data-testid="rail-demo-note">
              {t('demoProfile.notice')}
            </p>
          ) : null}
        </div>
      </header>

      <div className="mr-rail-body">
        {unavailable && incidents.length === 0 ? (
          <div className="mr-rail-empty" data-state="unavailable">
            <div>
              <p className="mr-rail-empty-title">{t('ledger.rail.unavailableTitle')}</p>
              <p className="mr-rail-empty-body">{t('ledger.rail.unavailableBody')}</p>
            </div>
          </div>
        ) : open.length === 0 ? (
          <div className="mr-rail-empty" data-state="no-open-alerts">
            <span className="mr-rail-empty-mark" aria-hidden="true">
              <CircleCheck size="sm" />
            </span>
            <div>
              <p className="mr-rail-empty-title">{t('ledger.rail.emptyTitle')}</p>
              <p className="mr-rail-empty-body">
                {flowsWatched > 0
                  ? tn('ledger.rail.emptyBody', flowsWatched, {
                      n: formatInt(flowsWatched),
                    })
                  : t('ledger.rail.emptyBodyNoFlows')}
              </p>
            </div>
          </div>
        ) : (
          <div className="mr-rail-group">
            <h3 className="mr-rail-group-title">{t('ledger.rail.open')}</h3>
            <ul className="mr-rail-list">
              {open.map((i) => (
                <RailItem key={i.id} incident={i} selected={selectedObject === i.objectKey} onSelectObject={onSelectObject} />
              ))}
            </ul>
          </div>
        )}

        {recent.length > 0 ? (
          <div className="mr-rail-group">
            <h3 className="mr-rail-group-title">{t('ledger.rail.recent')}</h3>
            <ul className="mr-rail-list">
              {recent.map((i) => (
                <RailItem key={i.id} incident={i} selected={selectedObject === i.objectKey} onSelectObject={onSelectObject} />
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
