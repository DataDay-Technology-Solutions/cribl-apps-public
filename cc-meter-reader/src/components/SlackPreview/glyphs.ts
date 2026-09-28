// src/components/SlackPreview/glyphs.ts — the Slack emoji shortcodes Meter Reader sends (core/payloads.ts
// slackGlyph) and the drawn glyph each becomes.

export type GlyphName = 'red' | 'orange' | 'green' | 'blue' | 'receipt';

export const SHORTCODE_GLYPHS: Readonly<Record<string, GlyphName>> = {
  red_circle: 'red',
  large_red_circle: 'red',
  large_orange_circle: 'orange',
  orange_circle: 'orange',
  large_green_circle: 'green',
  green_circle: 'green',
  large_blue_circle: 'blue',
  blue_circle: 'blue',
  receipt: 'receipt',
};
