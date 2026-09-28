// src/components/IncidentCard/SeverityGlyph.tsx — one glyph per severity, from the Capra icon set (PRD 8.8
// item 11: one icon set, one stroke weight). Colour comes from the wrapper, and the glyph always carries
// an accessible name so severity is never conveyed by colour alone.

import { AttentionSolid, CircleCheckSolid, CircleInfoSolid, WarningSolid } from '@capra/icons';
import { t } from '../../copy/en.ts';
import type { Tone } from './model.ts';
import './SeverityGlyph.css';

export type GlyphSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const ICONS = {
  high: AttentionSolid,
  medium: WarningSolid,
  info: CircleInfoSolid,
  recovered: CircleCheckSolid,
} as const;

const LABELS: Record<Tone, () => string> = {
  high: () => t('incidents.severity.high'),
  medium: () => t('incidents.severity.medium'),
  info: () => t('incidents.severity.info'),
  recovered: () => t('incidents.severity.recovered'),
};

export interface SeverityGlyphProps {
  tone: Tone;
  size?: GlyphSize;
}

export function SeverityGlyph({ tone, size = 'sm' }: SeverityGlyphProps) {
  const Icon = ICONS[tone];
  return (
    <span className={`mr-inc-glyph mr-inc-glyph--${tone}`} role="img" aria-label={LABELS[tone]()}>
      <Icon size={size} aria-hidden="true" />
    </span>
  );
}
