# EPIC audit — synthesis of 23 lenses (Phase A of the EPIC program)

_Written 2026-09-26 from 23 read-only lens reports (457 findings) against `dev` at `2e6758f`, the mock at :5173 and GET-only reads of the org. Companion data: `docs/review/EPIC_AUDIT.json` (the deduplicated backlog, 149 items, machine-readable). Evidence lives under `tests/report/audit/<lens>/` (git-ignored); every evidence path cited below was checked to exist at synthesis time (609 paths, 0 missing)._

**Owner's bar:** "truly epic — functionality and polish; tokens are not a constraint." **Deadline:** submission Wed 9/30.

## How to read this

- **Tier rule, applied mechanically.** **P0** = a judge hits it during the five-minute demo, in the Story/Tour loop, or on a fresh install of the release in their own workspace (single- or multi-group), or it is a truthfulness problem in what the judges read. **P1** = polish a judge might notice; land it if it fits before Wednesday. **P2** = wow features, ranked by impact ÷ effort.
- **Ordering.** P0 and P1: impact desc, then effort asc. P2: score = impact ÷ effort points (S = 1, M = 2, L = 3), ties by impact then effort.
- **Every item** carries area, files, evidence (paths and file:line), effort, impact, the lenses that raised it, a fix sketch and a one-line acceptance test. P2 items also carry a design paragraph.
- **Dedup.** Findings describing one defect were merged into one item and every evidence path was kept. 476 finding-citations are folded into 149 items (some findings inform two items, e.g. the toast placement and the keyboard map).
- **Not repeated here** (per the brief): the video's QR URL 404; the custom-range items in `tests/report/audit/_known/range-findings.json` (partial current hour, DOC_CAPS truncation, snapRange end past now, future ranges). Items already fixed by BEAUTY-3a/REVIEW-3a/NOTIFY-3a/STORY-3a/COREFIX-3a were dropped when a lens confirmed the fix landed (F1/F2/F3/F13 stage fixes, F4/F7 Settings, F15, F22 partially, F25).
- **In flight elsewhere, redirected rather than tiered** (section 5): the incident `after`/`recoveredTo` arithmetic (D47, workflow `critique-fixes`), the percentage labels and "priced as preset" rows (same workflow), the board-pack / PDF / SVG receipt export (workflow `report-card`), the custom-range read plan and range correctness (the range fixer).

---

## 1. Scorecard per lens

Scores are the lenses' own (1–10, hackathon-judge framing). Findings are counted by the severity the lens assigned. "Into P0" names what this synthesis promoted from that lens.

| Lens | Score | Findings (blocker / major / minor / idea) | One-line verdict | Into P0 |
|---|---|---|---|---|
| judge-cribl-pm | 8 | 19 (0/7/8/4) | A real app that uses the platform seriously; kept from 9–10 by the undeclared `/master/groups` call, silent 403/429, the packaged README, dead shortcuts after a tab click, the webhook default and an emulator that never exercises the Cribl-native delivery. | P0-03, P0-05, P0-07, P0-10, P0-11, P0-21 |
| judge-cfo | 6 | 20 (0/8/8/4) | Credible engine, non-credible receipt: nothing forwarded carries a basis, coverage or unpriced exclusions; a dead Committed field; budget pace 25× low mid-month; diversion credits blended with measured reductions. | P0-17, P0-19, P0-23 |
| judge-security | 7 | 10 (0/3/5/2) | Strong posture (create-only writes, secrets in Cribl, no browser storage); the gaps are disclosure: read grants return decrypted tokens, write grants allow any body, the demo build's grants make a shared member a config admin. | P0-22 |
| judge-sre | 5 | 17 (1/7/6/3) | Strong metering core but not safe unattended: >3 worker groups meter $0 (blocker), the spike rule never learns level shifts, no mute/exclude/ack, no back-off under rate limiting, lock not renewed on slow Leaders. | P0-02, P0-07 |
| judge-devrel | 7 | 16 (0/5/7/4) | Polished and fast in the first five minutes; the newcomer gets lost at README step 3 ($0 suggested prices on DevNull rigs, MTD landing on $10.62, custom price under a preset label, no on-screen affordance for the shortcuts). | P0-04 |
| judge-wow | 7 | 16 (1/5/6/4) | The takeover landing by itself is the memorable moment; as scripted it will not land (blocker), the rest state is a static number on a half-empty stage, the dollar map never appears in the story or video, the real stage frame is light theme. | P0-01, P0-13 |
| view-receipt | 7 | 22 (0/2/15/5) | The most finished screen; composition not craft holds it back (an ~800 px void beside the hero, truncated savers on the tour, a copied receipt that does not look like the screen). | P0-18 (with view-firstrun) |
| view-flow | 7 | 26 (0/6/15/5) | Well built, but bands are sized by bytes and plates gated by pixels on the view whose subtitle is "This is dollars"; saved plates float; light ribbons 1.3–1.7:1; the dark wedge invisible. | — |
| view-whatif | 7 | 17 (0/4/8/5) | Coherent and on-brief; range treatments wrap and clip the compare strip, $0-before says the same number three times, box-in-a-box math, an un-Capra slider, the payoff state is one grey sentence. | — |
| view-ledger | 7 | 26 (0/4/17/5) | Pixel-aligned tabular figures and sticky totals; the wide table truncates both name columns at 1440 and 1920, a ragged lower row, phone day labels collide, the commit card covers its own title. | — |
| view-settings | 7 | 30 (0/8/17/5) | The most disciplined view; the judge's first two screens read as broken: four "Internal / free · $0.00" rows, a 160 px preset listbox of sentences, Add endpoint already red, the webhook default. | P0-04, P0-10, P0-19, P0-20 |
| view-presenter | 7 | 20 (0/5/10/5) | Rest frame and red→green payoff clear the bar; a two-line title clips the foot at 1920, the stage overflows at 720p/768p, the odometer shows glyph fragments on every ease, the QR is 200 px at 1440. | P0-08, P0-14, P0-15, P0-16 |
| view-story | 7 | 23 (0/4/14/5) | Cohesive; alert/restore beats overflow 1080 by 19/15 px, the hero re-lays out under the card, the striped band sits on every cinematic frame, leaders cut through money text. | P0-24 |
| view-demo | 7 | 22 (0/3/14/5) | Competent remote; half the desktop empty with tools below the fold, the one button that matters at 3.91:1, dark confirmations lose the "This affects" framing. (Demo build reviewed from source + beauty PNGs.) | — |
| view-firstrun | 7 | 20 (0/7/8/5) | Designed empty states are good; a layer of state-truthfulness bugs (unpinned sample band, "Waiting for the first sweep" when nothing can sweep, 403 copy for 5xx, "last good data" over $—, the trend drawing $0 before collection began). | P0-18 |
| view-shell | 7 | 22 (0/4/13/5) | Quiet, consistent chrome; scope discipline in the keyboard map (letters fire inside selects, P on a non-Receipt tab strips chrome, Escape ignored), toasts over the status cluster, a bare dot on phones, a skeleton flash into the stage. | P0-05, P0-06, P0-09 |
| a11y | 7 | 20 (0/5/12/3) | Well above hackathon norms; seven genuine WCAG 2.2 AA failures remain (markers behind role=img, the math drawer unscrollable by keyboard, Tab exits Story, no shortcut off switch, a 2.3:1 light focus ring, the toggle at 320 px, plus two inherited Capra colour issues). | P0-05 (Tab in Story) |
| copy | 7 | 30 (0/7/19/4) | Strong base (sentence case, no exclamation marks, blame-free errors); cross-screen contradictions (30 s vs every minute, "about 3 minutes" under the 1-minute profile, "illustrative" presets, unconditional "every Monday") and unit/typography wobble. | P0-21, P0-12 |
| motion | 7 | 15 (0/3/10/2) | 60 fps everywhere measured; the misses are in the hand-offs (red card vanishes before the green slides in, story frame grows 18.6 px, every lazy entry flashes a ghost page, the What-if morph double-tweens). | P0-24 (with view-story), P0-16 |
| states | 7 | 23 (0/8/12/3) | Designed states are genuinely good; presenter truthfulness (Live forever, toasts on the stage, P on any route drops the chrome), a metering failure silent for five minutes, prices an open tab never re-reads. | P0-06, P0-07, P0-08, P0-09 |
| api-budget | 6 | 11 (0/3/6/2) | One metering tab is 35–38 calls/min (under the 50 target); the org runs ≈ 59/min because tab and runner both meter; the worst legal presenter config 429s continuously; the stage path has never been measured. | — (F2 handed to the range fixer) |
| truth | 7 | 16 (0/3/12/1) | Unusually honest; the hard claims held (packages, grants, constants, presets, sources, live numbers); wording outruns the product in "read-only", unconditional "every Monday", "within two minutes", the Slack card's provenance and stale version bookkeeping. | P0-11, P0-12 |
| scout | 7 | 16 (0/1/0/15) | Core is judge-ready; the Custom range is invisible in the Tour, the stage has no positive payoff, commits are named but never priced; one stage-critical bug (P/Y/? dead while a tab has focus). | P0-05 |

**Totals:** 457 findings = 2 blockers, 112 major, 242 minor, 101 ideas. Mean score 6.9, median 7. No lens scored below 5; nothing was found that blocks submission, two things block the demo as scripted (P0-01) or a customer install (P0-02).

---

## 2. The ten things a judge would notice

1. **Click any nav tab, press P → nothing.** Every mouse click on a tab leaves it focused and the shell's bubble-phase listener never sees the key; on stage that is "click Ledger, press P, silence". (P0-05)
2. **Press P on the Ledger or Flow → a chromeless Ledger with the title clipped and no way back.** The stage exists only at `/`. (P0-06)
3. **On the emulator and on the demo rig, "Use suggested prices (4)" prices a SIEM at $0.00** and the first Receipt reads "$0 · 0% saved"; every rig destination is DevNull and `suggestPreset` keys on type alone. (P0-04)
4. **The live Receipt's 30-day trend will show ~26 days of $0 then a cliff by Wednesday** (collecting since Sep 26): "Cribl saved nothing for four weeks, then something happened". (P0-18)
5. **As scripted, the takeover card cannot land:** it mounts only in the presenter view and ignores incidents already open when P is pressed, while PITCH has the laptop on Flow at 2:40. (P0-01)
6. **The pasted receipt (pitch step 9) is a bare total** — no price basis, no counterfactual disclosure, no unpriced exclusions, no "N of M minutes metered" — and the Monday receipt in Slack is the same six lines. (P0-23)
7. **The footer says every 30 seconds while the Runtime card beside it says every minute**; the demo toast says "about 3 minutes" with the 1-minute profile on; Show the math still calls sourced presets "illustrative". (P0-21)
8. **A member on a fresh install gets a 403 on the Prices page** (undeclared `GET /master/groups`), and **an org with more than three worker groups meters $0 for the ones the first sweep skipped**, silently. (P0-03, P0-02)
9. **"Read-only" in the launch copy** against four POST grants in `policies.yml` (PITCH's own never-say list), an unconditional "every Monday", and a README whose packaged form opens with a broken hero image and dead links. (P0-12, P0-11)
10. **Silent failure:** with the metrics query refused or rate-limited the chip stays "Live", the diag says "errors none", and after five minutes it only says "Stale"; the presenter says "Live" forever, even under a 502. (P0-07, P0-08)

Runner-up: the Settings preset picker (a 160 px column of three-line sentences opening upward over the card), the dead "Committed $ / GB" field, the new-endpoint default that Standard plans cannot use, and the takeover's foot clipped at 1920 by a two-line title.

---

## 3. The backlog

Rendered from `EPIC_AUDIT.json`; the JSON is the source of truth. Each item: `id · title`, then area · package · impact · effort · lenses, files, evidence, gate (dependency), fix, acceptance.
### 3.1 P0 — defects to fix before the demo (24)

Order: impact desc, then effort asc.

| ID | Impact | Effort | Package | Item |
|---|---|---|---|---|
| P0-01 | 5 | S | WP-N | The payoff cannot land as scripted: the takeover mounts only in the presenter view and its tracker ignores incidents already open when P ... |
| P0-03 | 5 | S | WP-E | The pre-sweep inventory calls the undeclared, deprecated GET /master/groups, so a non-admin member gets a 403 on the Prices page of a fre... |
| P0-05 | 5 | S | WP-A | Global shortcuts (P, Y, ?, /) are dead whenever a nav tab has focus (the state after every mouse click on a tab); fixing that in the capt... |
| P0-06 | 5 | S | WP-A | P (or ?present=1) on any non-home route strips the chrome from that view instead of opening the stage: the Ledger renders with no nav, ti... |
| P0-22 | 5 | S | WP-N | The README does not say what the grants expose: the Source/Destination read grants return auth tokens, API keys and passwords decrypted t... |
| P0-23 | 5 | S | WP-F | Every forwardable receipt (Copy receipt, the Monday receipt in the bell/Slack/targets) is a bare total with no per-destination price basi... |
| P0-02 | 5 | M | WP-E | Orgs with more than three Stream worker groups meter $0 for the groups the first sweep did not pick; the inventory refresh never fits the... |
| P0-04 | 5 | M | WP-G1 | 'Use suggested prices (4)' fills every destination with Internal / free at $0.00 because the emulator and the live demo rig outputs are a... |
| P0-08 | 4 | S | WP-B | The stage says 'Live' forever: the green dot and the word stay while data is 7 min or 2 days old, while every poll answers 502, and with ... |
| P0-10 | 4 | S | WP-G2 | A new endpoint defaults to 'Direct webhook', the one channel the release cannot use on Standard plans (its own hint says so) and the one ... |
| P0-11 | 4 | S | WP-N | The README inside every .tgz is the Marketplace overview and opens with a broken hero image (video/ is excluded from the stage), dead rel... |
| P0-12 | 4 | S | WP-N | Launch copy outruns the product: 'read-only' / 'never touches config' (the release posts four creating writes and Connect is a labelled c... |
| P0-13 | 4 | S | WP-N | The five-minute pitch never shows the forecast-confirmed-live beat (What-if -> Apply for real -> 'projected 33%, measured 34%'), and the ... |
| P0-14 | 4 | S | WP-B | A two-line incident title pushes the takeover's foot out of the fixed lower-half card at 1920: the card scrolls inside itself and 'Caught... |
| P0-15 | 4 | S | WP-B | At 1280x720 and 1366x768 the stage does not fit (24 px / 12 px of vertical scroll; the QR 19-34 px from the bottom edge instead of >= 40)... |
| P0-16 | 4 | S | WP-B | During every ease the digit window is taller than the glyph, so fragments of the next and previous digits show above the cap line and bel... |
| P0-17 | 4 | S | WP-F | Budget pace projects paid-MTD over minutes since the 1st of the month, not since collecting began: a day-25 install projects 25x low so '... |
| P0-19 | 4 | S | WP-G1 | 'Committed $ / GB' is a dead field: PriceTable stores committedMilliCentsPerGb, nothing in core reads it, it is undocumented, and on a ne... |
| P0-20 | 4 | S | WP-G1 | The Preset listbox is the trigger's width (160 px) while every option is a sentence, so 15 options wrap to 3 lines, four fit, the list op... |
| P0-21 | 4 | S | INT | The app contradicts itself on facts a judge reads side by side: footer 'every 30 seconds' vs Runtime card, first-run strip and Story 'eve... |
| P0-24 | 4 | S | WP-C | In the Story loop the alert and restore beats overflow a 1920x1080 frame by 19/15 px (the inline takeover card grows the 1fr stage row), ... |
| P0-07 | 4 | M | WP-D | A refused, rate-limited or failing sweep is invisible: with metrics 403/429/500 the chip stays 'Live', the footer keeps 'Last sweep N min... |
| P0-18 | 4 | M | WP-H | The 30-day trend plots every day before collection began as $0: the live org (collecting since Sep 26) will show ~26 days of a flat zero ... |
| P0-09 | 3 | S | WP-A | Error and delivery toasts land on the presenter stage (top-right, over the frame the audience sees) while the hero caption or the takeove... |

#### P0-01 · The payoff cannot land as scripted: the takeover mounts only in the presenter view and its tracker ignores incidents already open when P is pressed; PITCH has the laptop on Flow at 2:40

- **Area:** pitch / presenter takeover · **Package:** WP-N · **Impact:** 5 · **Effort:** S · **Lenses:** judge-wow (1 finding merged)
- **Files:** `PITCH.md`
- **Evidence:** src/views/Presenter/index.tsx:198 (sole IncidentTakeover mount besides Story/stages.tsx); src/components/IncidentTakeover/tracker.ts:4-5 (first snapshot is the baseline); PITCH.md:7,15,16,21; docs/LIVE_VALIDATION.md run 8 (validated only with ?present=1 already on screen); tests/report/audit/stage-judge/takeover-alert-dark-1920.png
- **Fix:** Script: end step 6 with 'press P' (~2:35, inside the 1:27-2:13 window) and rewrite line 21 ('press P and narrate; the card lands on the presenter view'). The code half (takeover in the Shell, tracker seeded from the tab's last snapshot) is P1-A01.
- **Acceptance:** Rehearsal on the org following PITCH.md verbatim: Break the trim from the phone, laptop on Flow, press P at the scripted second, the red card lands within the measured window without any other click.

#### P0-03 · The pre-sweep inventory calls the undeclared, deprecated GET /master/groups, so a non-admin member gets a 403 on the Prices page of a fresh install and can never start the meter

- **Area:** policies / member path · **Package:** WP-E · **Impact:** 5 · **Effort:** S · **Lenses:** judge-cribl-pm (1 finding merged)
- **Files:** `core/adapters/config.ts`, `core/adapters/cribl-urls.ts`, `tests/compliance.test.ts`
- **Evidence:** core/adapters/config.ts:202-205 listWorkerGroups -> urls.groups(); core/adapters/cribl-urls.ts:13 '/master/groups'; src/state/runtime.ts:107 readLeaderInventory; core/sweep.ts:858 uses urls.streamGroups(); tests/report/audit/pm-cribl/evidence-b.json (step C1 callsOnPricesPage: GET /master/groups x2); config/policies.yml (no /master/groups grant)
- **Gate:** tests/compliance.test.ts (the journaled-routes assertion) is loaned from WP-N
- **Fix:** Point listWorkerGroups at urls.streamGroups() with the type:'stream' filter; add a compliance/e2e assertion that every route the emulator journals during the Playwright run is a declared policy object (method + object).
- **Acceptance:** tests/compliance.test.ts fails on any journaled route absent from config/policies.yml; the e2e journal for Settings -> Prices on a fresh install contains no /master/groups call.

#### P0-05 · Global shortcuts (P, Y, ?, /) are dead whenever a nav tab has focus (the state after every mouse click on a tab); fixing that in the capture phase must land together with guards for open Capra selects, Tab inside Story, Escape and Shift+D modifiers

- **Area:** shell / keyboard map · **Package:** WP-A · **Impact:** 5 · **Effort:** S · **Lenses:** judge-cribl-pm, scout, view-shell, a11y, judge-devrel (6 findings merged)
- **Files:** `src/components/Shell/useShellEffects.ts`, `src/lib/shortcuts.ts`, `src/lib/dom.ts`, `src/components/Shell/DiagPanel.tsx`, `tests/e2e/keyboard.spec.ts`
- **Evidence:** tests/report/audit/pm-cribl/evidence-kbd.json; tests/report/audit/pm-cribl/evidence-kbd2.json; tests/report/audit/feature-scout/pkey.ts; tests/report/audit/feature-scout/pkey2.ts; tests/report/audit/feature-scout/pkey3.ts; tests/report/audit/shell/notes3.json (combo.pInListbox.url=/ledger?present=1); tests/report/audit/shell/select-typeahead-p-1440.png; tests/report/audit/shell/notes.json (keys.1440.metaShiftD.diagOpen=true); tests/report/audit/accessibility/keyboard-results.json (story.checks.afterTab.storyStillOpen=false); src/components/Shell/useShellEffects.ts:12,26-31,35 (bubble-phase window listener; MODIFIER_KEYS lacks Tab); src/lib/shortcuts.ts:78-83 (rejects named keys); src/lib/dom.ts:7-20 isTypingTarget; src/demo/keyboard.ts:7-9 (levers share the listener); src/components/Shell/DiagPanel.tsx:31-36 (no modifier check)
- **Fix:** Register the shell keydown listener in the capture phase; in isShortcutEvent bail out when event.target.closest('[role=listbox],[role=option],[role=menu],[role=menuitem],[aria-haspopup],[role=dialog]') matches or an open listbox/menu exists; add Tab (and arrows) to the Story exit exclusion set; let normalizeKey accept 'Escape' and register Escape -> leave presenter / close diag / close sheet; make Shift+D go through registerShortcut with a modifier check.
- **Acceptance:** tests/e2e/keyboard.spec.ts: click each of the five nav tabs then press P -> ?present=1 and Y -> ?story=1; open the Ledger Status select, type 'p' -> listbox still open and URL unchanged; in Story press Tab -> story still open and focus on the close button; Cmd+Shift+D does not open the diag panel; Escape leaves presenter mode.

#### P0-06 · P (or ?present=1) on any non-home route strips the chrome from that view instead of opening the stage: the Ledger renders with no nav, title clipped, and no 'Press P to leave' hint

- **Area:** presenter routing · **Package:** WP-A · **Impact:** 5 · **Effort:** S · **Lenses:** states, view-shell (2 findings merged)
- **Files:** `src/components/Shell/Shell.tsx`, `src/components/Shell/useShellEffects.ts`
- **Evidence:** tests/report/audit/degraded-states/present-ledger-light-1440.png; tests/report/audit/degraded-states/present-ledger-light-390.png; tests/report/audit/degraded-states/s4-params.notes.json; tests/report/audit/shell/select-typeahead-p-1440.png; src/components/Shell/Shell.tsx:61-74 (Outlet in the presenter branch for every route); src/router.tsx:64-71 (PresenterView only for '/'); src/copy/en.ts:1551 (exit hint lives in PresenterView only)
- **Fix:** Make P navigate to '/' + sticky params + present=1 and remember the origin tab for the second P; in the presenter branch render PresenterView (or redirect to '/') when pathname !== '/'.
- **Acceptance:** From /ledger and /flow press P -> the presenter stage renders (hero + savers + QR) with the exit hint; second P returns to the origin tab with its params intact.

#### P0-22 · The README does not say what the grants expose: the Source/Destination read grants return auth tokens, API keys and passwords decrypted to any shared member (measured: in_splunk_hec.authTokens[0].token plain); the four notification POST grants allow any body (scheduled searches, exfiltrating notifications, arbitrary bell messages); the demo build's PATCH/commit/deploy grants make any shared member a config admin with only a client-side tag check

- **Area:** security / README disclosure of grants · **Package:** WP-N · **Impact:** 5 · **Effort:** S · **Lenses:** judge-security (3 findings merged)
- **Files:** `README.md`, `docs/NOTIFICATIONS.md`, `config/demo/policies.yml`
- **Evidence:** tests/report/audit/security/evidence.json (live GET /m/default/system/inputs; GET /apps/meter-reader -> 1.0.7 demo build); README.md:92,113,115-118; config/policies.yml:12-13,35-48; config/demo/policies.yml:2-4,38-55; core/demo/levers.ts:200; core/adapters/config.ts:4-6 (fields dropped in-app); AGENTS.md:250 (path + method only)
- **Fix:** Add a third bullet under 'Two things an administrator should know' (the read grants return secrets decrypted; Meter Reader never stores or shows them; share the App with the platform team); a 'What a shared member could do with these grants' paragraph naming the four write capabilities and rewording README:113 to 'Meter Reader's code only creates; the grants themselves allow any body'; one sentence in the Demo rig section and in the Demo Console intro that the demo build's write grants apply to every object for anyone it is shared with. The policy tightening attempt (literal id segments) is P1-N04.
- **Acceptance:** README 'Cribl API endpoints' and 'Two things an administrator should know' contain the three disclosures verbatim; docs/NOTIFICATIONS.md mirrors the write-grant paragraph; the packaged README carries them.

#### P0-23 · Every forwardable receipt (Copy receipt, the Monday receipt in the bell/Slack/targets) is a bare total with no per-destination price basis, no counterfactual disclosure, no unpriced exclusions and no metered-minute coverage; the period hero itself never says how much of the month was metered although the range picker already computes 'N of M minutes'

- **Area:** receipt basis and coverage on everything forwarded · **Package:** WP-F · **Impact:** 5 · **Effort:** S · **Lenses:** judge-cfo (2 findings merged)
- **Files:** `core/receipt.ts`, `core/pricing.ts`, `core/delivery.ts`, `core/payloads.ts`
- **Evidence:** tests/report/audit/cfo/A-copy-receipt-mtd.txt; tests/report/audit/cfo/A-copy-receipt-30d.txt; tests/report/audit/cfo/A-copy-receipt-annualized.txt; tests/report/audit/cfo/probe1.txt (P5, P8); tests/report/audit/cfo/B-receipt-first-sweep-light-1440.png; tests/report/audit/cfo/drive-log.txt; core/receipt.ts:164 renderReceipt; core/payloads.ts:214-220; core/delivery.ts:102-107; core/pricing.ts:227-240 Headline; src/copy/en.ts:555,725; core/range.ts:280,369-370; README.md:151
- **Gate:** after critique-fixes merges (core/payloads.ts is builder A's file); core/delivery.ts (bell text) is loaned from WP-E
- **Fix:** Add minutesMtd/expectedMtd (and today/30d) to Headline from totals.byDay[].minutes and caption the hero 'month to date - 27,540 of 34,560 minutes metered (80%)'; add a Basis footer to receiptText/Copy receipt and the weekly receipt: one line per money-carrying destination ('Splunk Cloud $2.25/GB - preset (typical list)' / '- contract'), counterfactual credits ('Cribl Lake credited at Splunk Cloud price: $X'), 'N destinations unpriced, excluded', 'metered N of M minutes (P%)', the deep link; wrap inside the 48-column layout.
- **Acceptance:** tests/unit/receipt.test.ts: Copy receipt and the weekly receipt text contain a Basis block with one line per priced destination, the coverage line and the unpriced count; the MTD hero caption shows 'N of M minutes metered' when coverage < 100%.

#### P0-02 · Orgs with more than three Stream worker groups meter $0 for the groups the first sweep did not pick; the inventory refresh never fits the 35-call plan so they are never added

- **Area:** core sweep / multi-group inventory · **Package:** WP-E · **Impact:** 5 · **Effort:** M · **Lenses:** judge-sre (1 finding merged)
- **Files:** `core/sweep.ts`
- **Evidence:** tests/report/audit/sre-day2/probes/multi-group-trace.txt; tests/report/audit/sre-day2/probes/multi-group.txt; tests/report/audit/sre-day2/probes/multi-group-budget.txt; tests/report/audit/sre-day2/probes/multi-group-sweepnow.txt; core/sweep.ts:848-869 (inventoryDue, cost, roomFor gate, rotate/pick, byGroup keeps only listed groups); core/sweep.ts:918 fetchMetrics(knownGroups)
- **Fix:** First run and any run where the listing knows groups the inventory lacks: fetch the missing groups regardless of the plan (bounded only by the hard budget) or round-robin one missing group per sweep; never drop a known group; log and record in meta when a refresh is skipped; expose 'N of M worker groups metered' in Settings -> Runtime and the diag panel.
- **Acceptance:** tests/unit/sweep.test.ts: an 8-group org with traffic only in 'default' meters money by sweep 3 without Sweep now; meta.groupsKnown equals the listing; a skipped refresh writes a log line and a meta field.

#### P0-04 · 'Use suggested prices (4)' fills every destination with Internal / free at $0.00 because the emulator and the live demo rig outputs are all DevNull and suggestPreset keys on type alone; the first Receipt reads $0 / 0% saved and once any price exists an unpriced DevNull is treated as free

- **Area:** Settings -> Prices / suggested prices on DevNull rigs · **Package:** WP-G1 · **Impact:** 5 · **Effort:** M · **Lenses:** judge-devrel, view-settings, judge-cfo (3 findings merged)
- **Files:** `core/presets.ts`, `src/components/PriceTable/model.ts`, `src/components/PriceTable/PriceTable.tsx`, `core/pricing.ts`, `demo/rig/destinations.json`, `tests/fixtures/cribl/live-outputs.json`
- **Evidence:** tests/report/audit/devadvocate/04-prices-suggested-1440-dark.png; tests/report/audit/devadvocate/06-receipt-first-1440-dark-full.png; tests/report/audit/devadvocate/07-after-price-ledger-1440-dark.png; tests/report/audit/devadvocate/notes.json; tests/report/audit/design-settings/prices-fresh-light-1440.png; tests/report/audit/design-settings/prices-saved-toast-light-1440.png; tests/report/audit/design-settings/prices-priced-light-1440.png; tests/report/audit/cfo/drive-log.txt; core/presets.ts:344-351 (type match only, 'internal' fallback); core/pricing.ts:123; demo/rig/destinations.json:3,11,24,37,50 (all devnull, pricePreset hint unread); README.md:23
- **Gate:** core/pricing.ts:123 (DevNull-as-free rule) is loaned from WP-F; changing tests/fixtures/cribl/live-outputs.json churns every e2e that asserts DevNull rows (settings.spec.ts, receipt.spec.ts), so WP-G1 updates those assertions in the same change
- **Fix:** suggestPreset: honour a description hint ('Priced with the <preset> preset' / rig pricePreset) and name hints (siem|splunk -> splunk_cloud, analytics|datadog -> datadog, archive|s3 -> s3) before the type match; keep 'internal' only for names/types that are genuinely internal; 'Use suggested prices (n)' counts and fills only non-$0 suggestions (or labels the $0 rows); placeholder '$ --' not '0.00'; treat a demo-tagged DevNull without a price as unpriced; give the emulator rig outputs realistic types so npm run dev matches README step 3.
- **Acceptance:** On the emulator and on the demo org, 'Use suggested prices' fills siem-prod, analytics and archive-s3 with non-zero sourced presets and the toast never counts a $0 fill; a DevNull destination with no price shows the unpriced banner.

#### P0-08 · The stage says 'Live' forever: the green dot and the word stay while data is 7 min or 2 days old, while every poll answers 502, and with no prices ($-- under a green Live dot with a glow around an empty skeleton)

- **Area:** presenter status · **Package:** WP-B · **Impact:** 4 · **Effort:** S · **Lenses:** states, view-firstrun, view-presenter (4 findings merged)
- **Files:** `src/views/Presenter/index.tsx`, `src/views/Presenter/Presenter.css`, `src/views/Presenter/basis.ts`
- **Evidence:** tests/report/audit/degraded-states/stale6m-presenter-light-1440.png; tests/report/audit/degraded-states/runner-silent-viewer-presenter-light-1440.png; tests/report/audit/degraded-states/presenter-5xx-spa-dark-1440.png; tests/report/audit/design-first-run/shots/presenter-empty-dark-1920.png; tests/report/audit/design-first-run/shots/presenter-empty-light-1920.png; tests/report/audit/design-first-run/shots/skel-presenter-light-1920.png; tests/report/audit/design-presenter/state-loading-dark-1920x1080.png; src/views/Presenter/index.tsx:47-56 LiveStatus (no status input); src/views/Presenter/Presenter.css:149,188; src/views/Presenter/basis.ts:15 ('from today so far' before any data)
- **Fix:** Feed deriveDataStatus into LiveStatus (amber 'Stale - updated 2 days ago', red 'Cribl unreachable', the rate-limited caption, neutral 'Set prices to start' when unpriced); extend the :has() glow rule to the skeleton; render a caption-height ghost while loading instead of the 'today so far' basis.
- **Acceptance:** presenter.spec.ts: with a snapshot older than STALE_AFTER_MS the stage label reads Stale; with a 5xx poll fault it reads the offline label; unpriced shows no green dot and no glow; the loading frame has no basis text.

#### P0-10 · A new endpoint defaults to 'Direct webhook', the one channel the release cannot use on Standard plans (its own hint says so) and the one that stores a Slack secret in org-readable KV; the empty state tells the member to 'Add a Slack incoming webhook' under an intro that says to pick a Cribl notification target

- **Area:** Settings -> Where to send alerts / default channel · **Package:** WP-G2 · **Impact:** 4 · **Effort:** S · **Lenses:** judge-cribl-pm, judge-security, view-settings, copy (4 findings merged)
- **Files:** `src/components/EndpointEditor/model.ts`, `src/copy/en.ts`, `tests/e2e/settings.spec.ts`, `tests/unit/settings-model.test.ts`
- **Evidence:** tests/report/audit/pm-cribl/evidence-c.json (step D6 radios); tests/report/audit/pm-cribl/live-notify-editor-light-1440.png; tests/report/audit/pm-cribl/live-notify-bell-test-light-1440.png; tests/report/audit/security/settings-add-endpoint-default-light-1440.png; tests/report/audit/security/capture-notes.json (kvHoldsFullUrl true); tests/report/audit/design-settings/crop-notify-new-webhook-light.png; tests/report/audit/design-settings/notify-empty-light-1440.png; tests/report/audit/copy/settings-notify-light-1440.png; src/components/EndpointEditor/model.ts:110 (channel:'webhook', format:'slack'); src/copy/en.ts:1289-1290 emptyBody, :1335 webhookHintUi, :1328 intro
- **Gate:** settings.spec.ts and settings-model.test.ts assertions are loaned from WP-G1; new cases go into tests/e2e/settings-notify.spec.ts; emptyBody via INT
- **Fix:** newEndpointDraft defaults channel to 'cribl-target' when settings.runtime === 'ui' (keep 'webhook' for the backend/runner path); order the radios target-first and show the URL field only after 'Direct webhook' is chosen; rewrite notify.emptyBody: 'Add an endpoint and pick a Cribl notification target: Slack, PagerDuty, email, Amazon SNS or a webhook, with its secrets kept in Cribl. Direct webhooks work from the runner or on an Enterprise plan.'
- **Acceptance:** settings.spec.ts: Add endpoint on the release build -> the Cribl-target radio is checked, no URL field until webhook is chosen; the empty-state body names notification targets and never 'Slack incoming webhook'.

#### P0-11 · The README inside every .tgz is the Marketplace overview and opens with a broken hero image (video/ is excluded from the stage), dead relative links, unchecked hackathon checklists and a Pitch section; README/CHANGELOG/CLAUDE/RUNBOOK still name 1.0.2-demo while 1.0.8-demo is built, CHANGELOG puts the custom range under an unreleased 1.1.0 that the 1.0.0 tgz already ships, and README promises a tests/report/index.html that nothing generates

- **Area:** packaging / Marketplace README and version bookkeeping · **Package:** WP-N · **Impact:** 4 · **Effort:** S · **Lenses:** judge-cribl-pm, judge-devrel, truth (5 findings merged)
- **Files:** `README.md`, `scripts/package.mjs`, `CHANGELOG.md`, `tests/compliance.test.ts`, `CLAUDE.md`, `docs/RUNBOOK.md`
- **Evidence:** scripts/package.mjs:57 ('video' in EXCLUDE_TOP); README.md:5,7 (video/hero.gif), :13,21,118,156,319,326,350,431,456 (relative links), :434 (Stage One checklist), :454 (Pitch), :185,188 (1.0.2-demo), :428 (tests/report/index.html); CHANGELOG.md:3,5-11,27,51; CLAUDE.md:44; docs/RUNBOOK.md:53; release/ holds 1.0.6/1.0.7/1.0.8-demo; live GET /apps/meter-reader -> 1.0.7; tests/report/audit/truthfulness/NOTES.md; tests/report/audit/truthfulness/live-app-raw.txt
- **Gate:** docs/RUNBOOK.md:53 is loaned from WP-E; CHANGELOG.md via INT; README after report-card merges
- **Fix:** Absolute GitHub URLs for every README link (or a short customer README in the package plus SUBMISSION.md for the hackathon sections); ship the hero GIF under static/ and reference a path that exists in the package; compliance check that every relative link/image in the packaged README resolves inside the .tgz; replace the literal demo version with 'the current demo build (1.0.x)'; fold the custom-range entry into v1.0.0 or bump to 1.1.0 consistently; either generate tests/report/index.html (scripts/evidence-report.mjs) or delete the line and list the artifacts that exist.
- **Acceptance:** tar tzf release/meter-reader-1.0.0.tgz contains the hero image path the README references; tests/compliance.test.ts fails on any unresolved relative link in the packaged README; no '1.0.2-demo' literal in README/CHANGELOG/CLAUDE/RUNBOOK; every artifact README names exists on disk.

#### P0-12 · Launch copy outruns the product: 'read-only' / 'never touches config' (the release posts four creating writes and Connect is a labelled configuration write; PITCH forbids the phrase), unconditional 'every Monday' (the release sends the receipt only if a tab is open in the 24 h after Monday 12:00 UTC), 'within two minutes' (run 8: 131 s), 'about a minute and a half' (median 1:43), and a stage pre-flight that pgreps a laptop runner that moved to the workhorse

- **Area:** launch copy truthfulness · **Package:** WP-N · **Impact:** 4 · **Effort:** S · **Lenses:** truth, judge-devrel, copy (8 findings merged)
- **Files:** `docs/POSTS.md`, `PITCH.md`, `README.md`, `src/copy/en.ts`, `VIDEO_SCRIPT.md`, `STATE.md`
- **Evidence:** docs/POSTS.md:34,36,64,72,74,82; PITCH.md:8,17,23,28,63-64,70; README.md:11,13,65,334; src/copy/en.ts:492 (story caption), :500, :1535, :1543; VIDEO_SCRIPT.md:26,34,83; core/weekly.ts:44-45,59; config/policies.yml:35-48; core/adapters/cribl-notify.ts:226; docs/LIVE_VALIDATION.md (nine rows: 2:07 2:11 1:30 1:27 2:13 1:43 1:55 1:30 1:30; run 8 closed 131 s after restore); logs/runner.log 2026-09-26T20:21:23Z (laptop runner stopped); tests/report/audit/truthfulness/NOTES.md; tests/report/audit/truthfulness/live-meta-raw.txt
- **Gate:** en.ts captions via INT; VIDEO_SCRIPT.md is regenerated by WP-C (loaned); STATE.md line is WP-N's
- **Fix:** Use README:11's exact scope everywhere ('never changes pipeline, route, source or destination configuration; it reads, prices and posts alerts through Cribl'); qualify the weekly receipt once per surface ('from the runner or Enterprise schedule; the release sends it the first time the App is opened that Monday'); 'in about two minutes (96-131 s across nine runs)'; 'under two and a quarter minutes, nine of nine (median 1:43)'; replace the pgrep line with the workhorse health check and a laptop-runner fallback; regenerate story.json/VIDEO_SCRIPT/captions (scripts/story.ts) after the caption changes and note the video re-render as optional.
- **Acceptance:** grep -n 'read-only\|never touches config\|every Monday\|minute and a half' README.md PITCH.md docs/POSTS.md src/copy/en.ts returns only the qualified forms; scripts/story.ts --check reports current; PITCH pre-flight names scripts/runner-health.sh.

#### P0-13 · The five-minute pitch never shows the forecast-confirmed-live beat (What-if -> Apply for real -> 'projected 33%, measured 34%'), and the real stage frame is light theme inside Cribl chrome with no pre-flight step to darken it

- **Area:** pitch script / stage pre-flight · **Package:** WP-N · **Impact:** 4 · **Effort:** S · **Lenses:** judge-wow, view-shell, view-presenter (3 findings merged)
- **Files:** `PITCH.md`
- **Evidence:** PITCH.md:10-19 (steps never open /whatif), :39,45 (What-if only in Q&A); docs/evidence/2026-09-26-presenter-takeover-live.jpg (light theme, Cribl chrome); docs/DESIGN_BRIEF.md:48-49 ('Dark by default on stage'); src/theme/bridge.ts (follows CRIBL_APP_LAYOUT only); AGENTS.md Theming (no switcher); tests/report/audit/stage-judge/whatif-default-dark-1920.png; tests/report/audit/stage-judge/takeover-alert-dark-1920.png; tests/report/audit/shell/presenter-light-1920.png
- **Fix:** Replace the first pack lever in step 3 with What-if on Windows workstation events (read the projection, Apply for real, confirm) and come back at step 6 to read 'projected 33%, measured 34%'; add a pre-flight checklist: switch the Cribl account theme to dark, browser fullscreen, zoom so the iframe fills the projector, rehearse the takeover once in that state; keep the other two levers on the phone.
- **Acceptance:** PITCH.md has the What-if beat in steps 3 and 6 and a dated pre-flight checklist; one rehearsal on the org confirms the projected-vs-measured line appears within the step-6 window.

#### P0-14 · A two-line incident title pushes the takeover's foot out of the fixed lower-half card at 1920: the card scrolls inside itself and 'Caught in 2:50 - Sent to Slack' is cut off exactly at the payoff

- **Area:** presenter / takeover card long title · **Package:** WP-B · **Impact:** 4 · **Effort:** S · **Lenses:** view-presenter (1 finding merged)
- **Files:** `src/components/IncidentTakeover/IncidentTakeover.css`, `tests/e2e/presenter.spec.ts`
- **Evidence:** tests/report/audit/design-presenter/takeover-longtitle-dark-1920x1080.png; tests/report/audit/design-presenter/takeover-longtitle-dark-1440x900.png; tests/report/audit/design-presenter/measure-full.json (takeover-longtitle-dark-1920x1080: scrollH 532 > clientH 474); src/components/IncidentTakeover/IncidentTakeover.css:132-136 (.mr-tk-body flex 1 0 auto), ~66-72 (fixed height, overflow-y auto)
- **Fix:** .mr-tk-body { flex: 1 1 auto; min-height: 0 }; clamp .mr-tk-title and .mr-tk-commit-text to 2 lines on the overlay placement (full text in title=); drop the demo-profile note before the clock if the foot still cannot fit.
- **Acceptance:** presenter.spec.ts fixture with a 60-char label and a 120-char commit message at 1920x1080 and 1920x900: takeover scrollHeight <= clientHeight and the foot's 'Caught in' text is inside the card box.

#### P0-15 · At 1280x720 and 1366x768 the stage does not fit (24 px / 12 px of vertical scroll; the QR 19-34 px from the bottom edge instead of >= 40) because the 200 px QR floor and the max() floors in the upper band stop the stage scaling below ~1440 wide

- **Area:** presenter / 720p and 768p projectors · **Package:** WP-B · **Impact:** 4 · **Effort:** S · **Lenses:** view-presenter (1 finding merged)
- **Files:** `src/views/Presenter/Presenter.css`, `tests/e2e/presenter.spec.ts`
- **Evidence:** tests/report/audit/design-presenter/rest-dark-1280x720.png; tests/report/audit/design-presenter/rest-empty-dark-1366x768.png; tests/report/audit/design-presenter/measure-full.json (rest-dark-1280x720: scrollHeight 744 vs 720); src/views/Presenter/Presenter.css:35 (--mr-pv-qr max(200px, ...)), :40 (--mr-pv-band-h)
- **Fix:** Let the QR column scale with height (clamp(160px, 240*var(--mr-sp), 240px) on desktop; keep the 200 px floor only in the <= 720 px query) or place the caption beside the code when 100vh < 800px; make the grid's middle row minmax(0,1fr) absorb the shortfall; add 1280x720 and 1366x768 to the 'Corners breathe' assertion.
- **Acceptance:** presenter.spec.ts at 1280x720 and 1366x768: document.scrollHeight === innerHeight and every [data-callout] box is >= 40 px from each viewport edge.

#### P0-16 · During every ease the digit window is taller than the glyph, so fragments of the next and previous digits show above the cap line and below the baseline (30-40 px at 166 px) and the number looks broken for ~900 ms on every snapshot; the Receipt Meter shows the same sliver at 1.12em

- **Area:** presenter / odometer · **Package:** WP-B · **Impact:** 4 · **Effort:** S · **Lenses:** view-presenter, judge-devrel, motion (3 findings merged)
- **Files:** `src/views/Presenter/Presenter.css`, `src/views/Presenter/HeroMeter.tsx`, `src/components/Meter/Meter.css`
- **Evidence:** tests/report/audit/design-presenter/hero-mid-ease-dark-1920x1080.png; tests/report/audit/design-presenter/hero-mid-ease-dark-1440x900.png; tests/report/audit/design-presenter/measure-full.json (tick-dark-1920x1080 data-value progression); tests/report/audit/devadvocate/11-tour-start-390-light.png; src/views/Presenter/Presenter.css:217 (.mr-odo-cell height 1em overflow hidden), :226 (260 ms per-digit transition); src/components/Meter/Meter.css:55-65 (wheel clips at 1.12em); tests/report/audit/motion/sheet-presenter-roll-1920.png
- **Fix:** Mask the window to the glyph (mask-image linear-gradient transparent 0, #000 18%, #000 84%, transparent 100%) or size the cell to 0.78em with the strip offset -0.14em; only restart a cell's roll when its digit has been stable for one frame; clip the Receipt wheel to 1em; longer term replace HeroMeter with <Meter size='presenter'> so both odometers roll alike and honour a live reduced-motion change.
- **Acceptance:** presenter.spec.ts screenshot mid-ease (inject two snapshots 900 ms apart, capture at 400 ms): no ink outside each .mr-odo-cell's cap box (pixel probe above the cap line is background colour); reduced motion toggled while the stage is up stops the rAF loop within one frame.

#### P0-17 · Budget pace projects paid-MTD over minutes since the 1st of the month, not since collecting began: a day-25 install projects 25x low so 'On pace for' is wrong for the whole first month, while on the 1st a batch hour projects 2,927% and pages HIGH for a day

- **Area:** core money / budget pace · **Package:** WP-F · **Impact:** 4 · **Effort:** S · **Lenses:** judge-cfo, judge-sre (2 findings merged)
- **Files:** `core/detector.ts`, `core/snapshot.ts`, `src/views/Settings/model.ts`
- **Evidence:** tests/report/audit/cfo/probe2.txt; tests/report/audit/sre-day2/probes/detector-noise.txt (section D); core/detector.ts:368,372,377-379; core/snapshot.ts:241; src/views/Settings/model.ts:160-161
- **Gate:** after critique-fixes (wf_f18438fd) merges: core/detector.ts is builder A's file; src/views/Settings/model.ts (budgetPace call site) is loaned from WP-G2
- **Fix:** One core budgetPace(): elapsed = minutes actually metered this month (totals.byDay[].minutes) or now - max(monthStart, collectingSince); require >= 5% of the month or 24 h before projecting (medium until day 3); Settings/model.ts and snapshot.ts call the same function.
- **Acceptance:** tests/unit/detector.test.ts: day-25 install at $100/day with a $3,000 budget projects ~$3,000 (100%); $40 paid in hour 1 of a $1,000 budget opens nothing; Settings -> Budgets and the Ledger chip show the same pct.

#### P0-19 · 'Committed $ / GB' is a dead field: PriceTable stores committedMilliCentsPerGb, nothing in core reads it, it is undocumented, and on a never-priced row typing a committed rate (valid or junk) is not even a change

- **Area:** Settings -> Prices / Committed $ per GB · **Package:** WP-G1 · **Impact:** 4 · **Effort:** S · **Lenses:** judge-cfo, view-settings (2 findings merged)
- **Files:** `src/components/PriceTable/PriceTable.tsx`, `src/components/PriceTable/model.ts`, `core/pricing.ts`
- **Evidence:** tests/report/audit/cfo/probe1.txt (P3); tests/report/audit/cfo/A-prices-committed-typed-light-1440.png; tests/report/audit/design-settings/crop-prices-committed-1_2345.png; tests/report/audit/design-settings/run-d.log (committedProbe invalid:0); core/types.ts:58; src/components/PriceTable/model.ts:276-279,289-292; src/components/PriceTable/PriceTable.tsx:166-181; src/copy/en.ts:1186,1209
- **Gate:** core/pricing.ts is loaned from WP-F only if the field is wired (the S fix touches PriceTable alone)
- **Fix:** For 1.0 hide the column (keep the field in the schema) and add a helper line under Price ('your contract rate'); the M upgrade (paid at the committed rate, would-have-paid at list, 'list $2.25 - your rate $1.60' in Show the math, 'at contract rates' hero badge) is P1-F10. If kept, isDirty must count committed/counterfactual edits on unpriced rows and validateDraft must surface its error.
- **Acceptance:** On a fresh install the Prices table shows no inert column; typing into every visible field on an unpriced row either changes the dirty count or shows an inline error; tests/unit/settings-model.test.ts covers both.

#### P0-20 · The Preset listbox is the trigger's width (160 px) while every option is a sentence, so 15 options wrap to 3 lines, four fit, the list opens upward over the card description and toolbar; at 390 it runs under the footer

- **Area:** Settings -> Prices / preset picker · **Package:** WP-G1 · **Impact:** 4 · **Effort:** S · **Lenses:** view-settings, copy (2 findings merged)
- **Files:** `src/components/PriceTable/PriceTable.tsx`, `src/components/PriceTable/PriceTable.css`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/design-settings/prices-preset-open-light-1440.png; tests/report/audit/design-settings/phone-preset-open-light-390.png; tests/report/audit/design-settings/run-c.log (listbox 160x320, optionCount 15); src/components/PriceTable/PriceTable.tsx:96-105; src/components/PriceTable/PriceTable.css:16-19; src/copy/en.ts:1194-1197 presetOption
- **Fix:** Render each SelectField.Item as name (body.md) + 'typical $2.25 - $1.47-$4.85' caption in tabular figures; give the popover a min-width >= 320 px; put Internal / free last under a divider; presetOption copy uses ' / GB' with spaces like every price column.
- **Acceptance:** settings.spec.ts opens the preset picker at 1440 and 390: every option renders on <= 2 lines, the listbox is >= 320 px wide, and it does not cover the card description.

#### P0-21 · The app contradicts itself on facts a judge reads side by side: footer 'every 30 seconds' vs Runtime card, first-run strip and Story 'every minute'; the demo Break-the-trim toast says 'about 3 minutes' with the 1-minute profile on; Show the math, README step 3 and CHANGELOG still call sourced presets 'illustrative' while the Prices page says 'typical list pricing'; the Ledger chip says 'Over budget' for a 90% pace

- **Area:** copy / contradictions on one screen · **Package:** INT · **Impact:** 4 · **Effort:** S · **Lenses:** copy, judge-cribl-pm (5 findings merged)
- **Files:** `src/copy/en.ts`, `README.md`, `CHANGELOG.md`
- **Evidence:** tests/report/audit/copy/receipt-full-light-1440.png; tests/report/audit/copy/settings-notify-light-1440.png; tests/report/audit/copy/settings-runtime-text-light.txt; tests/report/audit/copy/first-run-text.txt; tests/report/audit/copy/receipt-math-preset-light-1440.png; tests/report/audit/copy/receipt-math-text-light.txt; tests/report/audit/pm-cribl/evidence-b.json (step C9); tests/report/audit/pm-cribl/live-runtime-light-1440.png; src/copy/en.ts:31,425,431,469,487,690,991,1146,1208,1424,1452; src/state/meterLoop.ts:27 UI_SWEEP_INTERVAL_MS 30_000; src/demo/actions.tsx:115; README.md:23; CHANGELOG.md:22; core/detector.ts:379
- **Gate:** README.md:23 is loaned from WP-N; INT owns en.ts and CHANGELOG.md
- **Fix:** footer.runtimeUi 'Meters every minute while open'; runtimeThisTab/OtherTab 'Metered by this tab, every minute'; uiNote 'Meters every completed minute while this app is open (it checks twice a minute) ...'; demo.trimBrokenProfile 'about two minutes with the demo profile', trimBroken 'about four minutes at the default confirmation'; math preset line 'typical list price, not a quote'; README:23 and CHANGELOG:22 likewise; ledger.states.budget 'Over budget pace'.
- **Acceptance:** grep -n '30 seconds\|illustrative\|about 3 minutes' src/copy/en.ts README.md CHANGELOG.md returns nothing but README's '### Install in 30 seconds' (PRD 13's required heading, an install-time claim, not a cadence; amended after the wave 1 review); the Runtime card and footer render the same cadence sentence in tests/e2e/settings.spec.ts.

#### P0-24 · In the Story loop the alert and restore beats overflow a 1920x1080 frame by 19/15 px (the inline takeover card grows the 1fr stage row), so a scrollbar appears for two beats and the caption rail shifts down and back four times per loop

- **Area:** Story loop / 1920 overflow · **Package:** WP-C · **Impact:** 4 · **Effort:** S · **Lenses:** view-story, motion (2 findings merged)
- **Files:** `src/views/Story/Story.css`, `tests/e2e/story.spec.ts`
- **Evidence:** tests/report/audit/story-design/shots/1920-dark-06-alert.png; tests/report/audit/story-design/shots/1920-dark-08-restore.png; tests/report/audit/story-design/measurements.json (1920-dark geo.alert.docScroll.h 1099); tests/report/audit/motion/log-x-storybeats.txt; tests/report/audit/motion/story-alert-rail-dark-1920.png; tests/report/audit/motion/story-restore-rail-dark-1920.png; src/views/Story/Story.css:29-33,194-206,234-236
- **Fix:** .mr-st-stage { overflow: hidden } with the card allowed to shrink (min-height 0, the takeover's own max-height) and a smaller gap when a card is up, or size the compact figure from the remaining height; assert rail.y identical on all 12 beats.
- **Acceptance:** story.spec.ts at 1920x1080 and 390x844: document.scrollHeight === innerHeight and .mr-st-rail top is identical on every beat.

#### P0-07 · A refused, rate-limited or failing sweep is invisible: with metrics 403/429/500 the chip stays 'Live', the footer keeps 'Last sweep N min ago', the diag says 'errors none', no notice renders; after 5 min it only says 'Stale' with no reason; the promised metricsForbidden and rate-limit countdown copy never render

- **Area:** metering truth / silent sweep failure · **Package:** WP-D · **Impact:** 4 · **Effort:** M · **Lenses:** judge-cribl-pm, states, judge-sre, view-settings (6 findings merged)
- **Files:** `src/state/meterLoop.ts`, `src/components/Shell/status.ts`, `src/components/Shell/StatusCluster.tsx`, `src/components/Shell/Footer.tsx`, `src/components/common/ErrorNotice.tsx`, `src/views/Settings/RuntimeSection.tsx`, `src/views/Settings/SweepNowButton.tsx`
- **Evidence:** tests/report/audit/pm-cribl/evidence-c.json (steps D4, D5); tests/report/audit/pm-cribl/live-fault-metrics-403-100s-light-1440.png; tests/report/audit/pm-cribl/live-fault-metrics-403-diag-light-1440.png; tests/report/audit/pm-cribl/live-fault-metrics-429-light-1440.png; tests/report/audit/degraded-states/sweep500-6min-t1m-receipt-light-1440.png; tests/report/audit/degraded-states/sweep500-6min-t6m-receipt-light-1440.png; tests/report/audit/degraded-states/sweep500-runtime-sweepnow-light-1440.png; tests/report/audit/degraded-states/s5-long.notes.json; tests/report/audit/degraded-states/s6-more.notes.json; tests/report/audit/design-settings/crop-runtime-429-light.png; tests/report/audit/sre-day2/probes/rate-limit.txt; tests/report/audit/sre-day2/probes/kv-full.txt; src/components/Shell/status.ts:23-36 (reads only live.lastError); src/state/meterLoop.ts (applySummary stores lastResult; nothing in the chrome reads it); src/views/Settings/RuntimeSection.tsx:107-108 (raw lastError); src/copy/en.ts:1469 metricsForbidden (unused); README.md:111,406; docs/DESIGN_BRIEF.md section 6
- **Gate:** RuntimeSection.tsx and SweepNowButton.tsx (the error-code -> copy mapping) are loaned from WP-G2; WP-D exports the classifier from status.ts
- **Fix:** Surface sweep.lastResult / meta.sweepErrors / lastError into deriveDataStatus: a 'metering-failed' status after two consecutive failed sweeps (chip 'Not metering since HH:MM', footer 'Sweeps have been failing since ...'), the per-section metricsForbidden notice with actions disabled on 403, the DESIGN_BRIEF rate-limit line with the next-sweep countdown on 429, a shell banner when meta.lastSweepAt is stale or sweepErrors grew; classify sweep error codes into copy (never print rate_limited or raw JSON); list the error in the diag panel.
- **Acceptance:** e2e with the emulator fault metrics=403 for 100 s: within two sweeps the chip reads a non-Live state, the Receipt shows the metricsForbidden notice, Settings -> Runtime prints human copy; with 429 the notice shows 'Next sweep in m:ss'; recovery clears all three without reload.

#### P0-18 · The 30-day trend plots every day before collection began as $0: the live org (collecting since Sep 26) will show ~26 days of a flat zero line then a cliff by Wednesday, which reads as 'Cribl saved nothing for four weeks'

- **Area:** Receipt / trend chart on a young workspace · **Package:** WP-H · **Impact:** 4 · **Effort:** M · **Lenses:** view-firstrun (1 finding merged)
- **Files:** `src/components/TrendChart/TrendChart.tsx`, `src/components/TrendChart/trendMath.ts`, `src/components/TrendChart/TrendChart.css`
- **Evidence:** tests/report/audit/design-first-run/shots/learning-receipt-viewport-light-1440.png; tests/report/audit/design-first-run/shots/learning-trend-light-1440.png; tests/report/audit/design-first-run/shots/learning-trend-dark-390.png; core/snapshot.ts:305-310 (savedM ?? 0 for every day in the window); src/components/TrendChart/TrendChart.tsx:61 (learning = whole.length < 2); live meta collectingSince 2026-09-26T06:20Z (tests/report/audit/truthfulness/live-meta-raw.txt)
- **Fix:** Carry collectingSince into TrendChart: start the x-axis at max(collectingSince, today-30d) with the caption 'collecting since Sep 25 - N days', or render pre-collection days as a hatched blank region with no line; keep the learning panel until >= 2 whole days; when max is 0 use $0/$50/$100 ticks and a one-line 'Nothing saved yet' state instead of '$0 / $1 / $1'.
- **Acceptance:** Receipt fixture with collectingSince 4 days ago: the plotted line begins at the first collected day (no $0 segment before it), the caption states the collected day count, and an all-zero series shows the empty-state sentence rather than a flat line under a '$1' axis.

#### P0-09 · Error and delivery toasts land on the presenter stage (top-right, over the frame the audience sees) while the hero caption or the takeover card already carries the message

- **Area:** presenter / toasts on stage · **Package:** WP-A · **Impact:** 3 · **Effort:** S · **Lenses:** states, judge-cribl-pm (2 findings merged)
- **Files:** `src/components/Shell/useShellEffects.ts`, `src/components/common/Toasts.tsx`
- **Evidence:** tests/report/audit/degraded-states/presenter-5xx-spa-dark-1440.png; tests/report/audit/degraded-states/snap5xx-presenter-dark-1440.png; tests/report/audit/pm-cribl/tour-presenter-takeover-dark-1920.png; src/components/Shell/useShellEffects.ts:62-72 useLiveErrorToast (runs in every shell mode); src/components/Shell/Shell.tsx:63-72 (same overlays mounted in presenter mode)
- **Fix:** Skip notify.* while params.present or params.story (the stage's own status line and the card are the notification).
- **Acceptance:** presenter.spec.ts: inject a poll 5xx and a delivered incident in ?present=1 -> zero Capra toasts in the DOM; leaving presenter mode restores toasts.

### 3.2 P1 — polish to land if it fits before Wednesday (97)

Order: impact desc, then effort asc.

| ID | Impact | Effort | Package | Item |
|---|---|---|---|---|
| P1-F06 | 5 | M | WP-F | The cost-spike rule never learns a new level (qualifying minutes never feed the baseline; frozen while open; no sigma floor): a Source th... |
| P1-F07 | 5 | M | WP-F | A deliberate change on a flow worth > $5/day opens a regression that never closes and re-notifies every cooldown forever; the release has... |
| P1-I01 | 5 | M | WP-I | Ribbon width encodes in-bytes on the view whose subtitle is 'This is dollars', and $/day plates are gated by pixel thickness: the cheapes... |
| P1-A06 | 4 | S | WP-A | The SAMPLE DATA band scrolls away while the tab bar stays sticky; on a scrolled phone the only cue that the numbers are fake is one 8 px ... |
| P1-C02 | 4 | S | WP-C | Every frame of the loop carries the striped SAMPLE DATA band with a 'Clear sample data' button (the presenter in the same state shows a q... |
| P1-D05 | 4 | S | WP-D | The tab never yields to a fresh runner (both meter every minute: ~59 calls/min for one viewer), the off-cycle cheap check re-reads meta a... |
| P1-F01 | 4 | S | WP-F | A counterfactual 'another destination' whose target has no price silently prices would-have-paid at $0: not flagged unpriced, the chip st... |
| P1-H08 | 4 | S | WP-H | After realistic prices the Receipt lands on MTD and the newcomer's first number is '$10.62' (the seed hour) while Annualized '$92,983 - f... |
| P1-J01 | 4 | S | WP-J | Range figures break the before/after strip: at 390 '+$24,836-$51,134 / year' is clipped and the after value sits on the cell border, 'Sen... |
| P1-L02 | 4 | S | WP-L | The 7:5 grid leaves the main column empty from y~655 to the page bottom at 1440x900 and 1920 while the levers column runs to y~1250: 'Res... |
| P1-A01 | 4 | M | WP-A | Code half of P0-01: mount the takeover in the Shell so it overlays every view, and seed the tracker from the last snapshot the tab saw so... |
| P1-B01 | 4 | M | WP-B | When the incident closes while the red card is on stage, the red card vanishes in one frame (no leaving fade) and the green card slides u... |
| P1-C01 | 4 | M | WP-C | In the alert beat the figure is the full centred hero for 0.4 s, then the card's incident.open action flips HeroFigure to compact: the nu... |
| P1-E01 | 4 | M | WP-E | When the Leader rate-limits below ~23 calls/min every sweep burns 20-24 calls and retries at full rate forever (1,253-1,440 calls/h, 0 mi... |
| P1-F02 | 4 | M | WP-F | Diversion credits (counterfactual 'another destination') are blended with measured reductions: the Ledger shows a 0% reduction flow savin... |
| P1-G05 | 4 | M | WP-G2 | Pressing 'Add endpoint' renders a card that is already red (two error icons, 'give this endpoint a name', 'must start with https://') and... |
| P1-H01 | 4 | M | WP-H | The right ~800 px of the hero card is empty beside the number at 1440 and 1920 (SCORES-3a N1 still open): the meter figure is 416 px wide... |
| P1-H02 | 4 | M | WP-H | The sample tour (the first screen a judge sees) truncates 2 of 5 top-saver labels at 1440 and 3 of 5 at 390 ('Palo Alto traffic aggregat.... |
| P1-I02 | 4 | M | WP-I | '$ saved' plates float 40-111 px right of the pipeline column over crossing ribbons with nothing tying them to their ribbon; pipeline nam... |
| P1-K01 | 4 | M | WP-K | At 1440 and 1920 the Route column truncates 5 of 6 demo rows and Pipeline 2, while Route always repeats Source; the page caps at 1280 px ... |
| P1-K03 | 4 | M | WP-K | In 7 d on the phone the day labels collide into 'Sun 20Mon 21Tue 22...'; the commit card (242 px) opens above a 172 px chart and covers t... |
| P1-I06 | 4 | L | WP-I | Pressing 'What if...' inserts a 440 px calculator above the map (map starts at y~604 at 1440, y~994 at 390) and the projected layout re-o... |
| P1-A02 | 3 | S | WP-A | Every lazy view (P, Y, Flow, Ledger, tour start) shows the generic edge-to-edge ViewSkeleton for ~300 ms on the dev server (one RTT in pr... |
| P1-A03 | 3 | S | WP-A | Toasts land top-right over the status cluster and the hero actions, full-width over the tab row on phones, stack when unkeyed ('Receipt c... |
| P1-A04 | 3 | S | WP-A | At <= 439 px the live/updated chip is a bare 8 px dot with no label, title or tap target: green, amber, red, grey and purple all mean not... |
| P1-A08 | 3 | S | WP-A | ?diag=1 omits what a 3 a.m. screenshot needs (meteredThrough, sweepErrors/lastError, consecutiveRateLimited, lock owner/expiry, runner fr... |
| P1-B02 | 3 | S | WP-B | The recovery card ends in a bare 'pipeline' chip with a 70%-empty foot; a long delivery line wraps the foot and overflows the card by 3 p... |
| P1-B03 | 3 | S | WP-B | The QR renders at 200 px at 1440 (brief >= 220) with a 15 px ask and a 10.5 px mono URL, and at 1920 the URL breaks after the slash under... |
| P1-C04 | 3 | S | WP-C | The caption 'Saved by Cribl: $544,974.' is frozen at generation time while the hero ticks ($544,983 in the same frame, $45 over by the re... |
| P1-C06 | 3 | S | WP-C | On touch the 'Press any key to exit' hint is hidden and the only exit is a 32x32 x (under the 44 px target); tapping the stage does nothi... |
| P1-D01 | 3 | S | WP-D | Hydration failures never reach the status dot: 'Waiting for the first sweep' with no prices (nothing can sweep), with every KV read 500/4... |
| P1-D02 | 3 | S | WP-D | With no snapshot ever loaded, a 5xx on the snapshot claims 'Showing the last good data, updated 4 s ago' (alert, toast and status) over a... |
| P1-D04 | 3 | S | WP-D | An open tab never re-reads prices once it holds a document, so a second tab's save (or a Load demo prices elsewhere) is invisible until r... |
| P1-D06 | 3 | S | WP-D | After saving all-$0 prices the app is in two states ('/' shows a live $0 Receipt and Prices says 'All priced', '/first-run' still shows t... |
| P1-E02 | 3 | S | WP-E | The 90 s KV lock is never renewed during a sweep with a 100 s time budget and the writes come last, so at ~4.5 s per call a second runtim... |
| P1-E03 | 3 | S | WP-E | When KV refuses writes (full store, 507/413/5xx on roll/* PUT) every sweep fails, the cursor stops and the hourly expiry that could free ... |
| P1-E05 | 3 | S | WP-E | The runner's 'scheduled' mode skips the cheap check, so whenever a tab metered the minute first the runner still spends a full 22-call sw... |
| P1-E06 | 3 | S | WP-E | Runner ops gaps (monitoring itself is now done via the Automic health job): no single-instance guard, the supervisor restarts every 10 s ... |
| P1-F04 | 3 | S | WP-F | Copy receipt for MTD/Today/30d/Annualized has no line items (the view passes no lines), no Net line, prints the literal 'run rate' in the... |
| P1-F09 | 3 | S | WP-H | The drawer mixes two bases: 'The formulas' is the period total (MTD $544,974) while 'At each destination' is the last 60 min x 24 (rows s... |
| P1-F11 | 3 | S | WP-G1 | 'You would have paid / You paid / Saved' presents avoided cost as realized cash, but Splunk Cloud ingest, Sentinel tiers and Sumo credits... |
| P1-G01 | 3 | S | WP-G1 | Typing a contract rate leaves the picker on 'Internal / free' with 'No destination charge' under a $1.80 field and Show the math prints '... |
| P1-G02 | 3 | S | WP-G2 | On an unpriced fresh install every mount of the Prices/Budgets sections walks the Leader config (groups + 4 GETs per group) with no share... |
| P1-G06 | 3 | S | WP-G2 | The endpoints empty state is a four-row table ghost identical to the loading skeleton under a fully rendered bell card, with a second pri... |
| P1-G07 | 3 | S | WP-G2 | On a phone the Save bar is the card footer ~900 px below the first field with nothing in view saying the page is dirty; only Prices rows ... |
| P1-H03 | 3 | S | WP-H | The Receipt ghost's caption is the 403 sentence for every failure kind ('once your role can read the savings snapshot' under a 500, a 429... |
| P1-H07 | 3 | S | WP-H | The math drawer's scrolling body has no focusable content and is not focusable, so a keyboard user cannot scroll to the per-destination f... |
| P1-I03 | 3 | S | WP-I | Light-theme pastel ribbons land at 1.34-1.68:1 on white; the dark-theme saved wedge background is 1.00:1 so only 36%-alpha hatch lines ca... |
| P1-I04 | 3 | S | WP-I | Destination captions sum only drawn flows so the same destination reads different money by viewport (Splunk Cloud $32,978 at 1440 vs $29,... |
| P1-I08 | 3 | S | WP-I | Pitch step 6 is 'back to Flow as the ribbons narrow', but the layout tween is 200 ms, so on a 10 s poll a ribbon snaps to its new width a... |
| P1-K02 | 3 | S | WP-K | The Change timeline card (388 px) and the Alerts rail (543 px) end on a 155 px step at every desktop width; 'Show in table' floats detach... |
| P1-K04 | 3 | S | WP-K | The timeline SVG is role=img, which makes its four focusable role=button markers presentational to assistive tech (WCAG 4.1.2); the Flow ... |
| P1-L01 | 3 | S | WP-L | 'Break the trim' (page lever, phone bottom bar, confirm modal) is white 14 px on #e5484d at 3.91:1 in both themes; in dark the confirmati... |
| P1-A07 | 3 | M | WP-A | The stage follows the account theme: on a light Cribl account presenter mode is a white screen with a grey-green smudge behind the number... |
| P1-C03 | 3 | M | WP-C | Leader lines cut through the text they point past ('the commit' through '$1,250 a day' at 1920; four receipt lines at 390) because text c... |
| P1-E04 | 3 | M | WP-E | After a gap longer than 24 h the minutes before the floor are never metered and nothing records the hole (a 30 h outage left 6 h missing;... |
| P1-E07 | 3 | M | WP-E | One timing-out webhook endpoint costs ~40 s per incident per sweep (two incidents: 80 s, near the lock TTL; the notification budget trips... |
| P1-F03 | 3 | M | WP-F | Saved is max(0, whp - paid) and the Ledger reduction is clamped to [0,1], so a pipeline that grows bytes (enrichment, GeoIP) counts as $0... |
| P1-F05 | 3 | M | WP-F | User-facing receipt and Slack strings live in core/receipt.ts and core/payloads.ts and have drifted from en.ts ('Open alerts: none' vs '0... |
| P1-F10 | 3 | M | WP-F | Give the committed rate the meaning a CFO expects: paid at the contract rate, would-have-paid at list, both printed in Show the math and ... |
| P1-J02 | 3 | M | WP-J | The disclosure is a box inside the card (border-top plus the Collapse's own border), 'Saved / day' lacks its unit, the dry-run paragraph ... |
| P1-J03 | 3 | M | WP-J | After 'Apply for real' (or ?applied=) the panel collapses to one grey sentence 'Projected 33%, measured 0% after 3 min': no strip, no her... |
| P1-N01 | 3 | M | WP-N | Try literal segments for the relay grants (drop :gid/:id) at the next deploy so the write grants cannot schedule arbitrary searches or at... |
| P1-N04 | 3 | M | WP-N | The video's Slack card is the runner's direct-webhook Block Kit rendering; Slack, PagerDuty, email and SNS targets were never exercised (... |
| P1-O01 | 3 | M | WP-O | The in-browser emulator (dev server and every Playwright e2e) does not emulate the four notification writes, /notification-targets, the p... |
| P1-A05 | 2 | S | WP-A | Shell nits: Escape does nothing in presenter/diag; the diag panel remounts (and closes) on P/Y; '/' on a view without search does nothing... |
| P1-B05 | 2 | S | WP-B | Every rAF frame writes an inline transform on all 8 wheel strips and dataset.valueM even when only the cents wheels moved (~57 style reca... |
| P1-C05 | 2 | S | WP-C | Progress bar is 31-34 px off-centre with 1.05:1 upcoming segments and no within-beat progress under reduced motion; the hero glow leaks a... |
| P1-D03 | 2 | S | WP-D | The 'who meters' line lies: 'Metered by another open tab' after a reload of the only tab; both open tabs claim 'this tab' (skipped:'curre... |
| P1-E08 | 2 | S | WP-E | The hourly expiry pass costs 2 lists + 2 calls per deleted key (del pre-reads for a chunk manifest) and repeats every sweep when the back... |
| P1-F12 | 2 | S | WP-H | 'Net after Cribl - Paid for itself' shows for MTD and Annualized only; Today and 30 days return null so the line disappears and the hero ... |
| P1-G03 | 2 | S | WP-G1 | Prices nits: numeric error copy wraps 4 lines under a 104 px field; 'Devnull' capitalised beside lowercase siblings; popover sources show... |
| P1-G04 | 2 | S | WP-G1 | hostFromUrl accepts userinfo, so 'https://svc:P4ssw0rd@relay.example.com/hook' validates, is stored in KV in full and masked in the UI, c... |
| P1-G08 | 2 | S | WP-G2 | Colour is still spent on status: green 'priced'/'no setup' pills, green test alerts, blue 'via Cribl', red tertiary 'Remove'; the Slack p... |
| P1-G09 | 2 | S | WP-G2 | 'Send a test alert' is enabled before Connect and answers with a red 'Connect this target first'; the weekly-receipt hint says 'Mondays, ... |
| P1-H04 | 2 | S | WP-H | Row stretch leaves 50-250 px voids (savers list ends at y=761 with the footer at 858; four open alerts stretch Where the money goes by 25... |
| P1-H05 | 2 | S | WP-H | The unpriced hatch is invisible in dark (1.00:1 background); the row's right figure has no 'paid' word; a tiny paid share renders as a 2 ... |
| P1-H06 | 2 | S | WP-H | The learning-state text plate is opaque over the dashed ghost curve and gridlines, leaving disconnected stubs (a 30 px stub at 390); the ... |
| P1-H09 | 2 | S | WP-H | Switching periods cuts the hero figure in one frame (the Meter is keyed by period and remounts) while the bar eases; 'How this number is ... |
| P1-I05 | 2 | S | WP-I | On the 390 list a tap pins the row on a receipt card that sits off-screen and nothing scrolls; truncated SVG labels rely on <title> which... |
| P1-J04 | 2 | S | WP-J | Hero caption phrases run together with no spaces in the DOM; the unpriced state reuses the Flow copy 'on this map' and the loading skelet... |
| P1-K05 | 2 | S | WP-K | The muted chip truncates exactly at its countdown ('muted after a ...') and is the only lower-case chip; the sort caret floats between th... |
| P1-K06 | 2 | S | WP-K | The loading skeleton renders only the flows card so the page jumps in height; under 503/401/429 with no data the Ledger renders the error... |
| P1-L03 | 2 | S | WP-L | Status-line icon floats mid-gap on phones; the title jitters when the status card grows; the hero countdown collapses to 16 px at zero; '... |
| P1-M01 | 2 | S | WP-M | Flow and What-if empty states use the table-rows ghost (FlowScreen passes the ignored `illustration` prop, a `flow` ghost exists); the no... |
| P1-M02 | 2 | S | WP-M | README says tour/active is written by First run but the tour is in-memory only, so a reload (or Presenter/Story opened by URL) drops the ... |
| P1-N02 | 2 | S | WP-N | The build org's tenant id is in 11 tracked files and home-directory paths in 6; forbidden.txt has no rule for them, for bearer JWTs or webh... |
| P1-N03 | 2 | S | WP-N | LIVE_VALIDATION run labels skip 3, 5, 6 and the replay row's offsets disagree with its caught-in; VIDEO_SCRIPT says the video cannot disa... |
| P1-N05 | 2 | S | WP-N | README:410 'Between sweeps the UI only reads snapshot and meta' is no longer true (prices while unpriced, demo/state, inventory per sweep... |
| P1-Y01 | 2 | S | INT | Units and typography wobble across screens: '/day' vs '/ day' and '{typical}/GB' vs '/ GB'; 'an hour' vs '/ hour' (with two dead keys); '... |
| P1-Y02 | 2 | S | INT | 'The Leader' and 'the savings snapshot' appear in error copy on the Receipt and presenter (leadership surfaces); the sample band says 'sa... |
| P1-A09 | 2 | M | WP-A | Single-character shortcuts have no off switch or focus-only mode (WCAG 2.1.4); ARIA nits: aria-label on a span badge, div presenter root ... |
| P1-B04 | 2 | M | WP-B | The release bundle still carries the whole rig id table and rig flow list in the Presenter chunk and the demo copy keys ('Demo levers (de... |
| P1-F13 | 2 | M | WP-J | Any treatment projects on any stream regardless of source type ('Windows XML pack' on 'Palo Alto firewall east' projects -$486/day from a... |
| P1-I07 | 2 | M | WP-I | The map stays 932x567 at 1440 and 1920 (350 px empty below on a projector); 500/403/429 are a lone banner over ~700 px of blank page; loa... |
| P1-O02 | 2 | M | WP-O | No Playwright spec asserts the open tab's call rate (the journal helpers exist unused), so a regression to 60+/min passes CI; no test gua... |
| P1-F08 | 1 | S | WP-F | Beyond 50 price versions the two oldest merge keeping the older effectiveFrom, so the displayed price for minutes between them reads at t... |

#### P1-F06 · The cost-spike rule never learns a new level (qualifying minutes never feed the baseline; frozen while open; no sigma floor): a Source that starts sending opens a HIGH spike that never closes, a +1%/min ramp opens at minute 31 forever, an hourly batch opens a new incident every hour with a bell entry each

- **Area:** spike rule learning · **Package:** WP-F · **Impact:** 5 · **Effort:** M · **Lenses:** judge-sre (1 finding merged)
- **Files:** `core/detector.ts`, `core/baseline.ts`, `core/settings.ts`
- **Evidence:** tests/report/audit/sre-day2/probes/detector-noise.txt (A, B, C); core/detector.ts:303-323,339,358; core/sweep.ts:1110-1119
- **Gate:** after critique-fixes merges; core/settings.ts (new threshold defaults) is loaned from WP-G1
- **Fix:** Feed the baseline at reduced weight while open and auto-close as 'new normal' after N minutes at the level (noted); sigma floor max(sigma, 15% of mean, $1/h); require warm-up samples with traffic; one incident per object per 24 h for repeats; a medium tier under 2x.
- **Acceptance:** tests/unit/detector.test.ts replays probes A/B/C: A opens <= 2 incidents in 8 h, B closes as new normal, C closes within 60 min of the ramp settling.

#### P1-F07 · A deliberate change on a flow worth > $5/day opens a regression that never closes and re-notifies every cooldown forever; the release has no mute, exclude or acknowledge (excludedObjectKeys is honoured by the detector but has no UI; demo/state.muted is demo-only); README lists 'accept the new normal' as roadmap

- **Area:** mute / exclude / accept the new normal · **Package:** WP-F · **Impact:** 5 · **Effort:** M · **Lenses:** judge-sre, scout (2 findings merged)
- **Files:** `core/incidents.ts`, `core/detector.ts`, `core/baseline.ts`, `core/types.ts`, `src/components/IncidentCard/IncidentCard.tsx`, `src/views/Settings/AlertsSection.tsx`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/sre-day2/probes/renotify.txt; tests/report/audit/sre-day2/settings-alerts-light-1440.png; tests/report/audit/feature-scout/shots/A-ledger-light-1440.png; core/sweep.ts:689,714,1281-1286; core/incidents.ts:52,66-77; core/detector.ts:137; core/types.ts:282,343; core/baseline.ts:30; README.md:400
- **Gate:** after critique-fixes; the IncidentCard action and the AlertsSection chips are loaned from WP-H / WP-G2 after the core lands
- **Fix:** Incident.closedReason 'recovered' | 'accepted' + acceptedBy; acceptIncident() re-seeds the baseline and closes with a note (existing 'closed' bell kind); 'Mute 24 h' as a release-safe mute doc; 'Exclude object' writing excludedObjectKeys with removable chips in Settings -> Alerts; the actions on the full incident card and the payload link.
- **Acceptance:** unit: accepting an open regression closes it, re-seeds byObject to the current ratio and the next sweep opens nothing on that object; e2e: the card shows 'accepted by <user>' and Settings lists the excluded object.

#### P1-I01 · Ribbon width encodes in-bytes on the view whose subtitle is 'This is dollars', and $/day plates are gated by pixel thickness: the cheapest flow ($527/day) is the biggest shape while $2-3k/day flows carry no figure at 1440

- **Area:** Flow encoding: bytes vs dollars · **Package:** WP-I · **Impact:** 5 · **Effort:** M · **Lenses:** view-flow (1 finding merged)
- **Files:** `src/components/FlowDiagram/layout.ts`, `src/components/FlowDiagram/FlowMap.tsx`, `docs/DESIGN_BRIEF.md`
- **Evidence:** tests/report/audit/flow-design/tour-light-1440.png; tests/report/audit/flow-design/tour-zoom-left-light-1440.png; tests/report/audit/flow-design/measurements.json; src/components/FlowDiagram/layout.ts:518,805; docs/DESIGN_BRIEF.md:52
- **Gate:** docs/DESIGN_BRIEF.md:52 (name the band quantity) is loaned from WP-N
- **Fix:** Make would-have-paid the band quantity on /flow (sqrt scale stays; the wedge rule still holds), keep bytes as the optional mode behind the W-04 toggle; gate the $ plate by dollar rank (every flow >= 2% of the map's whp gets a figure; thin ribbons get a leader or a label-line suffix).
- **Acceptance:** flow.spec.ts on the tour at 1440: ribbon widths are monotonic in whpPerDayM; every flow >= 2% of total whp has a $ plate.

#### P1-A06 · The SAMPLE DATA band scrolls away while the tab bar stays sticky; on a scrolled phone the only cue that the numbers are fake is one 8 px purple dot (brief 5.6: band pinned top)

- **Area:** sample band pinning · **Package:** WP-A · **Impact:** 4 · **Effort:** S · **Lenses:** view-firstrun (1 finding merged)
- **Files:** `src/components/Shell/Shell.tsx`, `src/components/common/common.css`
- **Evidence:** tests/report/audit/design-first-run/shots/sample2-scrolled-light-390.png; tests/report/audit/design-first-run/shots/sample2-scrolled-dark-390.png; tests/report/audit/design-first-run/shots/sample2-scrolled-light-1440.png; src/components/Shell/Shell.tsx:79; src/components/Shell/Shell.css:15-21; src/components/common/common.css:17-33
- **Gate:** common.css line for .mr-sample-band is loaned from WP-M
- **Fix:** Move <SampleBand /> inside the sticky header (or position: sticky; top: <header height>) and keep a one-word 'Sample' label next to the dot at <= 439 px.
- **Acceptance:** e2e: scroll the tour Receipt 800 px at 390 and 1440 -> .mr-sample-band bounding top >= 0 and visible.

#### P1-C02 · Every frame of the loop carries the striped SAMPLE DATA band with a 'Clear sample data' button (the presenter in the same state shows a quiet chip); the 'change' caption says 'A real commit, a real deploy' under that band; the story's presenter beats are not the presenter (centred $544,974 MTD at 173 px, no savers, no QR, while P shows $8,136,556 annualized at 200 px with the list and the QR)

- **Area:** Story frame: sample band and 'real' vs 'sample' · **Package:** WP-C · **Impact:** 4 · **Effort:** S · **Lenses:** view-story, judge-wow (3 findings merged)
- **Files:** `src/views/Story/index.tsx`, `src/views/Story/stages.tsx`, `src/views/Story/Story.css`, `src/story/beats.ts`, `src/copy/en.ts`, `demo/sample/story.json`
- **Evidence:** tests/report/audit/story-design/shots/1920-dark-00-title.png; tests/report/audit/story-design/shots/1920-dark-01-hook.png; tests/report/audit/story-design/shots/real-tour-present-takeover-1920-dark.png; tests/report/audit/stage-judge/story-change-dark-1920.png; tests/report/audit/stage-judge/measurements.json (sampleBandVisibleByBeat all true); tests/report/audit/story-design/measurements.json (1920-dark geo.hook); src/views/Story/index.tsx:94; src/views/Presenter/index.tsx:121,142; src/views/Story/stages.tsx:59-75; src/views/Story/Story.css:145-151; src/components/Meter/Meter.css:20; src/copy/en.ts story.captions.change
- **Gate:** caption edits via INT; regenerate story.json/VIDEO_SCRIPT/captions with scripts/story.ts; the filed v1 video is not re-rendered unless asked
- **Fix:** Render the presenter's chip in .mr-st-top and drop the band in Story mode (or a 24 px single-line variant without the button); caption 'An admin ships a pipeline change. Meter Reader sees the commit.' and let the live-proof card own 'real'; hook beat shows the annualized figure with periodBasis('annualized') at --mr-hero-max with the SaversList, MTD stays on the receipt beat; .mr-st-basis 28 px at 1920.
- **Acceptance:** story.spec.ts: no .mr-sample-band inside .mr-story; the hook beat's data-period is annualized and its figure font-size equals the presenter's; the change caption contains no 'real'.

#### P1-D05 · The tab never yields to a fresh runner (both meter every minute: ~59 calls/min for one viewer), the off-cycle cheap check re-reads meta and triggers a full refresh on every skipped sweep, prices are polled every 10 s while unpriced, demo/state every poll, meta every poll in presenter mode; a hidden tab keeps the full meter budget

- **Area:** API budget / tab yields to the runner · **Package:** WP-D · **Impact:** 4 · **Effort:** S · **Lenses:** api-budget, judge-sre, states (5 findings merged)
- **Files:** `src/state/meterLoop.ts`, `src/state/selectors.ts`, `src/state/live.ts`, `src/state/services.ts`
- **Evidence:** tests/report/audit/api-budget/findings.json; tests/report/audit/api-budget/receipt-default-1440.json; tests/report/audit/api-budget/hidden-tab-v2.json; tests/report/audit/api-budget/settings-unpriced-fresh.json; tests/report/audit/api-budget/receipt-presenter.json; tests/report/audit/api-budget/worst-config-presenter-30d.json; logs/runner.log (41 no-op 22-call sweeps; 10 'locked'); src/state/selectors.ts:53-60,124; src/state/meterLoop.ts:30,117,120-140,171; src/state/live.ts:137-142; src/state/services.ts:84
- **Fix:** A 'runner' blocker in meterBlocker using isRunnerFresh so an open tab only polls while the runner is alive (skip the tick when document.hidden and the runner is fresh); skip the refresh when skipped === 'current'; align the meter tick to the poll and reuse store.meta for the cheap check when lastOkAt < pollSeconds old; poll prices at the hidden cadence, demo/state only while a lever or scene is owned, meta every third poll in presenter mode; the core half (cheap check in every mode) is P1-E05.
- **Acceptance:** tests/e2e/budget.spec.ts (P1-O02): with a fresh runner owner in meta a metering tab makes <= 15 Leader calls/min steady; without one <= 35; presenter default <= 40.

#### P1-F01 · A counterfactual 'another destination' whose target has no price silently prices would-have-paid at $0: not flagged unpriced, the chip stays, Show the math prints '60.1 GB x $0.00 = $0'

- **Area:** counterfactual to an unpriced destination · **Package:** WP-F · **Impact:** 4 · **Effort:** S · **Lenses:** judge-cfo (1 finding merged)
- **Files:** `core/pricing.ts`, `src/components/PriceTable/PriceTable.tsx`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/cfo/probe1.txt (P2); tests/report/audit/cfo/B-math-destinations-light-1440.png; tests/report/audit/cfo/B-where-money-goes-text.txt; core/pricing.ts:110-114,123
- **Gate:** PriceTable picker line loaned from WP-G1
- **Fix:** In effectivePrices set unpriced (or counterfactualUnpriced) when counterfactual.kind === 'other' and the target has no entry so the banner counts it; disable or caption '(no price yet)' targets in the picker; Show the math prints 'analytics has no price: this credit is $0 until it does'.
- **Acceptance:** tests/unit/pricing.test.ts: a flow whose counterfactual target is unpriced reports unpriced=true and the Receipt banner counts it; the picker shows the caption.

#### P1-H08 · After realistic prices the Receipt lands on MTD and the newcomer's first number is '$10.62' (the seed hour) while Annualized '$92,983 - from today so far' is one click away with nothing hinting at it

- **Area:** landing period for a young install · **Package:** WP-H · **Impact:** 4 · **Effort:** S · **Lenses:** judge-devrel (1 finding merged)
- **Files:** `src/views/Receipt/model.ts`, `src/lib/params.ts`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/devadvocate/24-realistic-receipt-1440-dark.png; tests/report/audit/devadvocate/25-realistic-annualized-1440-dark.png; src/views/Receipt/model.ts:24 PERIOD_ORDER; src/lib/params.ts:40
- **Gate:** params.ts default via INT
- **Fix:** When collecting-since is under 24 h and no ?period is set, land on Annualized (its caption already says 'from today so far'), or add an '~ $92,983 a year at this rate' line under the MTD figure reusing the range hero's rate line.
- **Acceptance:** e2e: a workspace collecting for 1 h with no ?period opens on Annualized (or the MTD hero shows the annual rate line); after 24 h the default is MTD again.

#### P1-J01 · Range figures break the before/after strip: at 390 '+$24,836-$51,134 / year' is clipped and the after value sits on the cell border, 'Sent / day' wraps even in the non-range case, cells 3-4 never get a delta line so heights differ; and when the stream saves nothing today the panel says the same number three times ('$0 -> $66', '+$66 / day', '+$24,109')

- **Area:** What-if compare strip · **Package:** WP-J · **Impact:** 4 · **Effort:** S · **Lenses:** view-whatif (2 findings merged)
- **Files:** `src/components/WhatIf/WhatIf.css`, `src/components/WhatIf/WhatIfPanel.tsx`, `src/styles/utilities.css`
- **Evidence:** tests/report/audit/whatif-design/V6-aggressive-strip-dark-390.png; tests/report/audit/whatif-design/06-aggressive-dark-390.png; tests/report/audit/whatif-design/02-documented-math-light-1440.png; tests/report/audit/whatif-design/01-panel-light-390.png; tests/report/audit/whatif-design/01-panel-light-1440.png; tests/report/audit/whatif-design/metrics.json; src/components/WhatIf/WhatIf.css:475-500; src/components/WhatIf/WhatIfPanel.tsx:839-856; src/styles/utilities.css:15-19
- **Gate:** utilities.css via INT
- **Fix:** Stack before above after in every cell (always three lines), let ranges break at the en dash, compact money for big ranges ('$24.8k-$51.1k'), a third line for cells 3-4 ('-26.5 GB / day', '+33 pts'); when current savedPerDayM === 0 render the after value alone with a 'new' tag and no delta, leaving the hero as the only annual delta.
- **Acceptance:** whatif.spec.ts at 390 with the aggressive treatment: no .mr-num has scrollWidth > clientWidth and all four cells have equal height; the default pack case shows '$66 / day' once in the strip.

#### P1-L02 · The 7:5 grid leaves the main column empty from y~655 to the page bottom at 1440x900 and 1920 while the levers column runs to y~1250: 'Reset and tools', Replay and Tour/Story sit below the fold of the presenter laptop; Tour/Story are tertiary links and there is no Presenter control at all on the phone

- **Area:** Demo console desktop layout · **Package:** WP-L · **Impact:** 4 · **Effort:** S · **Lenses:** view-demo, judge-wow (3 findings merged)
- **Files:** `src/views/Demo/index.tsx`, `src/views/Demo/DemoConsole.css`, `src/views/Demo/panels.tsx`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/design-demo-console/zoom-empty-left-column-light-1440.png; tests/report/beauty/demo-idle-light-1440.png; tests/report/beauty/demo-idle-light-1920.png; tests/report/audit/design-demo-console/zoom-tour-story-light-1440.png; tests/report/audit/design-demo-console/idle-light-390-3.png; src/views/Demo/index.tsx:206-243
- **Fix:** Move ToolsPanel under Scenes in the main column (or three columns at >= 1440); secondary xl buttons 'Start the tour' / 'Play the story' / 'Open presenter' plus 'Story (live run)' navigating to ?story=live; the P hint as a kbd chip inside the presenter button.
- **Acceptance:** demo.spec.ts at 1440x900: every lever and tool button is above the fold; at 390 the Tools panel has an 'Open presenter' button and a 'Story (live run)' button.

#### P1-A01 · Code half of P0-01: mount the takeover in the Shell so it overlays every view, and seed the tracker from the last snapshot the tab saw so a late P still shows an incident opened in the last 45 s

- **Area:** presenter takeover / shell mount · **Package:** WP-A · **Impact:** 4 · **Effort:** M · **Lenses:** judge-wow (1 finding merged)
- **Files:** `src/components/Shell/Shell.tsx`, `src/components/IncidentTakeover/tracker.ts`
- **Evidence:** src/views/Presenter/index.tsx:198; src/components/IncidentTakeover/tracker.ts:4-5,49; PITCH.md:16,21; tests/report/audit/stage-judge/measurements-rest-flow-whatif.json
- **Gate:** tracker.ts is loaned from WP-B for this item only
- **Fix:** Render <IncidentTakeover> from the Shell in every mode (present, normal, story off); tracker baseline = the store's last-seen snapshot rather than the first one the presenter sees.
- **Acceptance:** e2e: open an incident while on /flow, then press P -> the red card is on stage within one poll; opening ?present=1 fresh still treats already-open incidents as old news unless the tab saw them open in the last 45 s.

#### P1-B01 · When the incident closes while the red card is on stage, the red card vanishes in one frame (no leaving fade) and the green card slides up from the bottom again, so the payoff reads as a glitch-cut plus a second entrance instead of the same card turning green (the CSS says 'the recovery is the SAME card')

- **Area:** takeover alert -> recovery hand-off · **Package:** WP-B · **Impact:** 4 · **Effort:** M · **Lenses:** motion (1 finding merged)
- **Files:** `src/components/IncidentTakeover/IncidentTakeover.tsx`, `src/components/IncidentTakeover/IncidentTakeover.css`, `src/components/IncidentTakeover/TakeoverCard.tsx`
- **Evidence:** tests/report/audit/motion/log-takeover.txt (recoverySequence at 1920/1440/390); tests/report/audit/motion/sheet-takeover-recovery-1920.png; src/components/IncidentTakeover/IncidentTakeover.tsx:106-116; src/components/IncidentTakeover/IncidentTakeover.css:9-11; src/components/IncidentTakeover/TakeoverCard.tsx:97-110
- **Gate:** TakeoverCard.tsx after critique-fixes merges
- **Fix:** Either run the 200 ms leave fade before swapping the queue head, or morph in place: keep the card mounted across alert -> recovery, transition band/background/border over ~300 ms and crossfade the body; skip the slide when the previous card was already on stage; reduced motion instant.
- **Acceptance:** presenter.spec.ts screencast: between the last red frame and the first green frame there is no frame with an empty lower half; the card's box does not move.

#### P1-C01 · In the alert beat the figure is the full centred hero for 0.4 s, then the card's incident.open action flips HeroFigure to compact: the number moves up 174 px and shrinks to 118 px (140 at 1920, under the >= 160 px presenter floor) while the 450 ms slide and the 360 ms scene entrance overlap; the real presenter keeps the 200 px hero still and slides the card over the lower half

- **Area:** Story alert beat: hero re-layout · **Package:** WP-C · **Impact:** 4 · **Effort:** M · **Lenses:** view-story (1 finding merged)
- **Files:** `src/views/Story/stages.tsx`, `src/views/Story/Story.css`, `src/components/Meter/Meter.css`
- **Evidence:** tests/report/audit/story-design/shots/1440-light-motion-alert-200ms.png; tests/report/audit/story-design/shots/1440-light-motion-alert-600ms.png; tests/report/audit/story-design/shots/real-tour-present-takeover-1920-dark.png; tests/report/audit/story-design/measurements.json (hook vs alert meter box); src/views/Story/stages.tsx:77-96; src/views/Story/Story.css:116,234-236; src/views/Presenter/Presenter.css:46
- **Gate:** stages.tsx after critique-fixes merges; Meter.css (presenter clamp) is loaned from WP-B
- **Fix:** Start the alert beat already in the compact layout with the card slot reserved (min-height) so only the card slides in, or render the card as the presenter does (fixed over the lower half, hero untouched); keep the compact figure >= 160 px at 1920 once the card no longer competes for height.
- **Acceptance:** story.spec.ts: the meter's bounding box is identical at t=200 ms and t=800 ms of the alert beat; its font-size at 1920 >= 160 px.

#### P1-E01 · When the Leader rate-limits below ~23 calls/min every sweep burns 20-24 calls and retries at full rate forever (1,253-1,440 calls/h, 0 minutes metered); the failure is never recorded because recordFailure and releaseLock write through the same rate-limited store, so consecutiveRateLimited stays 0 and the lock stays held for its TTL; the one retry ignores Retry-After

- **Area:** rate limiting / back-off · **Package:** WP-E · **Impact:** 4 · **Effort:** M · **Lenses:** judge-sre, api-budget (2 findings merged)
- **Files:** `core/sweep.ts`, `core/http.ts`, `core/kv.ts`, `scripts/runner.ts`
- **Evidence:** tests/report/audit/sre-day2/probes/rate-limit.txt; tests/report/audit/api-budget/warm-ratelimit-50-presenter-30d.json; core/sweep.ts:267-313,562-567,598,617-628,633-661; scripts/runner.ts:256-262; src/mock/emulator.ts:444 (sends retry-after)
- **Fix:** Back off the cadence after consecutive 429s (skip 2, 4, 8 minutes; runner and tab); keep the streak in process/heartbeat memory as well as KV; honour Retry-After (cap 60 s) for the retry and live.ts back-off; sleep to the next minute before the failure-record and lock-release writes (or skip the release, the lock is re-entrant for this owner); surface 'rate limited since HH:MM' in Settings -> Runtime and the diag panel.
- **Acceptance:** tests/unit/sweep.test.ts with a 15/min limiter: calls/hour < 200 after the first failure, meta.consecutiveRateLimited increments, the lock is not held past the sweep, and the first successful sweep after recovery backfills.

#### P1-F02 · Diversion credits (counterfactual 'another destination') are blended with measured reductions: the Ledger shows a 0% reduction flow saving $2,502/day, the weekly receipt lists it beside measured trims, 10% of the sample headline is an assumption and no row, chip or line says which dollars are measured

- **Area:** measured vs assumed dollars · **Package:** WP-F · **Impact:** 4 · **Effort:** M · **Lenses:** judge-cfo, copy (2 findings merged)
- **Files:** `core/receipt.ts`, `core/snapshot.ts`, `src/components/LedgerTable/LedgerTable.tsx`, `src/components/ReceiptBar/ReceiptBar.tsx`, `src/components/MathDrawer/MathDrawer.tsx`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/cfo/A-ledger-light-1440.png (row 6); tests/report/audit/cfo/probe1.txt (P5); tests/report/audit/cfo/A-receipt-mtd-light-1440.png; tests/report/audit/copy/ledger-text-light.txt; README.md:266; core/receipt.ts lineLabel
- **Gate:** Ledger/ReceiptBar/MathDrawer cells loaned from WP-K/WP-H; core split first
- **Fix:** Split saved into reducedM and divertedM per flow (the counterfactual kind is per destination); tag Ledger rows and receipt lines '(diverted)' with the Reduction cell reading 'diverted' and a title 'Without Cribl -> Splunk Cloud'; two greens (or a hatch) in the hero bar legend; 'Saved by reduction $X - by diversion $Y' in Show the math and both receipts.
- **Acceptance:** unit: snapshot.headline carries reducedM + divertedM = mtdM; the weekly receipt text tags the DNS line '(diverted)'; the Ledger renders 'diverted' in the Reduction cell for that row.

#### P1-G05 · Pressing 'Add endpoint' renders a card that is already red (two error icons, 'give this endpoint a name', 'must start with https://') and the save bar says 'Fix 2 fields to save.' before any keystroke; ten empty endpoints read 'Fix 16 fields'

- **Area:** premature validation on Add endpoint · **Package:** WP-G2 · **Impact:** 4 · **Effort:** M · **Lenses:** view-settings (1 finding merged)
- **Files:** `src/views/Settings/NotificationsSection.tsx`, `src/components/EndpointEditor/EndpointEditor.tsx`
- **Evidence:** tests/report/audit/design-settings/notify-new-webhook-light-1440.png; tests/report/audit/design-settings/crop-notify-new-webhook-light.png; tests/report/audit/design-settings/notify-limit-light-1440.png; tests/report/audit/design-settings/crop-notify-replace-light.png; src/views/Settings/NotificationsSection.tsx:173; src/components/EndpointEditor/EndpointEditor.tsx:191,234,555
- **Fix:** Track touched/blurred per field (or validate after the first Save attempt) and count only touched errors in the save bar; keep aria-invalid for saved rows.
- **Acceptance:** settings.spec.ts: Add endpoint -> zero error icons and the save bar reads the dirty count without 'Fix'; blur an empty name -> one error.

#### P1-H01 · The right ~800 px of the hero card is empty beside the number at 1440 and 1920 (SCORES-3a N1 still open): the meter figure is 416 px wide at x=112 inside a 1216 px content box with nothing to its right for three rows

- **Area:** Receipt hero composition · **Package:** WP-H · **Impact:** 4 · **Effort:** M · **Lenses:** view-receipt (2 findings merged)
- **Files:** `src/views/Receipt/Receipt.css`, `src/views/Receipt/HeroCard.tsx`, `src/views/Receipt/model.ts`
- **Evidence:** tests/report/audit/design-receipt/shots/receipt-dark-1440-fold.png; tests/report/audit/design-receipt/shots/receipt-light-1920-fold.png; tests/report/audit/design-receipt/measure.json (grid:dark:1440 meterFigure w 416, hero w 1280); src/views/Receipt/Receipt.css .mr-hero grid-template-areas
- **Gate:** after the range fixer lands (HeroCard.tsx, Receipt.css)
- **Fix:** At >= 1024 px give the hero a right column ('number aside' / 'caption aside'): the other three periods as small tabular figures (Today - 30 days - Annualized) or Net after Cribl - Paid for itself plus a 24 h savedM sparkline, so the toggle reads as focus; this also moves the range popover off the number.
- **Acceptance:** e2e at 1440 and 1920: the hero's right half contains the aside figures; no empty rect wider than 300 px beside the meter; 390 keeps the single column.

#### P1-H02 · The sample tour (the first screen a judge sees) truncates 2 of 5 top-saver labels at 1440 and 3 of 5 at 390 ('Palo Alto traffic aggregat...'), and the phone incident toast covers the tab bar and the sample band

- **Area:** top savers truncation · **Package:** WP-H · **Impact:** 4 · **Effort:** M · **Lenses:** view-receipt, judge-cribl-pm (2 findings merged)
- **Files:** `src/components/ReceiptList/ReceiptList.css`, `src/components/ReceiptList/ReceiptList.tsx`, `demo/sample/tour.json`
- **Evidence:** tests/report/audit/design-receipt/shots/sample-dark-1440.png; tests/report/audit/design-receipt/shots/sample-light-390.png; tests/report/audit/design-receipt/measure.json (sample truncated entries); tests/report/audit/pm-cribl/tour-receipt-alert-light-390.png; src/components/ReceiptList/ReceiptList.css .mr-rlist-label nowrap
- **Fix:** Let a label wrap to two lines with the leader on the last line (or stack name / leader+amount at <= 480 px), move the repeated '/ day' into the card caption, and shorten the sample labels in tour.json so the demo never ellipsises.
- **Acceptance:** e2e on the tour at 1440 and 390: no .mr-rlist-label has scrollWidth > clientWidth; the amounts stay right-aligned.

#### P1-I02 · '$ saved' plates float 40-111 px right of the pipeline column over crossing ribbons with nothing tying them to their ribbon; pipeline names sit 4 px above their own bar and 7 px below the previous node, reading as captions of the node above, with a halo that notches the bands

- **Area:** Flow labels and plates · **Package:** WP-I · **Impact:** 4 · **Effort:** M · **Lenses:** view-flow (2 findings merged)
- **Files:** `src/components/FlowDiagram/layout.ts`, `src/components/FlowDiagram/FlowDiagram.css`, `src/components/FlowDiagram/FlowDiagram.tsx`
- **Evidence:** tests/report/audit/flow-design/tour-zoom-mid-light-1440.png; tests/report/audit/flow-design/tour-zoom-right-dark-1440.png; tests/report/audit/flow-design/rig-phone-map-light-390-full.png; tests/report/audit/flow-design/rig-zoom-mapcard-dark-1440.png; tests/report/audit/flow-design/measurements.json; src/components/FlowDiagram/layout.ts:805-811; src/components/FlowDiagram/FlowDiagram.css .mr-flow-label--node-pipe
- **Fix:** Anchor saved plates at pipe node + 8 px inside the ribbon's own band, stacked per row, append the saving to the pipeline label when the wedge is thinner than the plate, a 1 px leader in the ribbon colour when a plate must move; bias labels to their own node (2 px gap own, >= 10 px previous), a 2 px tick, drop the halo where the label leaves the band.
- **Acceptance:** flow.spec.ts: every saved plate's box intersects its own ribbon band or is joined to it by a leader element; pipe label distance to own bar < distance to previous node for all nodes.

#### P1-K01 · At 1440 and 1920 the Route column truncates 5 of 6 demo rows and Pipeline 2, while Route always repeats Source; the page caps at 1280 px so 1920 adds 640 px of empty canvas beside a truncating table; the medium layout leaves ~250 px dead

- **Area:** Ledger columns · **Package:** WP-K · **Impact:** 4 · **Effort:** M · **Lenses:** view-ledger (3 findings merged)
- **Files:** `src/components/LedgerTable/LedgerTable.css`, `src/components/LedgerTable/LedgerTable.tsx`, `src/components/LedgerTable/layout.ts`, `src/views/Ledger/index.tsx`
- **Evidence:** tests/report/audit/design-ledger/table-head-zoom-light-1440.png; tests/report/audit/design-ledger/ledger-light-1920-full.png; tests/report/audit/design-ledger/table-dark-1024.png; tests/report/audit/design-ledger/measurements.json; src/components/LedgerTable/LedgerTable.css:16-19; src/components/LedgerTable/layout.ts:9
- **Fix:** Collapse Route into Source when the humanized labels are equal (or a 1fr/1fr/1.4fr split with route min 128 px and pipeline min 160 px); Page width 'wide' (1440 px) for the Ledger at >= 1600 with a Group column; cap Status at minmax(128px,160px) in the medium layout and bring back Would have paid at >= 960.
- **Acceptance:** ledger.spec.ts at 1440 and 1920 on the demo rows: no name cell has scrollWidth > clientWidth; at 1920 the flows card is >= 1400 px wide.

#### P1-K03 · In 7 d on the phone the day labels collide into 'Sun 20Mon 21Tue 22...'; the commit card (242 px) opens above a 172 px chart and covers the card's own title; coincident diamonds stack 13 px per level into the plot so four Sat 26 commits read as 20/22/24/26% values; the 7 d line stops ~1.5% short of the right edge with today's diamonds beyond it; at 1440 the open card covers the legend readout and 40% of the plot; the card autofocus draws a ring after keyboard use

- **Area:** Change timeline on the phone and markers · **Package:** WP-K · **Impact:** 4 · **Effort:** M · **Lenses:** view-ledger (6 findings merged)
- **Files:** `src/components/ChangeTimeline/model.ts`, `src/components/ChangeTimeline/ChangeTimeline.tsx`, `src/components/ChangeTimeline/ChangeTimeline.css`
- **Evidence:** tests/report/audit/design-ledger/timeline-7d-dark-390.png; tests/report/audit/design-ledger/timeline-7d-light-390.png; tests/report/audit/design-ledger/timeline-card-light-390.png; tests/report/audit/design-ledger/timeline-7d-light-1440.png; tests/report/audit/design-ledger/timeline-card-light-1440.png; tests/report/audit/design-ledger/timeline-card-cause-dark-1440.png; tests/report/audit/design-ledger/measurements-states.json; src/components/ChangeTimeline/model.ts:135-150,228,240-251; src/components/ChangeTimeline/ChangeTimeline.tsx:64,162-164,276,409-412,559
- **Fix:** dayTicks takes maxTicks from plotW/64 and thins to every 2nd/3rd day (short labels under 560); render the commit card as a bottom sheet / docked under the chart below 560; draw commits in an 18 px marker strip between the axis and its labels; append the live series' last point so the 7 d line runs to now; place the card left of the diamond when x > 60% and below the legend; focus the close button instead of the container.
- **Acceptance:** ledger.spec.ts at 390 in 7 d: no two day labels overlap and the commit card's box stays inside the chart card; at 1440 an open card does not intersect the legend readout.

#### P1-I06 · Pressing 'What if...' inserts a 440 px calculator above the map (map starts at y~604 at 1440, y~994 at 390) and the projected layout re-orders the source rows, so the 'same map, ghosted after-state' becomes a different picture; the toggle is a 14 px link at rest and an outlined button when on

- **Area:** What-if entry on the Flow view · **Package:** WP-I · **Impact:** 4 · **Effort:** L · **Lenses:** view-flow (2 findings merged)
- **Files:** `src/views/Flow/FlowScreen.tsx`, `src/views/Flow/FlowScreen.css`, `src/components/FlowDiagram/layout.ts`
- **Evidence:** tests/report/audit/flow-design/rig-whatif-light-1440-full.png; tests/report/audit/flow-design/rig-whatif-dark-1440.png; tests/report/audit/flow-design/rig-phone-whatif-light-390-full.png; tests/report/audit/flow-design/measurements.json (rig-whatif mapCard.y); tests/report/audit/flow-design/rig-zoom-head-light-1440.png; src/views/Flow/FlowScreen.tsx:143; docs/DESIGN_BRIEF.md 5.9
- **Fix:** Day 1 (S): pin node order to the live layout during a projection (fixed nodeSort into computeFlowLayout) and one secondary 'Open What-if' button with aria-pressed. Day 2 (M): on /flow render a <= 120 px compact bar (stream, treatment, before -> after chips, basis chip) above the map with Show the math in the receipt card; the full panel stays on /whatif.
- **Acceptance:** flow.spec.ts: enabling What-if keeps the in-column node order identical to the live layout and the map card top within 200 px of its previous position at 1440.

#### P1-A02 · Every lazy view (P, Y, Flow, Ledger, tour start) shows the generic edge-to-edge ViewSkeleton for ~300 ms on the dev server (one RTT in prod) before cutting to the view; the skeleton spans 1392 px while every view sits in the 1280 px Page frame, so the page shifts 56 px

- **Area:** lazy view entry / skeleton flash · **Package:** WP-A · **Impact:** 3 · **Effort:** S · **Lenses:** view-shell, motion, view-firstrun (3 findings merged)
- **Files:** `src/router.tsx`, `src/components/Shell/Shell.tsx`, `src/components/common/Loading.tsx`, `src/components/common/common.css`
- **Evidence:** tests/report/audit/shell/notes2.json (presenter.enterTimeline skeleton 82-263 ms); tests/report/audit/shell/presenter-enter-100ms-dark-1920.png; tests/report/audit/shell/story-enter-100ms-dark-1920.png; tests/report/audit/motion/sheet-presenter-entry-1440.png; tests/report/audit/motion/sheet-tour-entry-1440.png; tests/report/audit/motion/log-x-entries.txt; tests/report/audit/design-first-run/shots/skel-firstrun-light-1440.png; tests/report/audit/design-first-run/shots/tour-starting-light-1440.png; tests/report/audit/design-first-run/shots/measurements-splash-skeleton-sample-unpriced.json; src/components/Shell/Shell.tsx:54,66,85; src/components/common/Loading.tsx:27-42; src/router.tsx:45-52
- **Gate:** Loading.tsx and common.css (route-shaped skeletons) are loaned from WP-M; WP-A does the preload/startTransition half
- **Fix:** Preload the Presenter and Story chunks on idle after hydration and a nav link's chunk on hover/focus; wrap the view switch in startTransition so the current view stays mounted until the chunk resolves; wrap ViewSkeleton in <Page> (narrow on /first-run) with route-shaped placeholders (ReceiptSkeleton for '/', a title + one tall panel for Flow/Ledger, nav + panel for Settings).
- **Acceptance:** e2e screencast: pressing P after hydration shows no .mr-view-skeleton frame; the cold-load skeleton's left edge equals the rendered Page's left edge at 1440 and 390.

#### P1-A03 · Toasts land top-right over the status cluster and the hero actions, full-width over the tab row on phones, stack when unkeyed ('Receipt copied.' x2, four save-failure toasts), and appear/vanish with no motion

- **Area:** toasts · **Package:** WP-A · **Impact:** 3 · **Effort:** S · **Lenses:** view-shell, view-receipt, view-settings, judge-devrel, judge-cribl-pm, states, motion, view-demo (8 findings merged)
- **Files:** `src/components/common/Toasts.tsx`, `src/views/Receipt/index.tsx`, `src/views/Settings/hooks.ts`, `src/demo/actions.tsx`
- **Evidence:** tests/report/audit/shell/status-offline-toast-light-1440.png; tests/report/audit/shell/status-offline-toast-dark-390.png; tests/report/audit/shell/toast-success-dark-1440.png; tests/report/audit/shell/notes.json (state.offline toastBox); tests/report/audit/design-receipt/shots/copy-toast-dark-390.png; tests/report/audit/design-receipt/shots/copy-toast-light-1440.png; tests/report/audit/design-settings/prices-saved-toast-light-1440.png; tests/report/audit/pm-cribl/tour-receipt-alert-light-390.png; tests/report/audit/devadvocate/12-tour-regression-390-light.png; tests/report/audit/degraded-states/save429-prices-light-1440.png; tests/report/audit/motion/log-x-toast.txt; tests/report/audit/motion/sheet-toast-1440.png; src/components/common/Toasts.tsx:11-22,31; src/views/Receipt/index.tsx:107; src/views/Settings/hooks.ts:26
- **Gate:** the notify.once call sites are loaned: Receipt/index.tsx from WP-H, Settings/hooks.ts from WP-G2, demo/actions.tsx from WP-L; WP-A owns Toasts.tsx
- **Fix:** position 'bottom-right' on desktop and offset below the sticky header (or above the demo bottom bar) on <= 640 px; notify.once keys at every call site (receipt-copied, save-failed per form, lever outcomes); a 150 ms fade + 8 px slide on mount and a fade on close, disabled under reduced motion; move the shortcut chip out of the toast corner.
- **Acceptance:** e2e: the toast box never intersects .mr-status or the TabNav at 1440/390; two Copy receipt clicks yield one toast; a toast has a running opacity transition on mount unless prefers-reduced-motion.

#### P1-A04 · At <= 439 px the live/updated chip is a bare 8 px dot with no label, title or tap target: green, amber, red, grey and purple all mean nothing to a judge on a phone

- **Area:** phone status cluster · **Package:** WP-A · **Impact:** 3 · **Effort:** S · **Lenses:** view-shell, states, view-firstrun (3 findings merged)
- **Files:** `src/components/Shell/Shell.css`
- **Evidence:** tests/report/audit/shell/header-light-390.png; tests/report/audit/shell/status-ratelimited-dark-390.png; tests/report/audit/shell/firstrun-light-390.png; tests/report/audit/shell/sample-band-light-390.png; tests/report/audit/shell/notes3.json (status.title null); tests/report/audit/degraded-states/403-prices-receipt-dark-390.png; tests/report/audit/design-first-run/shots/sample2-scrolled-light-390.png; src/components/Shell/Shell.css:110-136
- **Fix:** Keep the one-word label for every non-Live state (hide it only for 'Live') and let the tab row scroll; give .mr-status a title and, with W-21, a tap target.
- **Acceptance:** e2e at 390 in stale, rate-limited, offline and sample states: the status label text is visible and readable by aria snapshot.

#### P1-A08 · ?diag=1 omits what a 3 a.m. screenshot needs (meteredThrough, sweepErrors/lastError, consecutiveRateLimited, lock owner/expiry, runner freshness, held minutes, groups known vs listed, KV key count, per-tab Leader calls in the last minute), has no copy button, no touch/mouse close, and dumps raw JSON sliced mid-token

- **Area:** diagnostics panel · **Package:** WP-A · **Impact:** 3 · **Effort:** S · **Lenses:** judge-sre, view-firstrun, a11y, api-budget (4 findings merged)
- **Files:** `src/components/Shell/DiagPanel.tsx`, `src/components/Shell/Shell.css`
- **Evidence:** tests/report/audit/sre-day2/diag-light-1440.png; tests/report/audit/sre-day2/diag-dark-390.png; tests/report/audit/design-first-run/shots/firstrun-diag-dark-390.png; tests/report/audit/design-first-run/shots/measurements-kverr.json; tests/report/audit/api-budget/warm-ratelimit-receipt-70s-light-1440.png; src/components/Shell/DiagPanel.tsx:33-45,52-67; src/components/Shell/Shell.css:236-256
- **Fix:** Add the rows from meta and the store, a 'Copy diagnostics' button (plain text), a CloseOutlined IconButton that strips ?diag, render lastResult as ok / mode / calls / error fields, a bottom sheet with its own scroll at <= 640 px, tabIndex=0 on the aside, colour the meta row when lastSweepAt is older than 3 minutes.
- **Acceptance:** e2e: the diag panel lists meteredThrough, lastError, groups known/listed and calls-last-minute rows; a tap on its close button removes it and ?diag from the URL; Copy diagnostics puts plain text on the clipboard.

#### P1-B02 · The recovery card ends in a bare 'pipeline' chip with a 70%-empty foot; a long delivery line wraps the foot and overflows the card by 3 px (scrollbar on Windows); the body is vertically centred with ~60/110 px of air and the right column ends 340 px short; the git icon floats between commit lines; the money line breaks after the separator at 390; the dismiss button is 32 px beside a 36 px title; the 'name on the alert' is the smallest type on the card (author 24 px, hash 22 px); on the phone the card covers the QR and the vote ask; the delivery flip reflows the card at 390

- **Area:** takeover card polish · **Package:** WP-B · **Impact:** 3 · **Effort:** S · **Lenses:** view-presenter, judge-wow, motion, states (10 findings merged)
- **Files:** `src/components/IncidentTakeover/IncidentTakeover.css`, `src/components/IncidentTakeover/TakeoverCard.tsx`, `src/views/Presenter/Presenter.css`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/design-presenter/takeover-recovery-dark-1920x1080.png; tests/report/audit/design-presenter/takeover-blocked-dark-1920x1080.png; tests/report/audit/design-presenter/takeover-bell-dark-1920x1080.png; tests/report/audit/design-presenter/takeover-card-dark-1440x900.png; tests/report/audit/design-presenter/takeover-spike-dark-390x844.png; tests/report/audit/design-presenter/takeover-head-dark-1920x1080.png; tests/report/audit/design-presenter/takeover-delivered-dark-390x844.png; tests/report/audit/design-presenter/takeover-longtitle-dark-390x844.png; tests/report/audit/design-presenter/measure-full.json; tests/report/audit/stage-judge/measurements-typo.json; tests/report/audit/stage-judge/takeover-alert-realistic-clock-dark-1920.png; tests/report/audit/motion/log-takeover.txt (390 deliveryFlip cls 0.0186); tests/report/audit/degraded-states/presenter-takeover-dark-390.png; src/components/IncidentTakeover/IncidentTakeover.css:136,216,273-280,319,353-360; src/components/IncidentTakeover/TakeoverCard.tsx:128-133,150,187; src/copy/en.ts:1076
- **Gate:** TakeoverCard.tsx after critique-fixes merges
- **Fix:** Recovery: the closing commit line ('Restored by 9b1c2f3 ... - s.koelpin') or 'traffic returned to baseline' in place of the kind chip and the recovery delivery in the foot's right slot; a fixed two-slot foot grid (clock | delivery) with a reserved note line so every delivery state has the same height and overflow hidden; align-items start with a one-line 'what happened' sentence; icon align-self flex-start; nbsp before ' - {perYear} a year'; size='lg' dismiss; promote the person into the header band or a 36 px second line under the money; at <= 720 px place the card inline between the savers and the QR (or shrink the QR to 120 px top-right); min-height for two delivery lines under 720 px with a 200 ms crossfade.
- **Acceptance:** presenter.spec.ts: every delivery fixture yields the same card height at 1920; the recovery card has no bare 'pipeline' chip; at 390 the QR block stays visible with a card up; the author callout font size >= 32 px at 1920.

#### P1-B03 · The QR renders at 200 px at 1440 (brief >= 220) with a 15 px ask and a 10.5 px mono URL, and at 1920 the URL breaks after the slash under a three-line ask; a smaller number renders bigger (6 figures hit the 200 px cap, 7 figures fit at 166) so crossing $1M shrinks the hero 17% and moves the caption; HeroMeter reads reduced motion once and is a second odometer with different roll timing; on entry the accrual since sweepAt rolls the digits; the Live dot spends the money green and the sample chip is Capra purple; the only key hint is 'Press P to leave' for 6 s and '?' opens a small blue Capra modal over the number

- **Area:** presenter hero polish · **Package:** WP-B · **Impact:** 3 · **Effort:** S · **Lenses:** view-presenter, motion, view-shell (9 findings merged)
- **Files:** `src/views/Presenter/Presenter.css`, `src/views/Presenter/HeroMeter.tsx`, `src/views/Presenter/index.tsx`, `src/components/QrBlock/QrBlock.tsx`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/design-presenter/qr-dark-1440x900.png; tests/report/audit/design-presenter/qr-dark-1920x1080.png; tests/report/audit/design-presenter/stress-6fig-longlabel-dark-1920x1080.png; tests/report/audit/design-presenter/rest-dark-1920x1080.png; tests/report/audit/design-presenter/top-dark-1440x900.png; tests/report/audit/design-presenter/state-sample-top-dark-1920x1080.png; tests/report/audit/design-presenter/shortcuts-dark-1920x1080.png; tests/report/audit/design-presenter/rest-hint-dark-1920x1080.png; tests/report/audit/design-presenter/measure-full.json; tests/report/audit/motion/log-presenter.txt (digitRollover fs 200 -> 166.4; mountTrace); tests/report/audit/motion/presenter-rollover-dark-1920.png; tests/report/audit/motion/notes.json (reduced.live.presenter rafPerSec 60); src/views/Presenter/Presenter.css:35,100-105,115,226,344; src/views/Presenter/HeroMeter.tsx:6-7,107-122,130-136; src/views/Presenter/index.tsx:41; src/components/QrBlock/QrBlock.tsx:55
- **Fix:** Desktop QR floor 220 px asserted at 1440, no URL line on stage (the code is the URL) and a two-line ask at >= 24 px; size the figure from a fixed 10-character budget (or the largest of the four period figures) so magnitude changes do not resize it; replace HeroMeter with <Meter size='presenter'> (live matchMedia, one roll timing) and jump to the accrued value on mount; a neutral live dot and a warning-tinted sample chip (Shell band to match); hint 'P leaves presenter mode - ? shows keys' with a stage-scaled sheet (>= 24 px keys, any key closes) listing Escape and the lever keys when demo.enabled.
- **Acceptance:** presenter.spec.ts: QR >= 220 px at 1440; the figure's font-size is identical for '$290,905' and '$1,286,345'; toggling prefers-reduced-motion while the stage is up stops the rAF loop; no accent-blue element on the stage; no success-green outside the money figure.

#### P1-C04 · The caption 'Saved by Cribl: $544,974.' is frozen at generation time while the hero ticks ($544,983 in the same frame, $45 over by the restore beat); the 'watching' chart spans 30 minutes with a fixed 0-100% domain so the 75 -> 50 drop is a 60 px stub in a quarter of the plot

- **Area:** Story captions and watch chart · **Package:** WP-C · **Impact:** 3 · **Effort:** S · **Lenses:** view-story, judge-wow (3 findings merged)
- **Files:** `src/views/Story/stages.tsx`, `src/views/Story/RatioWatch.tsx`, `src/story/beats.ts`
- **Evidence:** tests/report/audit/story-design/shots/1440-light-03-meter-line1.png; tests/report/audit/story-design/shots/1440-light-08-restore.png; tests/report/audit/story-design/shots/1440-light-05-watching.png; tests/report/audit/story-design/shots/1920-dark-05-watching.png; tests/report/audit/stage-judge/story-watching-dark-1920.png; src/story/beats.ts:225-241; src/views/Story/stages.tsx:65-71; src/views/Story/RatioWatch.tsx:56-58,65,99
- **Gate:** stages.tsx after critique-fixes
- **Fix:** Pass ratePerSecM 0 on the receipt beat (static whole dollars matching the caption and bar) or drop the figure from the caption; window RatioWatch to [change - 8 min, change + 4 min] with the y-domain [max(0, min - 0.15), 1] and label the shaded loss with its $/day.
- **Acceptance:** story.spec.ts: the hero text equals the caption's figure during the receipt beat; in the watching beat the after-segment spans >= 30% of the plot width.

#### P1-C06 · On touch the 'Press any key to exit' hint is hidden and the only exit is a 32x32 x (under the 44 px target); tapping the stage does nothing, and 'Watch the 90-second story' on the phone first-run card drops a judge into a loop with one small way out; the story=live replay has no button anywhere

- **Area:** Story exit on touch · **Package:** WP-C · **Impact:** 3 · **Effort:** S · **Lenses:** judge-devrel, view-story, judge-wow (3 findings merged)
- **Files:** `src/views/Story/index.tsx`, `src/views/Story/Story.css`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/devadvocate/notes.json (story-exit-affordance closeBox 32x32); tests/report/audit/devadvocate/10-story-title-390-light.png; tests/report/audit/stage-judge/measurements.json (storyLive.releaseBuild); src/views/Story/Story.css:96-99; src/views/Story/source.ts HAS_LIVE_STORY; src/views/Demo/panels.tsx:596
- **Gate:** the console button is P1-L02's; Tab handling is P0-05's
- **Fix:** Exit on a stage tap or swipe-down on touch, a 44 px x, 'Tap to exit' in place of the key hint; aria-keyshortcuts='Escape' on the region and Escape named in the hint; label the presenter chip 'Replay - recorded 9/26' for ?story=live.
- **Acceptance:** story.spec.ts on the mobile project: a tap on the stage exits; the close button box is >= 44x44; the hint text is visible on hover:none.

#### P1-D01 · Hydration failures never reach the status dot: 'Waiting for the first sweep' with no prices (nothing can sweep), with every KV read 500/401, and with 429 at boot; after a good load a 401 leaves the chip green 'Live' permanently; the first-run header contradicts its own footer

- **Area:** status cluster / hydration errors · **Package:** WP-D · **Impact:** 3 · **Effort:** S · **Lenses:** states, view-firstrun, judge-devrel (3 findings merged)
- **Files:** `src/components/Shell/status.ts`, `src/state/hydrate.ts`, `src/state/selectors.ts`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/design-first-run/shots/firstrun-viewport-light-1440.png; tests/report/audit/design-first-run/shots/kv-all-500-firstrun-viewport-light-1440.png; tests/report/audit/design-first-run/shots/kv-all-401-receipt-viewport-light-1440.png; tests/report/audit/design-first-run/shots/rate-limited-receipt-viewport-light-1440.png; tests/report/audit/design-first-run/shots/measurements-kverr.json; tests/report/audit/degraded-states/all5xx-receipt-t1.5s-light-1440.png; tests/report/audit/degraded-states/401-ledger-light-1440.png; tests/report/audit/degraded-states/s1b-errors.notes.json; tests/report/audit/devadvocate/01-first-run-1440-dark.png; src/components/Shell/status.ts:23-36; src/state/hydrate.ts:78-105; src/state/selectors.ts:53-60 meterBlocker; src/components/Shell/status.ts:34; src/copy/en.ts:398
- **Fix:** hydrate sets status.live.lastError from the first failed read; deriveDataStatus maps unauthorized/forbidden to a 'Signed out'/'No access' status with the reload action, rate-limited at hydrate like the poll path, and meterBlocker 'no-prices' to 'Not metering yet' (neutral dot).
- **Acceptance:** tests/e2e/shell.spec.ts: first run without prices reads 'Not metering yet'; KV 500 everywhere reads Offline within the hydrate phase; 401 after a good load reads Signed out.

#### P1-D02 · With no snapshot ever loaded, a 5xx on the snapshot claims 'Showing the last good data, updated 4 s ago' (alert, toast and status) over a $-- ghost, because lastOkAt is set when meta OR snapshot succeeded

- **Area:** 'last good data' with none · **Package:** WP-D · **Impact:** 3 · **Effort:** S · **Lenses:** view-firstrun, states (3 findings merged)
- **Files:** `src/state/hydrate.ts`, `src/components/Shell/status.ts`, `src/components/common/ErrorNotice.tsx`, `src/components/Shell/useShellEffects.ts`
- **Evidence:** tests/report/audit/design-first-run/shots/kv-snapshot-500-receipt-viewport-light-1440.png; tests/report/audit/degraded-states/snap5xx-ledger-light-1440.png; tests/report/audit/degraded-states/s1-errors.notes.json; tests/report/audit/design-first-run/shots/measurements-kverr.json; src/state/hydrate.ts:92-96; src/components/common/ErrorNotice.tsx:121-124; src/components/Shell/status.ts:15-19; src/components/Shell/useShellEffects.ts:68
- **Gate:** useShellEffects.ts:68 (toast branch) is loaned from WP-A
- **Fix:** Set lastOkAt only when snapshot.ok (matching live.ts:167); dataUpdatedAt returns undefined without a snapshot; the toast picks serverToast vs a no-data variant on lastOkAt and is skipped when the same message is already inline.
- **Acceptance:** e2e with snapshot 500 on a cold load: the alert reads 'Nothing to show yet. Meter Reader will keep trying.', no toast, status not 'updated N s ago'.

#### P1-D04 · An open tab never re-reads prices once it holds a document, so a second tab's save (or a Load demo prices elsewhere) is invisible until reload and the stale in-memory document then overwrites it on Save (tab B's $0.55 reverted to $0.03)

- **Area:** prices / multi-tab · **Package:** WP-D · **Impact:** 3 · **Effort:** S · **Lenses:** states (1 finding merged)
- **Files:** `src/state/live.ts`, `src/state/services.ts`
- **Evidence:** tests/report/audit/degraded-states/s7-prices-conflict.notes.json; tests/report/audit/degraded-states/prices-conflict-tabB-saved-light-1440.png; tests/report/audit/degraded-states/prices-conflict-tabA-saved-light-1440.png; src/state/live.ts:8-11,137; src/state/services.ts:119-129; src/components/PriceTable/model.ts:93
- **Fix:** Poll prices every N-th poll (always while on /settings/prices) and compare updatedAt; before saving GET prices and refuse with 'Prices changed since you opened this page' when updatedAt differs, or append the new version onto the stored document.
- **Acceptance:** integration test: two stores share one KV; B saves; A's later save either refuses or preserves B's version; the merged document has both versions.

#### P1-D06 · After saving all-$0 prices the app is in two states ('/' shows a live $0 Receipt and Prices says 'All priced', '/first-run' still shows the onboarding card) and nothing says nothing can ever count as saved; 'Where the money goes' says 'No destinations yet' after a sweep that read four; the Ledger empty state has no Set prices action

- **Area:** first-run gate consistency · **Package:** WP-D · **Impact:** 3 · **Effort:** S · **Lenses:** judge-devrel (3 findings merged)
- **Files:** `src/state/selectors.ts`, `src/tour/selectors.ts`, `src/views/Receipt/model.ts`, `src/views/Ledger/index.tsx`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/devadvocate/20-zero-first-run-1440-dark.png; tests/report/audit/devadvocate/21-zero-receipt-1440-dark-full.png; tests/report/audit/devadvocate/06-receipt-first-1440-dark-full.png; tests/report/audit/devadvocate/02-empty-ledger-1440-dark.png; tests/report/audit/devadvocate/notes2.json; tests/report/audit/devadvocate/notes.json; src/tour/selectors.ts:19-24 vs src/state/selectors.ts:16-23; src/views/Receipt/model.ts:226-234; src/views/Ledger/index.tsx:294-296; src/copy/en.ts:658-659,935-940
- **Gate:** Receipt/model.ts and Ledger/index.tsx lines are loaned from WP-H and WP-K
- **Fix:** One gate for both routes; when every priced destination is $0 show an inline Receipt notice 'Every destination is priced at $0, so nothing can count as saved. Set a price.'; distinct copy when destinations exist but carry no money; the same Set prices button on the Ledger empty state.
- **Acceptance:** e2e: save four $0 prices -> '/' and '/first-run' render the same view and the $0 notice; the Ledger empty state has a Set prices link.

#### P1-E02 · The 90 s KV lock is never renewed during a sweep with a 100 s time budget and the writes come last, so at ~4.5 s per call a second runtime acquires the lock at 95 s while the first is still writing minute docs, totals, incidents and meta

- **Area:** lock renewal on slow Leaders · **Package:** WP-E · **Impact:** 3 · **Effort:** S · **Lenses:** judge-sre (1 finding merged)
- **Files:** `core/sweep.ts`, `core/kv.ts`
- **Evidence:** tests/report/audit/sre-day2/probes/slow-leader.txt; core/sweep.ts:130,132,617-630; core/http.ts DEFAULT_TIMEOUT_MS=25000
- **Fix:** Renew the lock (fresh expiresAt) before step 8 and before notifications, abort the writes if the lock is no longer ours, set LOCK_TTL_MS >= SWEEP_TIME_BUDGET_MS + 30 s; consider a 60 s read deadline so writes always fit.
- **Acceptance:** unit probe with 4.5 s latency: a second acquireLock during the writes fails and the first sweep completes its writes; TTL constant >= budget + 30 s.

#### P1-E03 · When KV refuses writes (full store, 507/413/5xx on roll/* PUT) every sweep fails, the cursor stops and the hourly expiry that could free keys never runs because it sits after the writes; nothing on screen says metering stopped

- **Area:** KV write failures · **Package:** WP-E · **Impact:** 3 · **Effort:** S · **Lenses:** judge-sre (1 finding merged)
- **Files:** `core/sweep.ts`
- **Evidence:** tests/report/audit/sre-day2/probes/kv-full.txt; core/sweep.ts:1203-1237,1358-1367
- **Fix:** Run the expiry pass first when the previous sweep failed on a KV write; stamp lastExpiredAt after every pass with a cursor; count keys in the diag panel; the banner is P0-07.
- **Acceptance:** unit probe: with PUTs failing for 30 sweeps the expiry pass runs on the second failed sweep and meteredThrough resumes within one sweep of recovery with the backlog metered.

#### P1-E05 · The runner's 'scheduled' mode skips the cheap check, so whenever a tab metered the minute first the runner still spends a full 22-call sweep that meters nothing (41 of 754 sweeps today)

- **Area:** runner / cheap check in every mode · **Package:** WP-E · **Impact:** 3 · **Effort:** S · **Lenses:** api-budget (1 finding merged)
- **Files:** `core/sweep.ts`, `scripts/runner.ts`
- **Evidence:** tests/report/audit/api-budget/findings.json; logs/runner.log (41 sweeps minutes:0 at 22 calls before the 'locked' clusters); core/sweep.ts:553 (mode === 'ui' gate on the early return); scripts/runner.ts:220
- **Fix:** Run the cheap check in every mode (read meta before the lock; return skipped 'current' when meteredThrough >= windowEnd).
- **Acceptance:** unit: a scheduled sweep after a tab metered the same minute makes <= 2 calls and returns skipped:'current'.

#### P1-E06 · Runner ops gaps (monitoring itself is now done via the Automic health job): no single-instance guard, the supervisor restarts every 10 s forever with no back-off from the working tree, heartbeat ok = !error so a runner refused the lock every minute reports healthy, the hostname is written into org-visible KV, --setup writes demo settings to whatever org .env points at with no confirmation, logs duplicate and never rotate, RUNBOOK has no stop/restart/upgrade section and no rows for the sweep's real error codes

- **Area:** runner operations · **Package:** WP-E · **Impact:** 3 · **Effort:** S · **Lenses:** judge-sre, judge-security (6 findings merged)
- **Files:** `scripts/runner.ts`, `scripts/runner-supervise.sh`, `docs/RUNBOOK.md`, `.env.example`
- **Evidence:** scripts/runner.ts:51,63-68,111-126,141,156-203,235; scripts/runner-supervise.sh:7-12; docs/RUNBOOK.md sections 6 and 9; logs/runner.log ('exited with code 143; restarting in 10 s'); tests/report/audit/security/evidence.json (meta.lastSweepOwner runner:MacBook-Pro-3:26537); tests/report/audit/sre-day2/findings.json; STATE.md (runner on the workhorse; Automic meter-reader-runner-health)
- **Fix:** Pidfile/KV-owner guard refusing a second instance; supervisor exponential back-off with a max, pinned checkout; heartbeat ok false on consecutive 'locked' skips; owner label 'runner' unless MR_RUNNER_HOST is set (documented); --setup requires --demo-org <orgId> equal to CRIBL_ORG and prints the plan; cache the /apps failure for the TTL; single log with size rotation; RUNBOOK start/stop/restart/upgrade around the supervisor plus one row per SweepResult error/skipped code.
- **Acceptance:** Starting a second runner exits non-zero with a named reason; runner.heartbeat.json ok=false after 3 consecutive 'locked' skips; RUNBOOK has the four-verb section and a row for time_budget, rate_limited, budget, no inventory, held minutes, stuck lock, 507/413.

#### P1-F04 · Copy receipt for MTD/Today/30d/Annualized has no line items (the view passes no lines), no Net line, prints the literal 'run rate' in the date slot, and truncated labels leave '... ..' before the amount; the weekly receipt in the Story shows the same artifact

- **Area:** Copy receipt fidelity · **Package:** WP-F · **Impact:** 3 · **Effort:** S · **Lenses:** judge-cfo, view-receipt, view-story (3 findings merged)
- **Files:** `core/receipt.ts`, `src/views/Receipt/index.tsx`
- **Evidence:** tests/report/audit/cfo/A-copy-receipt-mtd.txt; tests/report/audit/design-receipt/shots/copied-dark-1440.txt; tests/report/audit/design-receipt/shots/copied-annualized-dark.txt; tests/report/audit/story-design/shots/1440-light-zoom-weekly.png; tests/report/audit/story-design/shots/1920-dark-09-receipt.png; core/receipt.ts:116-118,145-150,171,270,278; src/views/Receipt/index.tsx:104-105
- **Gate:** index.tsx one-liner loaned from WP-H
- **Fix:** Pass snapshot.topSavers (or the summed period rows through planRangeReads) as lines labelled 'at current rates ($/day)'; add the Net line when criblCost is set; annualized header 'as of Sep 26, 2026'; truncate labels 4 chars shorter so >= 4 leader dots remain (unit test for a label longer than `room`).
- **Acceptance:** unit: receiptTextForPeriod('mtd') contains the top-five lines and the Net line; no line contains '... ..'; the annualized header has a date.

#### P1-F09 · The drawer mixes two bases: 'The formulas' is the period total (MTD $544,974) while 'At each destination' is the last 60 min x 24 (rows sum to $32,956/day), and nothing says why; DestinationFigures already carries mtd* fields

- **Area:** Show the math reconciliation · **Package:** WP-H · **Impact:** 3 · **Effort:** S · **Lenses:** judge-cfo (1 finding merged)
- **Files:** `src/components/MathDrawer/MathDrawer.tsx`, `src/views/Receipt/model.ts`
- **Evidence:** tests/report/audit/cfo/A-math-drawer-text-1440.txt; tests/report/audit/cfo/A-ledger-light-1440.png; core/snapshot.ts:161-162; core/types.ts DestinationFigures
- **Fix:** When the period is MTD print each destination's mtdWhpM/mtdPaidM/mtdSavedM and a reconciliation line 'these rows sum to the figure above'; keep the per-day view for the Ledger labelled 'last hour x 24'.
- **Acceptance:** unit on destinationRows: for period 'mtd' the row sum equals headline.mtdM within rounding; the drawer renders the reconciliation sentence.

#### P1-F11 · 'You would have paid / You paid / Saved' presents avoided cost as realized cash, but Splunk Cloud ingest, Sentinel tiers and Sumo credits are prepaid entitlements realized at renewal; only the preset popover and README say so

- **Area:** entitlement vs metered wording · **Package:** WP-G1 · **Impact:** 3 · **Effort:** S · **Lenses:** judge-cfo (1 finding merged)
- **Files:** `core/presets.ts`, `src/copy/en.ts`, `core/receipt.ts`
- **Evidence:** tests/report/audit/cfo/A-preset-info-splunk_cloud.txt; tests/report/audit/cfo/A-hero-annualized-light-1440.png; README.md:315; src/copy/en.ts:573-575
- **Gate:** core/receipt.ts (the entitlement line) is loaned from WP-F
- **Fix:** billing: 'metered' | 'entitlement' | 'storage' on each preset; one line under the receipt bar and on the receipts: 'At your rates. Entitlement destinations (Splunk Cloud, Sentinel) realize this at renewal.'
- **Acceptance:** unit: every preset has a billing field; the Receipt renders the entitlement line only when an entitlement-billed destination carries money.

#### P1-G01 · Typing a contract rate leaves the picker on 'Internal / free' with 'No destination charge' under a $1.80 field and Show the math prints '$2.25 / GB - Preset: Internal / free'; the 'Custom price' copy is unreachable once a preset id is stored

- **Area:** custom price keeps the preset label · **Package:** WP-G1 · **Impact:** 3 · **Effort:** S · **Lenses:** judge-devrel (1 finding merged)
- **Files:** `src/components/PriceTable/PriceTable.tsx`, `src/components/PriceTable/model.ts`, `src/views/Receipt/model.ts`
- **Evidence:** tests/report/audit/devadvocate/22-realistic-filled-390-light.png; tests/report/audit/devadvocate/26-realistic-math-1440-dark.png; src/views/Receipt/model.ts:213; src/components/MathDrawer/MathDrawer.tsx:241; src/components/PriceTable/PriceTable.tsx:127
- **Gate:** Receipt/model.ts presetLabel line loaned from WP-H
- **Fix:** Clear the preset on manual edit (or when the stored price differs from the preset's typical) so the row note reads 'Custom - $2.25' and the math prints 'Custom price'.
- **Acceptance:** settings.spec.ts: type 1.80 on a preset row -> the row note reads Custom; Show the math for that destination says Custom price.

#### P1-G02 · On an unpriced fresh install every mount of the Prices/Budgets sections walks the Leader config (groups + 4 GETs per group) with no shared cache: 37 calls on first paint, 27 more after hopping away and back; on a priced workspace the inventory doc is re-read per hook instance per sweep and per hop

- **Area:** Settings inventory reads per mount · **Package:** WP-G2 · **Impact:** 3 · **Effort:** S · **Lenses:** api-budget (1 finding merged)
- **Files:** `src/views/Settings/hooks.ts`, `src/views/Settings/PricesSection.tsx`, `src/views/Settings/BudgetsSection.tsx`
- **Evidence:** tests/report/audit/api-budget/settings-unpriced-fresh.json; tests/report/audit/api-budget/warm-settings-prices-mounts.json; tests/report/audit/api-budget/settings-priced.json; src/views/Settings/hooks.ts:118-146; core/adapters/config.ts:181-186
- **Gate:** PricesSection.tsx and BudgetsSection.tsx call sites are loaned from WP-G1; WP-G2 owns hooks.ts
- **Fix:** Hold the inventory (KV doc or Leader walk) in the store keyed by lastSweepAt, read once for all sections and reuse across mounts until the next sweep; cache the unpriced-path Leader walk for the session.
- **Acceptance:** budget.spec.ts: /settings/prices -> /settings/alerts -> /settings/prices on an unpriced install makes one inventory walk; priced steady state reads kv:inventory <= 1/sweep.

#### P1-G06 · The endpoints empty state is a four-row table ghost identical to the loading skeleton under a fully rendered bell card, with a second primary 'Add endpoint' 700 px below the header; it also paints before settings are read (a workspace with three endpoints shows 'No endpoints yet' first); three prose blocks precede the first control

- **Area:** endpoints empty state and hydration · **Package:** WP-G2 · **Impact:** 3 · **Effort:** S · **Lenses:** view-settings, view-firstrun (3 findings merged)
- **Files:** `src/views/Settings/NotificationsSection.tsx`, `src/components/common/EmptyBlock.tsx`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/design-settings/notify-empty-light-1440.png; tests/report/audit/design-settings/crop-notify-empty-dark.png; tests/report/audit/design-settings/run-b.log (primaries 2); tests/report/audit/design-settings/notify-empty-light-390.png; tests/report/audit/design-first-run/shots/skel-notify-light-1440.png; tests/report/audit/design-first-run/notify-check.mjs; src/views/Settings/NotificationsSection.tsx:265-268,282-287; src/views/Settings/PricesSection.tsx:151-152 (the gate to copy)
- **Gate:** EmptyBlock 'cards' ghost is WP-M's; pass ghost='card' here
- **Fix:** Gate on hydration like PricesSection (LoadingBlock until hydrated); ghost='card' with one line 'No endpoints yet - alerts still reach the bell'; one Add endpoint (secondary) and Save as the single primary; one description line, storage sentence only inside the webhook editor.
- **Acceptance:** settings.spec.ts: during hydration the section shows a LoadingBlock, never 'No endpoints yet'; exactly one primary button on the page.

#### P1-G07 · On a phone the Save bar is the card footer ~900 px below the first field with nothing in view saying the page is dirty; only Prices rows show a dirty marker; switching sections with unsaved edits has no guard or rail hint; a 403/500 on Save is only a fading toast

- **Area:** save bar and dirty state · **Package:** WP-G2 · **Impact:** 3 · **Effort:** S · **Lenses:** view-settings (4 findings merged)
- **Files:** `src/views/Settings/shared.tsx`, `src/views/Settings/Settings.css`, `src/views/Settings/index.tsx`, `src/views/Settings/hooks.ts`, `src/views/Settings/BudgetsSection.tsx`, `src/views/Settings/AlertsSection.tsx`, `src/views/Settings/CostSection.tsx`
- **Evidence:** tests/report/audit/design-settings/run-c.log (phoneSaveBar y 1733 of 1872); tests/report/audit/design-settings/prices-dirty-error-light-390.png; tests/report/audit/design-settings/notify-new-target-light-390.png; tests/report/audit/design-settings/crop-prices-row-dirty-light.png; tests/report/audit/design-settings/budgets-mixed-light-1440.png; tests/report/audit/design-settings/run-a.log (dirtyGuard dialogs 0); tests/report/audit/design-settings/prices-save-403-light-1440.png; src/views/Settings/Settings.css:114; src/views/Settings/hooks.ts:19-25
- **Gate:** BudgetsSection.tsx and CostSection.tsx (data-dirty wrappers) are loaned from WP-G1; WP-G2 owns shared.tsx, hooks.ts, index.tsx and Settings.css
- **Fix:** position: sticky; bottom: 0 on the card foot while dirty (backdrop + hairline) at <= 760 px; one data-dirty treatment on every field wrapper; a dot after the rail label for dirty sections and a beforeunload guard; SaveBar takes a `failure` prop and keeps 'Couldn't save (403) - try again' until the next attempt.
- **Acceptance:** settings.spec.ts at 390: editing the first price keeps the Save bar within the viewport; a 403 on save leaves the failure line in the bar after the toast is gone.

#### P1-H03 · The Receipt ghost's caption is the 403 sentence for every failure kind ('once your role can read the savings snapshot' under a 500, a 429 and an expired session); the 429 state shows the generic 'checking less often' line instead of the brief's countdown; Settings stacks two identical alerts for one failure

- **Area:** Receipt error captions · **Package:** WP-H · **Impact:** 3 · **Effort:** S · **Lenses:** view-firstrun, states, view-flow (5 findings merged)
- **Files:** `src/views/Receipt/index.tsx`, `src/views/Settings/PricesSection.tsx`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/design-first-run/shots/kv-snapshot-500-receipt-viewport-light-1440.png; tests/report/audit/design-first-run/shots/rate-limited-receipt-viewport-light-1440.png; tests/report/audit/design-first-run/shots/kv-all-401-receipt-viewport-light-1440.png; tests/report/audit/design-first-run/shots/kv-all-500-settings-viewport-dark-1440.png; tests/report/audit/degraded-states/all5xx-receipt-t13s-light-1440.png; tests/report/audit/degraded-states/429-coldload-light-1440.png; tests/report/audit/degraded-states/all5xx-settings-light-1440.png; src/views/Receipt/index.tsx:177,189-190; src/copy/en.ts:608; src/components/common/ErrorNotice.tsx:105-113; src/views/Settings/index.tsx:112-118 + PricesSection.tsx:147-150
- **Gate:** PricesSection lines loaned from WP-G1
- **Fix:** Pick the caption by error.kind (forbidden -> role sentence; rate-limited -> 'Figures appear after the next sweep.'; server/network -> 'once the Leader answers again'; unauthorized -> 'Reload to sign in'); pass status.live.backoffUntil as nextSweepAt to both ErrorNotice call sites; when the settings-level WriteNotice shows, sections render their ghost without a second alert.
- **Acceptance:** e2e: snapshot 500 / 429 / 401 each render their own caption; the 429 notice counts down; Settings under a 503 shows exactly one Alert.

#### P1-H07 · The math drawer's scrolling body has no focusable content and is not focusable, so a keyboard user cannot scroll to the per-destination formulas (WCAG 2.1.1); the live line prints '$0.43893 per second' and a cents-level running sum two lines under 'shown in whole dollars'; 'How this number is made' explains attribution in a 90-word engineering sentence

- **Area:** Show the math drawer · **Package:** WP-H · **Impact:** 3 · **Effort:** S · **Lenses:** a11y, copy (3 findings merged)
- **Files:** `src/components/MathDrawer/MathDrawer.tsx`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/accessibility/axe-results.json (scrollable-region-focusable receipt-math 6/6); tests/report/audit/accessibility/keyboard-results.json; tests/report/audit/copy/receipt-math-text-light.txt; src/components/MathDrawer/MathDrawer.tsx:207-317,340; src/copy/en.ts:613-614,696-697,706,714-715
- **Fix:** tabIndex=0 role=region aria-label on the content root (focusable scroll container with the app ring) or move initial focus to it; liveLine 'The meter adds {perMinute} a minute ... since the sweep at {time}' with cents; drop or round the running sum; howMeasured.reconciled shortened to the three-sentence form, the long text stays in the drawer's basis.
- **Acceptance:** axe: zero scrollable-region-focusable on receipt-math; Tab from 'Close drawer' lands on the scrollable region; the live line shows two decimals at most.

#### P1-I03 · Light-theme pastel ribbons land at 1.34-1.68:1 on white; the dark-theme saved wedge background is 1.00:1 so only 36%-alpha hatch lines carry it; drift dots in dark read as perforations; hover dims every other ribbon to 0.08 while all 30 labels stay bold, inverting the hierarchy; the folded flow hover is a solid grey slab

- **Area:** Flow colour and hover · **Package:** WP-I · **Impact:** 3 · **Effort:** S · **Lenses:** view-flow, motion (5 findings merged)
- **Files:** `src/components/FlowDiagram/FlowDiagram.css`, `src/styles/palette.css`
- **Evidence:** tests/report/audit/flow-design/contrast.json; tests/report/audit/flow-design/rig-light-1440.png; tests/report/audit/flow-design/tour-zoom-mid-dark-1440.png; tests/report/audit/flow-design/tour-dark-1440.png; tests/report/audit/flow-design/tour-hover-thinnest-light-1440.png; tests/report/audit/flow-design/tour-hover-biggest-light-1440.png; tests/report/audit/motion/flow-drift-zoom-light-1440@2x.png; src/components/FlowDiagram/FlowDiagram.css --mr-band-hi, .is-dim, .mr-flow-drift; src/styles/palette.css:35,44 and --mr-dest-2..5
- **Gate:** palette.css edits via INT
- **Fix:** Light --mr-band-hi 0.9 / --mr-band-lo 0.35 and reorder the ramp so the first four are saturated (or a 1 px stroke at 0.9); wedge fill --mr-saved at 0.16-0.2 with lines at 0.7 alpha; body.dark .mr-flow-drift stroke-opacity 0.3; dim bands to 0.22, non-owner bars 0.4, non-owner labels 0.6; .is-other.is-active 0.45.
- **Acceptance:** flow.spec.ts contrast probe: every band vs panel >= 3:1 in light; the wedge fill vs panel >= 1.3:1 in dark; on hover non-active labels have opacity < 1.

#### P1-I04 · Destination captions sum only drawn flows so the same destination reads different money by viewport (Splunk Cloud $32,978 at 1440 vs $29,420 at 390); the footer says 'N flows without a price - Set prices' when everything is priced; the folded node says 18 flows while the card says 15; rig destinations are slugs ('siem-prod') beside prose sources

- **Area:** Flow captions, footer and naming · **Package:** WP-I · **Impact:** 3 · **Effort:** S · **Lenses:** view-flow, view-ledger (5 findings merged)
- **Files:** `src/components/FlowDiagram/layout.ts`, `src/components/FlowDiagram/FlowMap.tsx`, `src/components/FlowDiagram/FlowDiagram.css`, `core/humanize.ts`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/flow-design/measurements.json (labels out:*); tests/report/audit/flow-design/tour-phone-map-light-390-full.png; tests/report/audit/flow-design/rig-zoom-foot-light-1440.png; tests/report/audit/flow-design/tour-hover-biggest-light-1440.png; tests/report/audit/flow-design/rig-phone-list-light-390-full.png; tests/report/audit/design-ledger/table-light-1440.png; src/components/FlowDiagram/FlowMap.tsx:213-216; core/humanize.ts:13-15
- **Fix:** Node captions from the group's full totals; split the footer count ('n flows had no traffic today' without a link; 'n unpriced - Set prices' only when an unpriced destination has traffic); card heading '15 of the 18 smaller flows'; humanize mrd_siem_prod -> 'SIEM (prod)', 'Analytics', 'S3 archive' (the Ledger and Settings pick this up).
- **Acceptance:** flow.spec.ts: Splunk Cloud's caption is identical at 1440 and 390; the footer has no Set prices link when all destinations are priced; the rig destination labels are title-cased.

#### P1-I08 · Pitch step 6 is 'back to Flow as the ribbons narrow', but the layout tween is 200 ms, so on a 10 s poll a ribbon snaps to its new width and the saved wedge appears rather than grows; the drift animates stroke-dashoffset at 120 paints/s for an effect nobody can see

- **Area:** Flow live tween · **Package:** WP-I · **Impact:** 3 · **Effort:** S · **Lenses:** judge-wow, motion (2 findings merged)
- **Files:** `src/components/FlowDiagram/FlowDiagram.tsx`, `src/components/FlowDiagram/hooks.ts`, `src/components/FlowDiagram/FlowDiagram.css`
- **Evidence:** src/components/FlowDiagram/FlowDiagram.tsx:125 (tweenMs 200); src/components/FlowDiagram/hooks.ts:110; tests/report/audit/motion/log-flow.txt (PaintPerSec 120); tests/report/audit/motion/log-x-drift.txt; PITCH.md:15
- **Fix:** A 1.2 s ease-out tween when a live snapshot changes a flow's ratio (keep 200 ms for resize/hover) with the hatched wedge growing from the pipeline node; drift as a composited transform on the hovered/pinned path only, paused when hidden or offscreen.
- **Acceptance:** flow.spec.ts: injecting a snapshot that halves a flow's ratio produces a band-height transition lasting >= 1 s; Paint events per second on an idle Flow tab < 10.

#### P1-K02 · The Change timeline card (388 px) and the Alerts rail (543 px) end on a 155 px step at every desktop width; 'Show in table' floats detached 20 px under each rail card; the demo-profile note repeats in every card and the ' - ' joiner dangles at line ends on the phone

- **Area:** Ledger lower row · **Package:** WP-K · **Impact:** 3 · **Effort:** S · **Lenses:** view-ledger (3 findings merged)
- **Files:** `src/views/Ledger/Ledger.css`, `src/components/ChangeTimeline/ChangeTimeline.tsx`, `src/components/IncidentsRail/IncidentsRail.tsx`, `src/components/IncidentsRail/IncidentsRail.css`, `src/components/IncidentCard/IncidentCard.tsx`
- **Evidence:** tests/report/audit/design-ledger/ledger-light-1440-full.png; tests/report/audit/design-ledger/rail-light-1440.png; tests/report/audit/design-ledger/statuses-rail-light-1440.png; tests/report/audit/design-ledger/rail-dark-390.png; tests/report/audit/design-ledger/measurements.json; src/views/Ledger/Ledger.css:122-127; src/components/ChangeTimeline/ChangeTimeline.tsx:276; src/components/IncidentsRail/IncidentsRail.css:81-84; src/components/IncidentCard/IncidentCard.tsx:173
- **Gate:** IncidentCard.tsx:173 is loaned from WP-H after critique-fixes
- **Fix:** Drop align-items:start and let the chart fill the card (flex:1, height from the ResizeObserver) or cap the rail to the timeline height; move the action into the card footer or make the compact card clickable with a chevron; say the demo-profile note once in the rail header; wrapping-safe separators.
- **Acceptance:** ledger.spec.ts at 1440: timeline card height equals rail height within 8 px; no standalone 'Show in table' link outside a card.

#### P1-K04 · The timeline SVG is role=img, which makes its four focusable role=button markers presentational to assistive tech (WCAG 4.1.2); the Flow map uses role=group and is clean

- **Area:** commit markers hidden from screen readers · **Package:** WP-K · **Impact:** 3 · **Effort:** S · **Lenses:** a11y (1 finding merged)
- **Files:** `src/components/ChangeTimeline/ChangeTimeline.tsx`
- **Evidence:** tests/report/audit/accessibility/axe-results.json (nested-interactive ledger 12/12); src/components/ChangeTimeline/ChangeTimeline.tsx:487,565-585; src/components/FlowDiagram/FlowDiagram.tsx:167,180
- **Fix:** role=group with the aria-label and a <desc> keyboard hint; keep the ratio path aria-hidden.
- **Acceptance:** axe on ledger and ledger-commit-card: zero nested-interactive; the aria snapshot lists the four commit buttons by name.

#### P1-L01 · 'Break the trim' (page lever, phone bottom bar, confirm modal) is white 14 px on #e5484d at 3.91:1 in both themes; in dark the confirmation's 'This affects' item card is invisible (same colour as the modal surface) and so is the abandoned-scene list; disabled labels measure 1.91:1 on white

- **Area:** Demo console contrast · **Package:** WP-L · **Impact:** 3 · **Effort:** S · **Lenses:** view-demo (3 findings merged)
- **Files:** `src/views/Demo/DemoConsole.css`, `src/demo/demo.css`, `src/views/Demo/panels.tsx`
- **Evidence:** tests/report/audit/design-demo-console/contrast-output.txt; tests/report/audit/design-demo-console/zoom-break-btn-light-1440.png; tests/report/audit/design-demo-console/zoom-break-btn-dark-1440.png; tests/report/audit/design-demo-console/zoom-confirm-affects-dark-1440.png; tests/report/audit/design-demo-console/zoom-confirm-affects-light-1440.png; tests/report/audit/design-demo-console/zoom-abandoned-item-dark-390.png; src/views/Demo/panels.tsx:427; src/demo/demo.css:31-38,63-69
- **Fix:** A darker danger fill step (or the 18 px semibold label size); border: 1px solid var(--mr-border-subtle) on .mr-demo-confirm-item and .mr-demo-left-item; color.foreground.disabled for disabled labels.
- **Acceptance:** contrast.py over the demo console in both themes: the Break button label >= 4.5:1, the confirm item card visible against the modal, disabled labels >= 3:1.

#### P1-A07 · The stage follows the account theme: on a light Cribl account presenter mode is a white screen with a grey-green smudge behind the number (brief 5.2 'Dark by default on stage'); the pre-flight in P0-13 works around it, this makes it structural

- **Area:** dark stage regardless of account theme · **Package:** WP-A · **Impact:** 3 · **Effort:** M · **Lenses:** view-shell, view-presenter, judge-wow (3 findings merged)
- **Files:** `src/components/Shell/Shell.tsx`, `src/views/Presenter/Presenter.css`
- **Evidence:** tests/report/audit/shell/presenter-light-1920.png; tests/report/audit/shell/notes.json (presenter.light.1920.bodyDark=false); tests/report/audit/design-presenter/rest-light-1920x1080.png; tests/report/audit/design-presenter/rest-light-1440x900.png; src/theme/bridge.ts:19-22,41; src/views/Presenter/Presenter.css:149; AGENTS.md Theming
- **Gate:** Presenter.css (glow/QR ring fallback) is loaned from WP-B
- **Fix:** If AGENTS.md permits a per-view surface (it forbids a switcher, not a dark stage): add Capra's `dark` class to .mr-shell--presenter so its dark tokens apply to the subtree while portalled overlays follow body; otherwise drop the glow to 6% in light and ring the QR plate.
- **Acceptance:** presenter.spec.ts on a light body: .mr-pv background is the dark panel token and every stage text pair still measures >= 4.5:1.

#### P1-C03 · Leader lines cut through the text they point past ('the commit' through '$1,250 a day' at 1920; four receipt lines at 390) because text crossings are only soft-scored and own-box intersections are exempt; pills straddle the danger band and card edges because the avoid set holds only targets, rail and top bar

- **Area:** Story callouts · **Package:** WP-C · **Impact:** 3 · **Effort:** M · **Lenses:** view-story (2 findings merged)
- **Files:** `src/story/layout.ts`, `src/views/Story/Callouts.tsx`
- **Evidence:** tests/report/audit/story-design/shots/1920-dark-06-alert.png; tests/report/audit/story-design/shots/1920-light-06-alert.png; tests/report/audit/story-design/shots/390-light-06-alert.png; tests/report/audit/story-design/shots/390-light-03-meter.png; tests/report/audit/story-design/shots/390-light-09-receipt.png; tests/report/audit/story-design/shots/1920-dark-zoom-alert-card.png; tests/report/audit/story-design/shots/390-light-07-slack.png; tests/report/audit/story-design/shots/390-light-11-ask.png; tests/report/audit/story-design/tour.ts; src/story/layout.ts:181-186,200-233; src/views/Story/Callouts.tsx:248-259,272-284,374-379
- **Fix:** Treat a leader crossing non-own text as illegal when a non-crossing candidate exists (hard filter with fallback); an elbow leader that routes around a text line; at < 640 allow labels in the card's padding and prefer start/end positions in the row gutter; underline the receipt line instead of a leader; add card header bands and plate edges to the soft set with a high weight, or snap a placed label fully inside or outside the nearest card rect.
- **Acceptance:** story.spec.ts geometry probe at 1920 and 390: no leader segment intersects a text node other than its own target; no pill box straddles a card edge or the takeover band edge.

#### P1-E04 · After a gap longer than 24 h the minutes before the floor are never metered and nothing records the hole (a 30 h outage left 6 h missing; meta and snapshot have no gap field; Receipt figures are simply lower)

- **Area:** backfill gaps · **Package:** WP-E · **Impact:** 3 · **Effort:** M · **Lenses:** judge-sre (1 finding merged)
- **Files:** `core/sweep.ts`, `core/snapshot.ts`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/sre-day2/probes/backfill-gap.txt; core/sweep.ts:136,766-776; docs/PLATFORM_NOTES.md N1 (~2 days retained)
- **Gate:** snapshot.ts field goes through WP-F
- **Fix:** Record gaps in meta ({from,to}[]) and totals; show 'N h not metered on <date>' in the Receipt caption, Ledger and diag panel; raise MAX_BACKFILL toward the ~48 h the Leader retains, metering coarse rows without judging them.
- **Acceptance:** unit probe with a 30 h gap: meta.gaps has one entry of ~6 h (or 0 h with the raised floor) and the Receipt caption mentions it.

#### P1-E07 · One timing-out webhook endpoint costs ~40 s per incident per sweep (two incidents: 80 s, near the lock TTL; the notification budget trips and the healthy delivery slips a sweep); the failed-attempt cooldown is per incident, not per endpoint

- **Area:** dead webhook endpoint · **Package:** WP-E · **Impact:** 3 · **Effort:** M · **Lenses:** judge-sre (1 finding merged)
- **Files:** `core/sweep.ts`, `core/adapters/webhook.ts`, `core/delivery.ts`
- **Evidence:** tests/report/audit/sre-day2/probes/dead-webhook.txt; core/sweep.ts:1293-1307; core/adapters/webhook.ts:14-15
- **Fix:** Per-endpoint circuit breaker for the rest of the sweep after a timeout; deliver Cribl channels (bell, targets) before direct webhooks; one attempt per endpoint per sweep with the retry next sweep.
- **Acceptance:** unit probe with one dead endpoint and two incidents: sweep < 30 s and the healthy endpoint receives both incidents in the same sweep.

#### P1-F03 · Saved is max(0, whp - paid) and the Ledger reduction is clamped to [0,1], so a pipeline that grows bytes (enrichment, GeoIP) counts as $0 saved instead of negative and an all-positive 'Saved by Cribl' looks cherry-picked

- **Area:** byte-inflating pipelines · **Package:** WP-F · **Impact:** 3 · **Effort:** M · **Lenses:** judge-cfo (1 finding merged)
- **Files:** `core/pricing.ts`, `core/snapshot.ts`, `src/components/LedgerTable/model.ts`, `src/components/MathDrawer/MathDrawer.tsx`
- **Evidence:** tests/report/audit/cfo/probe1.txt (P1); core/pricing.ts:151,157; src/components/LedgerTable/model.ts:193; README.md:258
- **Gate:** LedgerTable/model.ts cell is loaned from WP-K and MathDrawer.tsx line from WP-H; core first
- **Fix:** Keep the clip in the headline but record addedM per flow; 'Cost added by Cribl on N flows: $X/day' in Show the math and the Ledger totals row; an 'inflating' status; let the Ledger reduction go negative.
- **Acceptance:** unit: in 1 GB / out 1.3 GB at $2.25 -> savedM 0, addedM 675 mc; the Ledger shows -30% and the totals row shows the added line.

#### P1-F05 · User-facing receipt and Slack strings live in core/receipt.ts and core/payloads.ts and have drifted from en.ts ('Open alerts: none' vs '0' vs README '1 (...)'); the duplicate en.ts receipt.weekly* keys are dead

- **Area:** receipt/Slack strings hardcoded in core · **Package:** WP-F · **Impact:** 3 · **Effort:** M · **Lenses:** copy (1 finding merged)
- **Files:** `core/receipt.ts`, `core/payloads.ts`, `core/strings.ts`, `src/copy/en.ts`, `README.md`
- **Evidence:** tests/report/audit/cfo/A-copy-receipt-mtd.txt; core/receipt.ts:139,202-208,214-217,286,328-337; core/payloads.ts:143,157-181,245,269,273; src/copy/en.ts:581-587; README.md:78
- **Gate:** core must not import src/copy (the runner and Enterprise backend build from core/ alone): add core/strings.ts and re-export it from en.ts (INT); README.md:78 is loaned from WP-N
- **Fix:** Move the literals into a core/strings.ts module (plain constants with the same keys), have en.ts re-export them so the copy file stays the single index, delete the dead receipt.weekly* keys, update the README sample.
- **Acceptance:** grep for 'Open alerts' finds one definition; the compliance/copy test proves every string rendered into a receipt or Slack payload originates from core/strings.ts; README:78 matches renderReceipt output.

#### P1-F10 · Give the committed rate the meaning a CFO expects: paid at the contract rate, would-have-paid at list, both printed in Show the math and an 'at contract rates' badge on the hero

- **Area:** Committed $/GB semantics (upgrade of P0-19) · **Package:** WP-F · **Impact:** 3 · **Effort:** M · **Lenses:** judge-cfo, view-settings (1 finding merged)
- **Files:** `core/pricing.ts`, `src/components/MathDrawer/MathDrawer.tsx`, `src/views/Receipt/HeroCard.tsx`
- **Evidence:** tests/report/audit/cfo/probe1.txt (P3); core/types.ts:58; src/components/PriceTable/model.ts:276-279
- **Gate:** MathDrawer.tsx and HeroCard.tsx lines are loaned from WP-H after the range fixer lands
- **Fix:** effectivePrices uses committedMilliCentsPerGb for paid when present; Show the math prints 'list $2.25 - your rate $1.60'; the hero badge reads 'at contract rates' once every money-carrying destination has a non-preset or committed price (CFO idea 'confidence badge').
- **Acceptance:** unit: with committed 150000 mc the paid figure uses it and whp uses the list price; the hero badge text flips between 'at preset prices' and 'at contract rates'.

#### P1-J02 · The disclosure is a box inside the card (border-top plus the Collapse's own border), 'Saved / day' lacks its unit, the dry-run paragraph prints under every basis, the 390 grid interleaves label/value/formula; the native range slider is the one un-Capra control; the basis tag and Projection chip are 10 px; the controls row leaves 400 px blank for four of five treatments

- **Area:** What-if Show the math and controls · **Package:** WP-J · **Impact:** 3 · **Effort:** M · **Lenses:** view-whatif (5 findings merged)
- **Files:** `src/components/WhatIf/WhatIf.css`, `src/components/WhatIf/WhatIfPanel.tsx`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/whatif-design/02-mathbox-light-1440.png; tests/report/audit/whatif-design/02-mathbox-dark-390.png; tests/report/audit/whatif-design/04-custom-slider-focus-light-1440.png; tests/report/audit/whatif-design/04-custom-dark-390.png; tests/report/audit/whatif-design/01-default-similar-light-1440-fold.png; tests/report/audit/whatif-design/metrics.json (basisTag fontSize 10px); src/components/WhatIf/WhatIf.css:366-389,404-409,521-530,612-615,644-652; src/components/WhatIf/WhatIfPanel.tsx:784,996; docs/platform/capra.md section 2 (no Slider)
- **Fix:** Drop the border-top and use the Receipt's tertiary 'Show the math' pattern with dot-leader mono lines; add the unit; show the dry-run note only when dryRunAvailable or basis === 'dry-run'; style the range track/thumb with Capra tokens and 0%/90% end captions (or a ToggleButtonGroup of presets plus the slider); body.sm.semibold (12 px) for the tag and chip; a 'Basis' field with the dry-run button in the free column.
- **Acceptance:** whatif.spec.ts: one horizontal rule above the math; the slider's computed track height is 4 px with a tokenised thumb; no text under 12 px in the panel.

#### P1-J03 · After 'Apply for real' (or ?applied=) the panel collapses to one grey sentence 'Projected 33%, measured 0% after 3 min': no strip, no hero, no projected vs measured $/day; the demo's payoff moment has the least design of any state

- **Area:** What-if applied state · **Package:** WP-J · **Impact:** 3 · **Effort:** M · **Lenses:** view-whatif, scout (2 findings merged)
- **Files:** `src/components/WhatIf/WhatIfPanel.tsx`, `src/components/WhatIf/WhatIf.css`, `src/components/WhatIf/useWhatIf.ts`
- **Evidence:** tests/report/audit/whatif-design/E6-applied-url-light-1440.png; tests/report/audit/whatif-design/E6-applied-url-light-390.png; tests/report/beauty/whatif-applied-light-1440.png; src/components/WhatIf/WhatIfPanel.tsx:966-976; docs/DESIGN_BRIEF.md 5.9
- **Fix:** Keep the four-cell strip with a third 'Measured' column (ratio, $/day, GB/day) filling in as sweeps arrive, 'projected 33% -> measured 34%' in metric.lg with the elapsed clock, and the hero showing the now-real annualized figure; W-06 turns the same moment into a green takeover.
- **Acceptance:** whatif.spec.ts with ?applied= and two later snapshots: the Measured column populates and the metric line reads the measured ratio.

#### P1-N01 · Try literal segments for the relay grants (drop :gid/:id) at the next deploy so the write grants cannot schedule arbitrary searches or attach notifications to other saved searches; decide the GET /notification-targets grant (it returns every target's full configuration to any shared member; the typed-id path already works)

- **Area:** policy tightening and the targets grant · **Package:** WP-N · **Impact:** 3 · **Effort:** M · **Lenses:** judge-security, judge-cribl-pm (2 findings merged)
- **Files:** `config/policies.yml`, `README.md`, `docs/NOTIFICATIONS.md`, `src/views/Settings/NotificationsSection.tsx`
- **Evidence:** config/policies.yml:35-48; docs/platform/config-apis.md:527-541; tests/report/audit/pm-cribl/evidence-c.json (D6: typed id works); README.md:117,449
- **Gate:** needs a deploy to verify (Phase B live check); the NotificationsSection.tsx 'Load targets' change is loaned from WP-G2
- **Fix:** '/m/default_search/search/saved' and '/m/default_search/search/saved/meter_reader_alert_relay/notifications' as literal objects; if the Leader rejects literals the fix is disclosure-only (P0-22); drop the targets grant from the release policies, make 'Load targets' admin-only or a link to Cribl's Notification targets page.
- **Acceptance:** After the deploy, LIVE_VALIDATION records whether the literal grants were accepted and the bell test as a member still passes; the README grant table matches config/policies.yml.

#### P1-N04 · The video's Slack card is the runner's direct-webhook Block Kit rendering; Slack, PagerDuty, email and SNS targets were never exercised (README admits it); the 1.0.0 release tgz with the notification grants has never been installed as the release package in a clean workspace and the member path is unproven

- **Area:** live proof of the delivery channels and the install path · **Package:** WP-N · **Impact:** 3 · **Effort:** M · **Lenses:** truth (2 findings merged)
- **Files:** `docs/LIVE_VALIDATION.md`, `docs/NOTIFICATIONS.md`, `README.md`, `docs/evidence/`
- **Evidence:** README.md:63,165,118,446-448; VIDEO_SCRIPT.md:50; demo/sample/tour.json settings.notifications[0]; docs/LIVE_VALIDATION.md:10; docs/NOTIFICATIONS.md:18; tests/report/audit/truthfulness/NOTES.md
- **Gate:** ops on the org (an admin creates one Slack target); not code
- **Fix:** Create one Slack notification target in the demo org, Connect it, send a test alert, screenshot Slack, add the row; install the current 1.0.0 tgz in a clean workspace as a non-admin member, screenshot the Review App screen, run the bell test; then caption the video beat or hedge the hero accordingly.
- **Acceptance:** LIVE_VALIDATION has a Slack-target row and a member-install row with screenshots under docs/evidence/; README's 'not exercised' sentence is updated to what was measured.

#### P1-O01 · The in-browser emulator (dev server and every Playwright e2e) does not emulate the four notification writes, /notification-targets, the preview API or sample content: the bell test 404s in dev, the target list 404s, the dry run reports 'No dry run', and no e2e exercises Connect or a channel test; the delivery log is never written when the bell is unavailable so an open incident shows no delivery line

- **Area:** emulator coverage of the Cribl-native integrations · **Package:** WP-O · **Impact:** 3 · **Effort:** M · **Lenses:** judge-cribl-pm (2 findings merged)
- **Files:** `src/mock/emulator.ts`, `src/mock/fixtures.ts`, `tests/e2e/notifications.spec.ts`, `core/delivery.ts`, `src/copy/en.ts`
- **Evidence:** src/mock/emulator.ts:470-500; tests/e2e/demo.spec.ts:183; tests/report/audit/pm-cribl/evidence-b.json (C7, C5b, C13, C13b); tests/report/audit/pm-cribl/tour-ledger-alert-light-1440.png; core/delivery.ts:213-216
- **Gate:** core/delivery.ts DeliveryLog change via WP-E
- **Fix:** Routes for the bell (201, 409 on a repeated id, PATCH 405), /notification-targets (fixture targets), the relay saved-search/notification endpoints (accepting only SEARCH_NOTIFICATION_ ids), /preview (pipe mode) and Datagen sample content; e2e specs for bell test, Load targets -> Connect confirmation -> test send, and the dry-run basis; one DeliveryLog per pass for the implicit bell with a reason rendered as 'Not delivered - Cribl notification API unavailable (404)'.
- **Acceptance:** tests/e2e/notifications.spec.ts passes on chromium; an incident in the emulator with the bell route disabled shows the 'Not delivered' line on its card and in the rail.

#### P1-A05 · Shell nits: Escape does nothing in presenter/diag; the diag panel remounts (and closes) on P/Y; '/' on a view without search does nothing silently; no skip link; closing the shortcut sheet drops focus to body; no elevation on the sticky tab bar; the chrome is edge-anchored while the content column is centred (first tab 56-296 px left of the hero); the rate-limited caption repeats its label

- **Area:** shell polish bundle · **Package:** WP-A · **Impact:** 2 · **Effort:** S · **Lenses:** view-shell (8 findings merged)
- **Files:** `src/components/Shell/Shell.tsx`, `src/components/Shell/Shell.css`, `src/components/Shell/useShellEffects.ts`, `src/components/common/ShortcutSheet.tsx`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/shell/notes2.json (escape.exitsPresenter=false, diag.survivesEnterPresenter=0); tests/report/audit/shell/notes.json (sheet.focusAfter, keys.1440.slashNoSearch, m.1440.tabs, skipLink 0); tests/report/audit/shell/header-scrolled-light-1440.png; tests/report/audit/shell/header-light-1440.png; tests/report/audit/shell/receipt-light-1920.png; tests/report/audit/shell/footer-dark-1920.png; tests/report/audit/shell/status-ratelimited-light-1440.png; src/components/Shell/Shell.tsx:42-92; src/components/Shell/Shell.css:16-31,155-165; src/components/common/ShortcutSheet.tsx:33-52; src/copy/en.ts:401
- **Fix:** Render overlays once as a sibling of the branch; Escape registered via P0-05; '/' without a field navigates to /ledger and focuses search; a visually-hidden skip link to #main; restore focus on sheet close; data-scrolled shadow; an inner max-width 1280 container for .mr-topnav and .mr-footer; caption 'checking every 60 s until 3:11 PM'.
- **Acceptance:** e2e: Shift+D then P then P leaves the diag panel open; Tab from page start reaches 'Skip to content' first; the first tab's left edge equals the hero card's left edge at 1440 and 1920.

#### P1-B05 · Every rAF frame writes an inline transform on all 8 wheel strips and dataset.valueM even when only the cents wheels moved (~57 style recalcs/s idle; 53 ms script/s, a 59 ms long task and an 83 ms frame while scrolling at 4x phone CPU); the hero keeps ticking after it scrolls out of view

- **Area:** Receipt Meter frame cost on a phone · **Package:** WP-B · **Impact:** 2 · **Effort:** S · **Lenses:** motion (1 finding merged)
- **Files:** `src/components/Meter/Meter.tsx`, `src/components/Meter/meterMath.ts`
- **Evidence:** tests/report/audit/motion/notes.json (phone.idle.4x, phone.scroll.4x); tests/report/audit/motion/trace-receipt-390-4x.json; src/components/Meter/Meter.tsx:165-176
- **Fix:** Write a strip's transform only when its wheel position changed (cache per place); update dataset.valueM at ~4 Hz; stop the loop while the figure is offscreen (IntersectionObserver).
- **Acceptance:** motion probe at 4x CPU on 390: style recalcs/s < 15 while idle; no long task > 50 ms during a scroll; the loop pauses when the hero is scrolled out.

#### P1-C05 · Progress bar is 31-34 px off-centre with 1.05:1 upcoming segments and no within-beat progress under reduced motion; the hero glow leaks above the receipt card and the panel lacks the perforated edge; card edges move 32 px between the meter and change beats; the summary block sits left in a centred container; the ask beat says 'Meter Reader' three times and carries no number; the How strip is CSS-zoomed with uneven wraps; the inline alert card is left-heavy; hard cut to an empty stage between beats; two rAF loops in the meter beat and a width-animated reveal

- **Area:** Story polish bundle · **Package:** WP-C · **Impact:** 2 · **Effort:** S · **Lenses:** view-story, motion (10 findings merged)
- **Files:** `src/views/Story/Story.css`, `src/views/Story/index.tsx`, `src/views/Story/stages.tsx`, `src/views/Story/Callouts.tsx`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/story-design/shots/1440-light-zoom-topbar.png; tests/report/audit/story-design/shots/1440-dark-zoom-topbar.png; tests/report/audit/story-design/shots/1440-light-03-meter.png; tests/report/audit/story-design/shots/1440-light-04-change.png; tests/report/audit/story-design/shots/1440-light-10-summary.png; tests/report/audit/story-design/shots/1920-dark-11-ask.png; tests/report/audit/story-design/shots/1440-light-02-how.png; tests/report/audit/story-design/shots/1440-light-06-alert.png; tests/report/audit/story-design/measurements.json; tests/report/audit/story-design/colors.ts; tests/report/audit/motion/frames/story-alert-beat-1920-021-00360ms.jpg; tests/report/audit/motion/log-story.txt; src/views/Story/Story.css:45-84,110-137,161-169,218-247,263-278,388,451-457; src/views/Story/index.tsx:46-59; src/views/Story/Callouts.tsx:163-168; src/views/Story/stages.tsx:265-295
- **Fix:** Grid '1fr auto 1fr' top bar with 4-5 px segments on border.default and stepped fill under reduced motion; overflow hidden on the receipt panel plus the HeroFrame perforation mask; one panel width for both card beats; width fit-content on the summary; the payoff figure instead of the 64 px name on the ask beat; clamp() type scale on the strip with text-wrap balance; cap the inline card at 1120 px; a two-slot stage that crossfades scenes; measure callouts from a ResizeObserver + 250 ms interval and reveal the ratio line with clip-path.
- **Acceptance:** story.spec.ts: the progress bar centre is within 4 px of the viewport centre at 1440/1920/390; consecutive card beats share left edges; rAF per second during the meter beat < 70.

#### P1-D03 · The 'who meters' line lies: 'Metered by another open tab' after a reload of the only tab; both open tabs claim 'this tab' (skipped:'current' counts as swept); a runner silent for 20 min still reads 'Metered every minute by the runner on workhorse'; a Stale status has no explanation on the hero

- **Area:** who meters / stale truthfulness · **Package:** WP-D · **Impact:** 2 · **Effort:** S · **Lenses:** judge-cribl-pm, states (4 findings merged)
- **Files:** `src/state/selectors.ts`, `src/components/Shell/Footer.tsx`, `src/components/Shell/status.ts`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/pm-cribl/evidence-c.json (runtime 'Metered by another open tab'); tests/report/audit/degraded-states/two-tabs-tab1-light-1440.png; tests/report/audit/degraded-states/two-tabs-tab2-light-1440.png; tests/report/audit/degraded-states/runner-silent-viewer-runtime-light-1440.png; tests/report/audit/degraded-states/stale2d-receipt-light-1440.png; tests/report/audit/degraded-states/s3-live.notes.json; tests/report/audit/degraded-states/s6-more.notes.json; src/state/selectors.ts:115-140; src/components/Shell/Footer.tsx:26
- **Fix:** Treat a ui owner whose lock this tab now holds as 'this tab' until its first sweep; only a lastResult without `skipped` counts; meteredBy returns 'silent' with the owner when the last sweep is older than STALE_AFTER_MS ('The runner on workhorse stopped sweeping 20 min ago'); a stale line under the hero.
- **Acceptance:** unit tests on selectors: single-tab reload -> 'this tab'; two tabs -> exactly one says 'this tab'; runner older than STALE_AFTER_MS -> the silent line; e2e stale fixture shows the hero caveat.

#### P1-E08 · The hourly expiry pass costs 2 lists + 2 calls per deleted key (del pre-reads for a chunk manifest) and repeats every sweep when the backlog exceeds `room`; a budget-deferred timeline costs 3 calls every sweep until written

- **Area:** expiry and timeline refresh cost · **Package:** WP-E · **Impact:** 2 · **Effort:** S · **Lenses:** api-budget (1 finding merged)
- **Files:** `core/kv.ts`, `core/sweep.ts`
- **Evidence:** tests/report/audit/api-budget/receipt-default-1440.json; tests/report/audit/api-budget/warm-ratelimit-50-presenter-30d.json; core/kv.ts:863-872; core/sweep.ts:805-831,1358-1367
- **Fix:** Skip the pre-read for key families this process stored plain (knownChunks) and keep it for unknown keys; stamp lastExpiredAt after every pass with a cursor; write the timeline in the sweep that fetched it even when the budget deferred the rest.
- **Acceptance:** unit: an expiry pass over 10 plain keys makes 2 lists + 10 DELETEs; a deferred timeline is written in the same sweep.

#### P1-F12 · 'Net after Cribl - Paid for itself' shows for MTD and Annualized only; Today and 30 days return null so the line disappears and the hero shrinks 20 px on every toggle (the page below jumps)

- **Area:** Net after Cribl on Today / 30 days · **Package:** WP-H · **Impact:** 2 · **Effort:** S · **Lenses:** judge-cfo, view-receipt, motion (3 findings merged)
- **Files:** `src/views/Receipt/model.ts`
- **Evidence:** tests/report/audit/cfo/drive-log.txt; tests/report/audit/design-receipt/measure.json (period:today hero.h 378.5 vs mtd 398.5); tests/report/audit/design-receipt/shots/hero-today-light-1440.png; tests/report/audit/design-receipt/shots/hero-mtd-light-1440.png; tests/report/audit/motion/log-controls.txt; src/views/Receipt/model.ts:127-142
- **Fix:** Prorate the monthly cost to the period (cost / days in month x 1 or x 30) labelled 'cost prorated', or reserve the line with an em-dash placeholder so the card height is stable.
- **Acceptance:** e2e: toggling MTD -> Today -> 30 days keeps .mr-hero height constant and shows a Net line on every period when criblCost is set.

#### P1-G03 · Prices nits: numeric error copy wraps 4 lines under a 104 px field; 'Devnull' capitalised beside lowercase siblings; popover sources shown as raw hosts ('assets.ctfassets.net', a 60-char gov.uk host); meta line truncates the group at 1440; 24x24 info button; 'unpriced' pill 4.41:1 on a hovered row; dark budget track invisible at 0%; Cost card preview capped at 440 px leaving 320 px empty; 'Runtime' three times; the last stat alone on the phone grid

- **Area:** Settings polish bundle (Prices) · **Package:** WP-G1 · **Impact:** 2 · **Effort:** S · **Lenses:** view-settings, judge-devrel (11 findings merged)
- **Files:** `src/components/PriceTable/PriceTable.css`, `src/components/PriceTable/PresetInfoButton.tsx`, `src/components/PriceTable/PriceTable.tsx`, `core/humanize.ts`, `core/presets.ts`, `src/views/Settings/Settings.css`, `src/views/Settings/RuntimeSection.tsx`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/design-settings/crop-prices-row-error-light.png; tests/report/audit/design-settings/crop-alerts-error-light.png; tests/report/audit/design-settings/prices-fresh-light-1440.png; tests/report/audit/design-settings/prices-cf-open-light-1440.png; tests/report/audit/design-settings/prices-info-light-1440.png; tests/report/audit/design-settings/phone-info-light-390.png; tests/report/audit/design-settings/sample-prices-light-1440.png; tests/report/audit/design-settings/run-a.log; tests/report/audit/design-settings/crop-budgets-dark.png; tests/report/audit/design-settings/cost-light-1440.png; tests/report/audit/design-settings/runtime-light-390.png; tests/report/audit/devadvocate/03b-preset-info-1440-dark.png; src/components/PriceTable/PresetInfoButton.tsx:18-25,68; core/humanize.ts:54-74; src/views/Settings/Settings.css:344,437-441,585
- **Gate:** core/humanize.ts is owned by WP-I (the Devnull/slug casing change goes through that owner); Settings.css and RuntimeSection.tsx lines are loaned from WP-G2
- **Fix:** Short inline copy for numeric fields ('Enter a number >= 0'); capitalise every humanized name or none; a `publisher` per source ('Cribl pricing FAQ') as the link text; 'type - group' meta with the id only when it differs; size='md' info button with a 44 px hit area; solid warning pill or lighter hover; a visible track token; let the cost preview grow; label the runtime value 'Metering runs in'; last stat spans both columns at <= 640.
- **Acceptance:** settings.spec.ts contrast walker reports zero hits < 4.5:1 across hovered rows; the info popover lists publisher names, not hosts; numeric errors fit on <= 2 lines at 1440.

#### P1-G04 · hostFromUrl accepts userinfo, so 'https://svc:P4ssw0rd@relay.example.com/hook' validates, is stored in KV in full and masked in the UI, contradicting README:414

- **Area:** webhook URL userinfo · **Package:** WP-G1 · **Impact:** 2 · **Effort:** S · **Lenses:** judge-security (1 finding merged)
- **Files:** `core/settings.ts`, `core/adapters/webhook.ts`, `tests/unit/settings.test.ts`
- **Evidence:** core/settings.ts:476; core/adapters/webhook.ts:58; README.md:414; tests/report/audit/security/evidence.json
- **Gate:** core/adapters/webhook.ts deliver() guard is loaned from WP-E
- **Fix:** Reject URLs containing '@' before the first '/' in validateSettings ('Put credentials in a Cribl notification target, not in the URL') and in webhook.ts deliver(); unit test.
- **Acceptance:** unit: validateSettings rejects a userinfo URL with the named message; deliver() refuses it.

#### P1-G08 · Colour is still spent on status: green 'priced'/'no setup' pills, green test alerts, blue 'via Cribl', red tertiary 'Remove'; the Slack preview breaks mid-word at 390 ('mrd_pay_sam / ple')

- **Area:** status colour and preview wrap (F10/F19 residue) · **Package:** WP-G2 · **Impact:** 2 · **Effort:** S · **Lenses:** view-settings (2 findings merged)
- **Files:** `src/components/PriceTable/PriceTable.tsx`, `src/components/EndpointEditor/BellRow.tsx`, `src/components/EndpointEditor/EndpointEditor.tsx`, `src/views/Settings/Settings.css`, `src/components/SlackPreview/SlackPreview.css`
- **Evidence:** tests/report/audit/design-settings/prices-priced-light-1440.png; tests/report/audit/design-settings/crop-notify-bell-light.png; tests/report/audit/design-settings/crop-notify-tested-light.png; tests/report/audit/design-settings/crop-notify-weekly-result-light.png; tests/report/audit/design-settings/notify-tested-light-390.png; docs/review/SCORES-3a.md F10, F19; src/components/SlackPreview/SlackPreview.css:89,101
- **Gate:** PriceTable.tsx pill lines loaned from WP-G1
- **Fix:** Neutral outline pills with a check glyph; test results as neutral inline text with incident colour on failure only; neutral tertiary Remove (danger only in the confirm dialog); overflow-wrap: break-word; word-break: normal on preview values.
- **Acceptance:** settings.spec.ts: no success-green element outside money figures on any Settings section; the preview commit line at 390 does not split a word.

#### P1-G09 · 'Send a test alert' is enabled before Connect and answers with a red 'Connect this target first'; the weekly-receipt hint says 'Mondays, 12:00 UTC' (a schedule the tab does not keep); 'Last test 200' reads as a number; 'Send this week's receipt' with only the bell reports 'none of the 0 endpoints accepted it'; 'Good news' spans both columns for one switch; $5/day floor, recovery minutes, warm-up and excluded objects have no field

- **Area:** Settings notify nits · **Package:** WP-G2 · **Impact:** 2 · **Effort:** S · **Lenses:** view-settings, copy, judge-cribl-pm, judge-sre (6 findings merged)
- **Files:** `src/components/EndpointEditor/EndpointEditor.tsx`, `src/views/Settings/weekly.ts`, `src/views/Settings/AlertsSection.tsx`, `src/views/Settings/Settings.css`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/design-settings/crop-notify-target-tested-light.png; tests/report/audit/copy/settings-notify-text-tour-light.txt; tests/report/audit/pm-cribl/evidence-b.json (step C8b); tests/report/audit/design-settings/alerts-light-1920.png; tests/report/audit/sre-day2/probes/settings-shots.txt; src/components/EndpointEditor/EndpointEditor.tsx:457; src/views/Settings/weekly.ts:52-61; src/views/Settings/AlertsSection.tsx:18-29; core/settings.ts:11-26; src/copy/en.ts:1309,1319,1409; README.md:55
- **Fix:** Disable the test button with 'Connect first' while relay.status === 'missing'; weeklyHint 'After Monday 12:00 UTC' under the ui runtime; lastTestOk/lastTestFailed pair; count the bell as an endpoint in the weekly outcome; Good news beside Baseline; four new Alerts fields (floor $/day, recovery minutes, warm-up minutes, excluded objects as chips).
- **Acceptance:** settings.spec.ts: the test button is disabled on an unconnected target; sending the weekly receipt with the bell on reports the bell's line; Alerts shows the four new fields wired to thresholds.

#### P1-H04 · Row stretch leaves 50-250 px voids (savers list ends at y=761 with the footer at 858; four open alerts stretch Where the money goes by 250 px; the empty Alerts card is 399 px for 60 px of content); compact incident titles wrap beside a centred timestamp; two 'Show the math' affordances in two styles when the How panel is open; the How toggle is 12 px with a 20 px hit box

- **Area:** Receipt card voids and titles · **Package:** WP-H · **Impact:** 2 · **Effort:** S · **Lenses:** view-receipt (4 findings merged)
- **Files:** `src/views/Receipt/Receipt.css`, `src/views/Receipt/Sections.tsx`, `src/components/IncidentCard/IncidentCard.css`, `src/views/Receipt/HeroCard.tsx`, `src/components/ReceiptList/ReceiptList.tsx`
- **Evidence:** tests/report/audit/design-receipt/shots/zoom-savers-dark.png; tests/report/audit/design-receipt/shots/stress-dark-1440.png; tests/report/audit/design-receipt/shots/receipt-noalerts-dark-1440.png; tests/report/audit/design-receipt/shots/zoom-inc-dark.png; tests/report/audit/design-receipt/shots/how-open-dark-1440.png; tests/report/audit/design-receipt/shots/zoom-how-light.png; tests/report/audit/design-receipt/measure.json; docs/review/SCORES-3a.md line 233
- **Gate:** after the range fixer; IncidentCard.css after critique-fixes
- **Fix:** A total line under the dotted rule ('Top five ......... $7,821 / day' + 'N other flows ..... $X / day') using .mr-rlist-item--total; the empty Alerts card shows 'last alert closed 3 d ago - 12 caught this month'; kind as a 12 px eyebrow with the timestamp and the object as the one-line title; drop the in-panel math link; body.md + 32 px min-height on the How toggle.
- **Acceptance:** e2e at 1440 on the tour: the savers card has no empty band > 40 px above its footer; exactly one Show the math control is visible with the How panel open.

#### P1-H05 · The unpriced hatch is invisible in dark (1.00:1 background); the row's right figure has no 'paid' word; a tiny paid share renders as a 2 px nub; the paid/saved segments sit edge to edge at 1.05:1 (light) so the bar reads as one segment under deuteranopia or a washed-out projector, and both bars vanish under forced-colors; the whp bracket is a 1 px hairline with no ticks

- **Area:** Where the money goes and receipt bar · **Package:** WP-H · **Impact:** 2 · **Effort:** S · **Lenses:** view-receipt, a11y (7 findings merged)
- **Files:** `src/components/WhereMoneyGoes/WhereMoneyGoes.css`, `src/components/WhereMoneyGoes/WhereMoneyGoes.tsx`, `src/components/ReceiptBar/ReceiptBar.css`, `src/components/ReceiptBar/ReceiptBar.tsx`
- **Evidence:** tests/report/audit/design-receipt/shots/zoom390-wmg-dark.png; tests/report/audit/design-receipt/shots/zoom-dests-light.png; tests/report/audit/design-receipt/shots/zoom-wmg-row-dark.png; tests/report/audit/design-receipt/shots/zoom-wmg-chip-dark.png; tests/report/audit/design-receipt/shots/zoom-bar-dark.png; tests/report/audit/design-receipt/measure.json (wmgTrack bg, rbarBracket); tests/report/audit/accessibility/contrast-results.json; tests/report/audit/accessibility/probe2-results.json (forcedColors); tests/report/audit/accessibility/shots/forced-colors-receipt.png; src/components/WhereMoneyGoes/WhereMoneyGoes.css:78-82; src/components/ReceiptBar/ReceiptBar.css:28,42-47
- **Fix:** Hatch with --mr-hatch-whp at 45deg in both themes; 'paid $2,550 / day' in the head slot; hide the paid segment under 4 px; a 2 px card-colour gap between segments and a hatch on saved; @media (forced-colors: active) { forced-color-adjust: none; border: 1px solid CanvasText }; 6 px end ticks and 8 px height on the bracket with its label centred.
- **Acceptance:** e2e dark theme: the unpriced track's computed background differs from the card; forced-colors emulation still shows two segments; the walker finds no adjacent-segment pair under 1.3:1 without a gap.

#### P1-H06 · The learning-state text plate is opaque over the dashed ghost curve and gridlines, leaving disconnected stubs (a 30 px stub at 390); the chart's accessible name counts collected days while the heading says 30 days

- **Area:** trend chart learning state and axis · **Package:** WP-H · **Impact:** 2 · **Effort:** S · **Lenses:** view-receipt, view-firstrun, a11y (3 findings merged)
- **Files:** `src/components/TrendChart/TrendChart.css`, `src/components/TrendChart/TrendChart.tsx`
- **Evidence:** tests/report/audit/design-receipt/shots/learn-1-dark-1440.png; tests/report/audit/design-receipt/shots/learn-1-light-390.png; tests/report/audit/design-first-run/shots/network-lost-receipt-light-1440.png; tests/report/audit/accessibility/aria/receipt-light-1440.yml; src/components/TrendChart/TrendChart.css:177-186; src/components/TrendChart/TrendChart.tsx:111-129,143-145
- **Fix:** Transparent plate with a radial mask under the text (or the sentence below the axis); name the chart 'Saved per day, last 30 days - 7 days collected'.
- **Acceptance:** e2e learning fixture: the ghost path is one continuous dashed line (no gap where the plate sits); aria snapshot shows the window-based name.

#### P1-H09 · Switching periods cuts the hero figure in one frame (the Meter is keyed by period and remounts) while the bar eases; 'How this number is made' pops a 212 px panel with no reveal; the Custom popover opens bottom-left over the hero number while the right half is empty

- **Area:** period toggle and How panel motion · **Package:** WP-H · **Impact:** 2 · **Effort:** S · **Lenses:** motion, view-receipt (3 findings merged)
- **Files:** `src/views/Receipt/HeroCard.tsx`, `src/views/Receipt/Receipt.css`, `src/views/Receipt/RangePicker.tsx`
- **Evidence:** tests/report/audit/motion/log-controls.txt; tests/report/audit/motion/sheet-period-today-1440.png; tests/report/audit/motion/sheet-how-open-1440.png; tests/report/audit/design-receipt/shots/range-picker-dark-1440.png; tests/report/audit/design-receipt/shots/range-picker-light-390.png; src/views/Receipt/Receipt.css:301-310; src/views/Receipt/RangePicker.tsx Popover placement=bottomLeft
- **Gate:** hand to the range fixer (HeroCard.tsx, RangePicker.tsx, Receipt.css are theirs); not in _known/range-findings.json
- **Fix:** Keep the Meter mounted across periods and beginMotion from the previous figure with a 150 ms label crossfade; grid-template-rows 0fr -> 1fr + opacity over --mr-duration-ribbon on the How panel; anchor the popover bottomRight under the toggle's right end (full width below the toggle at 390).
- **Acceptance:** e2e: toggling MTD -> Today shows a running digit roll (data-value changes over >= 3 frames); the popover box does not intersect the meter figure at 1440.

#### P1-I05 · On the 390 list a tap pins the row on a receipt card that sits off-screen and nothing scrolls; truncated SVG labels rely on <title> which touch cannot show; the legend wraps into five caption lines; ribbons are not keyboard focusable so a keyboard user can never read one flow's receipt

- **Area:** Flow phone interactions · **Package:** WP-I · **Impact:** 2 · **Effort:** S · **Lenses:** view-flow (4 findings merged)
- **Files:** `src/components/FlowDiagram/FlowMap.tsx`, `src/components/FlowDiagram/FlowDiagram.tsx`, `src/components/FlowDiagram/FlowDiagram.css`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/flow-design/rig-phone-list-selected-light-390-full.png; tests/report/audit/flow-design/measurements.json (truncatedLabels); tests/report/audit/flow-design/tour-phone-list-dark-390-full.png; tests/report/audit/flow-design/rig-focus-node-light-1440.png; src/components/FlowDiagram/FlowMap.tsx:170; src/components/FlowDiagram/FlowDiagram.tsx:283-292,316,443
- **Fix:** Expand receipt lines inline under the selected row at <= 640 (or scrollIntoView + border flash); allow three label lines on compact layouts with aria-label = full text; phone legend 'Sent (paler = cheaper)' with flex-start alignment; tabIndex on ribbons after nodes (or Left/Right on a node cycles its flows).
- **Acceptance:** flow.spec.ts at 390: tapping a list row brings the receipt into the viewport; Tab reaches a ribbon and the card follows; the legend renders on <= 3 lines.

#### P1-J04 · Hero caption phrases run together with no spaces in the DOM; the unpriced state reuses the Flow copy 'on this map' and the loading skeleton is the Flow map shape; three button styles for dry run and the no-sample reason leaks 'only Datagen Sources carry one'; accent blue spent four ways; no reduced-motion crossfade and no strip animation; the projection ribbon double-tweens over 200 ms and the card pops

- **Area:** What-if nits · **Package:** WP-J · **Impact:** 2 · **Effort:** S · **Lenses:** view-whatif, motion (7 findings merged)
- **Files:** `src/components/WhatIf/WhatIfPanel.tsx`, `src/components/WhatIf/WhatIf.css`, `src/components/FlowDiagram/hooks.ts`, `src/views/Flow/FlowScreen.tsx`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/whatif-design/metrics.json (heroCaption.text run-on); tests/report/audit/whatif-design/E1-unpriced-light-1440.png; tests/report/audit/whatif-design/E3-loading-light-1440.png; tests/report/audit/whatif-design/07-dryrun-unavailable-light-1440.png; tests/report/audit/whatif-design/E5-dryrun-measured-light-1440.png; tests/report/audit/whatif-design/V1-morph-no-preference-0.5s.png; tests/report/audit/motion/sheet-flow-whatif-1440.png; src/components/WhatIf/WhatIfPanel.tsx:815-822,870-874; src/components/FlowDiagram/hooks.ts:92-96,102; src/views/Flow/FlowScreen.tsx:69-76
- **Gate:** hooks.ts and FlowScreen.tsx lines loaned from WP-I
- **Fix:** Join caption phrases with ' - '; whatif.empty copy and a WhatIfSkeleton; one secondary dry-run button with an inline Alert for the outcome and a platform-owner wording; neutral link styles; batch the projection into one 400 ms morph and crossfade under reduced motion; roll the strip digits over the same 400 ms.
- **Acceptance:** whatif.spec.ts: the caption's textContent contains spaces between phrases; the loading state renders a WhatIfSkeleton; a projection produces one band-height transition of ~400 ms with no overshoot.

#### P1-K05 · The muted chip truncates exactly at its countdown ('muted after a ...') and is the only lower-case chip; the sort caret floats between the two header lines; three 'Clear filters' controls in three styles for one state; '- / day' on unpriced cards; a raw pipe key in the deep-link notice and raw ids appended as filter options for vanished or bogus ?dest/?group values; sticky totals slice the row beneath; pipeline links have no at-rest affordance; text-spacing overrides clip leading digits

- **Area:** Ledger table nits · **Package:** WP-K · **Impact:** 2 · **Effort:** S · **Lenses:** view-ledger, states, a11y (10 findings merged)
- **Files:** `src/components/LedgerTable/status.ts`, `src/components/LedgerTable/LedgerTable.css`, `src/components/LedgerTable/LedgerTable.tsx`, `src/components/LedgerTable/model.ts`, `src/views/Ledger/index.tsx`, `src/views/Ledger/Toolbar.tsx`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/design-ledger/statuses-table-light-1440.png; tests/report/audit/design-ledger/statuses-table-dark-390.png; tests/report/audit/design-ledger/table-head-zoom-light-1440.png; tests/report/audit/design-ledger/deeplink-hidden-light-1440.png; tests/report/audit/design-ledger/scale-scrolled-light-1440.png; tests/report/audit/design-ledger/link-hover-light-1440.png; tests/report/audit/degraded-states/destgone-after-ledger-destmenu-light-1440.png; tests/report/audit/degraded-states/ledger-params-bogus-light-1440.png; tests/report/audit/accessibility/shots/textspacing-ledger-light.png; tests/report/audit/accessibility/probe2-results.json (textSpacing.ledger); src/components/LedgerTable/status.ts:19-21; src/components/LedgerTable/LedgerTable.css:128-133,195-201,225-260,281-286; src/components/LedgerTable/model.ts:397-411,422-449; src/views/Ledger/index.tsx:216-226,258
- **Fix:** Chip 'Muted - 6 min' with the sentence as a title; anchor the caret to the label line and bottom-align headers; one recovery action; omit the suffix on null Money; humanize the pipe key's pipeline segment; show unknown URL values as 'x (not in the latest sweep)' never as a normal option; a 12 px top gradient above the totals; the external-link icon at 0.6 opacity at rest; ch-based min widths with visible overflow for numeric cells.
- **Acceptance:** ledger.spec.ts: the muted chip text is fully visible at 1440 and 390; ?dest=nope renders a notice and no 'nope' option; with WCAG text-spacing applied no numeric cell clips.

#### P1-K06 · The loading skeleton renders only the flows card so the page jumps in height; under 503/401/429 with no data the Ledger renders the error alert AND the first-run ghosts ('No flows yet - after its first sweep prices them')

- **Area:** Ledger skeleton and error states · **Package:** WP-K · **Impact:** 2 · **Effort:** S · **Lenses:** view-ledger, states, view-firstrun (3 findings merged)
- **Files:** `src/views/Ledger/index.tsx`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/degraded-states/all5xx-ledger-light-1440.png; tests/report/audit/degraded-states/401-ledger-light-1440.png; tests/report/audit/degraded-states/s1b-errors.notes.json; tests/report/audit/design-first-run/shots/kv-snapshot-403-ledger-viewport-light-1440.png; src/views/Ledger/index.tsx:52-66,229-235,294-296
- **Fix:** Add the lower grid (2fr/1fr skeleton cards) to LedgerSkeleton; when errors.snapshot is set with no snapshot render the table ghost with the error alert only and error-flavoured empty copy.
- **Acceptance:** ledger.spec.ts: the skeleton's height is within 10% of the loaded page; under a snapshot 503 the page shows one alert and no 'No flows yet' copy.

#### P1-L03 · Status-line icon floats mid-gap on phones; the title jitters when the status card grows; the hero countdown collapses to 16 px at zero; 'Trim broken 0:00 ago'; 'Payments API' x3 and 'Palo Alto ... Palo Alto'; the danger confirm shows an amber info icon; number keys beside titles vs letter keys inside buttons; the pinned status card costs 9% of the phone viewport at idle; 'Abort and restore' spans 700 px on desktop; the left-scene detail mixes three punctuation styles; twelve dead copy keys

- **Area:** Demo console polish bundle · **Package:** WP-L · **Impact:** 2 · **Effort:** S · **Lenses:** view-demo (13 findings merged)
- **Files:** `src/views/Demo/DemoConsole.css`, `src/views/Demo/StatusBar.tsx`, `src/views/Demo/panels.tsx`, `src/demo/actions.tsx`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/design-demo-console/zoom-status-ready-ring-light-390.png; tests/report/audit/design-demo-console/zoom-status-retry-light-390.png; tests/report/audit/design-demo-console/zoom-titlerow-idle-light-1440.png; tests/report/audit/design-demo-console/zoom-titlerow-retry-light-1440.png; tests/report/audit/design-demo-console/zoom-next-alert-light-390.png; tests/report/beauty/demo-confirm-dark-390.png; tests/report/beauty/demo-incident-light-390.png; tests/report/beauty/demo-scene-light-1440.png; tests/report/beauty/demo-left-light-390.png; src/views/Demo/StatusBar.tsx:66-118; src/views/Demo/panels.tsx:98-106,206-216,389-416,444-456,498-501; src/copy/en.ts:27-47,284-287 (dead demo.* keys)
- **Fix:** align-items: flex-start with a fixed 16 px icon slot; align-self: start on the page head; keep metric.lg and show '0:00' in incident colour; formatRelative for 'ago'; 'Payments API' / 'Datagen rate' / '1x - normal'; a danger glyph for data-tone='danger'; number keys inside the buttons; one-line idle status at <= 640; 480 px max on the abort action; dot-grammar detail line; delete the twelve keys.
- **Acceptance:** demo.spec.ts: the h1 top does not move between idle and retry states; no '0:00 ago' text; copy-style test finds no unreferenced demo.* keys.

#### P1-M01 · Flow and What-if empty states use the table-rows ghost (FlowScreen passes the ignored `illustration` prop, a `flow` ghost exists); the notifications empty state needs a 'cards' ghost; the first-run primary and secondary buttons are the same 323 px width and step 4 wraps to three lines; Story's how-strip dims steps with opacity 0.35 (2.14:1)

- **Area:** ghost shapes and first-run card · **Package:** WP-M · **Impact:** 2 · **Effort:** S · **Lenses:** view-firstrun, a11y (4 findings merged)
- **Files:** `src/components/common/Ghost.tsx`, `src/components/common/EmptyBlock.tsx`, `src/views/FirstRun/FirstRun.css`, `src/components/HowItWorks/HowItWorks.css`, `src/views/Flow/FlowScreen.tsx`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/design-first-run/shots/empty-flow-zoom-light-1440.png; tests/report/audit/design-first-run/shots/empty-whatif-light-1440.png; tests/report/audit/design-first-run/shots/firstrun-viewport-light-1440.png; tests/report/audit/design-first-run/shots/measurements-firstrun.json; tests/report/audit/accessibility/axe-results.json (color-contrast story how-strip); src/views/Flow/FlowScreen.tsx:74,92,100; src/components/common/Ghost.tsx:82-92; src/components/common/EmptyBlock.tsx:20-21; src/views/FirstRun/FirstRun.css:72-76; src/components/HowItWorks/HowItWorks.css:65-67; src/copy/en.ts:471
- **Gate:** FlowScreen prop lines loaned from WP-I
- **Fix:** ghost='flow' in the three Flow/What-if EmptyBlocks and drop the dead prop; a 'cards' ghost; auto/auto columns with justify-content start at >= 641; shorten step 4 to 'Alerts in dollars'; dim inactive steps with color.foreground.subtle instead of opacity.
- **Acceptance:** e2e: the Flow empty state renders the Sankey ghost; the first-run primary is wider than the secondary at 1440; axe reports no contrast failure on the story how-strip.

#### P1-M02 · README says tour/active is written by First run but the tour is in-memory only, so a reload (or Presenter/Story opened by URL) drops the judge back to the first-run card; the pre-JS splash is three generic bars, then a different skeleton, then the ghost (three shapes in two seconds)

- **Area:** tour persistence and splash · **Package:** WP-M · **Impact:** 2 · **Effort:** S · **Lenses:** judge-cribl-pm, view-firstrun (2 findings merged)
- **Files:** `src/tour/controller.ts`, `src/lib/params.ts`, `index.html`, `README.md`
- **Evidence:** tests/report/audit/pm-cribl/evidence-a.json (steps A2-A4); tests/report/audit/design-first-run/shots/splash-light-1440.png; tests/report/audit/design-first-run/shots/skel-receipt-light-1440.png; tests/report/audit/design-first-run/shots/waiting-receipt-viewport-light-1440.png; README.md:140; src/tour/controller.ts:8; index.html:20-52
- **Gate:** params.ts via INT; README row via WP-N
- **Fix:** Carry ?tour=1 as a sticky param so reload/presenter/story keep the sample workspace (or write tour/active) and correct the README row; reshape .mr-splash to mirror ReceiptSkeleton's hero block.
- **Acceptance:** e2e: start the tour, reload -> still on the sample Receipt with the band; the splash's number block box matches the ReceiptSkeleton's within 8 px.

#### P1-N02 · The build org's tenant id is in 11 tracked files and home-directory paths in 6; forbidden.txt has no rule for them, for bearer JWTs or webhook.site inboxes; .stage/backend.spike.yml is tracked though .stage/ is ignored; release bundles still carry rig ids and demo copy the compliance test does not catch

- **Area:** repo hygiene before the public push · **Package:** WP-N · **Impact:** 2 · **Effort:** S · **Lenses:** judge-security (3 findings merged)
- **Files:** `tests/forbidden.txt`, `tests/compliance.test.ts`, `core/runtime.ts`, `docs/platform/config-apis.md`, `.stage/backend.spike.yml`
- **Evidence:** tests/report/audit/security/evidence.json (git grep counts; release_bundle_grep); tests/forbidden.txt; core/runtime.ts:99; tests/compliance.test.ts:592-598
- **Fix:** Add text rules for the tenant id and the home-directory path, the JWT and webhook.site regexes; scrub the hits; git rm --cached the spike file; extend compliance.test.ts with the mrd_/meter-reader-demo/Demo levers assertion once the Presenter import moves (P1-B04); pair with the D36 squashed-history publish.
- **Acceptance:** npm run compliance passes with the new rules; git grep for the tenant id and the home path returns nothing outside git-ignored paths.

#### P1-N03 · LIVE_VALIDATION run labels skip 3, 5, 6 and the replay row's offsets disagree with its caught-in; VIDEO_SCRIPT says the video cannot disagree with the loop yet the rendered cut has different windows and an extra live-proof line; the sample receipt does not add up ($1,503,380 - $958,407 != $544,974); PITCH states 50 calls/min as a tab fact; README 'tour in about two minutes' is 150 s; STATE/REPORT test counts are stale; five claims are unverified; POSTS.md chapters

- **Area:** docs accuracy bundle · **Package:** WP-N · **Impact:** 2 · **Effort:** S · **Lenses:** truth (8 findings merged)
- **Files:** `docs/LIVE_VALIDATION.md`, `VIDEO_SCRIPT.md`, `PITCH.md`, `README.md`, `STATE.md`, `docs/POSTS.md`, `core/format.ts`
- **Evidence:** tests/report/audit/truthfulness/NOTES.md; tests/report/audit/truthfulness/vitest.json; docs/LIVE_VALIDATION.md (Run column); video/production/output/timeline_slow.json; demo/sample/tour.json snapshot.headline; PITCH.md:12; README.md:22,99,143,31,344,247; STATE.md:39
- **Gate:** core/format.ts rounding rule via WP-F if changed; VIDEO_SCRIPT.md section via WP-C (loaned)
- **Fix:** Renumber the runs 1-9 with one sentence that none was omitted and absolute UTC times on the replay row; a 'Rendered cut' section in VIDEO_SCRIPT (or emitted by scripts/story.ts); format saved as the difference of the displayed whole-dollar figures; 'the sweep budgets about 25 calls a minute'; 'about two and a half minutes'; refresh counts from vitest --reporter=json; link the createSystemMetricsQuery reference page and record a POST /kvstore/keys count.
- **Acceptance:** LIVE_VALIDATION rows are 1-9 contiguous; scripts/story.ts --check current; the receipt bar's three displayed figures satisfy whp - paid = saved.

#### P1-N05 · README:410 'Between sweeps the UI only reads snapshot and meta' is no longer true (prices while unpriced, demo/state, inventory per sweep on Settings, roll/* for a custom range, weekly docs on Monday); the member-context rate limit (PLATFORM_NOTES Q6) is still open though the tab legitimately reaches 68-107 calls/min in allowed configurations; DESIGN_BRIEF's primary button text drifted

- **Area:** README limits and budget truth · **Package:** WP-N · **Impact:** 2 · **Effort:** S · **Lenses:** api-budget, judge-devrel (3 findings merged)
- **Files:** `README.md`, `docs/PLATFORM_NOTES.md`, `docs/DESIGN_BRIEF.md`
- **Evidence:** README.md:410,247; docs/PLATFORM_NOTES.md:258-268,496,580; tests/report/audit/api-budget/findings.json; docs/DESIGN_BRIEF.md:61 vs src/copy/en.ts:458
- **Fix:** List the extra reads and their cadence; run one read-only burst from a member tab (e.g. 150 KV GETs in a minute via ?diag=1) to close Q6 and record the ceiling in README Limits and PLATFORM_NOTES 4.2; 'planned under 35 calls in steady state (a catch-up sweep may use more)'; update the brief's button text.
- **Acceptance:** README Limits names the measured member ceiling with the date; PLATFORM_NOTES Q6 is closed.

#### P1-Y01 · Units and typography wobble across screens: '/day' vs '/ day' and '{typical}/GB' vs '/ GB'; 'an hour' vs '/ hour' (with two dead keys); '10 %'; nine curly apostrophes among 62 straight; Source/Destination capitalised mid-sentence in 11 strings; Oxford commas in two subtitles; 'Would have paid' unhyphenated as a noun; 'config' vs 'configuration'; '7 d' vs '7 days'; 'Demo Console' Title Case; 'Presenter mode' vs 'view'; counted strings without plural pairs; dead keys

- **Area:** copy units, typography and casing · **Package:** INT · **Impact:** 2 · **Effort:** S · **Lenses:** copy (15 findings merged)
- **Files:** `src/copy/en.ts`, `README.md`, `PITCH.md`, `docs/DESIGN_BRIEF.md`
- **Evidence:** tests/report/audit/copy/flow-hover-light-1440.png; tests/report/audit/copy/flow-labels-light.txt; tests/report/audit/copy/flow-card-text-light.txt; tests/report/audit/copy/ledger-text-light.txt; tests/report/audit/copy/settings-prices-text-light.txt; tests/report/audit/copy/audit.ts; src/copy/en.ts:34,304,369,622,697,711-712,751-753,776,939,1007-1008,1015,1053,1104,1116,1156,1194-1197,1219-1221 and the dead keys at :35-46,581-587,605-606,624,1053-1055,1461
- **Gate:** README.md, PITCH.md and docs/DESIGN_BRIEF.md lines are loaned from WP-N
- **Fix:** Apply the rule 'prose says a day / an hour, labels say / day / / hour'; spaces around every unit slash; '10%'; straight apostrophes; lowercase object nouns in prose; no Oxford comma; hyphenate the noun; 'configuration'; '7 days'; decide 'Demo Console' as a proper noun in the en.ts note; 'presenter view' everywhere; tn() pairs; delete dead keys; add the rules to en.ts:3-10.
- **Acceptance:** tests/unit/copy-style.test.ts (P1-O02) passes; grep for '/day' (no space), '\d %', the curly apostrophe and 'Presenter mode' in en.ts returns nothing.

#### P1-Y02 · 'The Leader' and 'the savings snapshot' appear in error copy on the Receipt and presenter (leadership surfaces); the sample band says 'sample' and 'real' in one line; 'Every alert' in the bell body where the default posts medium and up; the story caption says 'It's already in Slack' which PITCH forbids without a Slack target; the story beat renders a Block Kit card the release cannot send; small grammar ('That is 10 endpoints, the most...', 'a number of 0 or more', 'anytime')

- **Area:** copy for leadership surfaces · **Package:** INT · **Impact:** 2 · **Effort:** S · **Lenses:** copy, judge-cribl-pm (7 findings merged)
- **Files:** `src/copy/en.ts`, `src/story/beats.ts`, `demo/sample/story.json`
- **Evidence:** tests/report/audit/copy/receipt-full-light-1440.png; tests/report/audit/pm-cribl/tour-story-real-72s.png; src/copy/en.ts:498,607-608,1145,1288,1342,1411,1433,1459,1470,1480-1486,1508,1566; src/story/beats.ts:228-232; README.md:165; PITCH.md:64
- **Gate:** story caption changes regenerate story.json/VIDEO_SCRIPT/captions via WP-C; the filed v1 video is not re-rendered unless Steve asks
- **Fix:** 'Couldn't reach Cribl' / 'Cribl is rate limiting Meter Reader' on Receipt/presenter, 'Leader' only in Settings -> Runtime and the console; 'the savings figures'; sampleBand 'Sample data. This is how Meter Reader looks once it is metering your traffic.'; 'Alerts at or above the minimum severity appear in the bell'; 'Already in Slack through Cribl, with a name on it.'; caption the slack beat 'delivered through a Cribl notification target' and render the plain-text form (Block Kit kept for the runner path, labelled); the three grammar fixes.
- **Acceptance:** grep -n 'Leader' src/copy/en.ts hits only settings.* and demo.* keys; the story slack beat caption names the notification target; scripts/story.ts --check is current.

#### P1-A09 · Single-character shortcuts have no off switch or focus-only mode (WCAG 2.1.4); ARIA nits: aria-label on a span badge, div presenter root and kbd; static document title on every route; the presenter hero has no live region; What if jumps h1 -> h3; Story nests main/header inside a region; footer reads 'v1.0.0release'

- **Area:** a11y / shortcut off switch and nits · **Package:** WP-A · **Impact:** 2 · **Effort:** M · **Lenses:** a11y (6 findings merged)
- **Files:** `src/lib/shortcuts.ts`, `src/components/Shell/Shell.tsx`, `src/components/Shell/Footer.tsx`, `src/components/IncidentsRail/IncidentsRail.tsx`, `src/views/Presenter/HeroMeter.tsx`, `src/components/WhatIf/WhatIfPanel.tsx`, `src/views/Story/index.tsx`, `core/settings.ts`
- **Evidence:** tests/report/audit/accessibility/keyboard-results.json; tests/report/audit/accessibility/axe-results.json (aria-prohibited-attr, heading-order, landmark-*); tests/report/audit/accessibility/probe2-results.json (titles); tests/report/audit/accessibility/aria/receipt-light-1440.yml; src/lib/shortcuts.ts:20-47; src/components/IncidentsRail/IncidentsRail.tsx:58; src/views/Presenter/index.tsx:138; src/views/Presenter/HeroMeter.tsx:132-135; src/components/WhatIf/WhatIfPanel.tsx:184; src/views/Story/index.tsx:91-104; src/components/Shell/Footer.tsx:47-51; README.md:421
- **Gate:** one-line edits in Footer/IncidentsRail/HeroMeter/WhatIfPanel/Story are loaned from their owners; the settings field goes through core/settings.ts (WP-G1)
- **Fix:** A persisted 'Single-key shortcuts' setting (Settings -> Runtime) gating dispatchShortcut, listed on the ? sheet; visible count + hidden suffix instead of aria-label on the badge; role=region on the presenter root; document.title = '<view> - Meter Reader' when window.parent === window; a polite status span updated every 30 s on the presenter hero; h2 for the What-if subhead; presentational divs inside the story region; whitespace around the footer separator.
- **Acceptance:** axe over the 21-state matrix reports zero aria-prohibited-attr, heading-order and landmark violations; with the setting off, pressing P does nothing; document.title changes per route on the dev server.

#### P1-B04 · The release bundle still carries the whole rig id table and rig flow list in the Presenter chunk and the demo copy keys ('Demo levers (demo mode on)', '[meter-reader-demo]') in the en chunk: 40 'mrd_' and 67 'demo' hits in meter-reader-1.0.0.tgz; the compliance test only asserts no Demo chunk and no 'Demo Console' string

- **Area:** demo residue in the release bundle · **Package:** WP-B · **Impact:** 2 · **Effort:** M · **Lenses:** judge-security (1 finding merged)
- **Files:** `src/views/Presenter/index.tsx`, `src/views/Presenter/Gallery.tsx`, `src/demo/install.ts`, `tests/compliance.test.ts`
- **Evidence:** tests/report/audit/security/evidence.json (release_bundle_grep); the security lens's grep of the unpacked release tgz (Presenter-*.js and en-*.js chunks; release/ is git-ignored and rebuilt per package); tests/compliance.test.ts:592-598
- **Gate:** Gallery.tsx after critique-fixes; src/demo/install.ts is loaned from WP-L; the compliance assertion is added by WP-N (P1-N02)
- **Fix:** Move the rig-ids/rig-flows import used by the Presenter behind the demo flag (or into demo/install), gate the demo copy keys behind the same flag, then extend compliance.test.ts with the mrd_/meter-reader-demo/Demo levers assertion.
- **Acceptance:** npm run audit: the release package's static texts contain no 'mrd_', 'meter-reader-demo' or 'Demo levers'; the demo package still does.

#### P1-F13 · Any treatment projects on any stream regardless of source type ('Windows XML pack' on 'Palo Alto firewall east' projects -$486/day from a similar-stream basis) with no 'not applicable' hint

- **Area:** what-if treatment applicability · **Package:** WP-J · **Impact:** 2 · **Effort:** M · **Lenses:** judge-cribl-pm (1 finding merged)
- **Files:** `core/whatif.ts`, `src/components/WhatIf/WhatIfPanel.tsx`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/pm-cribl/tour-whatif-picked-light-1440.png; tests/report/audit/pm-cribl/evidence-a2.json (step B4b)
- **Fix:** Tag treatments with applicable source types (windows, pan/syslog, vpcflow, any for drop-%) and grey out or caption inapplicable ones.
- **Acceptance:** unit: estimateTreatment('windows_xml', panFlow) returns applicable=false; the select shows the caption and the projection is not computed.

#### P1-I07 · The map stays 932x567 at 1440 and 1920 (350 px empty below on a projector); 500/403/429 are a lone banner over ~700 px of blank page; loading is the Shell's three-card skeleton then a snap to two columns and the unpriced state is a table-rows ghost; a shared pipeline node bundles flows to two destinations so one ribbon crosses eight

- **Area:** Flow stage use, states and crossings · **Package:** WP-I · **Impact:** 2 · **Effort:** M · **Lenses:** view-flow, view-firstrun, states (6 findings merged)
- **Files:** `src/components/FlowDiagram/layout.ts`, `src/views/Flow/FlowScreen.tsx`, `src/components/FlowDiagram/FlowDiagram.tsx`
- **Evidence:** tests/report/audit/flow-design/rig-light-1920.png; tests/report/audit/flow-design/rig-state-error500-light-1440.png; tests/report/audit/flow-design/rig-state-ratelimit429-light-1440.png; tests/report/audit/flow-design/rig-loading-light-1440.png; tests/report/audit/flow-design/rig-empty-light-1440.png; tests/report/audit/flow-design/tour-group2-light-1440.png; tests/report/audit/design-first-run/shots/empty-flow-zoom-light-1440.png; src/views/Flow/FlowScreen.tsx:23-35,69-76,84-100 (illustration prop ignored; no ghost='flow')
- **Fix:** ROW_PX = max(46, fitHeight / rows) and Page width 1600 for Flow; keep the two-card frame with a 40% grey outline Sankey behind the inline notice (429 with the countdown); render empty and skeleton inside the same 932+332 grid with ghost='flow'; split a shared pipe node per destination or sort by dominant destination.
- **Acceptance:** flow.spec.ts at 1920: the map card height >= 70% of the viewport; error and empty states render inside the two-card grid with a Sankey ghost.

#### P1-O02 · No Playwright spec asserts the open tab's call rate (the journal helpers exist unused), so a regression to 60+/min passes CI; no test guards the copy rules en.ts states for itself (sentence case, no '!', plural pairs, no spaced %, straight apostrophes, referenced keys)

- **Area:** budget and copy-style tests · **Package:** WP-O · **Impact:** 2 · **Effort:** M · **Lenses:** api-budget, copy (2 findings merged)
- **Files:** `tests/e2e/budget.spec.ts`, `tests/unit/copy-style.test.ts`, `tests/e2e/helpers/mock.ts`
- **Evidence:** tests/e2e/helpers/mock.ts:96-104; tests/integration/scenarios.test.ts:352; tests/report/audit/api-budget/measure.ts; tests/report/audit/api-budget/extras.ts; src/copy/en.ts:3-10
- **Fix:** budget.spec.ts on a warm org: first minute <= 50 and steady <= 40 for '/', '/?range=30d' and presenter, plus one 429 -> back-off -> recovery path; copy-style.test.ts walking en with an allowlist for template-accessed groups.
- **Acceptance:** Both specs run in CI; budget.spec.ts fails when the poll interval is forced to 3 s; copy-style fails on an unreferenced leaf key.

#### P1-F08 · Beyond 50 price versions the two oldest merge keeping the older effectiveFrom, so the displayed price for minutes between them reads at the newer price

- **Area:** price version history · **Package:** WP-F · **Impact:** 1 · **Effort:** S · **Lenses:** judge-cfo (1 finding merged)
- **Files:** `core/pricing.ts`
- **Evidence:** tests/report/audit/cfo/probe1.txt (P4); core/pricing.ts:269-272
- **Fix:** Merge by dropping the older version and keeping the newer effectiveFrom (history before it falls to D25's first-price rule), or raise MAX_PRICE_VERSIONS.
- **Acceptance:** unit: after 52 versions priceEntryAt(t between v1 and v2) returns v1's price or the documented first-price rule.

### 3.3 P2 — wow features, ranked by impact ÷ effort (28)

Score = impact ÷ effort points (S = 1, M = 2, L = 3); ties by impact, then effort. Each carries a design paragraph and acceptance criteria.

| ID | Score | Impact | Effort | Package | Feature |
|---|---|---|---|---|---|
| P2-W01 | 5.0 | 5 | S | WP-B | 'Saved since you started watching' session ticker under the hero |
| P2-W19 | 3.0 | 3 | S | WP-B | A chime when the card lands, savers rows that slide in when a pack applies, a one-shot dim of the upper band during the payoff, a first-paint roll-up of the hero, and an ask that reads from the back row |
| P2-W27 | 3.0 | 3 | S | WP-M | An animated how-it-works strip on mount, the meter motif on the first-run card, an unpriced presenter that still pitches, and a receipt-stamp sample band |
| P2-W02 | 2.5 | 5 | M | WP-I | A 'Width: bytes | dollars' toggle that morphs the Insights-style bytes map into the dollar map (default dollars) |
| P2-W03 | 2.5 | 5 | M | WP-B | A red 'Lost since the deploy' counter running on the alert card, frozen on recovery into 'Cost $2.31 before it was caught' |
| P2-W04 | 2.5 | 5 | M | WP-B | Fill the takeover's footprint at rest with the receipt bar at stage scale, fading out 200 ms before the card lands |
| P2-W05 | 2.5 | 5 | M | WP-O | Synthesize sample rollup documents in memory so the Custom range (the v1.1.0 headline) works in the Tour a judge starts with |
| P2-W06 | 2.5 | 5 | M | WP-J | A saved-green takeover for good news: 'flip it on, watch it land' with projected vs measured on the card |
| P2-W07 | 2.5 | 5 | M | WP-K | Price every commit: dollar impact on the commit card, a 'Changes' receipt list under the Ledger, and the largest priced commit annotated on the trend |
| P2-W08 | 2.5 | 5 | M | WP-J | Render the What-if hero as the real Receipt hero card with the projection as a hatched extension of the green segment |
| P2-W09 | 2.5 | 5 | M | WP-G1 | A live receipt line per Prices row and a 'Start the meter' first save |
| P2-W10 | 2.0 | 4 | M | WP-I | A presenter-scale Flow: chrome hidden, diagram fitted to the projector, labels and plates >= 24 px, the receipt as a right-hand strip |
| P2-W11 | 2.0 | 4 | M | WP-C | A FlowStage beat in the 90-second loop (and the video) instead of 10 s of icon strip |
| P2-W12 | 2.0 | 4 | M | WP-C | The story's meter slows when the alert lands (red delta chip), a live 'Caught in' clock runs in the watching beat, and the Monday receipt prints line by line |
| P2-W13 | 2.0 | 4 | M | WP-H | 'Compare with...' in the range picker: previous period, same window a week earlier, or 24 h before vs after a commit, rendered as A -> B with a signed delta |
| P2-W14 | 2.0 | 4 | M | WP-K | When ?range= is set the Ledger switches its money columns to sums over the window, the Receipt gains 'By source' / 'By destination' cards, and Flow plates read the window's sum |
| P2-W15 | 2.0 | 4 | M | WP-B | RatioWatch on the full incident card and the takeover: the ratio line, the frozen baseline, the commit diamond and the shaded loss labelled with its $/day |
| P2-W16 | 2.0 | 4 | M | WP-I | A hatched 'Removed by Cribl - $18,524 / day' sink node, incident-marked ribbons, and destination legend chips that filter |
| P2-W17 | 2.0 | 4 | M | WP-K | Inline saved bars per row, a dot-leader totals row, a three-tile money strip above the table, bidirectional table <-> timeline linking, and an end label on the Trend sparkline |
| P2-W18 | 2.0 | 4 | M | WP-L | 'What the room sees' thumbnail, a run-of-show receipt per scene, the lever becoming the countdown, a five-item lever ledger, and a haptic cue |
| P2-W20 | 2.0 | 4 | M | WP-H | A savings goal with pace on the MTD hero, a 'This week so far' receipt card with a preview of Monday's message, and a price-confidence badge |
| P2-W23 | 2.0 | 4 | M | WP-J | Treatment RadioTiles with their documented ranges, and a ranked 'Biggest unclaimed savings' receipt list above the calculator |
| P2-W21 | 1.5 | 3 | M | WP-A | A status popover with a 60-minute sweep sparkline and 'next sweep in 0:42', tab badges for open alerts and unpriced destinations, and a footer tear-off stub with the sweep strip |
| P2-W22 | 1.5 | 3 | M | WP-A | A command palette (Cmd+K / ?) replacing the static shortcut sheet, and a view-transition into presenter/story mode |
| P2-W24 | 1.5 | 3 | M | WP-G1 | 'changed by <user> at <time>' on price versions (window.getCriblUser) and a vendor-tile preset picker |
| P2-W25 | 1.5 | 3 | M | WP-H | A per-destination monthly statement drawer, an hour-of-week savings heatmap, the counterfactual drawn as a hatched ghost, and a tear-off animation on Copy receipt |
| P2-W26 | 1.5 | 3 | M | WP-J | Let the member pick any captured sample file from the group's sample library for the dry run, not only Datagen sources |
| P2-W28 | 1.5 | 3 | M | WP-E | A tab's Leader-call budget made visible ('Leader calls in the last minute: 37 (sweep 23 - live 12 - range 1)') and a sweep read plan that skips documents the tab already holds |

#### P2-W01 · 'Saved since you started watching' session ticker under the hero

- **Area:** presenter / the meter must visibly run · **Package:** WP-B · **Impact:** 5 · **Effort:** S · **Score:** 5.0 · **Lenses:** scout, view-presenter, judge-wow (3 findings merged)
- **Files:** `src/views/Presenter/index.tsx`, `src/views/Presenter/Presenter.css`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/feature-scout/shots/A-presenter-dark-1920.png; tests/report/audit/stage-judge/measurements-rest-flow-whatif.json (annualized tick20s t0=t20); tests/report/audit/design-presenter/measure-full.json; src/views/Presenter/heroValue.ts:5,34,92; core/snapshot.ts:348 ratePerSecM; core/format.ts:35 fmtDollarsCents
- **Design:** The stage hero is an annualized rate that never accrues, so between sweeps the 'ticking number' is static for 60 s at a time. Add a second, smaller line under the caption that starts at $0.00 the moment presenter mode opens and accrues at snapshot.ratePerSecM, re-anchored on each snapshot the way HeroMeter already eases: 'Saved since you started watching - $12.40 - ~$0.09 a second'. Cents are allowed only on this line (document it as the brief's one exception), tabular figures in --mr-saved, driven by the same rAF loop, static under reduced motion, hidden or captioned 'sample rate' on sample/replay sources, frozen and greyed when the status goes stale. It turns the five-minute pitch into a visible proof and hands the presenter the closing line ('while I talked, Cribl saved $X').
- **Acceptance:** presenter.spec.ts: the session line reads $0.00 at entry and >= ratePerSecM x 10 s after 10 s of fake time; it freezes when the status is stale; it is absent on the sample tour.

#### P2-W19 · A chime when the card lands, savers rows that slide in when a pack applies, a one-shot dim of the upper band during the payoff, a first-paint roll-up of the hero, and an ask that reads from the back row

- **Area:** presenter / small moments · **Package:** WP-B · **Impact:** 3 · **Effort:** S · **Score:** 3.0 · **Lenses:** judge-wow, view-presenter, motion (5 findings merged)
- **Files:** `src/components/IncidentTakeover/IncidentTakeover.tsx`, `src/views/Presenter/index.tsx`, `src/views/Presenter/Presenter.css`, `src/components/Meter/Meter.tsx`, `src/components/QrBlock/QrBlock.tsx`, `core/settings.ts`
- **Evidence:** tests/report/audit/stage-judge/presenter-rest-annualized-dark-1920.png; tests/report/audit/stage-judge/takeover-delivered-dark-1920.png; tests/report/audit/design-presenter/qr-dark-1920x1080.png; tests/report/audit/motion/sheet-tour-entry-1440.png; grep 'new Audio|AudioContext' src -> none
- **Gate:** the chime setting field via core/settings.ts (WP-G1)
- **Design:** Five S-effort moments, each inside the brief's motion budget and off under reduced motion: (1) on an 'alert' TakeoverEvent, if settings.presenter.chime, a 2-note sine (E5 -> B5, 250 ms, gain 0.15) via an AudioContext created on the P keypress, a single lower note on recovery, off by default; (2) SaversList rows keyed by objectKey with a 400 ms translateY insert and a one-second green tint on a changed amount; (3) `.mr-pv:has(.mr-takeover--alert) :is(.mr-pv-hero, .mr-pv-savers) { opacity: .55 }` over 300 ms so the room's eyes go to the card; (4) on the Meter's first mount with a non-zero anchor, a one-time 1.2 s roll from $0 (or the previous snapshot) to the live figure, once per session; (5) the QR column as one larger ask ('Vote: Meter Reader - Customer track' at >= 28 px above a 260 px code, no URL on stage).
- **Acceptance:** presenter.spec.ts: a new saver row has a running transform transition on insert; the hero opacity is .55 while an alert card is up and 1 after; the chime never plays when the setting is off; the first Receipt mount shows a >= 1 s digit roll.

#### P2-W27 · An animated how-it-works strip on mount, the meter motif on the first-run card, an unpriced presenter that still pitches, and a receipt-stamp sample band

- **Area:** first run / the product explains itself · **Package:** WP-M · **Impact:** 3 · **Effort:** S · **Score:** 3.0 · **Lenses:** view-firstrun (5 findings merged)
- **Files:** `src/views/FirstRun/index.tsx`, `src/views/FirstRun/FirstRun.css`, `src/components/HowItWorks/HowItWorks.tsx`, `src/views/Presenter/index.tsx`, `src/components/common/common.css`
- **Evidence:** tests/report/audit/design-first-run/shots/firstrun-viewport-light-1440.png; tests/report/audit/design-first-run/shots/firstrun-viewport-light-1920.png; tests/report/audit/design-first-run/shots/presenter-empty-dark-1920.png; tests/report/audit/design-first-run/shots/sample-band-light-1440.png; src/components/HowItWorks/HowItWorks.tsx:24-27 activeStep; src/views/FirstRun/index.tsx:93
- **Gate:** the presenter empty state via WP-B
- **Design:** The first thing a judge sees should be the product explaining itself: step 1 lights, then 2, 3, 4 at 400 ms intervals with the hairline drawing between them (reduced motion: all lit); a dimmed '$--' hero above the title that rolls to a sample figure on hover/focus of 'Tour with sample data', plus the hero's perforated bottom edge, so the card carries both identity motifs. The presenter's no-prices state gets the four-step strip at >= 28 px under the hero and a QR that deep-links to /settings/prices, so an idle unpriced install at the booth still pitches. The sample band gets a perforated lower edge, the stripe only on the left cap, 'Sample data' in Source Code Pro like a stamp, and a 'tour - beat 3 of 12' chip.
- **Acceptance:** e2e: the first-run strip's steps gain data-active in sequence over ~1.6 s (all at once under reduced motion); hovering the tour button rolls the card meter; the unpriced presenter renders the strip and a QR.

#### P2-W02 · A 'Width: bytes | dollars' toggle that morphs the Insights-style bytes map into the dollar map (default dollars)

- **Area:** Flow / bytes <-> dollars morph · **Package:** WP-I · **Impact:** 5 · **Effort:** M · **Score:** 2.5 · **Lenses:** view-flow, judge-wow (2 findings merged)
- **Files:** `src/components/FlowDiagram/layout.ts`, `src/components/FlowDiagram/FlowMap.tsx`, `src/components/FlowDiagram/FlowDiagram.tsx`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/flow-design/tour-light-1440.png; src/components/FlowDiagram/FlowDiagram.tsx:351 useTweenedLayout; src/components/FlowDiagram/layout.ts:518
- **Design:** Make the pitch a gesture. computeFlowLayout takes weightBy: 'bytes' | 'dollars' (slot = sqrt(whpPerDayM) for dollars); a two-item segmented toggle in .mr-flowmap-top; pressing it morphs over the existing 400 ms tween so the $527/day S3 slab shrinks to a thread and the Splunk streams swell. Default dollars on /flow (this is the striking form of P1-I01, not a second change). A Story beat and the presenter-scale Flow (W-10) flip it on stage: 'this is what Insights shows you (bytes) - this is what it costs (dollars)'.
- **Acceptance:** flow.spec.ts: the toggle changes every ribbon's width monotonically with whpPerDayM vs inBPerDay; the change runs as one ~400 ms tween; ?weight=bytes survives reload.

#### P2-W03 · A red 'Lost since the deploy' counter running on the alert card, frozen on recovery into 'Cost $2.31 before it was caught'

- **Area:** presenter / money lost, live · **Package:** WP-B · **Impact:** 5 · **Effort:** M · **Score:** 2.5 · **Lenses:** judge-wow (1 finding merged)
- **Files:** `src/components/IncidentTakeover/TakeoverCard.tsx`, `src/components/IncidentTakeover/IncidentTakeover.css`, `src/copy/en.ts`
- **Evidence:** src/components/IncidentTakeover/TakeoverCard.tsx (useNow, .mr-tk-clock 44 px); core/types.ts:343 impactPerDayM; docs/LIVE_VALIDATION.md run 10 ($23.86/day); tests/report/audit/stage-judge/takeover-alert-dark-1920.png
- **Gate:** TakeoverCard.tsx after critique-fixes merges
- **Design:** The card already ticks a clock; a dollar figure moving the wrong way in red is the gasp the room is waiting for and makes 'caught in 1:43' felt rather than read. lostM = impactPerDayM x (now - deployedAt) / 86,400,000 rendered with the cents Meter at 44 px in the foot next to 'Caught in'; recovery mode shows the frozen total in the same slot ('Cost $2.31 before it was caught'). Red only on the live counter; reduced motion updates once per second. No new dependency, one copy key.
- **Acceptance:** presenter.spec.ts: with impactPerDayM 2,386,000 mc and deployedAt 60 s ago the counter reads ~$1.66 and grows; the recovery card shows the frozen 'Cost ... before it was caught' line.

#### P2-W04 · Fill the takeover's footprint at rest with the receipt bar at stage scale, fading out 200 ms before the card lands

- **Area:** presenter / stage at rest · **Package:** WP-B · **Impact:** 5 · **Effort:** M · **Score:** 2.5 · **Lenses:** view-presenter, judge-wow (3 findings merged)
- **Files:** `src/views/Presenter/index.tsx`, `src/views/Presenter/Presenter.css`, `src/components/ReceiptBar/ReceiptBar.tsx`
- **Evidence:** tests/report/audit/design-presenter/rest-dark-1920x1080.png; tests/report/audit/design-presenter/rest-dark-1440x900.png; tests/report/audit/design-presenter/measure-full.json (empty rect 1552x535 at 1920); tests/report/audit/stage-judge/presenter-rest-annualized-dark-1920.png; src/components/ReceiptBar (callout ids exist)
- **Gate:** ReceiptBar.tsx (a stage size prop) is loaned from WP-H
- **Design:** At rest, the frame a judge sees for all but ~55 seconds, 40% of the stage is bare canvas. Put content the takeover may legitimately cover into its footprint (left of the QR column, y 50-94%): one full-width receipt bar (would-have-paid -> paid grey -> saved green) with 'You would have paid $152,400 - You paid $60,980 - 60% saved' at >= 28 px, or the 30-day saved area chart in one stroke of --mr-saved. `.mr-pv:has(.mr-takeover) .mr-pv-bar { opacity: 0; transition: opacity 200ms }` so the F1 guarantee (nothing important covered) still holds and the payoff gets its before/after contrast: the bar visibly leaves when the alert arrives and returns when it clears. Exclude the bar from MUST_STAY_VISIBLE.
- **Acceptance:** presenter.spec.ts at 1920: no empty rect wider than 600 px below the upper band at rest; coveredBy stays [] with a card up; the bar's opacity is 0 while .mr-takeover is mounted.

#### P2-W05 · Synthesize sample rollup documents in memory so the Custom range (the v1.1.0 headline) works in the Tour a judge starts with

- **Area:** tour / custom range under the sample band · **Package:** WP-O · **Impact:** 5 · **Effort:** M · **Score:** 2.5 · **Lenses:** scout (1 finding merged)
- **Files:** `core/sampleRollups.ts`, `src/state/services.ts`, `src/views/Receipt/index.tsx`, `tests/unit/sampleRollups.test.ts`
- **Evidence:** tests/report/audit/feature-scout/shots/A-hero-light-1440.png; src/views/Receipt/index.tsx:130-131 customDisabled; src/copy/en.ts:547; src/state/services.ts:96; src/state/ports.ts:16 RollupDocs; demo/sample/tour.json (trend 30 days, ratioSeries 288 points, 55 flows); testdata/rollups.ts:95 seedRollupDocs
- **Gate:** services.ts wiring line via WP-D/INT; Receipt/index.tsx gate line via WP-H after the range fixer
- **Design:** Today the Tour greys Custom out ('Custom ranges read your live history'), so the new feature is invisible exactly where judges look. A pure sampleRollups(tourDoc) -> RollupDocs builds day rows straight from snapshot.trend, hour rows by spreading each day over 24 hours on the diurnal curve of ratioSeries, minute rows for the last 25 h from ratePerSecM, split per flow by savedPerDayM share. Passed as docs.rollups when source === 'sample'; no KV write (the tour stays 'nothing is written'), no config touched. The hero then shows '7 days - $177,198' under the band and the picker, the math section and Copy receipt all demo live.
- **Acceptance:** unit: sum of day rows equals trend and sum of hour rows per day equals that day's row; e2e on the tour: the Custom item is enabled and ?range=7d renders a figure with the sample band on.

#### P2-W06 · A saved-green takeover for good news: 'flip it on, watch it land' with projected vs measured on the card

- **Area:** What-if / the positive payoff on stage · **Package:** WP-J · **Impact:** 5 · **Effort:** M · **Score:** 2.5 · **Lenses:** scout, view-whatif, judge-wow (3 findings merged)
- **Files:** `src/components/WhatIf/WhatIfPanel.tsx`, `src/components/WhatIf/useWhatIf.ts`, `src/components/IncidentTakeover/tracker.ts`, `core/settings.ts`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/feature-scout/shots/A-presenter-dark-1920.png; tests/report/audit/whatif-design/E6-applied-url-light-1440.png; src/components/IncidentTakeover/tracker.ts:49; core/detector.ts:244-274 (goodnews with impactPerDayM); core/settings.ts:43 goodNewsEnabled false; core/whatif.ts:447 measureActual; src/components/WhatIf/useWhatIf.ts:72-73; src/copy/en.ts:914 projectedVsActual
- **Gate:** tracker.ts one-liner loaned from WP-B; goodNewsEnabled default under the demo profile via core/settings.ts (WP-G1)
- **Design:** The stage only ever takes over for the break. After 'Apply for real' the ribbon narrows quietly and What-if shows one grey sentence. Let goodnews incidents qualify for the takeover in a 'landed' mode (green, 15 s, never pre-empts an alert): 'Savings rose on Windows servers - 0% -> 33% - +$1,340 a day - +$489k a year - 7c2d410 "apply Windows XML pack" - s.koelpin - Projected 30-35%, measured 33% after 3 min'. The detector already opens goodnews incidents with a matching commit; the projected figure comes from useWhatIf's appliedProjection when the incident's commit matches the applied lever. goodNewsEnabled defaults true under the demo profile only; the release stays a calculator. With P0-13's script beat this is the forecast the room watches come true.
- **Acceptance:** demo build e2e: Apply for real on Windows workstations followed by two snapshots at the projected ratio opens a green takeover carrying 'Projected N%, measured M%'; the release build never opens one unless goodNewsEnabled.

#### P2-W07 · Price every commit: dollar impact on the commit card, a 'Changes' receipt list under the Ledger, and the largest priced commit annotated on the trend

- **Area:** Ledger / who moved the money · **Package:** WP-K · **Impact:** 5 · **Effort:** M · **Score:** 2.5 · **Lenses:** scout, view-receipt, view-ledger (3 findings merged)
- **Files:** `core/commitImpacts.ts`, `src/components/ChangeTimeline/model.ts`, `src/components/ChangeTimeline/ChangeTimeline.tsx`, `src/views/Ledger/index.tsx`, `src/components/TrendChart/TrendChart.tsx`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/feature-scout/shots/A-timeline-commit-card-light-1920.png; tests/report/audit/feature-scout/shots/A-trend-hover-light-1440.png; tests/report/audit/design-receipt/shots/trend-tip-deploy-dark-1440.png; src/components/ChangeTimeline/model.ts:347 whatMoved; src/copy/en.ts:1031 movedNone; core/detector.ts:274 impactPerDayM
- **Gate:** TrendChart annotation via WP-H
- **Design:** The pitch is 'a drop arrives with a commit ID and a username', but only regressions get a dollar figure; every other deploy reads 'No flow moved more than a few points'. commitImpacts(snapshot) (pure, tested) prices every move whatMoved finds: delta ratio x whpPerDayM -> $/day, x365 -> $/year, summed per commit. (a) The commit card gains '+$1,340 a day since this deploy - 3 flows moved'; (b) a 'Changes' ReceiptList under the Ledger table: every commit of the last 7 days, author, priced impact sorted by |$|, each row a deep link; (c) the 30-day trend shades the region after the largest priced commit with an inline '+$1,240 / day since 7c2d410 - j.rivera'. Both directions priced, so the same mechanism credits the good deploys.
- **Acceptance:** unit: commitImpacts on the tour fixture prices the sampling commit at -$1,250/day; e2e: the commit card shows a dollar line and the Ledger's Changes list has one row per commit in the window.

#### P2-W08 · Render the What-if hero as the real Receipt hero card with the projection as a hatched extension of the green segment

- **Area:** What-if / the hero IS the receipt · **Package:** WP-J · **Impact:** 5 · **Effort:** M · **Score:** 2.5 · **Lenses:** view-whatif (2 findings merged)
- **Files:** `src/components/WhatIf/WhatIfPanel.tsx`, `src/views/Receipt/HeroCard.tsx`, `src/components/ReceiptBar/ReceiptBar.tsx`
- **Evidence:** tests/report/audit/whatif-design/01-panel-light-1440.png; docs/DESIGN_BRIEF.md sections 1, 5.1, 5.3, 5.9
- **Gate:** HeroCard.tsx (projection prop) and ReceiptBar.tsx are loaned from WP-H after the range fixer lands
- **Design:** 'Saved by Cribl would read $119,724' becomes a literal preview of tomorrow's receipt: reuse HeroCard with a `projection` prop (perforated edge, PROJECTION pill, dashed hatched segment on the bar, no ticking after), and replace the four equal cells with one full-width receipt bar under the selects: grey paid, green saved today, hatched-green 'would save' extension with the four numbers as labels beneath. The Receipt, the Flow wedge and the What-if then share one visual grammar for money.
- **Acceptance:** whatif.spec.ts: the hero renders .mr-hero with the PROJECTION pill and a hatched bar segment whose width equals the projected saved share; no separate .mr-whatif-hero box.

#### P2-W09 · A live receipt line per Prices row and a 'Start the meter' first save

- **Area:** Settings -> Prices / the first save starts a meter · **Package:** WP-G1 · **Impact:** 5 · **Effort:** M · **Score:** 2.5 · **Lenses:** view-settings (3 findings merged)
- **Files:** `src/components/PriceTable/PriceTable.tsx`, `src/views/Settings/shared.tsx`, `src/views/Settings/PricesSection.tsx`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/design-settings/prices-priced-light-1440.png; tests/report/audit/design-settings/prices-fresh-light-1440.png; tests/report/audit/design-settings/crop-prices-foot-dirty-light.png; docs/DESIGN_BRIEF.md sections 1 and 5.5
- **Gate:** shared.tsx (SaveBar label/diff) is loaned from WP-G2
- **Design:** As a price is typed, a right-aligned mono receipt line appears in the row ('~ $1,340 / day' with a dot leader, from the last sweep's GB/day for that destination priced at the draft) and a card-level total ('4 destinations - ~ $4,210 / day would-have-paid'). On a never-priced workspace the primary button reads 'Start the meter', the save-bar note says what will start ('Meters every minute from the moment you save - 4 destinations'), the saved toast deep-links 'See the receipt ->', and the sticky save bar lists the diff receipt-style ('siem-prod $2.25 -> $2.50') with Cmd/Ctrl+S. The receipt motif lands inside Settings and the first save feels like starting a meter, not filling a form.
- **Acceptance:** settings.spec.ts: typing 2.25 on a row with 600 GB/day shows '~ $1,350 / day' in the row; on a fresh install the primary reads 'Start the meter' and the toast links to '/'.

#### P2-W10 · A presenter-scale Flow: chrome hidden, diagram fitted to the projector, labels and plates >= 24 px, the receipt as a right-hand strip

- **Area:** Flow on stage · **Package:** WP-I · **Impact:** 4 · **Effort:** M · **Score:** 2.0 · **Lenses:** judge-wow, view-flow (2 findings merged)
- **Files:** `src/components/FlowDiagram/FlowMap.tsx`, `src/components/FlowDiagram/layout.ts`, `src/views/Flow/FlowScreen.tsx`, `src/lib/params.ts`
- **Evidence:** tests/report/audit/stage-judge/measurements-typo.json (flow1920 mapBox 882x492, frameShare 21%); tests/report/audit/stage-judge/flow-rig-dark-1920.png; tests/report/audit/flow-design/rig-light-1920.png
- **Gate:** params.ts via INT
- **Design:** Steps 3-6 of the pitch (~1:50 of 5:00) are spent on Flow, which on a 1920x1080 projector draws the map at 21% of the frame under the nav and title with 14 px labels. /flow?present=1 (or the F key inside presenter mode) hides the chrome, fits the diagram to min(viewport width, height - header), sets ROW_PX 64 and label/plate sizes >= 24 px, and shows the receipt card as a strip on the right; a small cursor tooltip with the three numbers keeps the eye on the ribbon. Reuse FlowMap; only the container and a size token change. Combined with W-02 this is the second stage scene after the hero.
- **Acceptance:** flow.spec.ts at 1920 with ?present=1: the SVG's box is >= 70% of the viewport area, every label's computed font-size >= 24 px, no nav or title rendered, P returns to the normal Flow.

#### P2-W11 · A FlowStage beat in the 90-second loop (and the video) instead of 10 s of icon strip

- **Area:** Story / the dollar map · **Package:** WP-C · **Impact:** 4 · **Effort:** M · **Score:** 2.0 · **Lenses:** judge-wow (1 finding merged)
- **Files:** `src/views/Story/stages.tsx`, `src/story/beats.ts`, `src/views/Story/Story.css`, `demo/sample/story.json`, `VIDEO_SCRIPT.md`
- **Evidence:** tests/report/audit/stage-judge/story-how-dark-1920.png; tests/report/audit/stage-judge/flow-tour-dark-1920.png; src/story/beats.ts:183-258 (no flow beat); src/views/Story/stages.tsx:307-308
- **Gate:** stages.tsx after critique-fixes; regenerate story outputs; video re-render optional
- **Design:** The map is the one visual that answers 'isn't this just Insights?', and nobody online will see it. Add a FlowStage rendering the tour fixture's datacenter group (30 flows, $18,524/day saved) with FlowMap in projection-free dark mode; give the 'how' beat's second and third caption lines to it with callouts onto a '$ / day' plate ('priced at the destination') and a saved wedge ('what the pipeline removed'); keep the icon strip for 3 s. With W-02 the beat can flip bytes -> dollars mid-caption.
- **Acceptance:** story.spec.ts: a beat with view 'flow' renders .mr-flow-svg with >= 10 ribbons at 1920; the how beat's strip is on screen <= 3 s; scripts/story.ts --check current.

#### P2-W12 · The story's meter slows when the alert lands (red delta chip), a live 'Caught in' clock runs in the watching beat, and the Monday receipt prints line by line

- **Area:** Story / the number tells the incident · **Package:** WP-C · **Impact:** 4 · **Effort:** M · **Score:** 2.0 · **Lenses:** view-story (3 findings merged)
- **Files:** `src/views/Story/stages.tsx`, `src/components/SlackPreview/SlackPreview.tsx`, `src/views/Story/Story.css`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/story-design/shots/1440-light-06-alert.png; tests/report/audit/story-design/shots/1440-light-08-restore.png; tests/report/audit/story-design/shots/1440-light-05-watching.png; tests/report/audit/story-design/shots/1920-dark-09-receipt.png; src/views/Story/stages.tsx:65-71; src/story/beats.ts:239 caughtInSec
- **Gate:** stages.tsx after critique-fixes; SlackPreview.tsx (revealLines prop) is loaned from WP-G2
- **Design:** Three motions that make the loop earn its numbers: (1) in HeroStage rate = ratePerSecM - (incident open ? impact.perDayM / 86400 : 0) with a red chip '-$1,250 / day' that turns green ('back to +$1,250 / day') in the restore beat, so the identity number itself tells the incident; (2) WatchStage runs fmtDuration(reveal x caughtInSec) next to a clock glyph during the 10 s watching beat, freezing at 2:51 the instant the card lands, the same figure then appearing on the card, the Slack message and the summary; (3) SlackPreview gets a revealLines prop so the receipt's mono lines appear one per ~0.4 s with the total landing last. Reduced motion: static chip, final clock, all lines at once.
- **Acceptance:** story.spec.ts: during the alert beat the hero's per-second delta is lower than in the hook beat by impact/86400; the watch clock text equals the card's 'Caught in' at the alert beat's first frame; receipt lines appear progressively unless reduced motion.

#### P2-W13 · 'Compare with...' in the range picker: previous period, same window a week earlier, or 24 h before vs after a commit, rendered as A -> B with a signed delta

- **Area:** Receipt / compare two ranges · **Package:** WP-H · **Impact:** 4 · **Effort:** M · **Score:** 2.0 · **Lenses:** scout (1 finding merged)
- **Files:** `core/range.ts`, `src/views/Receipt/useRange.ts`, `src/views/Receipt/HeroCard.tsx`, `src/views/Receipt/RangePicker.tsx`, `core/receipt.ts`, `src/lib/params.ts`
- **Evidence:** tests/report/audit/feature-scout/shots/B-hero-range7d-light-1440.png; tests/report/audit/feature-scout/shots/B-range-picker-light-1440.png; core/range.ts:159,317; src/state/rangeReader.ts:70; core/receipt.ts:71-76,313; core/types.ts:294 Commit.deployedAt
- **Gate:** after the range fixer lands its pass (HeroCard/RangePicker/useRange transfer to WP-H then); core/range.ts and src/state/rangeReader.ts stay the range fixer's and are loaned for compareRanges; after the hybrid read plan (api-budget F2)
- **Design:** A single custom range answers 'how much', not 'better or worse'. sumRange runs twice (sequentially, sharing the immutable-doc cache) and the hero renders '$1,832 vs $1,610 - +$222 (+14%)', the receipt bar as two stacked bars, the per-pipeline lines with a delta column, Copy receipt carrying both windows; URL ?range=7d&vs=prev or &vs=<hash>. Refused with a caption when the combined plan exceeds DOC_CAPS. No writes.
- **Acceptance:** unit: compareRanges over seeded docs returns both sums and the delta; e2e: ?range=7d&vs=prev renders the two-figure hero and Copy receipt contains both windows.

#### P2-W14 · When ?range= is set the Ledger switches its money columns to sums over the window, the Receipt gains 'By source' / 'By destination' cards, and Flow plates read the window's sum

- **Area:** Ledger / Flow / Receipt follow the range · **Package:** WP-K · **Impact:** 4 · **Effort:** M · **Score:** 2.0 · **Lenses:** scout (1 finding merged)
- **Files:** `src/views/Ledger/index.tsx`, `src/components/LedgerTable/model.ts`, `src/views/Receipt/Sections.tsx`, `src/components/FlowDiagram/FlowMap.tsx`, `src/state/store.ts`
- **Evidence:** tests/report/audit/feature-scout/shots/B-ledger-under-range7d-light-1440.png; tests/report/audit/feature-scout/shots/B-receipt-range7d-light-1440.png; core/range.ts:285,287 byFlow/byOutput; src/lib/params.ts:48 STICKY_PARAMS; src/components/LedgerTable/model.ts:31
- **Gate:** after the range fixer; Receipt and Flow parts loaned from WP-H/WP-I
- **Design:** The URL already carries the range into the Ledger and Flow but both keep per-day rates and 'Where the money goes' stays 'per day at current rates' beside a 7-day hero. Lift the one range read into the store (one per tab); LedgerRow gains a rangeMoney map so the money columns show 'Sep 19-26 - sum saved' with the totals row sorted by sum; two ReceiptList cards from RangeFigures.byFlow (parseFlowKey -> inputId) and byOutput; Flow plates read the window sum with a 'sum 7 days' chip. Everything comes from data sumRange already populates.
- **Acceptance:** e2e: /ledger?range=7d shows a window header on the money columns and the totals equal the Receipt's range figure; the Receipt shows By source and By destination cards under a range.

#### P2-W15 · RatioWatch on the full incident card and the takeover: the ratio line, the frozen baseline, the commit diamond and the shaded loss labelled with its $/day

- **Area:** incident cards / draw the drop · **Package:** WP-B · **Impact:** 4 · **Effort:** M · **Score:** 2.0 · **Lenses:** scout, view-story (2 findings merged)
- **Files:** `src/components/RatioWatch/RatioWatch.tsx`, `src/components/IncidentTakeover/TakeoverCard.tsx`, `src/components/IncidentCard/IncidentCard.tsx`, `src/views/Story/RatioWatch.tsx`
- **Evidence:** tests/report/audit/feature-scout/shots/A-ledger-light-1440.png; src/views/Story/RatioWatch.tsx:39-55 (reusable pure SVG); core/types.ts:434 sparkline, :488 ratioSeries, :343 impactPerDayM
- **Gate:** TakeoverCard after critique-fixes; WP-B owns the new src/components/RatioWatch/*; src/views/Story/RatioWatch.tsx (the move) is loaned from WP-C and IncidentCard.tsx from WP-H
- **Design:** The alert is told in numbers but never drawn, while the Story already has the picture and it is the most legible moment of the loop. Move RatioWatch to src/components and feed it from the flow's sparkline (or ratioSeries for the workspace), incident.before as the dotted baseline, the commit diamond at deployedAt, incident.after as the after level and the gap shaded and labelled; render it in IncidentCard variant='full' and in TakeoverCard between the before -> after figures and the commit line (this also fills the card's empty right column). Compact cards keep the text; reduced motion static. It also makes the story's chart one click away in the product.
- **Acceptance:** presenter.spec.ts: the takeover card contains an .mr-rw SVG whose diamond x matches deployedAt within the window; the Ledger rail's full card shows the same chart.

#### P2-W16 · A hatched 'Removed by Cribl - $18,524 / day' sink node, incident-marked ribbons, and destination legend chips that filter

- **Area:** Flow / savings as a place, incidents on the map · **Package:** WP-I · **Impact:** 4 · **Effort:** M · **Score:** 2.0 · **Lenses:** view-flow, states (4 findings merged)
- **Files:** `src/components/FlowDiagram/layout.ts`, `src/components/FlowDiagram/FlowDiagram.tsx`, `src/components/FlowDiagram/FlowMap.tsx`, `src/components/FlowDiagram/FlowDiagram.css`
- **Evidence:** tests/report/audit/flow-design/tour-light-1440.png; tests/report/audit/flow-design/tour-zoom-foot-light-1440.png; tests/report/audit/degraded-states/incident-before-flow-light-1440.png; tests/report/audit/degraded-states/incident-after-flow-light-1440.png; src/components/FlowDiagram/FlowMap.tsx:189-204
- **Design:** Three additions to one component: (1) route the (wIn - wOut) width of each s2 segment into a fourth pseudo-node at the bottom of the destination column so savings become a visible sink instead of a taper (hover lights every saving path); (2) join snapshot.incidents to ribbons by object key so a regressed pipeline gets a 1.5 px dashed --mr-high outline and a plate '-$25 / day since 11:42 - a1f3c9e', green for the 10-s recovery window, and ?object= opens its receipt card; (3) replace the shape-only legend with one chip per destination ('Splunk Cloud - $32,978 / day - $2.25/GB') whose click isolates that destination's paths. The map becomes the live stage for the break-the-trim demo as well as the Receipt.
- **Acceptance:** flow.spec.ts: the tour layout has a saved sink node whose height equals the sum of wedge widths; an injected incident marks its ribbon with the dashed class and a plate; clicking a destination chip dims every other ribbon.

#### P2-W17 · Inline saved bars per row, a dot-leader totals row, a three-tile money strip above the table, bidirectional table <-> timeline linking, and an end label on the Trend sparkline

- **Area:** Ledger / the ledger reads as a ledger · **Package:** WP-K · **Impact:** 4 · **Effort:** M · **Score:** 2.0 · **Lenses:** view-ledger (5 findings merged)
- **Files:** `src/components/LedgerTable/LedgerTable.tsx`, `src/components/LedgerTable/LedgerTable.css`, `src/views/Ledger/index.tsx`, `src/components/ChangeTimeline/ChangeTimeline.tsx`, `src/components/Sparkline/Sparkline.tsx`
- **Evidence:** tests/report/audit/design-ledger/table-light-1440.png; tests/report/audit/design-ledger/ledger-light-1440-full.png; tests/report/audit/design-ledger/table-head-zoom-light-1440.png; src/views/Ledger/index.tsx:158-179
- **Design:** A 4 px saved/whp bar under each Saved figure (green on the neutral track) so the table visually sorts itself; the totals row label 'Total - 6 flows ........' in Source Code Pro; a money strip (Would have paid - Paid - Saved per day with 24 h deltas) at metric-md under the title, replacing the '6 flows - saving $279 / day' line on the phone; hovering a row highlights that flow's contribution on the chart and hovering a diamond pulses the rows it names; the 60-minute sparkline ends with its last value and colours only the segment after the newest commit.
- **Acceptance:** ledger.spec.ts: every row has a bar whose width equals saved/whp within 2 px; hovering a row adds the highlight class to the chart overlay; the strip figures equal totals().

#### P2-W18 · 'What the room sees' thumbnail, a run-of-show receipt per scene, the lever becoming the countdown, a five-item lever ledger, and a haptic cue

- **Area:** Demo console / the remote judges remember · **Package:** WP-L · **Impact:** 4 · **Effort:** M · **Score:** 2.0 · **Lenses:** view-demo (5 findings merged)
- **Files:** `src/views/Demo/index.tsx`, `src/views/Demo/panels.tsx`, `src/views/Demo/StatusBar.tsx`, `src/views/Demo/DemoConsole.css`, `src/demo/scenes.ts`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/design-demo-console/zoom-empty-left-column-light-1440.png; tests/report/beauty/demo-scene-light-1440.png; tests/report/beauty/demo-waiting-light-390.png; tests/report/beauty/demo-incident-light-390.png; src/views/Presenter/HeroMeter.tsx; src/demo/scenes.ts (approxMinutes per step)
- **Gate:** day-1 slice: phone caption row + lever countdown + haptic (S); the projector thumbnail and run-of-show are day 2
- **Design:** Fill the empty main column with a live thumbnail of the presenter view (HeroMeter at 0.35 scale in a panel titled 'On the projector'; on the phone a one-line 'Projector: $1,234,567 - no alert' strip under the status line) so the person holding the remote never has to look up. A scene's steps as dot-leader lines ('Break the trim ........ 0:00', 'Alert lands ........ ~2:07', 'Restore ........ 4:00') with a moving caret, replacing the anonymous progress segments. After Break the trim the disabled red button becomes the timer ('Alert in ~1:40', tabular, red border) and flips to 'Restore' when the incident opens. A five-item history under the status line ('10:42 Break the trim - b3a6f5e - deployed - caught in 2:37') shows every lever is a real attributed commit. navigator.vibrate([40,60,40]) and a 1.2 s status flash when the incident opens.
- **Acceptance:** demo.spec.ts: the console's main column contains the projector panel with the hero figure; the bottom bar reads 'Alert in m:ss' after a break; the scene card lists timed steps; the lever ledger shows the last five levers with commit ids.

#### P2-W20 · A savings goal with pace on the MTD hero, a 'This week so far' receipt card with a preview of Monday's message, and a price-confidence badge

- **Area:** Receipt / goal, this week, confidence · **Package:** WP-H · **Impact:** 4 · **Effort:** M · **Score:** 2.0 · **Lenses:** scout, judge-cfo (3 findings merged)
- **Files:** `src/views/Receipt/HeroCard.tsx`, `src/views/Receipt/Sections.tsx`, `src/views/Settings/CostSection.tsx`, `core/settings.ts`, `core/goal.ts`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/feature-scout/shots/A-receipt-light-1440.png; tests/report/audit/feature-scout/shots/A-settings-notifications-light-1440.png; tests/report/audit/feature-scout/shots/A-story-receipt-dark-1440.png; tests/report/audit/cfo/A-math-drawer-text-1440.txt; src/views/Settings/model.ts:151 budgetPace; core/receipt.ts:54 buildWeeklyReceipt; core/weekly.ts
- **Gate:** HeroCard.tsx after the range fixer; CostSection/core/settings.ts fields via WP-G1
- **Design:** Three receipt-native additions. (1) One optional workspace goal ('Savings goal per month' in the Cribl cost card) and under the MTD hero a thin pace strip: filled = saved so far, dashed continuation = projection at the MTD rate, a rule for the goal, 'On pace for $612k by Sep 30 - goal $500k' in saved green or 'Behind pace by $40k' in warning; the presenter shows the same line. (2) A 'This week so far' card (row 3 under Top savers): buildWeeklyReceipt over Monday -> now via the range reader, 'vs prior week +16%', the top five lines, open alerts, 'Preview Monday's message' (SlackPreview) and 'Send now', so the leadership artefact exists in the app before Monday. (3) A pill by the caption: 'at preset prices (typical list)' until every money-carrying destination has a non-preset or committed price, then 'at your contract rates', with the same words on the receipts (answers the first CFO question before it is asked).
- **Acceptance:** e2e: with a goal set the MTD hero shows the pace strip and the caption names the goal; the weekly card's total equals receiptTextForRange(Monday..now); the badge text flips when every destination has a contract price.

#### P2-W23 · Treatment RadioTiles with their documented ranges, and a ranked 'Biggest unclaimed savings' receipt list above the calculator

- **Area:** What-if / packs as cards, unclaimed savings · **Package:** WP-J · **Impact:** 4 · **Effort:** M · **Score:** 2.0 · **Lenses:** view-whatif (2 findings merged)
- **Files:** `src/components/WhatIf/WhatIfPanel.tsx`, `src/components/WhatIf/useWhatIf.ts`, `core/whatif.ts`, `src/copy/en.ts`
- **Evidence:** tests/report/audit/whatif-design/08-treatment-open-light-1440.png; tests/report/audit/whatif-design/V4-scale-light-1440.png; src/components/WhatIf/useWhatIf.ts:197-211 streamOptions; core/whatif.ts:334 estimateTreatment; docs/platform/capra.md section 3.3 RadioTile
- **Gate:** first slice: a top-3 list from estimateTreatment over every stream x fitting pack (M); the full ranked page (L) is a follow-on
- **Design:** Replace the Treatment select + help line with Capra RadioTiles (Windows XML pack - Palo Alto + syslog - VPC Flow aggregation - Go aggressive - Custom drop) each showing its documented range, one-line description and 'runs on N streams here (33%)', disabled with a reason when the pack does not fit the source. Above the calculator a short receipt-style list computed for every stream x fitting pack ('Windows XML pack on Windows workstations ........ +$24,109 / year'), top 5 with dot leaders, each line loading the calculator via ?stream=&treatment=. The page then answers the platform owner's real question ('where is the biggest saving I have not taken?') in one glance and gives the demo a 'biggest first' beat.
- **Acceptance:** whatif.spec.ts: the treatment control is a radio group of tiles with ranges; an inapplicable tile is disabled with a caption; the unclaimed list's first line deep-links to the highest-estimate stream/treatment pair.

#### P2-W21 · A status popover with a 60-minute sweep sparkline and 'next sweep in 0:42', tab badges for open alerts and unpriced destinations, and a footer tear-off stub with the sweep strip

- **Area:** shell / live pulse, badges, footer stub · **Package:** WP-A · **Impact:** 3 · **Effort:** M · **Score:** 1.5 · **Lenses:** view-shell (3 findings merged)
- **Files:** `src/components/Shell/StatusCluster.tsx`, `src/components/Shell/TopNav.tsx`, `src/components/Shell/Footer.tsx`, `src/components/Shell/Shell.css`, `src/state/store.ts`
- **Evidence:** tests/report/audit/shell/notes3.json (status.cursor auto, title null); tests/report/audit/shell/footer-light-1440.png; tests/report/audit/shell/header-ledger-light-390.png; tests/report/audit/shell/select-typeahead-p-1440.png ('Alerts 1' on the page, nothing on the tab); src/components/Shell/TopNav.tsx:67-81; src/components/Shell/Footer.tsx:18-28; src/components/Shell/DiagPanel.tsx:58 openIncidents in state
- **Gate:** StatusCluster/Footer are WP-D's files: this package runs after WP-D lands
- **Design:** The status cluster becomes the app's live pulse: click/tap opens a Capra Popover with a 60-minute sparkline of sweep calls and duration (a small ring buffer in the store), who meters, 'next sweep in 0:42' counting down from pollSeconds / meta.lastSweepAt, and a Sweep now button; the dot ticks one frame on every landed sweep (none under reduced motion). It answers 'are these numbers current?' on every width and gives the phone its missing label. TabNav items carry a danger count on Ledger while alerts are open and an amber dot on Settings while destinations are unpriced. The footer shows version - build, who meters, and a 60-minute strip of sweep durations with 'next in 0:42' (one line 'Live - next sweep 0:42' on phones).
- **Acceptance:** e2e: clicking the status opens a popover whose countdown decreases; the Ledger tab shows the open-incident count from the snapshot; the footer countdown matches pollSeconds.

#### P2-W22 · A command palette (Cmd+K / ?) replacing the static shortcut sheet, and a view-transition into presenter/story mode

- **Area:** shell / command palette and the lights going down · **Package:** WP-A · **Impact:** 3 · **Effort:** M · **Score:** 1.5 · **Lenses:** view-shell, view-story (3 findings merged)
- **Files:** `src/components/common/ShortcutSheet.tsx`, `src/components/common/CommandPalette.tsx`, `src/components/Shell/Shell.tsx`, `src/views/Story/index.tsx`
- **Evidence:** tests/report/audit/shell/sheet-light-1440.png; tests/report/audit/shell/presenter-enter-100ms-dark-1920.png; src/lib/shortcuts.ts:21-49 (every action has a label); grep requestFullscreen src -> none
- **Gate:** src/views/Story/index.tsx (the stage=1 param and fullscreen) is loaned from WP-C
- **Design:** Cmd+K / ? opens a Capra Modal (sm) with a TextField and a react-aria ListBox: fuzzy search across tabs, pipelines and destinations ('windows' -> Ledger row, Flow node, Settings price), actions (Copy receipt, Show the math, Presenter, Story, Sweep now, Send test alert) and, in the demo build, the levers with their key caps; single letters only mean things inside the palette, which retires the shortcut conflicts for good. Entering presenter/story runs a 400 ms crossfade of the chrome and a FLIP of the hero number from the Receipt card to the stage via document.startViewTransition (data-callout=saved is on both), reduced motion cuts; a `?story=1&stage=1` param requests fullscreen, forces the dark stage and hides the cursor after 2 s for the booth loop.
- **Acceptance:** e2e: Cmd+K opens the palette, typing 'wind' lists the Windows flows and Enter navigates; pressing P shows a running view transition (document.startViewTransition called) unless reduced motion; ?story=1&stage=1 calls requestFullscreen on the entry click.

#### P2-W24 · 'changed by <user> at <time>' on price versions (window.getCriblUser) and a vendor-tile preset picker

- **Area:** Settings -> Prices / authorship and vendor grid · **Package:** WP-G1 · **Impact:** 3 · **Effort:** M · **Score:** 1.5 · **Lenses:** judge-cribl-pm, view-settings (2 findings merged)
- **Files:** `src/components/PriceTable/PriceTable.tsx`, `src/components/PriceTable/model.ts`, `src/views/Settings/PricesSection.tsx`, `core/types.ts`, `core/pricing.ts`
- **Evidence:** tests/report/audit/pm-cribl/evidence-b.json (C12 'Prices last changed 3 min ago'); tests/report/audit/design-settings/prices-preset-open-light-1440.png; core/types.ts:64-67 PriceVersion; grep getCriblUser src core -> demo code only
- **Gate:** core/types.ts PriceVersion.changedBy via INT
- **Design:** The platform hands the identity over for free and prices are the whole model: add changedBy (username) to PriceVersion and Settings writes, show it in the Prices footer and in a 'Price history' disclosure per destination, and carry the author into Show the math. Replace the 15-line wrapping listbox with a Popover grid of vendor monograms (two-letter tiles in the destination ramp) + name + typical $/GB, 'Suggested for this destination' pinned first, a search field, Internal / free last, type-ahead and arrow keys. Reads like a product and finishes P0-20.
- **Acceptance:** settings.spec.ts: after a save the footer reads 'changed by <mock user>'; the preset picker is a grid of tiles with the suggestion first and search filtering.

#### P2-W25 · A per-destination monthly statement drawer, an hour-of-week savings heatmap, the counterfactual drawn as a hatched ghost, and a tear-off animation on Copy receipt

- **Area:** Receipt / destination statement, heatmap, small delights · **Package:** WP-H · **Impact:** 3 · **Effort:** M · **Score:** 1.5 · **Lenses:** scout, view-receipt (4 findings merged)
- **Files:** `src/components/WhereMoneyGoes/WhereMoneyGoes.tsx`, `src/components/DestinationStatement/DestinationStatement.tsx`, `src/components/Heatmap/Heatmap.tsx`, `core/heatmap.ts`, `src/views/Receipt/HeroCard.tsx`
- **Evidence:** tests/report/audit/feature-scout/shots/A-receipt-light-1440.png; tests/report/audit/design-receipt/shots/zoom-wmg-chip-dark.png; tests/report/audit/design-receipt/shots/zoom-perforation-dark.png; core/rollups.ts:227 outputMonthTotals; core/types.ts:237,241,251,446-452; src/state/rangeReader.ts
- **Gate:** HeroCard.tsx after the range fixer
- **Design:** Click a destination in Where the money goes -> a statement drawer: this month vs last (paid, would have paid, saved, GB in/out) from totals.byOutputMonth, the budget line and pace, the counterfactual sentence, the price versions that applied, a 'Copy statement' in receipt form. A 7 x 24 SVG heatmap of saved $/hour (saved-tint ramp, top three cells labelled, weekend columns marked, hover gives the hour's three figures) from <= 8 hour documents through the cached reader, filterable per flow from the Ledger's ?object=. For archive-s3 extend the bar with a hatched ghost segment to siem-prod's would-have-paid length so 'Without Cribl -> siem-prod' becomes a shape. On Copy receipt, a cloned strip of the hero tears off along the perforation (300 ms, none under reduced motion) so the edge does work instead of being decoration.
- **Acceptance:** e2e: clicking a destination row opens the statement with two month columns whose paid figures equal totals.byOutputMonth; the heatmap renders 168 cells with the top three labelled; Copy receipt plays a transform animation on the hero clone unless reduced motion.

#### P2-W26 · Let the member pick any captured sample file from the group's sample library for the dry run, not only Datagen sources

- **Area:** What-if / dry run over the sample library · **Package:** WP-J · **Impact:** 3 · **Effort:** M · **Score:** 1.5 · **Lenses:** judge-cribl-pm (1 finding merged)
- **Files:** `core/adapters/preview.ts`, `src/components/WhatIf/WhatIfPanel.tsx`, `config/policies.yml`, `README.md`
- **Evidence:** tests/report/audit/pm-cribl/evidence-c.json (C5b 'No dry run: only Datagen Sources carry one'); core/adapters/cribl-urls.ts:31 samples() unused; README.md:100
- **Gate:** config/policies.yml and README via WP-N; a new GET grant needs the compliance test's declared list updated
- **Design:** On a real customer workspace (HEC, syslog, S3 sources) the measured basis never applies. GET /m/:gid/system/samples (already in cribl-urls.ts) lists captured samples; filter by source, let the member pick one, run the preview over it and show its basis as 'measured on <sample name>'. Declare the list GET in policies.yml and the README grant table.
- **Acceptance:** e2e with the emulator's sample list: the dry run offers a sample picker for a non-Datagen source and reports a measured ratio; compliance passes with the new GET declared.

#### P2-W28 · A tab's Leader-call budget made visible ('Leader calls in the last minute: 37 (sweep 23 - live 12 - range 1)') and a sweep read plan that skips documents the tab already holds

- **Area:** runtime / the Leader-call budget made visible · **Package:** WP-E · **Impact:** 3 · **Effort:** M · **Score:** 1.5 · **Lenses:** api-budget (2 findings merged)
- **Files:** `core/http.ts`, `src/state/store.ts`, `src/components/Shell/DiagPanel.tsx`, `src/views/Settings/RuntimeSection.tsx`, `src/state/runtime.ts`, `core/sweep.ts`
- **Evidence:** tests/report/audit/api-budget/warm-ratelimit-receipt-70s-light-1440.png; tests/report/audit/api-budget/receipt-default-1440.json (8 KV GETs before the metrics queries); core/sweep.ts:735-738; src/state/runtime.ts:141-164
- **Gate:** WP-E owns core/http.ts and core/sweep.ts; src/state/{store,runtime}.ts are loaned from WP-D, DiagPanel.tsx from WP-A, RuntimeSection.tsx from WP-G2; schedule after those packages' day-1 slices land
- **Design:** Judges will ask what the App costs their Leader; the footer shows only the last sweep's calls. Count calls per tab in createFetchHttp / createFetchKvStore (a ring of timestamps), expose the last-minute total by family through the store, render it in the diag panel and Settings -> Runtime, and print 'metered by the runner - this tab is read-only' when a runner is fresh. Let runLocal pass cached settings/prices (with updatedAt) to runSweep and re-read only when meta.lastSweepAt shows another writer (23 -> ~18 calls per tab sweep).
- **Acceptance:** e2e: the diag panel's calls-last-minute row equals the emulator journal's count within 2; a tab sweep with warm settings/prices makes <= 18 calls.

---

## 4. Proposed parallel implementation plan (Phase B)

### 4.1 Ground rules

- **One package = one builder = one git worktree = one disjoint file set.** A builder never edits a file outside its package's list. A one-line change in another package's file is marked **loaned** in the item's gate and is sent to that package's owner (or the integrator) as a patch, not committed in the borrower's worktree.
- **Shared files belong to the integrator (INT):** `src/copy/en.ts`, `src/lib/params.ts`, `core/types.ts`, `src/styles/*` (`palette.css`, `base.css`, `utilities.css`), `CHANGELOG.md`, `package.json`. Builders write their new copy keys and type fields into a `PATCH-<pkg>.md` at the worktree root; the integrator lands them on `dev` in one commit per package merge. The integrator also runs the gates (`npx tsc -b && npm run lint && npx vitest run && npx playwright test --project=chromium --project=chromium-1920 --project=mobile`, then firefox/webkit, then `npm run audit`) and packages demo 1.0.9+.
- **A day = 6 effort points** (S = 1, M = 2, L = 3). Packages over 6 points are split into day slices below; no slice exceeds 7 points (A-day1, C-day1 and F-day1 are the 7s).
- **Three workflows are in flight and gate files:** `critique-fixes` (wf_f18438fd: `core/detector.ts`, `core/types.ts`, `core/payloads.ts`, `TakeoverCard.tsx`, `IncidentCard/model.ts`, `Presenter/Gallery.tsx`, `Story/stages.tsx`), the **range fixer** (`core/range.ts`, `src/state/rangeReader.ts`, `src/views/Receipt/useRange.ts`, `RangePicker.tsx`, `HeroCard.tsx`, `Receipt.css`) and `report-card` (wf_04cd288d: `core/report*.ts`, `core/format.ts`, `en.ts`, later README/CHANGELOG). Gated slices start when the named merge lands; ungated slices start now.
- **Merge order on `dev`:** critique-fixes → range fixer → report-card → then the packages below in the order their gates clear, INT resolving `en.ts`/`CHANGELOG.md` conflicts at each merge.

### 4.2 Packages and file ownership

| Package | Owns (nothing else) | Items (effort) | Gate |
|---|---|---|---|
| **INT** (integrator) | `src/copy/en.ts`, `src/lib/params.ts`, `core/types.ts`, `src/styles/*`, `CHANGELOG.md`, `package.json`, merges and gates | P0-21 (S), P1-Y01 (S), P1-Y02 (S) plus every loaned one-liner | continuous |
| **WP-A** shell & keyboard | `src/components/Shell/{Shell.tsx,Shell.css,useShellEffects.ts,DiagPanel.tsx,TopNav.tsx}`, `src/lib/{shortcuts.ts,dom.ts}`, `src/components/common/{ShortcutSheet.tsx,Toasts.tsx,CommandPalette.tsx}`, `src/router.tsx`, `tests/e2e/keyboard.spec.ts`, `tests/e2e/shell.spec.ts` | A-day1: P0-05, P0-06, P0-09, P1-A06, P1-A02, P1-A03, P1-A04 (7) · A-day2: P1-A01, P1-A08, P1-A05, P1-A07 (6) · A-day3: P1-A09, P2-W21, P2-W22 (6) | none (P1-A01 borrows `tracker.ts` from WP-B; P2-W21 after WP-D) |
| **WP-B** presenter, takeover, meter | `src/views/Presenter/*`, `src/components/IncidentTakeover/*`, `src/components/Meter/*`, `src/components/QrBlock/*`, `src/components/RatioWatch/*` (new), `tests/e2e/presenter.spec.ts` | B-day1: P0-08, P0-14, P0-15, P0-16, P1-B03, P1-B05 (6) · B-day2: P1-B01, P1-B02, P1-B04, P2-W01 (6) · B-day3: P2-W19, P2-W03, P2-W04 (5) · B-day4: P2-W15 (2) | B-day1 now; B-day2+ after critique-fixes (`TakeoverCard.tsx`, `Gallery.tsx`) |
| **WP-C** story | `src/views/Story/*`, `src/story/*`, `demo/sample/story*.json` (regenerated), `VIDEO_SCRIPT.md`, `demo/sample/captions*`, `tests/e2e/story.spec.ts` | C-day1: P0-24, P1-C02, P1-C04, P1-C06, P1-C05, P1-C01 (7) · C-day2: P1-C03, P2-W11, P2-W12 (6) | after critique-fixes (`stages.tsx`); captions via INT; regenerate with `scripts/story.ts` |
| **WP-D** metering truth & status | `src/state/*` (except `rangeReader.ts`), `src/components/Shell/{status.ts,StatusCluster.tsx,Footer.tsx}`, `src/components/common/ErrorNotice.tsx`, `src/tour/selectors.ts`, `tests/unit/{selectors,status,hydrate}*.test.ts` | D-day1: P0-07, P1-D05, P1-D01, P1-D02, P1-D04 (6) · D-day2: P1-D06, P1-D03 (2) | none |
| **WP-E** core sweep & runner | `core/sweep.ts`, `core/adapters/{config.ts,cribl-urls.ts,webhook.ts}`, `core/kv.ts`, `core/http.ts`, `core/delivery.ts`, `scripts/runner*.{ts,sh}`, `.env.example`, `docs/RUNBOOK.md`, `tests/unit/sweep*.test.ts` | E-day1: P0-03, P0-02, P1-E05, P1-E02, P1-E03 (6) · E-day2: P1-E01, P1-E06, P1-E08, P1-E04 (6) · E-day3: P1-E07, P2-W28 (4) | none |
| **WP-F** core money & detector | `core/pricing.ts`, `core/detector.ts`, `core/snapshot.ts`, `core/receipt.ts`, `core/payloads.ts`, `core/incidents.ts`, `core/baseline.ts`, `core/strings.ts`, `core/format.ts`, `tests/unit/{pricing,detector,receipt,snapshot}*.test.ts` | F-day1: P0-23, P0-17, P1-F01, P1-F04, P1-F08, P1-F06 (7) · F-day2: P1-F07, P1-F02, P1-F03 (6) · F-day3: P1-F05, P1-F10 (4) | after critique-fixes and report-card (`detector.ts`, `payloads.ts`, `format.ts`) |
| **WP-G1** Settings → Prices | `src/components/PriceTable/*`, `src/views/Settings/{PricesSection.tsx,BudgetsSection.tsx,CostSection.tsx}`, `core/presets.ts`, `core/settings.ts`, `demo/rig/destinations.json`, `tests/fixtures/cribl/*`, `tests/e2e/settings.spec.ts`, `tests/unit/settings*.test.ts` | G1-day1: P0-04, P0-19, P0-20, P1-G01, P1-G04 (6) · G1-day2: P1-F11, P1-G03, P2-W09 (4) · G1-day3: P2-W24 (2) | none |
| **WP-G2** Settings frame, Alerts / Notify / Runtime | `src/components/EndpointEditor/*`, `src/components/SlackPreview/*`, `src/views/Settings/{NotificationsSection.tsx,AlertsSection.tsx,RuntimeSection.tsx,SweepNowButton.tsx,weekly.ts,shared.tsx,index.tsx,Settings.css,hooks.ts,model.ts}`, `tests/e2e/settings-notify.spec.ts` | G2-day1: P0-10, P1-G05, P1-G06, P1-G07, P1-G08 (6) · G2-day2: P1-G09, P1-G02 (2) | none |
| **WP-H** Receipt | `src/views/Receipt/{index.tsx,model.ts,Sections.tsx,text.ts}`, `src/components/{ReceiptList,WhereMoneyGoes,TrendChart,ReceiptBar,MathDrawer,IncidentCard,DestinationStatement,Heatmap}/*`, `core/goal.ts`, `core/heatmap.ts` (new), `demo/sample/tour.json`, `tests/e2e/receipt.spec.ts`; plus `HeroCard.tsx`, `RangePicker.tsx`, `Receipt.css`, `useRange.ts` once the range fixer lands | H-day1: P0-18, P1-H08, P1-H03, P1-F09, P1-H07 (6) · H-day2: P1-H01, P1-H02, P1-F12, P1-H04 (6) · H-day3: P1-H05, P1-H06, P1-H09, P2-W20 (5) · H-day4: P2-W25, P2-W13 (4) | after the range fixer (`HeroCard.tsx`, `RangePicker.tsx`, `Receipt.css`, `useRange.ts` transfer to WP-H when it lands) and critique-fixes (`IncidentCard/model.ts`) |
| **WP-I** Flow | `src/components/FlowDiagram/*`, `src/views/Flow/*`, `core/humanize.ts`, `tests/e2e/flow.spec.ts` | I-day1: P1-I01, P1-I03, P1-I04, P1-I08, P1-I06 slice 1 (6) · I-day2: P1-I02, P1-I05, P1-I07 (5) · I-day3: P2-W02, P2-W10, P1-I06 slice 2 (6) · I-day4: P2-W16 (2) | none (`palette.css` via INT) |
| **WP-J** What-if | `src/components/WhatIf/*`, `core/whatif.ts`, `core/adapters/preview.ts`, `tests/e2e/whatif.spec.ts` | J-day1: P1-J01, P1-J02, P1-J04, P1-J03 (6) · J-day2: P2-W06, P1-F13, P2-W08 (6) · J-day3: P2-W23, P2-W26 (4) | none (P2-W08 after the range fixer) |
| **WP-K** Ledger | `src/components/{LedgerTable,ChangeTimeline,IncidentsRail,Sparkline}/*`, `src/views/Ledger/*`, `core/commitImpacts.ts`, `tests/e2e/ledger.spec.ts` | K-day1: P1-K01, P1-K03, P1-K04, P1-K02 (6) · K-day2: P1-K05, P1-K06, P2-W07, P2-W17 (6) · K-day3: P2-W14 (2) | none (P1-K02's `IncidentCard.tsx` line via WP-H) |
| **WP-L** Demo console | `src/views/Demo/*`, `src/demo/*`, `tests/e2e/demo.spec.ts` | L-day1: P1-L02, P1-L01, P1-L03, P2-W18 slice 1 (5) · L-day2: P2-W18 slice 2 (2) | none |
| **WP-M** first run, empty & loading | `src/views/FirstRun/*`, `src/components/common/{Loading.tsx,EmptyBlock.tsx,Ghost.tsx,common.css}`, `src/components/HowItWorks/*`, `src/tour/controller.ts`, `index.html` | M-day1: P1-M01, P1-M02, P2-W27 (3) | none |
| **WP-N** docs, pitch, packaging, policies | `README.md`, `PITCH.md`, `docs/POSTS.md`, `docs/LIVE_VALIDATION.md`, `docs/NOTIFICATIONS.md`, `docs/DESIGN_BRIEF.md`, `docs/PLATFORM_NOTES.md`, `CLAUDE.md`, `STATE.md`, `scripts/package.mjs`, `config/policies.yml`, `config/demo/policies.yml`, `tests/forbidden.txt`, `tests/compliance.test.ts`, `docs/evidence/` | N-day1: P0-01, P0-22, P0-11, P0-12, P0-13, P1-N02 (6) · N-day2: P1-N01, P1-N03, P1-N05, P1-N04 (6, N04 is ops on the org) | README/CHANGELOG after report-card merges; P1-N01 needs a deploy |
| **WP-O** emulator & test harness | `src/mock/*`, `testdata/*`, `tests/e2e/helpers/*`, `tests/e2e/{budget,notifications}.spec.ts`, `tests/unit/{copy-style,sampleRollups}.test.ts`, `core/sampleRollups.ts` | O-day1: P1-O01, P1-O02, P2-W05 (6) | none (W05's wiring lines via INT/WP-D) |
| **RANGE-FIXER** (existing) | `core/range.ts` and `src/state/rangeReader.ts` for the whole program; `src/views/Receipt/useRange.ts`, `RangePicker.tsx`, `HeroCard.tsx`, `Receipt.css` until its current pass lands (then WP-H) | api-budget F2 (hybrid read plan, debounce/abort, 429 policy; M), a11y 320 px toggle overflow (S), P1-H09's picker placement (S); loans `core/range.ts` to WP-H for P2-W13 | in flight |

Total: 16 builder packages + INT; 42 day-slices (file ownership verified at synthesis time by a throwaway script, not committed: every file an item touches is in its package's set, shared with INT, or named as a loan in the item's gate — 0 violations); **day 1 in parallel** runs A, B, D, E, G1, G2, I, J, K, L, M, N, O (13 builders) while C, F and H wait for their gates (C and F unblock when critique-fixes merges, H when the range fixer merges). The P0 list closes on day 1 except P0-17, P0-23 (F, after critique-fixes), P0-18 (H, after the range fixer) and P0-24 (C).

### 4.3 Suggested wave order

1. **Wave 1 (P0, day 1):** A-day1, B-day1, D-day1, E-day1, G1-day1, G2-day1, N-day1, then C-day1 / F-day1 / H-day1 as their gates clear. Integrator lands P0-21 first (the copy contradictions) so every builder's screenshots show the corrected strings. Gate run and demo 1.0.9 at the end of the wave; one rehearsal on the org following PITCH.md verbatim (P0-01, P0-13 acceptance).
2. **Wave 2 (P1, day 2):** A-day2, B-day2, C-day2, E-day2, F-day2, G1-day2, H-day2, I-day1, I-day2, J-day1, K-day1, L-day1, M-day1, O-day1, N-day2. Full matrix including firefox/webkit; a 3-lens review (correctness, design, truth) on the merged `dev`; demo 1.0.10 live.
3. **Wave 3 (P2, day 3+):** the wow slices in score order — W01/W19 (B), W02/W10 (I), W03/W04 (B), W05 (O), W06 (J), W07 (K), W08 (J), W09 (G1), W11/W12 (C), then the rest — each behind its acceptance test, each re-verified on the org before it is shown on stage. Stop taking P2 work Tuesday noon; Tuesday afternoon is rehearsal, packaging (release 1.0.0 / demo 1.0.N / Enterprise), `npm run audit`, README final, LIVE_VALIDATION final.

### 4.4 Acceptance for the program

- All 24 P0 acceptance tests pass on chromium, chromium-1920 and mobile; the org rehearsal lands the takeover from the Flow view via the scripted P press; `npm run audit` and compliance pass; no `_known` range item regressed.
- `tests/e2e/budget.spec.ts` (P1-O02) holds the tab under 40 calls/min steady and 15/min with a fresh runner.
- The packaged README renders on the Marketplace overview with a working hero image and no dead links.

---

## 5. What was rejected (or redirected) and why

| Finding(s) | Decision | Why |
|---|---|---|
| judge-cfo "recovered spike card arithmetic" ($152 → $119 next to $5,096/day; `after` overwritten on close) | **Redirected to `critique-fixes` (D47)** | Builder A is fixing exactly this (`recoveredTo` on `Incident`, cards read "76% → 49% · recovered to 89%"). Duplicating it here would collide on `core/detector.ts` and `core/types.ts`. |
| judge-cfo "dollars-% vs bytes-% labelling", "devnull · $2.25/GB rows", "Top five caption", `flow.hoverNow` | **Redirected to `critique-fixes` builder B** | Same in-flight workflow (Steve's 4:12 PM critique). |
| judge-cfo "board-pack export" (Markdown/HTML/PDF from Copy receipt), scout #8 "a paper receipt you can hand over (SVG download / print)" | **Redirected to `report-card` (wf_04cd288d)** | That workflow builds `core/report.ts`, a dependency-free PDF writer, HTML/CSV and a `/report` view with Download; it measured the iframe sandbox (downloads allowed, `window.print` not). P0-23's basis footer still applies to the text receipts and feeds the report. |
| api-budget F2 (custom-range reads: 31 GETs for 30 d, no debounce/abort, no 429 policy), a11y "period toggle overflows at 320 px", view-receipt "range popover covers the hero" | **Handed to the range fixer** (listed under RANGE-FIXER in 4.2) | They live in `core/range.ts`, `rangeReader.ts`, `RangePicker.tsx`, `Receipt.css`, which are under active churn; a second owner would only produce conflicts. Not in `_known`, so they are recorded here for that owner. |
| The four items in `tests/report/audit/_known/range-findings.json`; the video's QR URL 404 | **Excluded per the brief** | Already in the fixer's input / a known open decision for Steve. |
| copy "Import `t()` into `core/receipt.ts` and `core/payloads.ts`" | **Rejected as written; replaced by P1-F05's `core/strings.ts`** | `core/` must stay importable without `src/` (the runner and the Enterprise backend build from it); a core → `src/copy` import inverts the dependency. A `core/strings.ts` module re-exported by `en.ts` keeps one index of user-facing text without the inversion. |
| judge-sre "runner heartbeat monitor / no consumer of runner.heartbeat.json" | **Partly done since the lens ran; remainder kept as P1-E06** | The runner moved to the workhorse under launchd with the Automic job `meter-reader-runner-health` (every 5 min, critical through Wed). What is left is the single-instance guard, heartbeat `ok` semantics, the supervisor back-off and the RUNBOOK section. |
| judge-cfo "Cribl cost from credits" | **Rejected for 1.0** | D48 set the demo org's Cribl cost at the published $0.32/GB list ($4,380.97/month); a credits × rate model is a post-hackathon feature and the flat monthly field already produces "Net after Cribl" and "Paid for itself". |
| judge-cfo "preset coverage of 86 output types" (map every *_s3 type, add Dynatrace/Security Lake/XSIAM presets) | **Deferred (post-hackathon)** | M effort, no demo or judge-workspace exposure on a Standard-plan org; the fallback to 'internal' is disclosed. Worth doing before Marketplace listing. |
| judge-security "runner least privilege" (dedicated API credential with a custom role, token cache in tmpdir) | **Deferred (post-hackathon)**; RUNBOOK sentence only | Requires a Cribl role definition and a credential rotation that touches the org; not a build item for this week. |
| judge-sre "lock race: acquireLock is read-then-write-then-verify" | **No fix possible in-app** | A KV without compare-and-set cannot close the window; the verify-read is the best available guard (README:409). Recorded; the single-instance guard (P1-E06) removes the realistic trigger (two runners). |
| a11y "Capra primary buttons 3.26:1", "selected toggle 4.2:1", "TabNav focus ring", "SelectField name order (value before label)"; view-receipt "MTD 4.2:1" | **Upstream to Cribl (Capra); optional local mitigation noted** | These are Capra tokens and react-aria behaviour, not app CSS. P1-A09/P1-H* keep the app-owned focus ring and the light-theme selected label as local mitigations; the rest is a note to the Capra team. |
| judge-wow "video title card is 23 words" ; truth "VIDEO_SCRIPT no longer describes the rendered video" | **Title card: rejected (video v1 is filed); script: P1-N03 (document the rendered cut)** | Re-rendering the produced video for a title-card edit is not worth the risk this week; the script drift is fixed by documenting the rendered cut, not by re-cutting. Story-caption changes (P1-C02, P1-Y02) regenerate `story.json`/captions for the in-app loop; the filed video is re-rendered only if Steve asks. |
| view-whatif "capture artifact: plates detached from labels under `animations: 'disabled'`" | **Not a finding** | The lens itself verified 0 px drift in the DOM; the artifact is Playwright's, and audit scripts should not pass `animations:'disabled'` for SVG maps. |
| view-demo, view-shell, a11y items on the demo build's Demo Console that were reviewed from source only | **Kept, but flagged** | The dev server runs release flags, so the console was not driven; P1-L* acceptance tests run on the demo-build Playwright project (`VITE_MR_BUILD=demo`), which will catch source-only misreads. |
| judge-cribl-pm "story shows a Slack Block Kit card"; truth "Slack card is the runner's rendering" | **Split: caption fix in P1-Y02, live proof in P1-N04** | The honest fix is to exercise a real Slack target once (an admin creates it, Connect, test, screenshot) and then the claim is measured; until then the caption says "through a Cribl notification target". |
| scout #7 "scenario builder: several packs at once" | **Deferred (L effort)** | Exceeds a day-slice and changes `applyProjection`'s contract; P2-W23's ranked unclaimed list gives most of the demo value at M. |
| view-flow "What-if entry pushes the map below the fold" (L) | **Kept as P1-I06 but split** | Day-1 slice pins node order and unifies the toggle (S); the compact bar (M) is a day-3 slice. |
| view-ledger "phone card list nested scroll (F24 residual)" | **Deferred** | Only reachable with the quiet flows expanded (17 cards); window virtualization is M for a state the demo never reaches. |
| api-budget F8's member-context burst test; truth "unverified claims" (#1–#5) | **Kept as docs/ops items (P1-N05, P1-N03)** | They need one read-only burst and a few lookups, not code. |
| judge-cfo "sensitivity line (typical-range low/high)" | **Folded into P1-H07 / P2-W20's confidence badge** | Small enough to ride along with the math drawer work. |

### Appendix — method and verification

- **Inputs:** 23 lens reports (scores, verdicts) and their 457 findings, `STATE.md` (in-flight workflows and worktrees `../cc-meter-reader-wt-{incident,labels,report}`), `docs/review/*-3a.md` (prior fixes), `tests/report/audit/_known/range-findings.json`.
- **Spot checks against the tree** before tiering: `core/adapters/cribl-urls.ts:13` (`/master/groups`), `core/adapters/config.ts:203-204`, `src/components/Shell/useShellEffects.ts:35` (bubble-phase listener), `src/components/IncidentTakeover/tracker.ts:4-5,49`, `src/components/EndpointEditor/model.ts:110` (`channel:'webhook'`), `src/components/Shell/Shell.tsx:61-74` (Outlet in the presenter branch), `src/components/Shell/status.ts:21-36`, `core/sweep.ts:848-869`, `core/detector.ts:174,309,385` (`after` overwritten; in flight).
- **Verification of this document:** `EPIC_AUDIT.json` parses; 149 items (24 P0 / 97 P1 / 28 P2); every item has tier, id, area, files, effort, impact, acceptance; 609 evidence paths (`tests/report/audit/...`, `tests/report/beauty/...`, `docs/evidence/...`, `video/production/output/...`) were stat'ed and all exist; file ownership was checked mechanically (every file an item touches is in its package's set from 4.2, an INT-shared file, or named as a loan in the item's gate: 0 violations, 106 loans recorded); the 23 scorecard rows sum to 457 = 2/112/242/101; no item cites the QR 404 or a `_known` range finding; the markdown backlog is rendered from the JSON so counts cannot drift.
- **Effort points:** S = 1, M = 2, L = 3; a builder-day = 6.
- **Coverage bounds:** the demo build was not served on :5173 during the audit, so Demo Console items rest on source reading and the beauty PNGs; the Cribl iframe was not driven (only the plain dev page); Firefox/WebKit and real screen readers were not part of the a11y lens; the stage path's API budget (demo build + presenter + phone console + lever + runner) has never been measured.
