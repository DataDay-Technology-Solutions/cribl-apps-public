// src/components/QrBlock/qrPath.ts — a QR code as ONE SVG path, from the `qrcode` package's encoder.
//
// `create()` is the same encoder `QRCode.toString(url, { type: 'svg' })` renders from; drawing its module
// matrix ourselves gives the identical symbol as a React <path> — no SVG string, no innerHTML, no canvas
// (the sandbox forbids same-origin canvas reads, PRD:203), and nothing a URL could inject into.
//
// Only the encoder is imported (`qrcode/lib/core/qrcode.js`): the package root's browser entry also bundles
// the canvas renderer, and a release bundle must not carry a `getContext('2d')` it never calls (REVIEW-3a #14).

import type { QRCode, QRCodeOptions } from 'qrcode';
// @ts-expect-error — the encoder's deep path ships no types; `create` is typed from @types/qrcode just below.
import { create as createUntyped } from 'qrcode/lib/core/qrcode.js';

const create = createUntyped as (text: string, options?: QRCodeOptions) => QRCode;

export interface QrPath {
  /** width = height of the symbol in modules, including the quiet-zone margin */
  size: number;
  /** path data: one `M x y h n v 1 h -n z` rectangle per horizontal run of dark modules */
  d: string;
  /** QR version (1–40), for tests */
  version: number;
}

/**
 * Encodes `text` at error-correction level M (≈ 15 % recoverable — scans reliably off a projector) and
 * returns the path. `margin` is the quiet zone in modules (the spec asks for 4; the plate adds more).
 */
export function qrPath(text: string, margin = 2): QrPath {
  const qr = create(text || ' ', { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const data = qr.modules.data;
  let d = '';
  for (let row = 0; row < n; row++) {
    let col = 0;
    while (col < n) {
      if (!data[row * n + col]) {
        col++;
        continue;
      }
      const start = col;
      while (col < n && data[row * n + col]) col++;
      d += `M${start + margin} ${row + margin}h${col - start}v1h-${col - start}z`;
    }
  }
  return { size: n + margin * 2, d, version: qr.version };
}

/** 'https://github.com/x/y/' → 'github.com/x/y' (the address printed under the code). */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}
