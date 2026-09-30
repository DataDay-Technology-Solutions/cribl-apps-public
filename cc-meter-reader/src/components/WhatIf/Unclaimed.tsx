// src/components/WhatIf/Unclaimed.tsx — "Biggest unclaimed savings" (P2-W23): above the calculator, a short
// receipt of the savings this workspace has not taken yet — every stream × the next pack written for it
// (core/whatif.ts unclaimedSavings, on the calculator's own bases), largest first, top five, with dot leaders; a
// documented basis prints its range, never a point it did not measure.
// Each line loads the calculator on that stream and treatment (?stream=&treatment=).

import { useId } from 'react';
import { Link } from 'react-router-dom';
import { humanize } from '../../../core/humanize.ts';
import { t, type CopyKey } from '../../copy/en.ts';
import { Fig } from './Fig.tsx';
import { streamLabels } from './streamLabel.ts';
import { signedMoneyFigure, spanOf } from './figures.ts';
import type { WhatIfModel } from './useWhatIf.ts';
import '../ReceiptList/ReceiptList.css';

export function Unclaimed({ model, humanizeOverrides }: { model: WhatIfModel; humanizeOverrides?: Record<string, string> }) {
  const headingId = useId();
  if (model.appliedAt !== undefined) return null;
  const lines = model.unclaimed;
  // One name per stream, as the Stream picker below names it: "Source → Destination" when a Source feeds several.
  const labels = streamLabels([...model.streams, ...lines.map((l) => ({ key: l.streamKey, flow: l.flow }))].filter((s, i, all) => all.findIndex((x) => x.key === s.key) === i), humanizeOverrides);
  return (
    <section className="mr-whatif-unclaimed" aria-labelledby={headingId} data-testid="whatif-unclaimed">
      <div className="mr-whatif-unclaimed-head">
        {/* The page's first section under its h1 (the a11y heading order, P1-A09): an h2, like "Compared with". */}
        <h2 id={headingId} className="mr-whatif-subhead">
          {t('whatif.unclaimed.title')}
        </h2>
        <p className="mr-whatif-note">{t('whatif.unclaimed.caption')}</p>
      </div>
      {lines.length === 0 ? (
        // Why the list is empty (founder-build r1 ui-4, row 2): "already runs the pack" only when every stream a pack
        // fits runs it, never on a workspace no pack fits.
        <p className="mr-whatif-note" data-testid="whatif-unclaimed-none" data-reason={model.unclaimedEmpty ?? 'none'}>
          {t(`whatif.unclaimed.${model.unclaimedEmpty ?? 'none'}` as CopyKey)}
        </p>
      ) : (
        <ol className="mr-rlist mr-whatif-unclaimed-list" aria-label={t('whatif.unclaimed.listLabel')}>
          {lines.map((line) => {
            const treatment = t(`whatif.treatments.${line.treatment}` as CopyKey);
            const stream = labels.get(line.streamKey) ?? (humanize(line.flow.inputId, humanizeOverrides) || line.flow.inputId);
            // A point estimate prints exactly; a documented range prints as the range (ranked by its middle).
            const figure = signedMoneyFigure(...spanOf(line.estimate, (p) => p.deltaSavedPerYearM));
            const amount = figure.text;
            const current = model.stream?.key === line.streamKey && model.treatmentKey === line.treatment;
            return (
              <li key={`${line.streamKey}|${line.treatment}`} className="mr-rlist-item">
                <Link
                  to={model.linkFor(line.streamKey, line.treatment)}
                  replace
                  className="mr-rlist-line mr-rlist-line--link mr-whatif-unclaimed-line"
                  aria-current={current ? 'true' : undefined}
                  aria-label={t('whatif.unclaimed.aria', { treatment, stream, amount })}
                  data-stream={line.streamKey}
                  data-treatment={line.treatment}
                  data-delta={line.deltaPerYearM}
                >
                  {/* The Receipt's line (ReceiptList.tsx, P1-H02): the words wrap inside their box and the leader's
                      anchor follows the last word, so the box clips the dots before the figure. */}
                  <span className="mr-rlist-labelbox">
                    <span className="mr-rlist-label">
                      {t('whatif.unclaimed.line', { treatment, stream })}
                      <span className="mr-rlist-leader" aria-hidden="true" />
                    </span>
                  </span>
                  <Fig f={figure} className="mr-rlist-amount" />
                  <span className="mr-rlist-per">{t('units.perYear')}</span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
