# Beauty critique (wave 3a) — verdict and top fixes

Full grid: tests/report/beauty/SCORES.md

**Verdict: not yet, but close.** The Receipt and the presenter at rest already beat most of what Cribl ships: a restrained money palette, a real receipt identity, and one clean type system. The review would stop on four things:
- **The incident card on stage:** it covers content and the vote ask exactly at the payoff.
- **Dark theme:** the active Settings nav item is a near-white pill.
- **Sample band on phones:** it falls apart, and that's the judges' first 30 seconds.
- **Consistency:** page widths, card styles and colour meanings change from tab to tab.

Fixing F1, F4, F5 and F7 (with F2) gets it through a review; F8–F10 make it win. I did not edit anything in `src/`. Under PRD 8.8 item 12 the checkpoint isn't green: two Tier 0 screens (presenter with the incident card, and the incident card itself) have ✗.

**Top 15 fixes, ranked by impact**
1. **F1 – incident card covers the stage.** At 1920 its top edge is at y=540: saver rows 4–5, the hero caption and the QR vote caption are hidden or cut in half. At 1440 (top at y=450), row 5 and the caption are cut and the vote caption is hidden. `presenter.spec.ts` asserts the card's position, so fix the stage instead: in `Presenter.css`, pin the hero and savers to the top of their row so they end above half height (or fade the savers while an alert is up). Move `.mr-qr-caption` above the QR plate, and add a test that nothing overlaps the card.
2. **F2 – presenter empty state is a 140 px grey "$0".** Show `$—` or a skeleton with "Set prices to start the meter".
3. **F3 – recovery card isn't "the same card in green".** It's shorter, bottom-anchored, white on white in light theme, and its sub-line still says "Savings dropped". Give it the same height, the saved-green tint, and new copy.
4. **F4 – dark-theme Settings nav.** The active item measures background rgb(237,251,251) with teal text. Fix the override at `Settings.css:56`.
5. **F5 – sample band at 390.** `flex-wrap` leaves the dot alone on a row and orphans "traffic.", making the band about 90 px tall. Switch it to a grid, and change the purple highlight colour to the brief's striped `warning.subtle`.
6. **F6 – Demo tab is cut off on the phone remote ("Der").** Scroll the active tab into view, add an edge fade, and list Demo first on phones.
7. **F7 – page frame jumps between tabs.** Containers are 1200, 1280 and 1600 px, so titles sit at x=24 on some tabs and x=80 on others at 1440. Use one page container and one title rule.
8. **F8 – card styles differ by screen.** Some are flat, some shadowed; incident cards nest shadows inside shadows; severity stripes are clipped by rounded corners (a template tell); What-if uses dashed borders on ordinary containers. Use one card rule, no nested shadows, and a severity header band instead of stripes.
9. **F9 – Flow map with real data.** On the 28-flow sample tour it runs past the fold, stacks $2–9 labels, and the $45/day S3 passthrough is the biggest shape. Light-theme ribbons at 0.4 opacity will wash out on a projector. Fit the map to the viewport, group small flows, only label ribbons at least 12 px thick, fade cheap flows, and use a list on phones.
10. **F10 – colour spent on chrome.** Green is used for statuses, red for "Remove" and delivery problems, blue for info pills, purple for sample data, and some chips are ALL CAPS. The brief reserves green for money and red/amber for severity.
11. **F11 – Ledger is mostly noise.** 7 of 11 visible rows are zero-traffic flows with raw names ("In cribl http", "Main", "Devnull"). Hide them by default behind one summary row and humanize the names.
12. **F12 – change timeline hides its own story.** In the 24 h view the whole regression sits in the last ~15 px, with the markers stacked. Zoom to the markers by default and stagger overlapping ones.
13. **F13 – dot leaders don't read like a receipt.** The presenter's fixed-width amount column leaves 20–60 px gaps and clips the first dot; Receipt leaders stop at random points; the cost receipt uses solid rules and a hyphen instead of a minus.
14. **F14 – empty states are generic.** Stock cloud and folder illustrations and dashed boxes, where the brief asks for a skeleton of the real layout. The 403 copy says "everything else still works" over a blank page.
15. **F15 – Demo Console shows its scaffolding.** "Tier 2" chips, a "not in this build" row, a disabled button that looks filled (more prominent than enabled ones), and the status line above the title on desktop.

**Test status**
- **Playwright (chromium, chromium-1920, mobile):** 202 passed, 43 skipped, 1 failed. The one failure (a missing trace file) was caused by me: I ran `demo.spec.ts` at the same time, and it cleared the shared `tests/report/playwright` output folder mid-run.
- **Demo Console spec against a demo build:** 7 of 7 passed.
- **`tour.spec.ts` "narration" test:** it passed on chromium in the full run, but now fails on both chromium and mobile when re-run: "Cost spike: Kubernetes prod" is never shown. Other builders were editing `core/snapshot.ts`, `core/rollups.ts` and related files at the time; I haven't confirmed that's the cause.
- **`npx vitest run`:** 1047 of 1047 passed.
- **`npx tsc -b`:** 4 errors, all in `scripts/live-demo-run.ts`, which belongs to another builder (`deployedAt` does not exist on `LeverResult`).

**Open issues (not visual)**
- The "Where to send alerts" page says alerts go "through Cribl's proxy", shows a "declared" badge and "Packaged with this App. No setup needed". That contradicts D23 (the release has no `proxies.yml`).
- Test fixtures use backend mode, so release-build screenshots show "Sweeps run every minute in the background", which D12b rules out.
- The demo build footer reads `v1.0.0-demo`; D22 says demo versions are plain numeric (1.0.1 is installed).
- Some specs write files named `-1440` without checking the project, so the mobile project overwrites them with 390-wide images; I saw this happen. The lines are `receipt.spec.ts` 434/548/581/589 and `flow.spec.ts` 144/146/212/217/227.
- The takeover at 1440 and "Where to send alerts" at 1920 exist only in `critic/`, not in the main grid.

I stopped the two Vite servers I started (ports 5179 and 5180). The runner is still running and I didn't touch KV.

**Files**
- tests/report/beauty/SCORES.md (new: full screen × theme × width grid with a fix for every ✗)
- tests/report/beauty/critic/ (new: 72 gap screenshots)
- tests/report/beauty/*.png (regenerated by the runs)
- a throwaway spec and helpers in the session scratchpad (beauty/critic.spec.ts, not committed)