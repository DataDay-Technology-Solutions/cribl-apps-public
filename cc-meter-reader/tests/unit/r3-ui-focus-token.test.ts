// founder-build r3 ui-6 (FINDINGS_R3 #12, r3/5 F2): r2 ui-13 (IC-17) drew our focus ring in the accent foreground
// (src/styles/base.css: 4.7:1 light, 9:1 dark), but ~25 component rules kept Capra's `border.focus` ring
// (2px solid blue-8: 2.33:1 on white, 2.22:1 on the settings grey) and, being more specific than base.css's :where(),
// won. No stylesheet of ours may draw a focus indicator (outline, stroke or box-shadow) in `border.focus` again.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...cssFiles(path));
    else if (name.endsWith('.css')) out.push(path);
  }
  return out;
}

/** Every declaration in `css` (comments stripped) as [property, value, line]. */
function declarations(css: string): [string, string, number][] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const out: [string, string, number][] = [];
  const re = /([a-z-]+)\s*:\s*([^;{}]+);/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push([m[1], m[2], text.slice(0, m.index).split('\n').length]);
  return out;
}

describe('r3 ui-6: no focus ring of ours is drawn in border.focus', () => {
  const files = cssFiles(SRC);

  it('finds the stylesheets', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('no outline uses border.focus (2.33:1 on white)', () => {
    const hits: string[] = [];
    for (const file of files)
      for (const [prop, value, line] of declarations(readFileSync(file, 'utf8')))
        if (/^outline(-color)?$/.test(prop) && /border\.focus/.test(value)) hits.push(`${relative(ROOT, file)}:${line} ${prop}: ${value.trim()}`);
    expect(hits).toEqual([]);
  });

  it('no stroke, box-shadow or border draws a focus state in border.focus either', () => {
    const hits: string[] = [];
    for (const file of files)
      for (const [prop, value, line] of declarations(readFileSync(file, 'utf8')))
        if (/border\.focus/.test(value)) hits.push(`${relative(ROOT, file)}:${line} ${prop}: ${value.trim()}`);
    expect(hits).toEqual([]);
  });

  it('base.css keeps the one ring, in the accent foreground', () => {
    const base = readFileSync(join(SRC, 'styles', 'base.css'), 'utf8');
    expect(base).toMatch(/:focus-visible\s*\{\s*outline:\s*2px solid token\('color\.foreground\.accent\.default'\)/);
  });
});
