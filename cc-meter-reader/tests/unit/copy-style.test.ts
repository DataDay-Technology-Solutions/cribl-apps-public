// tests/unit/copy-style.test.ts — the rules src/copy/en.ts states for itself, held on every string (P1-O02).
//
// en.ts:3-10 asks for: sentence case, no exclamation marks, no emoji (the ✓ in delivery lines excepted), plurals
// as `{ one, other }` pairs resolved by tn(). The copy review (EPIC_AUDIT P1-Y01) adds two it already follows
// almost everywhere: no space before % ('10%', never '10 %') and straight apostrophes. And every string must be
// USED: a leaf key nothing in the product references is dead copy.
//
// The walk covers the release copy AND the demo build's sections (re-imported with VITE_MR_BUILD=demo, which is
// how en.ts selects them). "Referenced" means the product code (src/, core/, scripts/, backend/ — never tests)
// names the key: a literal ('incidents.sentTo'), a template or concatenated prefix (t(`flow.kind.${kind}`)
// covers flow.kind.*), or a property chain through `en` or an alias of it (CHANNEL_COPY = en.settings.notify.
// channels). A chain that stops at a group (indexed at runtime) covers the whole group.
//
// KNOWN lists the violations that exist today, key by key, per rule. They are P1-Y01's to fix (the integrator's
// copy pass). The test fails on any violation NOT listed — a new string must follow the rules — and on any
// listed entry that no longer violates, so the list only ever shrinks: delete the entry when you fix the copy.
// `COPY_STYLE_PRINT=1 npx vitest run tests/unit/copy-style.test.ts` prints what every rule finds right now.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { en as releaseEn } from '../../src/copy/en.ts';

const ROOT = join(import.meta.dirname, '..', '..');

// ─── The walk ────────────────────────────────────────────────────────────────

type Node = string | readonly Node[] | { readonly [k: string]: Node };
interface Leaf {
  key: string;
  kind: 'string' | 'plural' | 'lines';
  /** every string the leaf can render (a plural pair's two forms, each line of a caption sequence) */
  texts: string[];
  plural?: { one: string; other: string };
}

const isPluralPair = (v: object): v is { one: string; other: string } => {
  const keys = Object.keys(v).sort();
  return keys.length === 2 && keys[0] === 'one' && keys[1] === 'other';
};

function walkCopy(node: Node, prefix = ''): Leaf[] {
  if (typeof node === 'string') return [{ key: prefix, kind: 'string', texts: [node] }];
  if (Array.isArray(node)) {
    // A caption sequence is one leaf; a list of records ({ host, name } …) is walked item by item.
    if (node.every((x) => typeof x === 'string')) return [{ key: prefix, kind: 'lines', texts: [...(node as string[])] }];
    return (node as readonly Node[]).flatMap((x, i) => walkCopy(x, `${prefix}.${i}`));
  }
  const obj = node as { readonly [k: string]: Node };
  if (isPluralPair(obj)) {
    const pair = obj as unknown as { one: string; other: string };
    return [
      {
        key: prefix,
        kind: 'plural',
        texts: [pair.one, pair.other],
        plural: pair,
      },
    ];
  }
  return Object.entries(obj).flatMap(([k, v]) => walkCopy(v, prefix ? `${prefix}.${k}` : k));
}

// ─── The rules ───────────────────────────────────────────────────────────────

type Rule = 'sentenceCase' | 'exclamation' | 'emoji' | 'plural' | 'spacedPercent' | 'curlyApostrophe' | 'breakableUnit' | 'unreferenced';

/**
 * Words that are capitalized in the middle of a sentence because they are names: Cribl's products and objects
 * as the product names them, vendors, the App's own views, days, months. Everything else is lowercase after
 * the first word of a sentence (sentence case).
 */
const PROPER = new Set(
  (
    'Cribl Stream Edge Search Lake Lakehouse Leader Worker Workers Meter Reader Receipt Ledger Flow Settings Story Tour ' +
    'Slack PagerDuty ServiceNow Splunk Cloud Datadog Sentinel Microsoft Azure Amazon AWS Google Elastic Elasticsearch Kafka ' +
    'Windows Palo Alto Kubernetes Linux Syslog Apache Chrome Firefox Safari Enterprise Standard Free Marketplace Apps App ' +
    'Sumo Logic Relic G-Cloud Snowflake Flexera ' +
    'Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September ' +
    'October November December Payments Analytics Archive Innovators Network Datagen Steve Koelpin Chicago New York Coordinated Universal Time ' +
    'I OK Q Copilot GitHub Git Cribl.Cloud Capra Block Kit Webhook QR CriblCon Monitoring Insights Docs Logs ' +
    // UI labels a sentence points at, as they read on screen: views, Settings sections, toggles and buttons.
    'What Prices Budgets Alerts Demo Console Runtime Where Weekly External Access Reset Replay Abort Enter Escape Esc Shift Tab Nowhere'
  ).split(/\s+/),
);
/** An acronym, a unit, a number, a placeholder or an identifier (mrd_siem_prod, x-api-key): never case-checked. */
const EXEMPT_WORD = /^(?:[A-Z0-9][A-Z0-9&/-]*s?|\{\w+\}.*|.*\d.*|.*[_@/].*|[A-Z][a-z]*[A-Z].*|[^\p{Script=Latin}]+)$/u;

/** Words capitalized mid-sentence that are not names (sentence case: "Where the money goes", not "Where The Money Goes"). */
function midSentenceCapitals(text: string): string[] {
  const out: string[] = [];
  // Sentences restart after . ! ? : — and after a line break, a bullet or an opening quote/paren.
  const parts = text.split(/(?<=[.!?:;•·—–=→])\s+|\n+|(?<=["'(“‘])/);
  for (const part of parts) {
    const words = part.split(/\s+/).filter(Boolean);
    words.forEach((raw, i) => {
      if (i === 0) return;
      const word = raw.replace(/^[^\p{L}\p{N}{]+|[^\p{L}\p{N}}]+$/gu, '');
      if (!word || !/^\p{Lu}/u.test(word)) return;
      if (EXEMPT_WORD.test(word) || PROPER.has(word) || PROPER.has(word.replace(/['’]s$/, ''))) return;
      out.push(word);
    });
  }
  return out;
}

/** Words after a count that read the same for 1 and for n. */
const UNCOUNTED = new Set([
  'of',
  'to',
  'in',
  'on',
  'at',
  'by',
  'and',
  'or',
  'more',
  'missing',
  'left',
  'ago',
  'per',
  'from',
  'min',
  's',
  'ms',
  'h',
  'd',
  'x',
  'unpriced',
]);

/**
 * A figure and its unit abbreviation in running prose ("45 s apart", "after {minutes} min") are joined with a
 * no-break space (\u00a0), so a line never wraps between the number and its unit. Prose: five or more words
 * with a comma or sentence punctuation; short labels, chips and toggles ("6 h", "{n} min ago") do not wrap.
 */
const BREAKABLE_UNIT = /(?:\d|\})[ ](?:s|ms|min|h|KB|MB|GB|TB)\b/;
const isProse = (text: string): boolean => text.split(/\s+/).filter(Boolean).length >= 5 && /[,.;:?]/.test(text);

const EMOJI = /\p{Extended_Pictographic}/gu;
/** Pictographs the copy may use: the delivery check mark (en.ts:4) and the arrows and marks that read as text. */
const ALLOWED_PICTOGRAPHS = new Set(['✓', '↔', '©', '®', '™']);

function violations(leaf: Leaf): Rule[] {
  const rules = new Set<Rule>();
  for (const text of leaf.texts) {
    if (text.includes('!')) rules.add('exclamation');
    if ([...text.matchAll(EMOJI)].some((m) => !ALLOWED_PICTOGRAPHS.has(m[0]))) rules.add('emoji');
    if (/(?:\d|\})[   ]+%/.test(text)) rules.add('spacedPercent');
    if (/[‘’]/.test(text)) rules.add('curlyApostrophe');
    if (isProse(text) && BREAKABLE_UNIT.test(text)) rules.add('breakableUnit');
    if (midSentenceCapitals(text).length > 0) rules.add('sentenceCase');
  }
  if (leaf.kind === 'plural' && leaf.plural) {
    // A pair renders the same sentence for 1 and for n: two different forms with the same placeholders ({n} aside).
    const vars = (s: string) =>
      [...s.matchAll(/\{(\w+)\}/g)]
        .map((m) => m[1])
        .filter((v) => v !== 'n')
        .sort()
        .join(',');
    if (vars(leaf.plural.one) !== vars(leaf.plural.other)) rules.add('plural');
  }
  // A counted string must be a pair: '{n} alerts' reads '1 alerts'. Units ('{n} min ago') and words that do
  // not inflect ('Step {n} of {total}', '+{n} more') are fine as they are.
  if (leaf.kind !== 'plural' && leaf.texts.some((s) => [...s.matchAll(/\{(?:n|count)\}\s+(\p{Ll}+)/gu)].some((m) => !UNCOUNTED.has(m[1])))) rules.add('plural');
  return [...rules];
}

// ─── References ──────────────────────────────────────────────────────────────

/** Every .ts/.tsx file of the product (never tests, never the copy module itself). */
function productSources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.d\.ts$/.test(name)) out.push({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') });
    }
  };
  for (const dir of ['src', 'core', 'scripts', 'backend']) {
    try {
      walk(join(ROOT, dir));
    } catch {
      // a directory a checkout does not have
    }
  }
  return out.filter((s) => s.path !== join('src', 'copy', 'en.ts'));
}

/**
 * The leaf keys `sources` reference (see the header for what counts). `groupsByHand` names groups read with a
 * key built at runtime that no literal, prefix or chain shows.
 */
function referencedKeys(leafKeys: readonly string[], sources: readonly string[], groupsByHand: readonly string[] = []): Set<string> {
  const leafSet = new Set(leafKeys);
  const seen = new Set<string>();
  const markGroup = (group: string): void => {
    if (leafSet.has(group)) seen.add(group);
    const prefix = group === '' ? '' : `${group}.`;
    for (const k of leafKeys) if (k.startsWith(prefix)) seen.add(k);
  };
  for (const g of groupsByHand) markGroup(g);
  const aliases = new Map<string, string>([['en', '']]);
  for (const src of sources) {
    for (const m of src.matchAll(/\bconst\s+(\w+)\s*=\s*en((?:\.\w+)+)\s*(?:as\b[^;]*)?;/g)) aliases.set(m[1], m[2].slice(1));
  }
  for (const src of sources) {
    // literals naming a leaf
    for (const m of src.matchAll(/(['"`])([A-Za-z]\w*(?:\.[\w-]+)+)\1/g)) if (leafSet.has(m[2])) seen.add(m[2]);
    // template prefixes: t(`flow.kind.${kind}`), t(`demo.scene.${name}.title`)
    for (const m of src.matchAll(/`([A-Za-z]\w*(?:\.\w+)*)\.\$\{/g)) markGroup(m[1]);
    // concatenated prefixes: t('receipt.period.' + key)
    for (const m of src.matchAll(/(['"])([A-Za-z]\w*(?:\.\w+)*)\.\1\s*\+/g)) markGroup(m[2]);
    // property chains through en or an alias; a chain stopping at a group (or indexed with []) covers it
    for (const [alias, base] of aliases) {
      for (const m of src.matchAll(new RegExp(`(?<![\\w.])${alias}((?:\\??\\.\\w+)*)`, 'g'))) {
        if (alias === 'en' && m[1] === '') continue; // the bare import names nothing
        const chain = m[1].replace(/\?/g, '').slice(1);
        markGroup([base, chain].filter(Boolean).join('.'));
      }
    }
  }
  return seen;
}

/** Groups whose keys are built at runtime from values no source line spells out. Keep this list short. */
const GROUPS_BY_HAND: readonly string[] = [];

// ─── Known violations (P1-Y01 fixed the last of them; a new entry here needs a reason) ──

const KNOWN: Readonly<Record<Rule, readonly string[]>> = {
  sentenceCase: [],
  exclamation: [],
  emoji: [],
  plural: [],
  spacedPercent: [],
  curlyApostrophe: [],
  breakableUnit: [],
  unreferenced: [],
};

// ─── Tests ───────────────────────────────────────────────────────────────────

async function demoEn(): Promise<Node> {
  vi.stubEnv('VITE_MR_BUILD', 'demo');
  vi.resetModules();
  try {
    return (await import('../../src/copy/en.ts')).en as unknown as Node;
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
}

function report(leaves: readonly Leaf[], referenced: ReadonlySet<string>): Record<Rule, string[]> {
  const found: Record<Rule, string[]> = {
    sentenceCase: [],
    exclamation: [],
    emoji: [],
    plural: [],
    spacedPercent: [],
    curlyApostrophe: [],
    breakableUnit: [],
    unreferenced: [],
  };
  for (const leaf of leaves) {
    for (const rule of violations(leaf)) found[rule].push(leaf.key);
    if (!referenced.has(leaf.key)) found.unreferenced.push(leaf.key);
  }
  return found;
}

describe('copy style (src/copy/en.ts)', () => {
  it('walks the release copy and the demo sections', async () => {
    const release = walkCopy(releaseEn as unknown as Node);
    const demo = walkCopy(await demoEn());
    expect(release.length).toBeGreaterThan(500);
    expect(demo.length).toBeGreaterThan(release.length);
    expect(demo.some((l) => l.key.startsWith('demo.'))).toBe(true);
  });

  it('holds every rule en.ts states, apart from the listed violations P1-Y01 fixes', async () => {
    const leaves = walkCopy(await demoEn());
    const referenced = referencedKeys(
      leaves.map((l) => l.key),
      productSources().map((s) => s.text),
      GROUPS_BY_HAND,
    );
    const found = report(leaves, referenced);
    if (process.env.COPY_STYLE_PRINT) console.log(JSON.stringify(found, null, 2));
    const fresh: Record<string, string[]> = {};
    const fixed: Record<string, string[]> = {};
    for (const rule of Object.keys(found) as Rule[]) {
      const known = new Set(KNOWN[rule]);
      const now = new Set(found[rule]);
      const added = found[rule].filter((k) => !known.has(k));
      const gone = KNOWN[rule].filter((k) => !now.has(k));
      if (added.length) fresh[rule] = added;
      if (gone.length) fixed[rule] = gone;
    }
    const detail = (keys: Record<string, string[]>) =>
      Object.entries(keys)
        .map(
          ([rule, list]) => `${rule}: ${list.map((k) => `${k} = ${JSON.stringify(leaves.find((l) => l.key === k)?.texts.join(' | ') ?? '')}`).join('\n    ')}`,
        )
        .join('\n  ');
    expect(fresh, `new copy that breaks the rules (fix the string, or wire the key):\n  ${detail(fresh)}`).toEqual({});
    expect(fixed, `fixed — delete these from KNOWN in tests/unit/copy-style.test.ts:\n  ${detail(fixed)}`).toEqual({});
  });
});

describe('the checker itself', () => {
  it('flags an unreferenced leaf key, and a group read at runtime covers its keys', () => {
    const leaves = walkCopy({
      a: { used: 'x', dead: 'y' },
      kind: { pipe: 'p', route: 'r' },
      ch: { one: { title: 't' } },
    });
    const keys = leaves.map((l) => l.key);
    const sources = ["t('a.used')", 't(`kind.${k}`)', 'const C = en.ch;\nC.one.title'];
    const seen = referencedKeys(keys, sources);
    expect(keys.filter((k) => !seen.has(k))).toEqual(['a.dead']);
    expect(report(leaves, seen).unreferenced).toEqual(['a.dead']);
  });

  it('flags each rule on a sample string', () => {
    const leaf = (text: string): Leaf => ({
      key: 'k',
      kind: 'string',
      texts: [text],
    });
    expect(violations(leaf('Saved Over The Last 30 Days'))).toEqual(['sentenceCase']);
    expect(violations(leaf('Sent to Slack ✓ {time}'))).toEqual([]);
    expect(violations(leaf('Open the Ledger in Cribl Stream. Then press P.'))).toEqual([]);
    expect(violations(leaf('Saved!'))).toEqual(['exclamation']);
    expect(violations(leaf('Saved 🎉'))).toEqual(['emoji']);
    expect(violations(leaf('Down 10 %'))).toEqual(['spacedPercent']);
    expect(violations(leaf('{pct} %'))).toEqual(['spacedPercent']);
    expect(violations(leaf('Down 10%'))).toEqual([]);
    expect(violations(leaf('Couldn’t reach the Leader'))).toEqual(['curlyApostrophe']);
    expect(violations(leaf('Sweep now is available again in {seconds} s.'))).toEqual(['breakableUnit']);
    expect(violations(leaf('Windows, Palo Alto, VPC Flow, 45 s apart'))).toEqual(['breakableUnit']);
    expect(violations(leaf('Sweep now is available again in {seconds}\u00a0s.'))).toEqual([]);
    expect(violations(leaf('{n} min ago'))).toEqual([]);
    expect(violations(leaf('{n} alerts open'))).toEqual(['plural']);
    expect(violations(leaf('Step {n} of {total} · {n} min ago'))).toEqual([]);
    expect(
      violations({
        key: 'k',
        kind: 'plural',
        texts: ['{n} alert', '{n} alerts in {group}'],
        plural: { one: '{n} alert', other: '{n} alerts in {group}' },
      }),
    ).toEqual(['plural']);
    expect(
      violations({
        key: 'k',
        kind: 'plural',
        texts: ['{n} alert', '{n} alerts'],
        plural: { one: '{n} alert', other: '{n} alerts' },
      }),
    ).toEqual([]);
  });
});
