# Story mode (wave 3a) — builder report

Story mode is built and working. `?story=1` on any route, or the Y key, plays a 91-second loop that exits on any key. The same beat table generates `demo/sample/story.json`, `VIDEO_SCRIPT.md` and `video/captions.srt`, so the loop, video and captions can't drift. `demo/sample/story-live.json` was not generated because `demo/sample/replay.json` doesn't exist yet.

**Tests:** `npx tsc -b` has no errors. The full `npx vitest run` has 1105 passing and 3 failing. All 3 failures are in `tests/compliance.test.ts`, about `config/policies.yml` and README grants. Another builder is changing those files (notification delivery work), and I didn't touch them. My 49 story unit tests pass, and `tests/e2e/story.spec.ts` passes 16 of 16 across chromium, chromium-1920 and mobile. I checked the release package build, and it drops the story test hook.

**How it plays**
- **Beats:** title 4 s → hook 5 → how it works 10 → the Meter 8 → a change ships 6 → watching 10 → the alert 12 → Slack 6 → Restore 8 → the receipt 8 → summary 6 → the ask 8.
- **Captions:** wording comes from `story.captions.*` in `src/copy/en.ts`. Every number is formatted from `tour.json` when the files are generated ($73,832 / $33,453 / $40,379 / 25 points / 22d0a5e / j.rivera / $25 / $9,127 / 2:51). The last beat's caption is "Meter Reader · Customer track · vote in the CriblCon app." with the QR.
- **Engine and pieces:** the existing tour engine plays the beats in sample mode with loop on, with the SAMPLE DATA band showing. The view imports the Meter, ReceiptBar, HowItWorks (with `activeStep`), TakeoverCard, SlackPreview and QrBlock as they are.
- **Alert card:** the alert and its Slack delivery arrive together, so the card reads "Caught in 2:51" from its first frame, matching the caption. Otherwise the live clock would read about 3:11.
- **Watching chart:** the watching beat draws the payments pipeline's own ratio, minute by minute, going from 75% to 50%. The workspace-wide ratio only moves about 1 point, which you couldn't see.
- **Callouts:** each is a label with a leader line to its `data-callout` element, positioned from `getBoundingClientRect` and reflowed every frame and on resize. A label never covers any of the beat's targets, the caption rail or another label.
- **Timing change:** callouts stay up only while the caption line they arrived with is showing. I added this to cut clutter, especially on phones; it's my decision, not something the spec says.
- **Reduced motion:** nothing slides or draws in; states just switch. The × button or "Clear sample data" also exits.
- **`beatAt(tSeconds)` for the video capture:** it's in `src/story/doc.ts`. For plain Node, use `positionAt(doc, t)` in `src/story/timeline.ts`.

**Open issues**
- **`story-live.json`:** the loader in `src/views/Story/source.ts` switches the demo build to the recorded run automatically once `demo/sample/replay.json` and `demo/sample/story-live.json` both exist. After recording the replay, run `npx tsx scripts/story.ts`.
- **Callout labels:** the labels (e.g. "the commit", "who deployed it") are hardcoded in `src/story/beats.ts` because I don't own `en.ts`. They should move into `en.ts` under `story.callouts.*`.
- **Short cut length:** the PRD's rule for the 60-second cut (drop "how it works" and "watching") gives 1:11. `VIDEO_SCRIPT.md` states that and suggests trimming the title or summary.
- **Phone alert beat:** at 390 px, one leader line crosses the "$9,127 a year" text. The card has no free space near the commit hash.
- **Label placement after a jump:** a label placed while a card is still sliding in can keep a slightly worse spot. This only happens when seeking straight into a beat, which the video capture may do.
- **Test flake:** the Vite server Playwright starts hot-reloads when other builders edit `src/`. That caused one failed run (the story restarted from 0 mid-test); it passed on rerun.
- **Formatting:** Prettier has no config in the repo, so `npm run format` fails on existing files too. I kept the repo's style.
- **Not mine:** `npx tsc -b` showed errors in `scripts/live-demo-run.ts` during the session; they cleared by the final run.

Nothing was committed or pushed, and the runner is still running.

**Files (all within my ownership)**
- `src/story/`: `beats.ts` (the beat table), `timeline.ts`, `doc.ts`, `fixture.ts`, `layout.ts`, `render.ts`, `select.ts`, `index.ts`
- `src/views/Story/`: `index.tsx` (replaces the placeholder), `useStory.ts`, `source.ts`, `stages.tsx`, `RatioWatch.tsx`, `Callouts.tsx`, `testHook.ts`, `Story.css`
- `scripts/story.ts` (run `npx tsx scripts/story.ts`; `--check` reports stale files)
- Generated: `demo/sample/story.json`, `VIDEO_SCRIPT.md`, `video/captions.srt`
- Tests: `tests/unit/story-beats.test.ts`, `tests/unit/story-timeline.test.ts`, `tests/unit/story-layout.test.ts`, `tests/e2e/story.spec.ts`
- Screenshots (git-ignored, local only): `tests/report/beauty/story-<beat>-<theme>-<390|1920>.png`, 48 files