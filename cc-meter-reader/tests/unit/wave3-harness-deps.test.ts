// tests/unit/wave3-harness-deps.test.ts — every bare module the browser code imports is pre-bundled by the dev
// server (vite.config.ts PREBUNDLED_DEPS), so Vite never re-optimizes mid-run and reloads the pages a spec has open
// (D40, W3-HARNESS-1). A new dependency import fails here until it is listed there.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
/** Node-only modules under src/ that the browser never loads. */
const NODE_ONLY = new Set(['src/mock/node.ts']);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(path);
  }
  return out;
}

/** Runtime (not type-only) bare imports: `import … from 'x'`, `export … from 'x'`, `import('x')`, `import 'x'`. */
function bareImports(code: string): string[] {
  const out: string[] = [];
  const statics = /^\s*(import|export)\s+(type\s+)?[^;]*?from\s+'([^'.][^']*)'/gm;
  for (const m of code.matchAll(statics)) if (!m[2]) out.push(m[3]);
  for (const m of code.matchAll(/^\s*import\s+'([^'.][^']*)'/gm)) out.push(m[1]);
  for (const m of code.matchAll(/\bimport\(\s*'([^'.][^']*)'\s*\)/g)) out.push(m[1]);
  return out.filter((dep) => !dep.endsWith('.css')); // stylesheets go through Vite's CSS pipeline, not the optimizer
}

function prebundled(): string[] {
  const config = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
  const list = /export const PREBUNDLED_DEPS = \[([\s\S]*?)\];/.exec(config);
  if (!list) throw new Error('vite.config.ts has no PREBUNDLED_DEPS');
  return [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('the dev server pre-bundles every browser dependency (D40)', () => {
  const files = [...sources(join(ROOT, 'src')), ...sources(join(ROOT, 'core'))].filter((f) => !NODE_ONLY.has(relative(ROOT, f)));
  const imported = new Map<string, string>();
  for (const file of files) for (const dep of bareImports(readFileSync(file, 'utf8'))) if (!imported.has(dep)) imported.set(dep, relative(ROOT, file));

  it('finds the imports it guards (the scan is not empty)', () => {
    expect(imported.has('react')).toBe(true);
    expect(imported.has('d3-sankey')).toBe(true); // reached only through the lazy Flow view
    expect(imported.has('qrcode')).toBe(false); // a type-only import is not a runtime dependency
  });

  it('lists every runtime bare import in vite.config.ts optimizeDeps.include', () => {
    const include = new Set(prebundled());
    const missing = [...imported].filter(([dep]) => !include.has(dep)).map(([dep, file]) => `${dep} (first imported by ${file})`);
    expect(missing).toEqual([]);
  });

  it('lists nothing the code no longer imports, apart from the JSX runtimes the React plugin injects', () => {
    const injected = new Set(['react/jsx-runtime', 'react/jsx-dev-runtime']);
    expect(prebundled().filter((dep) => !imported.has(dep) && !injected.has(dep))).toEqual([]);
  });
});
