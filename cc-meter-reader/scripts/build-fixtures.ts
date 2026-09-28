// scripts/build-fixtures.ts — regenerates the bundled sample fixtures from the real core.
//
//   npx tsx scripts/build-fixtures.ts           write demo/sample/tour.json
//   npx tsx scripts/build-fixtures.ts --check   exit 1 if the committed file is stale (CI / tests)
//
// The tour fixture (testdata/tour.ts) is pure and deterministic, so the committed JSON must always equal
// what this script produces; tests/unit/tour-fixture.test.ts holds it to that.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOUR_JSON_PATH, buildTourDoc, serializeTour } from '../testdata/tour.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

const built = buildTourDoc();
const text = serializeTour(built.doc);
const out = resolve(root, TOUR_JSON_PATH);
const h = built.doc.snapshot.headline;
const summary = `${(built.bytes / 1024).toFixed(1)} KB · MTD saved $${Math.round(h.mtdM / 100_000).toLocaleString('en-US')} · ${built.doc.script.length} script steps · ${built.events.length} detector events`;

if (check) {
  let current = '';
  try {
    current = readFileSync(out, 'utf8');
  } catch {
    current = '';
  }
  if (current !== text) {
    console.error(`${TOUR_JSON_PATH} is stale. Run: npx tsx scripts/build-fixtures.ts`);
    process.exit(1);
  }
  console.log(`${TOUR_JSON_PATH} is current (${summary})`);
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(`wrote ${TOUR_JSON_PATH}: ${summary}`);
}
