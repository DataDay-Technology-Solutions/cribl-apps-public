#!/usr/bin/env node
// recommend.js — offline FIELD_WHITELIST advisor for the cc-cardinality-reduction pack.
//
// Runs your real event samples through the pack's REAL stage-1 engine (extracted
// from ../default/pipelines/cardinality_reduction/conf.yml) in audit mode, then
// reports, per leaf field:
//   - how often it appears and how many distinct values it carries
//   - whether the engine would normalize or drop it (and as which category)
//   - an example before -> after transformation
//
// The report is split into three buckets:
//   NORMALIZE  shape-detected machine noise (UUIDs, hashes, pod names, ...) —
//              safe to let the pack collapse.
//   REVIEW     business entity IDs (customer_id, user_id, order_id, email, ...) —
//              the pack WOULD collapse them, but if you query/group by them you
//              must whitelist them first. The report ends with a ready-to-paste
//              FIELD_WHITELIST line for exactly these fields.
//   KEPT       fields the engine would not touch.
//
// Usage:
//   node recommend.js [files-or-dirs...]        # default: ../data/samples/
//   node recommend.js --json events.json        # machine-readable output
//   node recommend.js --whitelist a,b,c         # simulate FIELD_WHITELIST
//   node recommend.js --mode aggressive         # simulate MODE=aggressive
//
// Input formats: .json files containing an array of event objects, a single
// event object, or NDJSON (one JSON event per line). Malformed lines/files are
// skipped with a warning.
//
// No npm dependencies — runs with bare `node recommend.js`.
'use strict';

const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------------
// CLI parsing
// ------------------------------------------------------------------
const argv = process.argv.slice(2);
const opts = { json: false, whitelist: '', mode: '', inputs: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') opts.json = true;
  else if (a === '--whitelist') opts.whitelist = String(argv[++i] || '');
  else if (a === '--mode') opts.mode = String(argv[++i] || '');
  else if (a === '--help' || a === '-h') {
    console.log('Usage: node recommend.js [--json] [--whitelist a,b,c] [--mode aggressive] [files-or-dirs...]');
    console.log('Default input: ../data/samples/ (the pack\'s bundled samples).');
    process.exit(0);
  } else if (a.startsWith('--')) {
    console.error('Unknown flag: ' + a + ' (see --help)');
    process.exit(2);
  } else opts.inputs.push(a);
}
if (opts.mode && opts.mode !== 'safe' && opts.mode !== 'aggressive') {
  console.error("--mode must be 'safe' or 'aggressive' (got '" + opts.mode + "')");
  process.exit(2);
}

// ------------------------------------------------------------------
// Extract the stage-1 engine code from the pipeline YAML.
// Indentation-based: the stage-1 block is the SECOND `code: |-` scalar;
// its lines are everything indented deeper than the `code:` key.
// ------------------------------------------------------------------
function extractStage1Code(confPath) {
  const lines = fs.readFileSync(confPath, 'utf8').split('\n');
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)code:\s*\|-\s*$/);
    if (!m) continue;
    seen++;
    if (seen < 2) continue; // stage 0 is the first block; we want stage 1
    const keyIndent = m[1].length;
    const block = [];
    for (let j = i + 1; j < lines.length; j++) {
      const ln = lines[j];
      if (ln.trim() === '') { block.push(''); continue; }
      const indent = ln.match(/^\s*/)[0].length;
      if (indent <= keyIndent) break;
      block.push(ln);
    }
    // strip the common indent of non-empty lines
    let common = Infinity;
    for (const ln of block) {
      if (ln.trim()) common = Math.min(common, ln.match(/^\s*/)[0].length);
    }
    if (!isFinite(common)) common = 0;
    return block.map(ln => ln.slice(common)).join('\n');
  }
  throw new Error('stage-1 code block (second `code: |-`) not found in ' + confPath);
}

const confPath = path.join(__dirname, '..', 'default', 'pipelines', 'cardinality_reduction', 'conf.yml');
let stage1;
try {
  stage1 = new Function('__e', 'C', extractStage1Code(confPath));
} catch (err) {
  console.error('Failed to load engine from ' + confPath + ': ' + err.message);
  process.exit(2);
}

// ------------------------------------------------------------------
// Mock Cribl context. C.Metric / C.Log stay undefined — the engine
// guards every call with `typeof C.Metric === 'function'`.
// ------------------------------------------------------------------
function makeC(vars) { return { vars: vars, Metric: undefined, Log: undefined }; }

const baseVars = { DRY_RUN: true, VERBOSE_AUDIT_METADATA: true };
if (opts.whitelist) baseVars.FIELD_WHITELIST = opts.whitelist;
if (opts.mode) baseVars.MODE = opts.mode;
const liveVars = Object.assign({}, baseVars, { DRY_RUN: false });

// ------------------------------------------------------------------
// Input loading
// ------------------------------------------------------------------
function loadEventsFromFile(file, out, warnings) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (err) { warnings.push('skipped ' + file + ': ' + err.message); return 0; }
  const trimmed = text.trim();
  if (!trimmed) { warnings.push('skipped ' + file + ': empty file'); return 0; }
  // Whole-file JSON first (array of events or a single event object)
  if (trimmed.charAt(0) === '[') {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        let n = 0;
        for (const ev of arr) if (ev && typeof ev === 'object') { out.push(ev); n++; }
        return n;
      }
    } catch (e) { warnings.push('skipped ' + file + ': invalid JSON array (' + e.message + ')'); return 0; }
  }
  // NDJSON / single object
  let n = 0, bad = 0;
  for (const line of trimmed.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try {
      const ev = JSON.parse(l);
      if (ev && typeof ev === 'object' && !Array.isArray(ev)) { out.push(ev); n++; }
      else bad++;
    } catch (e) { bad++; }
  }
  if (bad > 0) warnings.push(file + ': skipped ' + bad + ' non-JSON line(s)');
  if (n === 0) warnings.push('skipped ' + file + ': no parseable events');
  return n;
}

function gatherInputs(inputs) {
  const files = [];
  for (const p of inputs) {
    let st;
    try { st = fs.statSync(p); }
    catch (e) { warnings.push('skipped ' + p + ': not found'); continue; }
    if (st.isDirectory()) {
      const entries = fs.readdirSync(p).filter(f => f.endsWith('.json') || f.endsWith('.ndjson')).sort();
      for (const f of entries) files.push(path.join(p, f));
      if (entries.length === 0) warnings.push(p + ': no .json files found');
    } else files.push(p);
  }
  return files;
}

const warnings = [];
const inputPaths = opts.inputs.length ? opts.inputs : [path.join(__dirname, '..', 'data', 'samples')];
const files = gatherInputs(inputPaths);
const events = [];
const fileStats = [];
for (const f of files) {
  const n = loadEventsFromFile(f, events, warnings);
  if (n > 0) fileStats.push({ file: f, events: n });
}
if (events.length === 0) {
  for (const w of warnings) console.error('warning: ' + w);
  console.error('No events loaded. Pass .json (array or NDJSON) files or directories.');
  process.exit(1);
}

// ------------------------------------------------------------------
// Per-field aggregation
// ------------------------------------------------------------------
const SYSTEM_FIELDS = { source: 1, sourcetype: 1, host: 1, index: 1, cribl_pipe: 1, cribl_host: 1, cribl_wp: 1, cribl_breaker: 1 };
const MAX_DISTINCT_TRACKED = 20000;
const fieldsMap = new Map(); // key -> stats

function fieldKey(p) {
  // collapse array indices so tags.0 / tags.1 aggregate as tags[]
  return p.split('.').map(s => (/^\d+$/.test(s) ? '[]' : s)).join('.');
}

function getStats(p) {
  const key = fieldKey(p);
  let s = fieldsMap.get(key);
  if (!s) {
    s = { field: key, leaf: key.replace(/\.\[\]$/, '').split('.').pop(), occurrences: 0,
          values: new Set(), distinctCapped: false, hits: 0, drops: 0, whitelisted: 0,
          exampleBefore: null, examplePath: null };
    fieldsMap.set(key, s);
  }
  return s;
}

// Mirror the engine's leaf walk closely enough for honest occurrence /
// distinct-value counting: metrics -> labels only; logs -> recursive walk.
function collectLeaves(e) {
  const out = [];
  if (e._metric) {
    if (typeof e._metric === 'string' && e._metric.length > 0) out.push({ p: '_metric', v: e._metric });
    if (e.labels && typeof e.labels === 'object' && !Array.isArray(e.labels)) {
      for (const [k, v] of Object.entries(e.labels)) {
        if (k.startsWith('__') || k.startsWith('cr_')) continue;
        if (typeof v === 'string' && v.length > 0 && v.length <= 8192) out.push({ p: 'labels.' + k, v: v });
      }
    }
    return out;
  }
  (function walk(obj, prefix, depth) {
    if (depth > 6 || out.length >= 1000) return;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const v = obj[i];
        if (typeof v === 'string' && v.length > 0 && v.length <= 8192) out.push({ p: prefix + '.' + i, v: v });
        else if (v && typeof v === 'object') walk(v, prefix + '.' + i, depth + 1);
      }
      return;
    }
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('__') || k.startsWith('cr_')) continue;
      if (depth === 0) {
        if (k === '_raw' || k === '_time' || k === '_metric' || k === '_value' || k === 'labels') continue;
        if (SYSTEM_FIELDS[k]) continue;
      }
      const full = prefix ? prefix + '.' + k : k;
      if (typeof v === 'string') {
        if (v.length === 0 || v.length > 8192) continue;
        out.push({ p: full, v: v });
      } else if (v && typeof v === 'object') walk(v, full, depth + 1);
    }
  })(e, '', 0);
  return out;
}

function resolvePath(obj, p) {
  const parts = p.split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

// Audit fields emit capped joined lists; '…+N' markers are not field paths.
function parseList(s) {
  if (!s || s === 'none' || typeof s !== 'string') return [];
  return s.split(',').map(x => x.trim()).filter(x => x && x.indexOf('…') < 0);
}

// ------------------------------------------------------------------
// Main pass: run every event through the engine in audit mode
// ------------------------------------------------------------------
const riskCounts = { none: 0, medium: 0, high: 0, critical: 0 };
let unparsedRaw = 0;
let engineErrors = 0;

for (const ev of events) {
  let e;
  try { e = JSON.parse(JSON.stringify(ev)); } catch (err) { continue; }
  stage1(e, makeC(baseVars)); // engine mutates in place; audit mode never alters values
  if (e.cr_error) engineErrors++;
  if (e.cr_risk && riskCounts[e.cr_risk] !== undefined) riskCounts[e.cr_risk]++;
  if (e._raw && typeof e._raw === 'string' && !e._metric && !e._raw.trim().startsWith('{')) unparsedRaw++;

  for (const leaf of collectLeaves(e)) {
    const s = getStats(leaf.p);
    s.occurrences++;
    if (s.values.size < MAX_DISTINCT_TRACKED) s.values.add(leaf.v);
    else s.distinctCapped = true;
  }
  for (const p of parseList(e.cr_would_modify)) {
    const s = getStats(p);
    s.hits++;
    if (s.exampleBefore == null) {
      const v = p === '_metric' ? ev._metric : resolvePath(e, p);
      if (typeof v === 'string') { s.exampleBefore = v; s.examplePath = p; }
    }
  }
  for (const p of parseList(e.cr_would_drop)) {
    const s = getStats(p);
    s.drops++;
    if (s.exampleBefore == null) {
      const v = resolvePath(e, p);
      if (typeof v === 'string') { s.exampleBefore = v; s.examplePath = p; }
    }
  }
  for (const p of parseList(e.cr_whitelisted)) getStats(p).whitelisted++;
}

// ------------------------------------------------------------------
// Per-field probes: detected category (audit) + after-value (live).
// One synthetic single-field event per flagged field, through the
// same engine, so the category/example always match real behavior.
// ------------------------------------------------------------------
function probe(stat) {
  const v = stat.exampleBefore;
  if (v == null) return { category: null, after: null };
  const leaf = stat.leaf === '[]' ? stat.field.split('.')[0] : stat.leaf;
  const isLabel = stat.field.startsWith('labels.');
  const isMetricName = stat.field === '_metric';
  function synth() {
    if (isMetricName) return { _metric: v, _value: 1, labels: {} };
    if (isLabel) return { _metric: 'probe_metric', _value: 1, labels: { [leaf]: v } };
    return { [leaf]: v };
  }
  let category = null, after = null;
  try {
    const a = synth();
    stage1(a, makeC(baseVars));
    category = parseList(a.cr_categories)[0] || null;
    const l = synth();
    stage1(l, makeC(liveVars));
    let result;
    if (isMetricName) result = l._metric;
    else if (isLabel) result = (l.labels && leaf in l.labels) ? l.labels[leaf] : undefined;
    else result = (leaf in l) ? l[leaf] : undefined;
    if (result === undefined) after = '(dropped)';
    else if (result !== v) after = String(result);
  } catch (err) { /* probe is best-effort */ }
  return { category, after };
}

// ------------------------------------------------------------------
// Classification: NORMALIZE vs REVIEW vs KEPT
// ------------------------------------------------------------------
// Entity-ID fields an operator may actively query/group by — collapsing
// these loses business signal, so they need a human decision.
const ENTITY_RE = /^(customer|user|account|acct|tenant|org|organization|order|invoice|subscription|payment|charge|member|subscriber|client|patient|employee|merchant|vendor|partner|cart|checkout|device|contract|policy|claim|loan|ticket|case)_?(id|number|num|no|ref|key)$/;
function isEntityField(leaf, category) {
  const kl = String(leaf || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (ENTITY_RE.test(kl)) return true;
  if (kl === 'email' || kl.endsWith('_email') || kl === 'emailaddress' || kl === 'email_address') return true;
  if (category === 'email') return true;
  return false;
}

const normalize = [], review = [], kept = [];
for (const s of fieldsMap.values()) {
  s.distinct = s.values.size;
  if (s.hits > 0 || s.drops > 0) {
    const pr = probe(s);
    s.category = pr.category || (s.drops > 0 ? 'k8s_ephemeral' : 'unknown');
    s.exampleAfter = pr.after || (s.drops > 0 ? '(dropped)' : '(varies)');
    if (isEntityField(s.leaf, s.category)) review.push(s); else normalize.push(s);
  } else kept.push(s);
}
const byImpact = (a, b) => (b.distinct - a.distinct) || (b.occurrences - a.occurrences) || a.field.localeCompare(b.field);
normalize.sort(byImpact); review.sort(byImpact); kept.sort(byImpact);

// ------------------------------------------------------------------
// Reduction estimate (distinct values collapsed / total distinct)
// ------------------------------------------------------------------
const flagged = normalize.concat(review);
const flaggedDistinct = flagged.reduce((n, s) => n + s.distinct, 0);
const totalDistinct = flaggedDistinct + kept.reduce((n, s) => n + s.distinct, 0);
const collapsedTo = flagged.length; // each flagged field collapses to ~1 placeholder/group value
const eliminated = Math.max(0, flaggedDistinct - collapsedTo);
const pct = totalDistinct > 0 ? (eliminated / totalDistinct) * 100 : 0;

const whitelistLeaves = Array.from(new Set(review.map(s => s.leaf))).sort();
const whitelistLine = 'FIELD_WHITELIST=' + whitelistLeaves.join(',');

// ------------------------------------------------------------------
// Output
// ------------------------------------------------------------------
function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function padl(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

function rowFor(s) {
  return {
    field: s.field, leaf: s.leaf, events: s.occurrences, distinct: s.distinct,
    distinct_capped: !!s.distinctCapped, category: s.category,
    example_before: s.exampleBefore, example_after: s.exampleAfter,
  };
}

if (opts.json) {
  console.log(JSON.stringify({
    engine: confPath,
    simulated: { DRY_RUN: true, MODE: opts.mode || 'safe', FIELD_WHITELIST: opts.whitelist || '' },
    files: fileStats,
    events: events.length,
    unparsed_raw_events: unparsedRaw,
    engine_errors: engineErrors,
    risk: riskCounts,
    normalize: normalize.map(rowFor),
    review: review.map(s => Object.assign(rowFor(s), { suggested_whitelist_entry: s.leaf })),
    kept: kept.map(s => ({ field: s.field, events: s.occurrences, distinct: s.distinct, whitelisted: s.whitelisted > 0 })),
    whitelist_suggestion: whitelistLine,
    estimated_reduction: {
      flagged_fields: flagged.length, flagged_distinct_values: flaggedDistinct,
      collapse_to: collapsedTo, total_distinct_values: totalDistinct,
      pct_of_total_distinct: Math.round(pct * 10) / 10,
    },
    warnings: warnings,
  }, null, 2));
  process.exit(0);
}

const W_FIELD = 36, W_NUM = 8, W_DIS = 10, W_CAT = 16;
function printTable(rows) {
  console.log('  ' + pad('FIELD', W_FIELD) + padl('EVENTS', W_NUM) + padl('DISTINCT', W_DIS) + '  ' + pad('CATEGORY', W_CAT) + 'EXAMPLE');
  for (const s of rows) {
    const ex = s.exampleBefore != null ? clip(s.exampleBefore, 38) + ' → ' + clip(s.exampleAfter, 28) : '';
    console.log('  ' + pad(clip(s.field, W_FIELD - 1), W_FIELD) + padl(fmt(s.occurrences), W_NUM) +
      padl(fmt(s.distinct) + (s.distinctCapped ? '+' : ''), W_DIS) + '  ' + pad(s.category || '-', W_CAT) + ex);
  }
}

console.log('recommend.js — FIELD_WHITELIST advisor (real stage-1 engine, audit mode)');
console.log('Engine: ' + path.relative(process.cwd(), confPath));
console.log('Loaded ' + fmt(events.length) + ' events from ' + fileStats.length + ' file(s)' +
  (opts.mode === 'aggressive' ? ' | MODE=aggressive' : '') +
  (opts.whitelist ? ' | simulated FIELD_WHITELIST=' + opts.whitelist : ''));
console.log('Risk distribution: critical=' + fmt(riskCounts.critical) + ' high=' + fmt(riskCounts.high) +
  ' medium=' + fmt(riskCounts.medium) + ' none=' + fmt(riskCounts.none));
if (unparsedRaw > 0) {
  console.log('Note: ' + fmt(unparsedRaw) + ' event(s) carry non-JSON _raw (e.g. Prometheus exposition lines).');
  console.log('      In Cribl the stage-0 auto-parser structures those first; this offline tool');
  console.log('      analyzes structured fields only, so their _raw content is not scored here.');
}
for (const w of warnings) console.log('Warning: ' + w);
if (engineErrors > 0) console.log('Warning: engine reported cr_error on ' + fmt(engineErrors) + ' event(s)');

console.log('\n=== NORMALIZE (safe — shape-detected machine noise; let the pack collapse these) ===');
if (normalize.length) printTable(normalize); else console.log('  (none detected)');

console.log('\n=== REVIEW (entity IDs — whitelist any of these you actively query or group by) ===');
if (review.length) {
  printTable(review);
  console.log('\n  These fields look like business identifiers. The pack cannot know whether you');
  console.log('  query them — check your destination’s query/search logs before deciding. If a');
  console.log('  field is queried, add it to FIELD_WHITELIST; if not, let the pack collapse it.');
} else console.log('  (none detected)');

console.log('\n=== KEPT (untouched by the engine) ===');
if (kept.length) {
  const shown = kept.slice(0, 40);
  for (const s of shown) {
    console.log('  ' + pad(clip(s.field, W_FIELD - 1), W_FIELD) + fmt(s.occurrences) + ' events, ' +
      fmt(s.distinct) + ' distinct' + (s.whitelisted > 0 ? '  [whitelisted]' : ''));
  }
  if (kept.length > shown.length) console.log('  … +' + (kept.length - shown.length) + ' more (use --json for the full list)');
} else console.log('  (none)');

console.log('\n--- Proposed pack variable (paste into Cribl UI → Packs → cc-cardinality-reduction → Variables) ---');
console.log(whitelistLeaves.length ? whitelistLine : '# no REVIEW fields found — no whitelist needed');
console.log('\nEstimated reduction: ' + fmt(flaggedDistinct) + ' distinct values across ' + flagged.length +
  ' flagged fields collapse to ~' + collapsedTo + ' — ' + fmt(eliminated) + ' of ' + fmt(totalDistinct) +
  ' total distinct leaf values eliminated (' + pct.toFixed(1) + '%).');
