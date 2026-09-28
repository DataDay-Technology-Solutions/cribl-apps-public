// src/components/SlackPreview — a faithful Block Kit renderer framed like a Slack message (DESIGN_BRIEF 5.8).
export { SlackPreview, type SlackPreviewProps } from './SlackPreview.tsx';
export { SlackGlyph } from './SlackGlyph.tsx';
export { toSlackMessage, type Block, type Message, type TextObject } from './message.ts';
export { renderMrkdwn, renderInline, decodeEntities } from './mrkdwn.tsx';
export { SHORTCODE_GLYPHS, type GlyphName } from './glyphs.ts';
