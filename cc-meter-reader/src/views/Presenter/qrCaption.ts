// src/views/Presenter/qrCaption.ts — the stage QR's caption (OQ-04, D51). Its own module so the Presenter view exports only
// its component (React Fast Refresh; oxlint react/only-export-components).

import { qrDestination } from '../../../core/settings.ts';
import { t } from '../../copy/en.ts';

/**
 * The QR's caption: where the code goes (OQ-04, D51), and nothing it does not lead to — a vote ask under a code that
 * opens the Cribl Innovators Network would promise what the code does not do (and four more lines pushed the code
 * off a 1080p stage).
 */
export function presenterQrCaption(url: string): string {
  const where = qrDestination(url);
  return t(`presenter.qrCaption.${where.kind}`, { host: where.host });
}
