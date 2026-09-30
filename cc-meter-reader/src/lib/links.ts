// src/lib/links.ts — external links the UI shows. The repository URL has one definition (core/settings.ts,
// where it is also the presenter QR default).

import { DEFAULT_QR_URL } from '../../core/settings.ts';
import { linkBaseFrom } from '../../core/runtime.ts';
import { apiBaseUrl } from './env.ts';

export const REPO_URL: string = DEFAULT_QR_URL;

/**
 * The deep-link base the sweep's own alerts use (core/runtime.ts linkBaseFrom on CRIBL_API_URL and CRIBL_BASE_PATH,
 * contract C2), so what the App previews links where the delivered message links, never the frame's own origin.
 * '' when the API URL can't be resolved (outside Cribl with no emulator).
 */
export function appLinkBase(): string {
  if (typeof window === 'undefined') return '';
  try {
    return linkBaseFrom(new URL(apiBaseUrl(), window.location.href).href, window.CRIBL_BASE_PATH);
  } catch {
    return '';
  }
}
