// src/tour/TourParamSync.tsx — keeps the "Tour with sample data" and the `?tour=1` param in step (P1-M02).
//
// The tour lives in memory only (nothing is written to the member's workspace), so the URL is what carries
// it across a reload, a presenter view opened by URL (`?present=1&tour=1`) or a link someone shares:
//
//   • a page with `?tour=1` and no tour running starts the tour — without Story mode, which owns the sample
//     screen while it plays (it ends a running tour with 'replaced'; when Story closes, the tour comes back);
//   • a running tour whose URL lost the param (a toast's "View in Ledger" link) gets it back, so the next
//     reload still resumes;
//   • a tour the member ended ("Clear sample data") never restarts from a param still in the URL: the stop
//     already navigates to a path without it, and a param left behind is dropped instead.
//
// Rendered once inside the router (src/router.tsx). The controller chunk (and its fixture) loads only when a
// tour has to start; everything else reads src/tour/status.ts.

import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../copy/en.ts';
import { notify } from '../components/common/notify.tsx';
import { useAppParams } from '../lib/params.ts';
import { useServices } from '../state/react.tsx';
import { clearTourStop, meterYoursPending, useTourBeat } from './status.ts';

export function TourParamSync() {
  const [params, setParams] = useAppParams();
  const services = useServices();
  const navigate = useNavigate();
  const { active, lastStop } = useTourBeat();
  const wantsTour = params.tour && !params.story;
  // The latest ask, for a controller chunk that resolves after the URL moved on.
  const wanted = useRef(wantsTour);
  useEffect(() => {
    wanted.current = wantsTour;
  });

  // No param: the next `?tour=1` is a fresh ask, whatever ended the last tour.
  useEffect(() => {
    if (!params.tour) clearTourStop();
  }, [params.tour]);

  // A running tour always carries the param (not while Story owns the screen).
  useEffect(() => {
    if (active && !params.tour && !params.story) setParams({ tour: true });
  }, [active, params.tour, params.story, setParams]);

  // `?tour=1` with no tour: resume it, unless the member just ended it. Idempotent (StrictMode runs this
  // twice): whichever import resolves second finds the tour already running.
  useEffect(() => {
    if (!wantsTour || active) return;
    if (lastStop === 'user' || lastStop === 'cleared') {
      // After "See your own number" the stop's own navigation already leaves ?tour behind (on its way to Prices); a
      // drop from this render's stale path would send the member back to it (founder-build r1 ui-11, row 12).
      if (meterYoursPending()) return;
      setParams({ tour: null });
      return;
    }
    void import('./controller.ts')
      .then(({ getActiveTour, startSampleTour, takeTourResume }) => {
        if (!wanted.current || getActiveTour()) return;
        // Back from Story: the beat it stood at (a reload or a shared link starts at the top).
        const resumeAtSec = lastStop === 'replaced' ? takeTourResume() : undefined;
        startSampleTour(services, { navigate: (to) => navigate(to), ...(resumeAtSec !== undefined ? { resumeAtSec } : {}) });
      })
      .catch((error: unknown) => {
        console.error('[meter-reader] tour failed to resume', error);
        notify.error(t('tour.startFailed', { reason: error instanceof Error ? error.message : String(error) }));
        setParams({ tour: null });
      });
  }, [wantsTour, active, lastStop, services, navigate, setParams]);

  return null;
}
