// P1-F05 — the words in receipts and notifications have one home. They lived as literals in core/receipt.ts and
// core/payloads.ts and had drifted from en.ts ('Open alerts: none' there, 'Open alerts: 0' in en.ts, '1 (…)' in the
// README). Now they live in core/strings.ts (core/ builds without src/), en.ts re-exports that module, the dead
// receipt.weekly* keys are gone, and the README's sample is the renderer's own output.
//
// The proof: receipt.ts and payloads.ts hold no quoted phrase — no literal with two words, and no capitalized word —
// outside comments, so every word they render into a receipt, a Slack message, a ServiceNow ticket or the bell
// comes from core/strings.ts.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CORE_STRINGS, PAYLOAD_STRINGS, RECEIPT_STRINGS, fill, plural } from '../../core/strings.ts';
import * as en from '../../src/copy/en.ts';
import { receiptText } from '../../core/receipt.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/** Source with comments removed (line and block), keeping string literals intact. */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    out += c;
    i++;
  }
  return out;
}

/** The text parts of every string literal: quoted strings whole, template literals outside their ${…}. */
function literalTexts(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (m[3] !== undefined) out.push(...m[3].split(/\$\{[^}]*\}/));
    else out.push(m[1] ?? m[2] ?? '');
  }
  return out;
}

/** A phrase a person would read: two words, or a capitalized word (code keys and ids are one lowercase token). */
const isProse = (s: string): boolean =>
  !/^[a-z]{2}-[A-Z]{2}$/.test(s) && // a locale ('en-US')
  (/[A-Za-z]{2,}[\s,;:.]+\s*[A-Za-z]{2,}/.test(s) && /\s/.test(s)) || /(^|[^A-Za-z_])[A-Z][a-z]{2,}/.test(s);

describe('P1-F05 · receipt and notification words live in core/strings.ts', () => {
  it('core/receipt.ts and core/payloads.ts hold no quoted phrase: everything they render comes from core/strings.ts', () => {
    for (const file of ['core/receipt.ts', 'core/payloads.ts']) {
      const prose = literalTexts(read(file)).filter((s) => isProse(s) && !s.startsWith('./') && !s.startsWith('../'));
      expect(prose, `${file} renders words not defined in core/strings.ts`).toEqual([]);
    }
  });

  it('the scanner is not vacuous: it finds the phrases core/strings.ts defines', () => {
    const found = literalTexts(read('core/strings.ts')).filter(isProse);
    expect(found).toContain('Open alerts: none');
    expect(found).toContain('Saved by Cribl, last week');
    expect(found.length).toBeGreaterThan(60);
  });

  it("'Open alerts:' (the receipt's line) has one definition in the product", () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(join(ROOT, dir))) {
        const rel = join(dir, name);
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(name)) {
          const n = literalTexts(read(rel)).filter((s) => s.includes('Open alerts:')).length;
          for (let k = 0; k < n; k++) hits.push(rel);
        }
      }
    };
    for (const dir of ['core', 'src', 'scripts', 'backend']) walk(dir);
    // One template per form: none, a count with the titles, a bare count.
    expect(hits).toEqual(['core/strings.ts', 'core/strings.ts', 'core/strings.ts']);
    expect(RECEIPT_STRINGS.openAlertsNone).toBe('Open alerts: none');
  });

  it('en.ts re-exports the module (the one index of user-facing text) and the dead receipt.weekly* keys are gone', () => {
    expect(en.CORE_STRINGS).toBe(CORE_STRINGS);
    expect(en.RECEIPT_STRINGS).toBe(RECEIPT_STRINGS);
    expect(en.PAYLOAD_STRINGS).toBe(PAYLOAD_STRINGS);
    const receipt = (en.en as unknown as { receipt: Record<string, unknown> }).receipt;
    for (const k of ['weeklyTitle', 'weeklySavedLastWeek', 'weeklyTotals', 'weeklyVsPrior', 'weeklyOpenAlerts', 'weeklyNoOpenAlerts']) expect(receipt).not.toHaveProperty(k);
  });

  it('the words follow en.ts\'s own rules: no exclamation marks, straight apostrophes, no space before %', () => {
    const texts = literalTexts(read('core/strings.ts'));
    for (const s of texts) {
      expect(s).not.toMatch(/!/);
      expect(s).not.toMatch(/[‘’]/);
      expect(s).not.toMatch(/\d %|\} %/);
    }
  });

  it('fill and plural', () => {
    expect(fill('Open alerts: {n} ({titles})', { n: 2, titles: 'a; b' })).toBe('Open alerts: 2 (a; b)');
    expect(fill('{x} and {missing}', { x: '{missing}' })).toBe('{missing} and {missing}');
    expect(plural(1, RECEIPT_STRINGS.lastDays)).toBe('the last {n} day');
    expect(plural(3, RECEIPT_STRINGS.lastDays)).toBe('the last {n} days');
  });

  it("the README's sample weekly receipt is exactly what the renderer prints", () => {
    const readme = read('README.md');
    const block = /```text\n(Meter Reader — weekly receipt[\s\S]*?)\n```/.exec(readme)?.[1];
    expect(block, 'README.md has no sample weekly receipt').toBeDefined();
    const MC = 100_000;
    const text = receiptText({
      periodStart: '2026-09-21T00:00:00.000Z',
      periodEnd: '2026-09-28T00:00:00.000Z',
      label: 'Sep 21–27, 2026',
      lines: [
        { label: 'Windows event trimming', savedM: 9380 * MC },
        { label: 'Firewall duplicate suppression', savedM: 6384 * MC },
        { label: 'Kubernetes noise filter', savedM: 4480 * MC },
        { label: 'Payments API sampling', savedM: 2716 * MC },
        { label: 'CDN log aggregation', savedM: 847 * MC },
      ],
      savedM: 23807 * MC,
      whpM: 39678 * MC,
      paidM: 15871 * MC,
      ratio: 23807 / 39678,
      trendPct: 4,
      openIncidents: [{ title: 'Savings dropped: Payments API sampling' }],
    });
    expect(block).toBe(text);
  });
});
