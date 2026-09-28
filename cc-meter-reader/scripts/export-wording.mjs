#!/usr/bin/env node
// scripts/export-wording.mjs — the public export's own wording (scripts/publish-public.sh step 2b; DECISIONS D18, D36).
//
//   node scripts/export-wording.mjs <OUT> staging|community
//
// Rewrites two files in an export directory, never in the private tree, then refuses (exit 2) if the export would
// still say something it cannot make true:
//   • CLAUDE.md: its reading order names STATE.md and tests/forbidden.txt, which the export leaves out, so each
//     mention says the file is private. A line that names either without saying so is a refusal.
//   • README.md, --target staging only: the staging copy (DataDay-Technology-Solutions/cribl-apps-public) goes public
//     while the submission repository, Cribl-Community/cc-meter-reader, does not exist yet (rule 9.2: no claim the
//     repository does not yet make true). Every ticked checklist item that claims that repository is unticked and
//     says "(pushed at submission)"; an item that also makes other claims (the LICENSE line) is split, so the claims
//     that are true stay ticked. The staging export refuses if any ticked item still claims the repository, and also
//     if no checklist item names it at all: a rewording the matcher no longer recognises must fail loudly, not pass
//     with the tick intact (rules review r2: the old matcher silently stopped matching).
//
// tests/compliance.test.ts imports the same functions and runs them over the repository's own README, so a README
// change that would slip past the staging rewrite fails the test before any export is built.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The submission repository (README "App Metadata" → Repository; scripts/package.mjs PUBLIC_REPO). */
export const COMMUNITY_REPO = 'Cribl-Community/cc-meter-reader';
/** What an unticked repository claim says in the staging export. */
export const PUSHED_AT_SUBMISSION = '(pushed at submission)';

/** A Markdown task-list item: indent and bullet, the box, the text. */
const TASK_ITEM = /^(\s*[-*+] )\[([ xX])\] (.*)$/;
/** A claim that the submission repository exists: its slug, or the organization it lives in named as the home. */
const CLAIMS_COMMUNITY = /Cribl-Community\/cc-meter-reader|`?Cribl-Community`? organi[sz]ation/i;
/** The slug, backticked or not, where the "(pushed at submission)" note goes. */
const SLUG = /`?Cribl-Community\/cc-meter-reader`?/i;

/** Sentences of one checklist item's text: split after a full stop that ends a sentence (". " then a capital, a link or code). */
function sentences(text) {
  return text.split(/(?<=\.)\s+(?=[A-Z`[*])/);
}

/** One claim, marked as waiting for the submission push: the note after the slug, or before a closing full stop. */
function markPending(text) {
  if (text.includes(PUSHED_AT_SUBMISSION)) return text;
  if (SLUG.test(text)) return text.replace(SLUG, (m) => `${m} ${PUSHED_AT_SUBMISSION}`);
  return /\.$/.test(text) ? `${text.slice(0, -1)} ${PUSHED_AT_SUBMISSION}.` : `${text} ${PUSHED_AT_SUBMISSION}`;
}

/**
 * The staging export's README: every ticked item claiming the Cribl-Community repository unticked (split from the
 * item's other claims, which stay ticked). Returns the text, the 1-based lines rewritten, how many items name the
 * repository either way, and the problems that make the export refuse.
 */
export function stagingReadme(markdown) {
  const out = [];
  const rewritten = [];
  let mentions = 0;
  let fenced = false;
  markdown.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const item = fenced ? null : TASK_ITEM.exec(line);
    if (!item || !CLAIMS_COMMUNITY.test(item[3])) {
      out.push(line);
      return;
    }
    mentions++;
    const [, bullet, box, text] = item;
    if (box === ' ') {
      out.push(line);
      return;
    }
    rewritten.push(i + 1);
    const parts = sentences(text);
    const claims = parts.filter((s) => CLAIMS_COMMUNITY.test(s));
    const others = parts.filter((s) => !CLAIMS_COMMUNITY.test(s));
    if (others.length > 0) out.push(`${bullet}[${box}] ${others.join(' ')}`);
    out.push(`${bullet}[ ] ${markPending(claims.join(' '))}`);
  });
  const text = out.join('\n');
  const problems = [];
  text.split('\n').forEach((line, i) => {
    const item = TASK_ITEM.exec(line);
    if (item && item[2] !== ' ' && CLAIMS_COMMUNITY.test(item[3])) problems.push(`README.md:${i + 1} ticks the ${COMMUNITY_REPO} repository in the staging export`);
  });
  if (mentions === 0) {
    problems.push(
      `README.md: no checklist item names ${COMMUNITY_REPO}, so the staging export cannot hold its claim back; if the Stage One checklist was reworded, update CLAIMS_COMMUNITY in scripts/export-wording.mjs`,
    );
  }
  return { text, rewritten, mentions, problems };
}

/** Files the export leaves out, and what CLAUDE.md says beside each mention of them. */
const PRIVATE_NAMED = [
  { re: /(\*\*)?`STATE\.md`(\*\*)?/, note: ' (private restart file, not in this repository)' },
  { re: /`(?:tests\/)?forbidden\.txt`/, note: ' (private, not exported)' },
];

/** The export's CLAUDE.md: each mention of a file the export leaves out says it is private. */
export function exportClaudeMd(markdown) {
  const lines = markdown.split('\n').map((line) => {
    if (/private/i.test(line)) return line;
    for (const { re, note } of PRIVATE_NAMED) line = line.replace(re, (m) => m + note);
    return line;
  });
  const problems = [];
  lines.forEach((line, i) => {
    if (/STATE\.md|forbidden\.txt/.test(line) && !/private/i.test(line)) problems.push(`CLAUDE.md:${i + 1} names a file the export leaves out without saying it is private`);
  });
  return { text: lines.join('\n'), problems };
}

/** Applies both rewrites inside `out`; returns the problems and a one-line report. */
export function applyExportWording(out, target) {
  if (target !== 'staging' && target !== 'community') throw new Error(`target must be staging or community (got "${target}")`);
  const problems = [];
  const said = [];
  const claudeFile = join(out, 'CLAUDE.md');
  if (existsSync(claudeFile)) {
    const r = exportClaudeMd(readFileSync(claudeFile, 'utf8'));
    writeFileSync(claudeFile, r.text);
    problems.push(...r.problems);
    said.push('CLAUDE.md marks its private files');
  }
  const readmeFile = join(out, 'README.md');
  if (target === 'staging') {
    if (!existsSync(readmeFile)) problems.push('README.md is not in the export');
    else {
      const r = stagingReadme(readFileSync(readmeFile, 'utf8'));
      writeFileSync(readmeFile, r.text);
      problems.push(...r.problems);
      if (r.rewritten.length > 0) said.push(`README.md: the ${COMMUNITY_REPO} claim on line ${r.rewritten.join(', ')} now waits for the submission push`);
      else if (r.mentions > 0) said.push(`README.md: the ${COMMUNITY_REPO} claim was already unticked`);
    }
  }
  return { problems, report: `export wording (${target}): ${said.join('; ') || 'nothing to rewrite'}` };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const [out, target] = process.argv.slice(2);
  if (!out || !target) {
    console.error('usage: node scripts/export-wording.mjs <OUT> staging|community');
    process.exit(2);
  }
  const { problems, report } = applyExportWording(out, target);
  if (problems.length) {
    console.error(`refusing: the export says something it cannot yet make true:\n  ${problems.join('\n  ')}`);
    process.exit(2);
  }
  console.log(report);
}
