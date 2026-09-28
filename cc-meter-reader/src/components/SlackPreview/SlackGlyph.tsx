// src/components/SlackPreview/SlackGlyph.tsx — a drawn stand-in for a Slack emoji: a filled circle per
// severity, or a small receipt. Drawn rather than typed so it renders the same on every OS and in headless
// browsers (no emoji font needed), and never counts as emoji in the UI (PRD 8.8 item 11).

import { t } from '../../copy/en.ts';
import type { GlyphName } from './glyphs.ts';

const GLYPH_LABEL: Record<GlyphName, () => string> = {
  red: () => t('slackPreview.glyph.high'),
  orange: () => t('slackPreview.glyph.medium'),
  green: () => t('slackPreview.glyph.recovered'),
  blue: () => t('slackPreview.glyph.info'),
  receipt: () => t('slackPreview.glyph.receipt'),
};

export function SlackGlyph({ name }: { name: GlyphName }) {
  if (name === 'receipt') {
    return (
      <svg className="mr-slack-glyph mr-slack-glyph--receipt" viewBox="0 0 16 16" role="img" aria-label={GLYPH_LABEL.receipt()}>
        <path d="M3 1.5h10v12.5l-1.67-1.25L9.67 14 8 12.75 6.33 14 4.67 12.75 3 14z" className="mr-slack-glyph-paper" />
        <path d="M5.5 5h5M5.5 7.5h5M5.5 10h3" className="mr-slack-glyph-lines" />
      </svg>
    );
  }
  return <span className={`mr-slack-glyph mr-slack-glyph--${name}`} role="img" aria-label={GLYPH_LABEL[name]()} />;
}
