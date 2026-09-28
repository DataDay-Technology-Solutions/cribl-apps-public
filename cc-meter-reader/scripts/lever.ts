#!/usr/bin/env -S npx tsx
// scripts/lever.ts — pull the demo levers from the command line (the same core/demo/levers.ts the Demo
// Console calls), with the org API credential. Demo-tagged objects only; every lever refuses anything
// without [meter-reader-demo], commits with an explicit file list, deploys, and writes its own commit to
// the App's timeline so the incident names it.
//
//   npx tsx scripts/lever.ts break   mrd_pay_sample
//   npx tsx scripts/lever.ts restore mrd_pay_sample
//   npx tsx scripts/lever.ts apply   mrd_windows_workstations [aggressive]
//   npx tsx scripts/lever.ts revert  mrd_windows_workstations
//   npx tsx scripts/lever.ts baselines          (reset baselines)
//   npx tsx scripts/lever.ts reset              (reset everything the levers changed)
// The commit author recorded in the timeline is MR_DEMO_AUTHOR (default "s.koelpin").
import { applyPack, breakTrim, resetAll, resetBaselines, restoreTrim, revertPack } from '../core/demo/levers.ts';
import { leverDepsFrom } from '../core/runtime.ts';
import { deps } from './runner.ts';

const [cmd, target, level] = process.argv.slice(2);
const author = process.env.MR_DEMO_AUTHOR || 's.koelpin';
const d = leverDepsFrom(deps(), author);
const started = Date.now();
let result: unknown;
switch (cmd) {
  case 'break': result = await breakTrim(d, { pipelineId: target }); break;
  case 'restore': result = await restoreTrim(d, { pipelineId: target }); break;
  case 'apply': result = await applyPack(d, { routeId: target, level: level === 'aggressive' ? 'aggressive' : 'pack' }); break;
  case 'revert': result = await revertPack(d, { routeId: target }); break;
  case 'baselines': result = await resetBaselines(d); break;
  case 'reset': result = await resetAll(d); break;
  default:
    console.error('usage: lever.ts break|restore <pipelineId> | apply|revert <routeId> [aggressive] | baselines | reset');
    process.exit(2);
}
console.log(JSON.stringify({ cmd, target, at: new Date(started).toISOString(), ms: Date.now() - started, result }, null, 2));
