#!/usr/bin/env node
// Unblind and tally the verdicts: node bakeoff/tally.mjs <task-id>
// Writes bakeoff/runs/<task-id>/RESULTS.md and prints it.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep in step with RUBRIC.md.
const WEIGHTS = { correctness: 35, spec_fit: 20, repo_rules: 15, code_quality: 15, tests: 10, scope: 5 };
const BUILDERS = ['claude', 'codex'];

const task = process.argv[2];
if (!task) { console.error('usage: tally.mjs <task-id>'); process.exit(2); }
const run = join(dirname(fileURLToPath(import.meta.url)), 'runs', task);
const read = (f) => readFileSync(join(run, f), 'utf8');

// Codex writes the bare object; Claude's --output-format json wraps it.
function parseVerdict(text) {
  let v = JSON.parse(text);
  if (v && v.type === 'result') v = v.structured_output ?? JSON.parse(String(v.result).replace(/^```(json)?\s*|\s*```$/g, ''));
  for (const slot of ['A', 'B']) {
    for (const k of Object.keys(WEIGHTS)) {
      const s = v?.[slot]?.[k];
      if (!Number.isInteger(s) || s < 0 || s > 10) throw new Error(`${slot}.${k} = ${s}`);
    }
  }
  if (!['A', 'B', 'tie'].includes(v.winner)) throw new Error(`winner = ${v.winner}`);
  return v;
}
const total = (e) => Object.entries(WEIGHTS).reduce((t, [k, w]) => t + (e[k] * w) / 10, 0);

const rows = [];   // one per judge × pass × builder
const votes = [];  // one per judge × pass
const problems = [];
for (const f of readdirSync(join(run, 'verdicts')).filter((f) => /^\w+\.p\d+\.json$/.test(f)).sort()) {
  const [judge, pass] = f.replace('.json', '').split('.');
  let v;
  try { v = parseVerdict(read(`verdicts/${f}`)); } catch (e) { problems.push(`${f}: ${e.message}`); continue; }
  const key = JSON.parse(read(`key.${pass}.json`));
  for (const slot of ['A', 'B']) rows.push({ judge, pass, builder: key[slot], slot, ...v[slot], total: total(v[slot]) });
  votes.push({ judge, pass, winner: v.winner === 'tie' ? 'tie' : key[v.winner], rationale: v.rationale });
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmt = (n) => (Number.isNaN(n) ? '–' : n.toFixed(1));
const judges = [...new Set(rows.map((r) => r.judge))].sort();
const score = (b, j) => mean(rows.filter((r) => r.builder === b && (!j || r.judge === j)).map((r) => r.total));
const meta = Object.fromEntries(BUILDERS.map((b) => [b, existsSync(join(run, `${b}.meta.json`)) ? JSON.parse(read(`${b}.meta.json`)) : {}]));

const overall = Object.fromEntries(BUILDERS.map((b) => [b, score(b)]));
const [lead, trail] = [...BUILDERS].sort((x, y) => overall[y] - overall[x]);
const verdict = Math.abs(overall[lead] - overall[trail]) < 3 ? 'Tie (within 3 points)' : `**${lead}** wins by ${fmt(overall[lead] - overall[trail])}`;

// A judge that picks its own builder every time is a self-preference signal.
const selfPick = judges.filter((j) => {
  const mine = votes.filter((v) => v.judge === j);
  return mine.length > 0 && mine.every((v) => v.winner === j);
});

const out = [
  `# Bake-off results: ${task}`,
  '',
  `Result: ${verdict}. The score is the mean weighted total out of 100, across ${judges.length} judge(s) × ${new Set(votes.map((v) => v.pass)).size} pass(es) with A and B swapped.`,
  '',
  `| Builder | Overall | ${judges.map((j) => `by ${j}`).join(' | ')} | Check exit | Wall time | Patch lines |`,
  `|---|---|${judges.map(() => '---|').join('')}---|---|---|`,
  ...BUILDERS.map((b) => `| ${b} | ${fmt(overall[b])} | ${judges.map((j) => fmt(score(b, j))).join(' | ')} | ${meta[b].check_exit ?? '–'} | ${meta[b].seconds ?? '–'}s | ${meta[b].patch_lines ?? '–'} |`),
  '',
  '## Per criterion (mean, 0–10)',
  '',
  `| Criterion (weight) | ${BUILDERS.join(' | ')} |`,
  `|---|${BUILDERS.map(() => '---|').join('')}`,
  ...Object.entries(WEIGHTS).map(([k, w]) => `| ${k} (${w}) | ${BUILDERS.map((b) => fmt(mean(rows.filter((r) => r.builder === b).map((r) => r[k])))).join(' | ')} |`),
  '',
  '## Votes',
  '',
  ...votes.map((v) => `- **${v.judge}**, ${v.pass}: ${v.winner}. ${v.rationale}`),
  '',
  ...(selfPick.length ? [`> Self-preference check: ${selfPick.join(', ')} picked its own builder in every pass. Weigh the other judge's scores more heavily.`, ''] : []),
  ...(problems.length ? ['## Unusable verdicts', '', ...problems.map((p) => `- ${p}`), ''] : []),
  '## Judge notes (unblinded)',
  '',
  ...rows.map((r) => `- **${r.judge} on ${r.builder}** (${r.pass}, as ${r.slot}, ${fmt(r.total)}): ${r.notes}`),
  '',
];
writeFileSync(join(run, 'RESULTS.md'), out.join('\n'));
console.log(out.join('\n'));
if (problems.length) process.exitCode = 1;
