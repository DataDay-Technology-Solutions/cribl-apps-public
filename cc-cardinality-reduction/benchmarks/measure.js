#!/usr/bin/env node
// measure.js - reproducible before/after cardinality benchmark for the
// cc-cardinality-reduction pack. No npm dependencies (Node >= 14).
//
// What it does
//   1. Generates synthetic Prometheus exposition lines with a seeded port of
//      the generator behind DataTap's "datatap-prometheus" source
//      (github.com/DataDay-Technology-Solutions/cribl-apps-public/tree/main/cribl-datatap). Every sample
//      carries a fresh pod hash and a fresh instance IP:port, the worst-case
//      churn pattern that blows up a TSDB. Synthetic data only.
//   2. Runs every line through the pack's REAL pipeline
//      (default/pipelines/cardinality_reduction/conf.yml): all functions in
//      order, honoring each filter, exactly as the pack's own e2e harness
//      does. The stateful aggregation functions are skipped; they are off by
//      default (ENABLE_AGGREGATION=false), so they would not run anyway.
//   3. Counts distinct series (metric name + full label set) and distinct
//      label values BEFORE (audit mode, DRY_RUN=true, values untouched) and
//      AFTER (live mode, DRY_RUN=false), for MODE=safe and MODE=aggressive.
//
// Usage
//   node measure.js [--pack ../../cc-cardinality-reduction] [--events 100000]
//                   [--eps 100] [--seed 42] [--json]
'use strict';
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const opt = { pack: path.join(__dirname, '..', '..', 'cc-cardinality-reduction'), events: 100000, eps: 100, seed: 42, json: false };
for (let k = 0; k < argv.length; k++) {
  const a = argv[k];
  if (a === '--pack') opt.pack = argv[++k];
  else if (a === '--events') opt.events = parseInt(argv[++k], 10);
  else if (a === '--eps') opt.eps = parseInt(argv[++k], 10);
  else if (a === '--seed') opt.seed = parseInt(argv[++k], 10);
  else if (a === '--json') opt.json = true;
  else { console.error('unknown argument: ' + a); process.exit(2); }
}
function yamlLoad(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  const indentOf = (l) => l.match(/^ */)[0].length;
  const isSkippable = (l) => /^\s*(#.*)?$/.test(l);
  const skip = () => { while (i < lines.length && isSkippable(lines[i])) i++; };
  const fail = (msg) => { throw new Error('yamlmini: ' + msg + ' at line ' + (i + 1)); };

  function unescapeDouble(body) {
    let out = '';
    for (let k = 0; k < body.length; k++) {
      const ch = body[k];
      if (ch !== '\\') { out += ch; continue; }
      const n = body[++k];
      const map = { '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029' };
      if (n in map) { out += map[n]; continue; }
      const hexLen = n === 'x' ? 2 : n === 'u' ? 4 : n === 'U' ? 8 : 0;
      if (hexLen) { out += String.fromCodePoint(parseInt(body.substr(k + 1, hexLen), 16)); k += hexLen; continue; }
      fail('unknown escape \\' + n);
    }
    return out;
  }
  function closingDouble(s) { for (let k = 1; k < s.length; k++) { if (s[k] === '\\') { k++; continue; } if (s[k] === '"') return k; } return -1; }
  function closingSingle(s) { for (let k = 1; k < s.length; k++) { if (s[k] === "'") { if (s[k + 1] === "'") { k++; continue; } return k; } } return -1; }

  function scalar(raw) {
    let s = raw.trim();
    if (s === '') return null;
    if (s[0] === '"') { const e = closingDouble(s); if (e < 0) fail('unterminated double-quoted scalar'); return unescapeDouble(s.slice(1, e)); }
    if (s[0] === "'") { const e = closingSingle(s); if (e < 0) fail('unterminated single-quoted scalar'); return s.slice(1, e).replace(/''/g, "'"); }
    const c = s.search(/\s#/); if (c >= 0) s = s.slice(0, c).trim();
    if (s === '{}') return {};
    if (s === '[]') return [];
    if (s[0] === '[' && s[s.length - 1] === ']') return splitFlow(s.slice(1, -1)).map(scalar);
    if (s[0] === '{' && s[s.length - 1] === '}') { const o = {}; for (const part of splitFlow(s.slice(1, -1))) { const m = part.match(/^\s*([^:]+?)\s*:\s*(.*)$/); if (!m) fail('bad flow map entry'); o[scalar(m[1])] = scalar(m[2]); } return o; }
    if (/^(null|Null|NULL|~)$/.test(s)) return null;
    if (/^(true|True|TRUE)$/.test(s)) return true;
    if (/^(false|False|FALSE)$/.test(s)) return false;
    if (/^[-+]?(0|[1-9]\d*)$/.test(s)) return parseInt(s, 10);
    if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(s)) return parseFloat(s);
    return s;
  }
  function splitFlow(s) {
    const parts = []; let depth = 0, cur = '', q = null;
    for (let k = 0; k < s.length; k++) {
      const ch = s[k];
      if (q) { cur += ch; if (ch === '\\' && q === '"') { cur += s[++k]; continue; } if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === '[' || ch === '{') depth++;
      if (ch === ']' || ch === '}') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim() !== '') parts.push(cur);
    return parts;
  }

  // Block scalar: header is the text after "key:" e.g. "|-", ">", "|+2".
  function blockScalar(header, parentIndent) {
    const h = header.trim().replace(/\s+#.*$/, '');
    const style = h[0];
    const chomp = h.includes('-') ? 'strip' : h.includes('+') ? 'keep' : 'clip';
    const explicit = (h.match(/[1-9]/) || [])[0];
    let k = i, contentIndent = explicit ? parentIndent + Number(explicit) : -1;
    if (contentIndent < 0) {
      while (k < lines.length && lines[k].trim() === '') k++;
      contentIndent = k < lines.length ? indentOf(lines[k]) : parentIndent + 1;
      if (contentIndent <= parentIndent) contentIndent = parentIndent + 1;
    }
    const body = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') { body.push(''); i++; continue; }
      if (indentOf(l) < contentIndent) break;
      body.push(l.slice(contentIndent)); i++;
    }
    // separate trailing blank lines for chomping
    let trail = 0; while (trail < body.length && body[body.length - 1 - trail] === '') trail++;
    const content = body.slice(0, body.length - trail);
    let text;
    if (style === '|') text = content.join('\n');
    else {
      text = '';
      for (let n = 0; n < content.length; n++) {
        const line = content[n];
        if (n === 0) { text = line; continue; }
        const prev = content[n - 1];
        const moreIndented = /^\s/.test(line) || /^\s/.test(prev);
        if (line === '') text += '\n';
        else if (prev === '' || moreIndented) text += (prev === '' ? '' : '\n') + line;
        else text += ' ' + line;
      }
    }
    if (content.length === 0) return chomp === 'keep' ? '\n'.repeat(trail) : '';
    if (chomp === 'strip') return text;
    if (chomp === 'clip') return text + '\n';
    return text + '\n' + '\n'.repeat(trail);
  }

  const KEY = /^((?:"(?:[^"\\]|\\.)*")|(?:'(?:[^']|'')*')|(?:[^\s"'#\-?:,\[\]{}][^:#]*?|-[^\s:#][^:#]*?))\s*:(?:\s+(.*)|\s*)$/;

  function valueAfterKey(rest, keyIndent) {
    const r = (rest || '').trim();
    if (r === '' || r[0] === '#') {
      skip();
      if (i >= lines.length) return null;
      const ind = indentOf(lines[i]); const t = lines[i].trim();
      if ((t === '-' || t.startsWith('- ')) && ind >= keyIndent) return seq(ind);
      if (ind > keyIndent) return map(ind, {});
      return null;
    }
    if (r[0] === '|' || r[0] === '>') return blockScalar(r, keyIndent);
    if (r[0] === '"' && closingDouble(r) < 0) {
      // multi-line double-quoted scalar: consume lines until the closing quote, then fold
      const parts = [r];
      while (i < lines.length && closingDouble(parts.join('\n')) < 0) { parts.push(lines[i]); i++; }
      let folded = '';
      for (let n = 0; n < parts.length; n++) {
        let seg = n === 0 ? parts[n] : parts[n].replace(/^\s+/, '');
        const last = n === parts.length - 1;
        if (!last) seg = seg.replace(/[ \t]+$/, '');
        if (n === 0) { folded = seg; continue; }
        if (folded.endsWith('\\') && !folded.endsWith('\\\\')) { folded = folded.slice(0, -1) + seg; continue; }
        if (seg === '' && !last) { folded += '\\n'; continue; }
        folded += (folded.endsWith('\\n') ? '' : ' ') + seg;
      }
      return scalar(folded);
    }
    if (r[0] !== "'" && r[0] !== '"' && r[0] !== '[' && r[0] !== '{') {
      // plain scalar with possible continuation lines (more indented than the key)
      const parts = [r];
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '') {
          let k = i; while (k < lines.length && lines[k].trim() === '') k++;
          if (k < lines.length && indentOf(lines[k]) > keyIndent && !/^\s*#/.test(lines[k])) { for (let q = i; q < k; q++) parts.push('\n'); i = k; continue; }
          break;
        }
        if (indentOf(l) <= keyIndent || /^\s*#/.test(l)) break;
        parts.push(l.trim()); i++;
      }
      if (parts.length === 1) return scalar(r);
      let out = '';
      for (let n = 0; n < parts.length; n++) {
        const part = parts[n];
        if (part === '\n') { out += '\n'; continue; }
        out += (n === 0 || parts[n - 1] === '\n') ? part : ' ' + part;
      }
      return out.replace(/\s+#.*$/, '');
    }
    return scalar(r);
  }
  function map(n, obj) {
    while (true) {
      skip();
      if (i >= lines.length) break;
      const l = lines[i]; const ind = indentOf(l);
      if (ind < n) break;
      if (ind > n) fail('unexpected indentation (' + ind + ' > ' + n + ')');
      const t = l.slice(n);
      if (t === '-' || t.startsWith('- ')) break;
      const m = t.match(KEY);
      if (!m) fail('expected "key: value", got: ' + t.slice(0, 60));
      const key = scalar(m[1]);
      i++;
      obj[key] = valueAfterKey(m[2], n);
    }
    return obj;
  }
  function seq(n) {
    const arr = [];
    while (true) {
      skip();
      if (i >= lines.length) break;
      const l = lines[i]; const ind = indentOf(l);
      if (ind !== n) break;
      const t = l.slice(n);
      if (!(t === '-' || t.startsWith('- '))) break;
      const rest = t === '-' ? '' : t.slice(2);
      i++;
      if (rest.trim() === '' || rest.trim()[0] === '#') {
        skip();
        if (i < lines.length && indentOf(lines[i]) > n) {
          const ind2 = indentOf(lines[i]); const t2 = lines[i].trim();
          arr.push(t2 === '-' || t2.startsWith('- ') ? seq(ind2) : map(ind2, {}));
        } else arr.push(null);
        continue;
      }
      const inner = n + 2 + (rest.length - rest.trimStart().length);
      const rt = rest.trimStart();
      if (rt.startsWith('- ')) { i--; lines[i] = ' '.repeat(inner) + rt; arr.push(seq(inner)); continue; }
      const m = rt.match(KEY);
      if (m && !(rt[0] === '"' && closingDouble(rt) === rt.length - 1) && !(rt[0] === "'" && closingSingle(rt) === rt.length - 1)) {
        const obj = {};
        obj[scalar(m[1])] = valueAfterKey(m[2], inner);
        arr.push(map(inner, obj));
      } else if (rt[0] === '|' || rt[0] === '>') arr.push(blockScalar(rt, n));
      else arr.push(scalar(rt));
    }
    return arr;
  }
  skip();
  if (i >= lines.length) return null;
  const first = lines[i].trim();
  const out = (first === '-' || first.startsWith('- ')) ? seq(indentOf(lines[i])) : map(indentOf(lines[i]), {});
  skip();
  if (i < lines.length) fail('trailing content not parsed: ' + lines[i].slice(0, 60));
  return out;
}

// ---------------------------------------------------------------- pipeline
const confPath = path.join(opt.pack, 'default', 'pipelines', 'cardinality_reduction', 'conf.yml');
const pipe = yamlLoad(fs.readFileSync(confPath, 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(opt.pack, 'package.json'), 'utf8'));
const fns = pipe.functions.filter((f) => !f.disabled);
const compiled = fns.map((f) => (f.id === 'code' ? new Function('__e', 'C', f.conf.code + '\n; return __e;') : null));

function evalFilter(expr, e, C) {
  if (expr === 'true' || expr === true) return true;
  return new Function('C', '_raw', '_metric', 'labels', '__keep_bucket', '__cr_requires_aggregation', '__cr_metric_type',
    'parseFloat', 'parseInt', 'return (' + expr + ');')(C, e._raw, e._metric, e.labels, e.__keep_bucket,
    e.__cr_requires_aggregation, e.__cr_metric_type);
}
function runPipeline(event, vars) {
  const C = { vars: vars, Metric: undefined, Log: undefined };
  let e = event;
  for (let n = 0; n < fns.length; n++) {
    const fn = fns[n];
    let passes;
    try { passes = evalFilter(fn.filter, e, C); } catch (err) { passes = false; }
    if (!passes) continue;
    if (fn.id === 'code') e = compiled[n](e, C);
    else if (fn.id === 'eval') {
      for (const kv of (fn.conf && fn.conf.add) || []) {
        try { e[kv.name] = new Function('labels', '__e', 'parseFloat', 'parseInt', 'return (' + kv.value + ');')(e.labels, e); } catch (err) { /* same as harness */ }
      }
      for (const k of (fn.conf && fn.conf.remove) || []) delete e[k];
    } else if (fn.id === 'drop') return null;
    // 'aggregation' is stateful and off by default: not simulated.
  }
  return e;
}

// --------------------------------------------------------------- generator
function mulberry32(a) {
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function makeGenerator(seed) {
  const rng = mulberry32(seed);
  const ri = (a, b) => Math.floor(rng() * (b - a + 1)) + a;
  const pk = (arr) => arr[Math.floor(rng() * arr.length)];
  const hx = (n) => { let s = ''; for (let k = 0; k < n; k++) s += '0123456789abcdef'[Math.floor(rng() * 16)]; return s; };
  const pip = () => '10.' + ri(0, 255) + '.' + ri(0, 255) + '.' + ri(1, 254);
  const PMS = ['http_requests_total', 'http_request_duration_seconds', 'node_cpu_seconds_total', 'node_memory_MemAvailable_bytes',
    'node_network_receive_bytes_total', 'process_resident_memory_bytes', 'go_goroutines', 'container_cpu_usage_seconds_total',
    'container_memory_working_set_bytes'];
  const PJS = ['api-server', 'web-frontend', 'user-service', 'order-service', 'payment-service', 'auth-service', 'search-service'];
  return function line(nowMs) {
    const pm = PMS[Math.floor(nowMs / 15000) % PMS.length];
    const pj = pk(PJS); const pp = pj + '-' + hx(8) + '-' + hx(5); const pi = pip() + ':' + pk(['8080', '9090', '9100']);
    const pn = pk(['production', 'staging', 'default', 'monitoring', 'kube-system']);
    let pl = '', sfx = ''; const isH = pm.indexOf('duration') > -1;
    if (isH) { const le = pk(['0.005', '0.01', '0.025', '0.05', '0.1', '0.25', '0.5', '1', '2.5', '5', '10', '+Inf']); sfx = le === '+Inf' ? '_count' : le === '10' ? '_sum' : '_bucket'; if (sfx === '_bucket') pl = 'le="' + le + '",'; }
    if (pm.indexOf('http') === 0) pl += 'method="' + pk(['GET', 'GET', 'POST', 'PUT', 'DELETE']) + '",handler="' + pk(['/api/v1/users', '/api/v1/orders', '/api/v1/products', '/api/v1/auth', '/api/v1/health', '/api/v2/users/' + ri(1, 9999), '/webhook/' + hx(8)]) + '",code="' + pk(['200', '200', '201', '400', '404', '500', '503']) + '",';
    else if (pm.indexOf('node_') === 0) pl += 'mode="' + pk(['idle', 'user', 'system', 'iowait']) + '",device="' + pk(['sda', 'nvme0n1', 'eth0']) + '",';
    else if (pm.indexOf('container_') === 0) pl += 'container="' + pj + '",image="' + pk(['nginx:1.25', 'node:20', 'python:3.12']) + '",';
    pl += 'instance="' + pi + '",job="' + pj + '",pod="' + pp + '",namespace="' + pn + '"';
    const pv = pm.indexOf('bytes') > -1 ? ri(1e6, 8e9) : (pm.indexOf('seconds') > -1 || isH) ? ri(100, 86400) + '.' + ri(0, 999) : String(ri(100, 999999));
    return pm + sfx + '{' + pl + '} ' + pv + ' ' + Math.floor(nowMs / 1000) + '000';
  };
}

// ----------------------------------------------------------------- measure
function seriesKey(e) {
  const labels = e.labels || {};
  return e._metric + '{' + Object.keys(labels).sort().map((k) => k + '=' + labels[k]).join(',') + '}';
}
function measure(mode) {
  const gen = makeGenerator(opt.seed);
  const t0 = Date.UTC(2026, 8, 1, 12, 0, 0);
  const common = { DESTINATION_TYPE: 'prometheus', MODE: mode };
  const before = { series: new Set(), labels: {} }, after = { series: new Set(), labels: {} };
  let kept = 0, errors = 0;
  const track = (bucket, e) => {
    bucket.series.add(seriesKey(e));
    for (const [k, v] of Object.entries(e.labels || {})) (bucket.labels[k] = bucket.labels[k] || new Set()).add(v);
  };
  const started = Date.now();
  for (let n = 0; n < opt.events; n++) {
    const ts = t0 + Math.floor(n * 1000 / opt.eps);
    const raw = gen(ts);
    const mk = () => ({ _raw: raw, _time: ts / 1000, sourcetype: 'prometheus:metrics', source: 'datatap' });
    const a = runPipeline(mk(), Object.assign({ DRY_RUN: true }, common));
    if (a && a.cr_error) errors++;
    if (a) track(before, a);
    const l = runPipeline(mk(), Object.assign({ DRY_RUN: false }, common));
    if (l && l.cr_error) errors++;
    if (l) { kept++; track(after, l); }
  }
  const labelNames = Array.from(new Set(Object.keys(before.labels).concat(Object.keys(after.labels)))).sort();
  return {
    mode, events: opt.events, kept, dropped: opt.events - kept, engine_errors: errors, ms: Date.now() - started,
    series_before: before.series.size, series_after: after.series.size,
    labels: labelNames.map((k) => ({ label: k, before: before.labels[k] ? before.labels[k].size : 0, after: after.labels[k] ? after.labels[k].size : 0 })),
  };
}

const results = ['safe', 'aggressive'].map(measure);
const pct = (b, a) => (b > 0 ? ((1 - a / b) * 100).toFixed(1) + '%' : 'n/a');
const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
if (opt.json) {
  console.log(JSON.stringify({ pack: pkg.name, version: pkg.version, seed: opt.seed, eps: opt.eps, results }, null, 2));
} else {
  const minutes = (opt.events / opt.eps / 60).toFixed(1);
  console.log('cc-cardinality-reduction v' + pkg.version + ' - synthetic Prometheus benchmark');
  console.log(fmt(opt.events) + ' samples (' + minutes + ' min at ' + opt.eps + ' EPS), seed ' + opt.seed + ', DESTINATION_TYPE=prometheus\n');
  console.log('| MODE | unique series before | unique series after | reduction | samples kept | engine errors |');
  console.log('|---|---:|---:|---:|---:|---:|');
  for (const r of results) console.log('| ' + r.mode + ' | ' + fmt(r.series_before) + ' | ' + fmt(r.series_after) + ' | ' + pct(r.series_before, r.series_after) + ' | ' + fmt(r.kept) + ' | ' + r.engine_errors + ' |');
  for (const r of results) {
    console.log('\nDistinct label values, MODE=' + r.mode + ' (before -> after):');
    for (const l of r.labels) console.log('  ' + l.label.padEnd(10) + ' ' + fmt(l.before).padStart(8) + ' -> ' + fmt(l.after));
  }
}
