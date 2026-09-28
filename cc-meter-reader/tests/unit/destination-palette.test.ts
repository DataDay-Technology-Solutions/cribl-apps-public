// tests/unit/destination-palette.test.ts — the Receipt's destination dots (App QA, 9/27): no two destinations share
// a dot, and no destination hue is a source hue (D55 gave sources their own hues on Flow; the Receipt's "Where the
// money goes" and the price tiles still key destinations with the --mr-dest-* ramp).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESTINATION_TAIL_VAR, DESTINATION_VARS, destinationColorVar } from '../../src/theme/palette.ts';

const CSS = readFileSync(join(__dirname, '../../src/styles/palette.css'), 'utf8');

/** `--mr-<prefix>-<name>: token('<token>')` declarations inside one rule block, keyed by custom property. */
function tokens(block: string, prefix: 'dest' | 'src'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(new RegExp(`(--mr-${prefix}-[\\w-]+):\\s*token\\('([^']+)'\\)`, 'g'))) out[m[1]] = m[2];
  return out;
}
/** The first rule block that opens with `selector {` (no nested braces inside these blocks). */
function block(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return CSS.slice(start, CSS.indexOf('\n}', start));
}

describe('destination dots', () => {
  const eight = ['splunk_cloud', 'datadog', 'sentinel', 'cribl_lake', 'new_relic', 's3', 'elastic', 'snowflake'];

  it('the first six destinations (by sorted id) take six different hues; the seventh and later take one neutral, never a repeat', () => {
    const sorted = [...eight].sort();
    const colours = sorted.map((id) => destinationColorVar(id, eight));
    expect(new Set(colours.slice(0, 6)).size).toBe(6);
    expect(colours.slice(0, 6)).toEqual(DESTINATION_VARS.map((v) => `var(${v})`));
    expect(colours.slice(6)).toEqual([`var(${DESTINATION_TAIL_VAR})`, `var(${DESTINATION_TAIL_VAR})`]);
    // A hue never repeats: every coloured dot is unique, and the tail is not one of the six.
    expect(colours.slice(0, 6)).not.toContain(`var(${DESTINATION_TAIL_VAR})`);
  });

  it('past six, the six heaviest keep the hues (in sorted-id order among themselves) and the lightest go neutral', () => {
    const weights: Record<string, number> = { splunk_cloud: 900, sentinel: 800, datadog: 50, cribl_lake: 40, new_relic: 5, s3: 3, elastic: 2, snowflake: 1 };
    const colour = (id: string) => destinationColorVar(id, eight, (x) => weights[x] ?? 0);
    const tail = `var(${DESTINATION_TAIL_VAR})`;
    expect(colour('splunk_cloud')).not.toBe(tail);
    expect(colour('sentinel')).not.toBe(tail);
    expect(colour('elastic')).toBe(tail);
    expect(colour('snowflake')).toBe(tail);
    const hues = ['splunk_cloud', 'sentinel', 'datadog', 'cribl_lake', 'new_relic', 's3'].map(colour);
    expect(new Set(hues).size).toBe(6);
    expect(hues).not.toContain(tail);
    // sorted-id order among the six: cribl_lake < datadog < new_relic < s3 < sentinel < splunk_cloud
    expect(colour('cribl_lake')).toBe(`var(${DESTINATION_VARS[0]})`);
    expect(colour('splunk_cloud')).toBe(`var(${DESTINATION_VARS[5]})`);
  });

  it('is stable when flows reorder, and an unknown id takes the first hue', () => {
    expect(destinationColorVar('s3', eight)).toBe(destinationColorVar('s3', [...eight].reverse()));
    expect(destinationColorVar('nope', eight)).toBe(`var(${DESTINATION_VARS[0]})`);
  });

  for (const [theme, selector] of [
    ['dark', 'body,\n.dark'],
    ['light', 'body:not(.dark)'],
  ] as const) {
    it(`${theme}: no --mr-dest-* token is a --mr-src-* token, and the six hues plus the tail are all different`, () => {
      const b = block(selector);
      const dest = tokens(b, 'dest');
      const src = tokens(b, 'src');
      expect(Object.keys(dest).sort()).toEqual([...DESTINATION_VARS, DESTINATION_TAIL_VAR].sort());
      expect(Object.keys(src).length).toBeGreaterThanOrEqual(6);
      const shared = Object.entries(dest).filter(([, tok]) => Object.values(src).includes(tok));
      expect(shared, `${theme} destination tokens that a source also wears`).toEqual([]);
      expect(new Set(Object.values(dest)).size).toBe(Object.keys(dest).length);
    });
  }
});
