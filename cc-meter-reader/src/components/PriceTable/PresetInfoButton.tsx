// src/components/PriceTable/PresetInfoButton.tsx — the ⓘ beside a row's preset picker (SPEC 6).
//
// Opens a popover that says what the preset's typical price rests on: the typical value and range, how
// firm it is, the basis (how the vendor's pricing model becomes a per-GB figure, with its caveats), the
// sources, and the one line that keeps it honest: "Typical list pricing, not a quote. Enter your contract
// rate." A popover rather than a tooltip because the basis runs to a paragraph and the sources are links
// (Capra's Tooltip takes a plain string). The basis and sources are data from core/presets.ts
// PRESET_NOTES; every framing word comes from src/copy/en.ts.

import { memo } from 'react';
import { IconButton, Popover } from '@capra/core';
import { InfoOutlined } from '@capra/icons';
import type { PresetId } from '../../../core/types.ts';
import { t } from '../../copy/en.ts';
import { presetInfo } from './model.ts';

/** 'https://www.datadoghq.com/pricing/list/' → 'datadoghq.com'. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export interface PresetInfoButtonProps {
  preset: PresetId;
  /** The row's destination name, for the button's accessible name. */
  rowName: string;
}

export const PresetInfoButton = memo(function PresetInfoButton({ preset, rowName }: PresetInfoButtonProps) {
  const info = presetInfo(preset);
  // The not-a-quote line sits under the title, always in view; the basis and sources scroll beneath it.
  const content = (
    <div className="mr-pt-info" data-testid={`preset-info-${preset}`}>
      <p className="mr-pt-info-title">{t('settings.prices.presetInfoTitle', { preset: info.label, typical: info.typical })}</p>
      <p className="mr-pt-info-range">
        {info.free ? t('settings.prices.presetRangeFree') : t('settings.prices.presetRange', { low: info.low, high: info.high })}
        {' · '}
        {t(`settings.prices.presetConfidence.${info.confidence}`)}
      </p>
      <p className="mr-pt-info-disclaimer" data-testid="preset-disclaimer">
        {t('settings.prices.presetDisclaimer')}
      </p>
      <div className="mr-pt-info-scroll" role="region" aria-label={t('settings.prices.presetBasis')} tabIndex={0}>
        {info.basis ? <p className="mr-pt-info-basis">{info.basis}</p> : null}
        {info.sources.length > 0 ? (
          <>
            <p className="mr-pt-info-heading">{t('settings.prices.presetSources')}</p>
            <ol className="mr-pt-info-sources">
              {info.sources.map((s) => (
                <li key={s.url}>
                  {/* The publisher names the source (P1-G03: never 'assets.ctfassets.net'); the host is in the hover. */}
                  <a href={s.url} target="_blank" rel="noopener noreferrer" title={hostOf(s.url)}>
                    {s.publisher ?? hostOf(s.url)}
                  </a>
                  <q className="mr-pt-info-quote">{s.quote}</q>
                </li>
              ))}
            </ol>
          </>
        ) : null}
      </div>
    </div>
  );
  return (
    // A 32 px button with a 44 px hit area (P1-G03; PriceTable.css `.mr-pt-info-hit`).
    <span className="mr-pt-info-hit">
      <Popover content={content} placement="bottomRight">
        <IconButton
          icon={InfoOutlined}
          variant="tertiary"
          size="md"
          aria-label={`${t('settings.prices.presetInfo', { preset: info.label })}, ${rowName}`}
          data-testid="preset-info-button"
        />
      </Popover>
    </span>
  );
});
