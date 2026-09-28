# CLAUDE.md — Meter Reader (project index and reading order)

Meter Reader is a Cribl App (App Platform, Cribl.Cloud) that prices every data flow at its destination, shows leadership what Cribl saved in dollars, and notifies when the money moves the wrong way, through Cribl's own notification bell and notification targets. App ID `meter-reader`; display name `Meter Reader`; license Apache-2.0. The product brief is the [README](README.md).

## Reading order for a fresh session

1. **`AGENTS.md`**: the scaffold's platform guide. It outranks every other document here.
2. **`STATE.md`** (private restart file, not in this repository): the restart file: what is done, in progress and next, measured numbers, the resume command.
3. **`DECISIONS.md`**: every decision with its evidence (D1 onward). The ones that shape everything: D11/D12b (the open tab is the primary runtime), D23 (no `proxies.yml` in the release; it installs on every plan), D24 (the runner, a third runtime), D27–D30 (alert delivery through Cribl), D20 (reconciled attribution), D13 (KV chunking), D17 (the binding platform recommendations).
4. **`SPIKE.md`**: the three gating measurements (metrics query, KV value cap, backend compute).
5. **`docs/PLATFORM_NOTES.md`**: the engineering reference; its section 9 (N1–N26) is binding. **`docs/NOTIFICATIONS.md`**: every request and response behind the bell, notification targets and the Search relay.
6. **`docs/DESIGN_BRIEF.md`**: the binding visual spec for every screen; `docs/platform/capra.md` lists the real Capra exports.
7. **`docs/ARCHITECTURE.md`** and **`docs/RUNBOOK.md`**: how the pieces fit, and how to build, test, package, deploy and run the runner.
8. **`docs/LIVE_VALIDATION.md`**: every live install and break → alert → restore run. `docs/review/`: the wave review reports (adversarial findings, beauty scores, builder reports).
9. Depth when needed: `docs/platform/*.md` (metrics, version, KV and backend, config APIs, preview API, Capra, guidance, Insights and Apps docs) and `docs/RIG.md` (the live demo rig).

The planning PRD and SPEC are kept outside the repository. Where anything disagrees with `AGENTS.md`, `DECISIONS.md` or measured facts, those win.

## Index

| Path | What lives there |
|---|---|
| `core/` | Pure TypeScript shared by every runtime: types (`types.ts` is the contract), pricing, flows (with the D20 reconciliation), rollups, baseline, detector, incidents, timeline, payloads, receipt, weekly, what-if, snapshot, settings, KV (`kv.ts`, the only module that touches keys), the sweep (`sweep.ts`), the delivery router (`delivery.ts`), adapters (the only place URLs live, including `cribl-notify.ts` for the bell, targets and relay), demo levers |
| `src/` | The App UI (React + Capra): `router.tsx`, `views/`, `components/`, `state/` (store, hydrate, live polling, the open-tab meter loop), `story/` (the Story mode beat table), `tour/`, `copy/en.ts` (every user-facing string), `styles/`, `theme/`, `mock/` (the MSW Cribl emulator, dev and Playwright only) |
| `backend/` | Backend endpoints for the Enterprise variant only: `meter`, `weeklyReceipt`, `sendTest` |
| `config/` | `policies.yml` (the release grants: reads, the metrics query, the preview dry run, four notification writes); `demo/policies.yml` (the demo build's superset); `enterprise/` (`backend.yml`, `schedules.yml`, overlaid only into the Enterprise variant; no `proxies.yml` since D57) |
| `demo/` | The demo rig definition (`rig/*.json`), its synthetic sample files, and `sample/` (the tour, the recorded replay and the Story documents) |
| `testdata/` | Seeded synthetic generators for metrics and sample files |
| `tests/` | `unit/`, `integration/`, `e2e/` (Playwright), `compliance.test.ts` with `forbidden.txt` (private: `scripts/publish-public.sh` never exports it), `fixtures/`, `report/` (evidence; the public export keeps only `beauty/SCORES.md`) |
| `scripts/` | `package.mjs` (builds the release, demo and Enterprise packages), `audit.mjs` (release audit), `deploy.mjs` and `cribl-api.mjs` (Apps API install), `runner.ts` (the runner runtime), `lever.ts` (demo levers from a terminal), `story.ts` (generates the Story documents, `VIDEO_SCRIPT.md` and captions), `record-replay.ts`, `reset-app-kv.ts`, `rig/` (apply, verify, watch, remove the demo rig) |
| `release/` | The packaged App (git-ignored until release): `meter-reader-X.Y.Z.tgz` (primary), `meter-reader-X.Y.Z-demo.tgz` (demo, plain numeric version), `meter-reader-X.Y.Z-backend.tgz` (Enterprise variant). Superseded builds go to the git-ignored `build/superseded/`, out of the compliance check |
| `docs/` | Runbook, architecture, notifications, live validation, design brief, platform notes, rig, reviews |
| `PITCH.md` · `VIDEO_SCRIPT.md` · `CHANGELOG.md` | The session script, the generated narration, the release history |

## Commands

```bash
npm ci                                   # install exactly the locked dependencies
npm run dev                              # Vite dev server (outside Cribl it starts the mock emulator)
npm run typecheck && npm run lint        # tsc -b, oxlint
npm test                                 # unit + integration + compliance (vitest)
npx playwright test --project=chromium   # end to end against the mock (port 5174)
npm run package:release -- --version 1.1.0            # release/meter-reader-1.1.0.tgz
npm run package:demo -- --demo-version 1.0.N          # release/meter-reader-1.0.N-demo.tgz (D22: plain numeric; N = the next demo build)
npm run package:backend -- --version 1.1.0            # release/meter-reader-1.1.0-backend.tgz (Enterprise variant)
npm run compliance                       # tests/compliance.test.ts
npm run audit                            # package inventory + compliance
npx tsx scripts/runner.ts                # the runner: sweep every minute with the .env credential (never stop the live one casually)
npx tsx scripts/lever.ts break|restore mrd_pay_sample   # demo levers from a terminal
```

## Rules that are never bent

- TypeScript strict, `erasableSyntaxOnly`, `verbatimModuleSyntax`. No new dependencies without a disclosure row in the README.
- No browser storage (`localStorage`, `sessionStorage`, IndexedDB, cookies) and no canvas: persistence is the App KV store, charts are SVG.
- Money is integer millicents everywhere; format only with `core/format.ts`; labels through `core/humanize.ts`.
- Every user-facing string lives in `src/copy/en.ts`.
- The release build never changes Cribl configuration: demo code is compiled only when `import.meta.env.VITE_MR_BUILD === 'demo'` (tested inline so it tree-shakes), and `config/policies.yml` holds GETs, the metrics query, the preview dry run and exactly the four notification POSTs that `tests/compliance.test.ts` lists as `NOTIFICATION_WRITES`. A new write fails that test until it is documented there and in the README.
- The release and demo packages declare no `proxies.yml` and no backend (D23); only the Enterprise variant declares a backend, and no package declares a proxy host (D57).
- No build stores a credential in KV (D57, hackathon rule 4.5): no webhook URL, token, key or password. Settings keep notification-target ids only; direct webhooks live in the runner's git-ignored `.env`.
- Never act on Cribl configuration outside demo-tagged objects (description contains `[meter-reader-demo]`), never commit anything but the files a change touched, and never DELETE anything (a bell message included) without a confirmation that names it.
- Secrets live only in the git-ignored `.env`; nothing that is a credential is ever stored in plain KV, printed, or committed. Notification targets keep their secrets in Cribl; the App stores only the target id. `tests/forbidden.txt` (private, not exported) lists the strings the compliance test refuses anywhere in the repository or a package.
- Commits are Conventional Commits on `dev`; `main`, tags and releases wait for the project owner.
