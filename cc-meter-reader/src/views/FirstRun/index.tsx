// src/views/FirstRun/index.tsx — First run (`/first-run`; PRD 8.5, DESIGN_BRIEF 5.6, SPEC 17).
//
// A judge installs Meter Reader into an empty workspace. One centred card answers "what is this, and
// what do I do now?": the card's meter (a dimmed "$–––,–––" above a perforated edge that rolls to the sample's
// figure when the tour button is hovered or focused, P2-W27), the one-sentence promise, the four-step
// how-it-works strip (lighting step by step on mount), then two paths —
// "Set prices to start the meter" (primary, → /settings/prices) and "Tour with sample data" (secondary,
// plays the bundled enterprise workspace under the SAMPLE DATA band) — and a link to the 90-second story.
// The footer says what the app needs (PRD 8.6: roles, and "collecting since" once metering has begun).
//
// Gate (src/tour/selectors.ts): shown while the member's live workspace has no priced destination and no
// tour owns the screen; otherwise it hands over to the Receipt at `/`.
//
// The tour controller (and the ~270 KB fixture bundled with it) is a separate chunk: prefetched right
// after the card paints, so the card never waits on it and the click still starts the tour at once.

import { useCallback, useEffect, useId, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Button, ButtonLink, Link } from '@capra/core';
import { GaugeSimpleHigh, Play } from '@capra/icons';
import { formatLocalDateTime, fromIso } from '../../../core/time.ts';
import { t } from '../../copy/en.ts';
import { notify } from '../../components/common/notify.tsx';
import { Credit } from '../../components/common/Credit.tsx';
import { ViewSkeleton } from '../../components/common/Loading.tsx';
import { parseFlag, patchSearchParams } from '../../lib/params.ts';
import { shallowEqual, useAppState, useServices } from '../../state/react.tsx';
import { firstRunGate } from '../../tour/selectors.ts';
import { SAMPLE_WORKSPACE } from '../../tour/workspace.ts';
import { HowItWorks } from '../../components/HowItWorks/index.ts';
import { Page } from '../../components/Shell/Page.tsx';
import { CardMeter } from './CardMeter.tsx';
import './FirstRun.css';

const loadTour = () => import('../../tour/controller.ts');

export default function FirstRunView() {
  const services = useServices();
  const navigate = useNavigate();
  const { search } = useLocation();
  const titleId = useId();
  const howId = useId();
  const view = useAppState(
    (s) => ({
      gate: firstRunGate(s),
      collectingSince: s.source === 'live' ? s.meta?.collectingSince : s.liveStash?.meta?.collectingSince,
      tz: s.settings.displayTimezone,
    }),
    shallowEqual,
  );

  const [starting, setStarting] = useState(false);
  // The card's meter rolls to the sample's figure while the tour button is pointed at or focused.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [sampleMtdM, setSampleMtdM] = useState<number | null>(null);

  // Prefetch the tour chunk once the card is on screen; it also answers the figure the tour will open on.
  useEffect(() => {
    let live = true;
    const handle = setTimeout(
      () =>
        void loadTour()
          .then(({ sampleOpeningMtdM }) => {
            if (live) setSampleMtdM(sampleOpeningMtdM());
          })
          .catch(() => undefined),
      0,
    );
    return () => {
      live = false;
      clearTimeout(handle);
    };
  }, []);

  const startTour = useCallback(async () => {
    setStarting(true);
    try {
      const { startSampleTour } = await loadTour();
      startSampleTour(services, { navigate: (to) => navigate(to) });
      // `?tour=1` is sticky: a reload, the presenter or a shared link resume the tour (P1-M02).
      navigate({ pathname: '/', search: `?${patchSearchParams(new URLSearchParams(search), { tour: true }).toString()}` });
    } catch (error) {
      console.error('[meter-reader] tour failed to start', error);
      notify.error(t('tour.startFailed', { reason: error instanceof Error ? error.message : String(error) }));
      setStarting(false);
    }
  }, [services, navigate, search]);

  // `?tour=1` on a fresh page: src/tour/TourParamSync.tsx is starting the tour, so hold the skeleton
  // instead of flashing the card for the moment the tour chunk takes (it drops the param if it can't).
  const resuming = parseFlag(new URLSearchParams(search).get('tour'));
  if (view.gate === 'loading' || (resuming && view.gate === 'show')) return <ViewSkeleton />;
  if (view.gate !== 'show') return <Navigate to={{ pathname: '/', search }} replace />;

  const storyHref = `?${patchSearchParams(new URLSearchParams(search), { story: true }).toString()}`;
  const facts = SAMPLE_WORKSPACE;
  const sinceMs = view.collectingSince ? fromIso(view.collectingSince) : Number.NaN;

  return (
    // The Shell's one page frame, narrow (720 px): a lone centred card whose own h1 is the page title (F7).
    <Page width="narrow" className="mr-fr" role="region" aria-labelledby={titleId}>
      <article className="mr-fr-card" data-testid="first-run">
        <CardMeter valueM={sampleMtdM} rolled={hovered || focused || starting} />
        <header className="mr-fr-header">
          {/* The eyebrow's line carries the builder's signature at its far end (credit.firstRun). */}
          <div className="mr-fr-eyebrow-row">
            <p className="mr-fr-eyebrow">
              <span className="mr-fr-eyebrow-icon" aria-hidden="true">
                <GaugeSimpleHigh size="sm" />
              </span>
              {t('tour.eyebrow')}
            </p>
            <p className="mr-fr-credit">
              <Credit copyKey="credit.firstRun" testId="first-run-credit" />
            </p>
          </div>
          <h1 id={titleId} className="mr-fr-title">
            {t('firstRun.title')}
          </h1>
          <p className="mr-fr-lede">{t('tour.lede')}</p>
        </header>

        <section className="mr-fr-how" aria-labelledby={howId}>
          <h2 id={howId} className="mr-fr-label">
            {t('tour.howTitle')}
          </h2>
          <HowItWorks variant="strip" sequence ariaLabel={t('tour.howTitle')} />
        </section>

        <div className="mr-fr-actions" role="group" aria-label={t('tour.actionsLabel')}>
          <div className="mr-fr-buttons">
            <span className="mr-fr-button">
              <ButtonLink href="/settings/prices" variant="primary" size="lg" block>
                {t('firstRun.setPrices')}
              </ButtonLink>
            </span>
            <span
              className="mr-fr-button"
              onPointerEnter={() => setHovered(true)}
              onPointerLeave={() => setHovered(false)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
            >
              <Button variant="secondary" size="lg" block pending={starting} onPress={() => void startTour()} data-testid="start-tour">
                {t('firstRun.tour')}
              </Button>
            </span>
          </div>
          <p className="mr-fr-note">
            <span>{t('tour.tourNote', { sources: facts.sources, destinations: facts.destinations, days: facts.historyDays })}</span>{' '}
            <span>{t('tour.tourSafe')}</span>
          </p>
        </div>

        <div className="mr-fr-story">
          <span className="mr-fr-story-icon" aria-hidden="true">
            <Play size="sm" />
          </span>
          <span className="mr-fr-story-text">
            <Link href={storyHref}>{t('firstRun.watchStory')}</Link>
            <span className="mr-fr-story-note">{t('tour.storyNote')}</span>
          </span>
        </div>

        <footer className="mr-fr-footer">
          <p className="mr-fr-needs">
            <span className="mr-fr-needs-title">{t('firstRun.rolesTitle')}</span>
            <span>{t('firstRun.rolesBody')}</span>
          </p>
          {Number.isFinite(sinceMs) ? (
            <p className="mr-fr-since mr-num">{t('firstRun.collectingSince', { time: formatLocalDateTime(sinceMs, view.tz || 'UTC') })}</p>
          ) : null}
        </footer>
      </article>
    </Page>
  );
}
