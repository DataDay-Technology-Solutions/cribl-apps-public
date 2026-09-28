// src/views/Report/download.ts — handing the viewer a file and putting the report on the clipboard, inside the
// App's sandboxed iframe.
//
// Measured in the live Cribl shell: the iframe's sandbox allows downloads ("allow-downloads") and its permissions
// allow clipboard writes ("clipboard-write"), but not modals — so a Blob URL clicked through <a download> works and
// window.print() does not (the HTML file prints from the browser once opened, and the PDF is its own file).

import { copyText } from '../../lib/dom.ts';

/** Saves `data` as `fileName` through a temporary Blob URL. False when the browser refused. */
export function downloadFile(data: BlobPart, fileName: string, type: string): boolean {
  try {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked later, not now: some engines start reading the Blob after the click returns.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return true;
  } catch {
    return false;
  }
}

export type EmailCopyResult = 'html' | 'text' | 'failed';

/**
 * Copies the report for an email body: rich HTML plus its plain-text twin where the Clipboard API takes a
 * ClipboardItem (the mail client pastes the richer one), else the plain text through copyText's fallbacks.
 * `navigator.clipboard.write` is called before the first await, inside the click's user activation (Safari).
 */
export async function copyForEmail(html: string, text: string): Promise<EmailCopyResult> {
  try {
    const Item = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
    if (Item && typeof navigator !== 'undefined' && typeof navigator.clipboard?.write === 'function') {
      const pending = navigator.clipboard.write([
        new Item({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) }),
      ]);
      await pending;
      return 'html';
    }
  } catch {
    // fall through to plain text
  }
  return (await copyText(text)) ? 'text' : 'failed';
}
