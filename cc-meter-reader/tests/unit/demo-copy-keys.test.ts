// tests/unit/demo-copy-keys.test.ts — every Demo Console string in src/copy/en.ts is used (EPIC_AUDIT P1-L03:
// "copy-style test finds no unreferenced demo.* keys"). A key is referenced when some source file under
// src/ or core/ names it as a string literal ('demo.ready'), or builds it from a literal prefix
// (`demo.step.${label}` references every key under demo.step). Dead keys drift out of date and get
// translated, reviewed and shipped for nothing.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

/** Leaf key paths of a copy section: plural pairs ({ one, other }) and line arrays count as one leaf. */
function leaves(node: unknown, prefix: string, out: string[] = []): string[] {
  if (typeof node === 'string' || Array.isArray(node)) {
    out.push(prefix);
    return out;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (typeof obj.one === 'string' && typeof obj.other === 'string') {
      out.push(prefix);
      return out;
    }
    for (const [k, v] of Object.entries(obj)) leaves(v, `${prefix}.${k}`, out);
  }
  return out;
}

describe('Demo Console copy', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_MR_BUILD', 'demo');
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('has no unreferenced demo.* keys', async () => {
    const { en } = await import('../../src/copy/en.ts');
    const keys = leaves(en.demo, 'demo');
    expect(keys.length).toBeGreaterThan(100); // the demo build's copy really loaded

    const files = [...sources(join(ROOT, 'src')), ...sources(join(ROOT, 'core'))].filter((f) => !f.endsWith(join('src', 'copy', 'en.ts')));
    const text = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    const dynamicPrefixes = [...text.matchAll(/`(demo\.[A-Za-z.]*)\$\{/g)].map((m) => m[1]!);
    expect(dynamicPrefixes.length).toBeGreaterThan(0);

    const referenced = (key: string) =>
      text.includes(`'${key}'`) || text.includes(`"${key}"`) || text.includes(`\`${key}\``) || dynamicPrefixes.some((p) => key.startsWith(p));
    const unreferenced = keys.filter((key) => !referenced(key));
    expect(unreferenced, `unreferenced keys (searched ${files.length} files under ${relative(ROOT, join(ROOT, 'src'))}/ and core/)`).toEqual([]);
  });
});
