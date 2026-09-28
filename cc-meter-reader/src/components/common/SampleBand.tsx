// src/components/common/SampleBand.tsx — "Sample data" band (PRD 8.5, SPEC 17, DESIGN_BRIEF 5.6): visible whenever
// a tour or replay fixture is on screen, one click from clearing it. Renders nothing on live data.
//
// It reads like a receipt stamp (P2-W27): a striped left cap holding "SAMPLE DATA" (or "REPLAY") in Source Code
// Pro, the note after it, the tour's beat as a chip ("Tour · beat 3 of 10", from src/tour/status.ts, so the band
// never loads the tour chunk; visual only), the clear button, and a perforated lower edge. One grid row at every width
// (BEAUTY F5): on phones the note steps aside and the chip shortens to "3 of 10". The full sentence stays in the
// DOM (visually hidden) for screen readers; the stamp, note and chip are what the eye reads.

import { Button } from '@capra/core';
import { t } from '../../copy/en.ts';
import { useActions, useAppState } from '../../state/react.tsx';
import { useTourBeat } from '../../tour/status.ts';
import './common.css';

export function SampleBand() {
  const source = useAppState((s) => s.source);
  const { clearSample } = useActions();
  const tour = useTourBeat();
  if (source === 'live') return null;
  const replay = source === 'replay';
  const beat = !replay && tour.active && tour.beats > 1 ? { beat: tour.beat, beats: tour.beats } : null;
  return (
    <div className="mr-sample-band" role="status" data-callout="sample-band" data-source={source}>
      <span className="mr-sample-band-cap" aria-hidden="true">
        <span className="mr-sample-band-stamp">{replay ? t('sampleBand.replayStamp') : t('sampleBand.stamp')}</span>
      </span>
      <span className="mr-sample-band-text">
        <span className="mr-sample-band-full">{replay ? t('sampleBand.replayText') : t('sampleBand.text')}</span>
        <span className="mr-sample-band-note" aria-hidden="true">
          {replay ? t('sampleBand.replayNote') : t('sampleBand.note')}
        </span>
      </span>
      {beat ? (
        // Visual only: inside the band's live region a changing beat would be read out every few seconds.
        <span className="mr-sample-band-beat mr-num" aria-hidden="true" data-testid="sample-band-beat" data-beat={beat.beat} data-beats={beat.beats}>
          <span className="mr-sample-band-beat-long">{t('sampleBand.beat', beat)}</span>
          <span className="mr-sample-band-beat-short">{t('sampleBand.beatShort', beat)}</span>
        </span>
      ) : null}
      <Button size="sm" variant="secondary" onPress={clearSample}>
        {replay ? t('sampleBand.stopReplay') : t('sampleBand.clear')}
      </Button>
    </div>
  );
}
