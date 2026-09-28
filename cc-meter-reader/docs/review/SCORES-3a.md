# Beauty scores — fresh-eyes critic pass (PRD 8.8, DESIGN_BRIEF)

Scored by a reviewer who had not seen the build before this pass. The job was to read it the way Cribl's design team would. The reviewer looked only at screenshots, plus a handful of measurements taken in the running app.

## Evidence basis

| | |
|---|---|
| Code under review | `dev` at `b87432a` → `2b7aad0` (HEAD moved during the pass: docs + ops only). Dirty in the tree while shooting: `core/rollups.ts`, `core/snapshot.ts`, `core/sweep.ts`, `core/types.ts`, `core/settings.ts`, `src/state/runtime.ts`, `src/lib/env.ts` (other builders). |
| Grid | `tests/report/beauty/*.png`, regenerated 26 Sep 03:59–04:10 ET by `npx playwright test --project=chromium --project=chromium-1920 --project=mobile` (202 passed · 43 skipped · 1 failed, see Open issues). Some `receipt-*` files were overwritten again at 04:10 by another builder's run. |
| Demo Console | `tests/report/beauty/demo-*.png`, from `demo.spec.ts` against a demo build (`VITE_MR_BUILD=demo`, port 5179): 7 of 7 passed. |
| Gap frames | `tests/report/beauty/critic/` holds 72 frames at DPR 1, all captured from a release build on port 5180: the takeover (live, delivered, recovery) at 390/1440/1920 × both themes; presenter above-the-fold; and above-the-fold frames of Receipt, Flow, What-if, Ledger, Settings/Prices, Settings/Alerts and Settings/Where to send alerts on the sample tour at all three widths, plus Settings full pages at 1920. The throwaway spec is `scratchpad/beauty/critic.spec.ts`. It is not part of the repo. |
| Measured | Rendered fonts come from CDP `getPlatformFontsForNode`: Open Sans and Source Code Pro both load, and no fallback font shows up anywhere, including SVG. The takeover occlusion boxes are listed under F1. The dark-theme Settings nav colours are listed under F4. |

Legend: **✓** pass · **✗Fn** fail (fix Fn in the catalogue below) · **·** line does not apply to this screen · **—** this cell was not inspected closely enough to score (never inferred) · **○** motion, which a still cannot show (the e2e specs cover it: odometer bounding box, reduced motion, 450 ms takeover).

Lines: **L1** one typographic system · **L2** numbers read instantly · **L3** four-colour money palette · **L4** motion · **L5** Flow drawn like a product · **L6** Ledger · **L7** every state designed · **L8** presenter at 1920 · **L9** phone console · **L10** Slack message · **L11** consistency · **L12** evidence.

## Score grid (screen × theme × width)

| Screen | Theme | W | L1 | L2 | L3 | L4 | L5 | L6 | L7 | L8 | L9 | L10 | L11 | L12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Receipt | dark | 390 | ✓ | ✓ | ✗F22 | ○ | · | · | — | · | · | · | ✗F8 | ✓ |
| Receipt | dark | 1440 | ✗F23 | ✓ | ✗F22 | ○ | · | · | — | · | · | · | ✗F7 ✗F8 | ✓ |
| Receipt | dark | 1920 | ✗F23 | ✓ | ✗F22 | ○ | · | · | — | · | · | · | ✗F7 ✗F8 | ✓ |
| Receipt | light | 390 | ✓ | ✓ | ✗F22 | ○ | · | · | — | · | · | · | ✗F8 | ✓ |
| Receipt | light | 1440 | ✗F23 | ✓ | ✗F22 | ○ | · | · | ✗F14 | · | · | · | ✗F7 ✗F8 | ✓ |
| Receipt | light | 1920 | ✗F23 | ✓ | ✗F22 | ○ | · | · | — | · | · | · | ✗F7 ✗F8 | ✓ |
| Presenter (rest) | dark | 390 | ✓ | ✓ | ✓ | ○ | · | · | — | · | · | · | ✗F13 | ✓ |
| Presenter (rest) | dark | 1440 | ✓ | ✓ | ✓ | ○ | · | · | — | · | · | · | ✗F13 | ✓ |
| Presenter (rest) | dark | 1920 | ✓ | ✓ | ✓ | ○ | · | · | — | ✓ | · | · | ✗F13 | ✓ |
| Presenter (rest) | light | 390 | ✓ | ✓ | ✓ | ○ | · | · | — | · | · | · | ✗F13 | ✓ |
| Presenter (rest) | light | 1440 | ✓ | ✓ | ✓ | ○ | · | · | ✗F2 | · | · | · | ✗F13 | ✓ |
| Presenter (rest) | light | 1920 | ✓ | ✓ | ✓ | ○ | · | · | — | ✓ | · | · | ✗F13 | ✓ |
| Presenter + takeover | dark | 390 | ✓ | ✓ | ✓ | ○ | · | · | · | · | · | · | ✗F3 ✗F8 | ✓ |
| Presenter + takeover | dark | 1440 | ✓ | ✓ | ✓ | ○ | · | · | · | ✗F1 | · | · | ✗F3 ✗F8 | ✗F28 |
| Presenter + takeover | dark | 1920 | ✓ | ✓ | ✓ | ○ | · | · | · | ✗F1 | · | · | ✗F3 ✗F8 | ✓ |
| Presenter + takeover | light | 390 | ✓ | ✓ | ✓ | ○ | · | · | · | · | · | · | ✗F3 ✗F8 | ✓ |
| Presenter + takeover | light | 1440 | ✓ | ✓ | ✓ | ○ | · | · | · | ✗F1 | · | · | ✗F3 ✗F8 | ✗F28 |
| Presenter + takeover | light | 1920 | ✓ | ✓ | ✗F3 | ○ | · | · | · | ✗F1 | · | · | ✗F3 ✗F8 | ✓ |
| Flow | dark | 390 | ✓ | ✓ | ✓ | ○ | ✗F9 | · | — | · | · | · | ✓ | ✓ |
| Flow | dark | 1440 | ✓ | ✓ | ✓ | ○ | ✗F9 | · | ✗F14 | · | · | · | ✗F7 | ✓ |
| Flow | dark | 1920 | ✓ | ✓ | ✓ | ○ | ✗F9 | · | — | · | · | · | ✗F7 | ✓ |
| Flow | light | 390 | ✓ | ✓ | ✗F9 | ○ | ✗F9 | · | — | · | · | · | ✓ | ✓ |
| Flow | light | 1440 | ✓ | ✓ | ✗F9 | ○ | ✗F9 | · | — | · | · | · | ✗F7 ✗F8 | ✓ |
| Flow | light | 1920 | ✓ | ✓ | ✗F9 | ○ | ✗F9 | · | — | · | · | · | ✗F7 ✗F8 | ✓ |
| What-if | dark | 390 | ✓ | ✓ | ✓ | ○ | ✗F9 | · | — | · | · | · | ✗F8 ✗F10 | ✓ |
| What-if | dark | 1440 | ✓ | ✓ | ✓ | ○ | ✗F9 | · | — | · | · | · | ✗F8 ✗F10 ✗F25 | ✓ |
| What-if | dark | 1920 | ✓ | ✓ | ✓ | ○ | ✗F9 | · | — | · | · | · | ✗F8 ✗F10 ✗F25 | ✓ |
| What-if | light | 390 | ✓ | ✓ | ✗F9 | ○ | ✗F9 | · | — | · | · | · | ✗F8 ✗F10 | ✓ |
| What-if | light | 1440 | ✓ | ✓ | ✗F9 | ○ | ✗F9 | · | ✓ | · | · | · | ✗F8 ✗F10 ✗F25 | ✓ |
| What-if | light | 1920 | ✓ | ✓ | ✗F9 | ○ | ✗F9 | · | — | · | · | · | ✗F8 ✗F10 ✗F25 | ✓ |
| Ledger | dark | 390 | ✓ | ✓ | ✗F22 | ○ | · | ✗F11 ✗F12 ✗F24 | — | · | · | · | ✗F8 | ✓ |
| Ledger | dark | 1440 | ✓ | ✓ | ✗F22 | ○ | · | ✗F11 ✗F12 | — | · | · | · | ✗F7 ✗F8 | ✓ |
| Ledger | dark | 1920 | ✓ | ✓ | ✗F22 | ○ | · | ✗F11 ✗F12 | — | · | · | · | ✗F7 ✗F8 | ✓ |
| Ledger | light | 390 | ✓ | ✓ | ✗F22 | ○ | · | ✗F11 ✗F24 | — | · | · | · | ✗F8 | ✓ |
| Ledger | light | 1440 | ✓ | ✓ | ✗F22 | ○ | · | ✗F11 ✗F12 | ✗F14 | · | · | · | ✗F7 ✗F8 | ✓ |
| Ledger | light | 1920 | ✓ | ✓ | ✗F22 | ○ | · | ✗F11 ✗F12 | — | · | · | · | ✗F7 ✗F8 | ✓ |
| Settings / Prices | dark | 390 | ✓ | ✓ | ✗F10 | ○ | · | · | ✓ | · | · | · | ✓ | ✓ |
| Settings / Prices | dark | 1440 | ✓ | ✓ | ✗F4 ✗F10 | ○ | · | · | — | · | · | · | ✗F4 ✗F7 | ✓ |
| Settings / Prices | dark | 1920 | ✓ | ✓ | ✗F4 ✗F10 | ○ | · | · | — | · | · | · | ✗F4 ✗F7 | ✓ |
| Settings / Prices | light | 390 | ✓ | ✓ | ✗F10 | ○ | · | · | ✓ | · | · | · | ✓ | ✓ |
| Settings / Prices | light | 1440 | — | — | — | ○ | · | · | — | · | · | · | ✗F7 | ✓ |
| Settings / Prices | light | 1920 | ✓ | ✓ | ✗F10 | ○ | · | · | — | · | · | · | ✗F7 | ✓ |
| Settings / Where to send alerts | dark | 390 | ✓ | · | ✗F10 | ○ | · | · | — | · | · | ✗F19 | ✓ | ✓ |
| Settings / Where to send alerts | dark | 1440 | ✓ | · | ✗F4 ✗F10 | ○ | · | · | ✓ | · | · | ✗F19 | ✗F4 ✗F7 | ✓ |
| Settings / Where to send alerts | dark | 1920 | ✓ | · | ✗F4 ✗F10 | ○ | · | · | — | · | · | — | ✗F4 ✗F7 | ✗F28 |
| Settings / Where to send alerts | light | 390 | ✓ | · | ✗F10 | ○ | · | · | — | · | · | ✗F19 | ✓ | ✓ |
| Settings / Where to send alerts | light | 1440 | ✓ | · | ✗F10 | ○ | · | · | ✓ | · | · | ✓ | ✗F7 | ✓ |
| Settings / Where to send alerts | light | 1920 | ✓ | · | ✗F10 | ○ | · | · | — | · | · | — | ✗F7 | ✗F28 |
| First run | dark | 390 | ✓ | · | ✓ | ○ | · | · | ✓ | · | · | · | ✗F20 | ✓ |
| First run | dark | 1440 | ✓ | · | ✓ | ○ | · | · | ✓ | · | · | · | ✗F20 | ✓ |
| First run | dark | 1920 | ✓ | · | ✓ | ○ | · | · | ✓ | · | · | · | ✗F20 | ✓ |
| First run | light | 390 | ✓ | · | ✓ | ○ | · | · | ✓ | · | · | · | ✗F20 | ✓ |
| First run | light | 1440 | ✓ | · | ✓ | ○ | · | · | ✓ | · | · | · | ✗F20 | ✓ |
| First run | light | 1920 | ✓ | · | ✓ | ○ | · | · | ✓ | · | · | · | ✗F20 | ✓ |
| Tour (Receipt + band, dialogs) | dark | 390 | ✓ | ✓ | ✗F5 | ○ | · | · | ✗F5 | · | · | · | ✗F5 | ✓ |
| Tour (Receipt + band, dialogs) | dark | 1440 | ✓ | ✓ | ✗F5 | ○ | · | · | ✓ | · | · | · | ✗F7 ✗F18 | ✓ |
| Tour (Receipt + band, dialogs) | dark | 1920 | ✓ | ✓ | ✗F5 | ○ | · | · | ✓ | · | · | · | ✗F7 | ✓ |
| Tour (Receipt + band, dialogs) | light | 390 | ✓ | ✓ | ✗F5 | ○ | · | · | ✗F5 | · | · | · | ✗F5 | ✓ |
| Tour (Receipt + band, dialogs) | light | 1440 | ✓ | ✓ | ✗F5 | ○ | · | · | ✓ | · | · | · | ✗F7 ✗F18 | ✓ |
| Tour (Receipt + band, dialogs) | light | 1920 | ✓ | ✓ | ✗F5 | ○ | · | · | ✓ | · | · | · | ✗F7 | ✓ |
| Demo Console | dark | 390 | ✓ | ✓ | ✗F15 | ○ | · | · | ✓ | · | ✗F6 ✗F15 | · | ✗F15 | ✓ |
| Demo Console | dark | 1440 | ✓ | ✓ | ✗F15 | ○ | · | · | ✓ | · | · | · | ✗F15 | ✓ |
| Demo Console | dark | 1920 | ✓ | ✓ | ✗F15 | ○ | · | · | — | · | · | · | ✗F15 | ✓ |
| Demo Console | light | 390 | ✓ | ✓ | ✗F15 | ○ | · | · | ✓ | · | ✗F6 ✗F15 | · | ✗F15 | ✓ |
| Demo Console | light | 1440 | — | — | — | ○ | · | · | ✓ | · | · | · | — | ✓ |
| Demo Console | light | 1920 | ✓ | ✓ | ✗F15 | ○ | · | · | — | · | · | · | ✗F15 | ✓ |
| Incident card | dark | 390 | ✓ | ✗F17 | ✗F10 | ○ | · | · | · | · | ✓ | · | ✗F8 ✗F16 | ✓ |
| Incident card | dark | 1440 | ✓ | ✗F17 | ✗F10 | ○ | · | · | · | · | · | · | ✗F8 ✗F16 | ✓ |
| Incident card | dark | 1920 | — | ✗F17 | — | ○ | · | · | · | · | · | · | — | ✓ |
| Incident card | light | 390 | ✓ | ✗F17 | ✗F10 | ○ | · | · | · | · | ✓ | · | ✗F8 ✗F16 | ✓ |
| Incident card | light | 1440 | ✓ | ✗F17 | ✗F10 | ○ | · | · | · | · | · | · | ✗F8 ✗F16 | ✓ |
| Incident card | light | 1920 | ✓ | ✗F17 | ✗F10 | ○ | · | · | · | · | · | · | ✗F8 ✗F16 | ✓ |
| Slack preview | dark | 390 | ✓ | ✓ | ✓ | · | · | · | · | · | · | ✗F19 | ✗F19 | ✓ |
| Slack preview | dark | 1440 | ✓ | ✓ | ✓ | · | · | · | · | · | · | ✗F19 | ✗F19 | ✓ |
| Slack preview | dark | 1920 | — | — | — | · | · | · | · | · | · | — | — | ✓ |
| Slack preview | light | 390 | ✓ | ✓ | ✓ | · | · | · | · | · | · | ✗F19 | ✗F19 | ✓ |
| Slack preview | light | 1440 | ✓ | ✓ | ✓ | · | · | · | · | · | · | ✓ | ✓ | ✓ |
| Slack preview | light | 1920 | — | — | — | · | · | · | · | · | · | — | — | ✓ |

Tier 0 screens with an ✗: **Presenter + takeover (F1, F3)** and **the incident card (F17, F8, F16)**. Under PRD 8.8 item 12 the checkpoint is therefore not green.

## Fix catalogue

Each fix gives the file or component, the property and value, and why. Fixes F1–F15 are the ranked top 15 below. Selectors are the ones in the tree at the time of the pass.

**F1 · The takeover covers the stage it is meant to sit under (Tier 0 payoff frame).** Measured with the spec's own fixture:
- **1920×1080:** card top 540. Saver row 4 "Payments API sampling" (503–546) is sliced, and row 5 (558–601) is hidden. The hero caption "annualized run rate…" (538–575) is hidden. The QR vote caption `.mr-qr-caption` (top 960, right 1584 = card right) is hidden.
- **1440×900:** card top 450. Row 5 (454–486) is hidden. The caption (439–466) is cut in half through its letters. The vote caption is hidden.

So the audience sees half a line of text and loses the vote ask exactly at the payoff. `presenter.spec.ts` asserts `card.y <= 541` and `card.y >= figure bottom`, so the card must not move. Fix the stage instead, in `src/views/Presenter/Presenter.css`:
- (a) Make the stage's upper content end above 50 vh. Set `.mr-pv-hero, .mr-pv-savers { align-self: start; }` and give the middle row a top pad (`.mr-presenter` `grid-template-rows: auto auto 1fr auto` plus `padding-top: clamp(24px, 6vh, 96px)` on row 2). Hero, caption and list then end near 450 px at 1080 and near 380 px at 900. Alternatively, when an alert is up, set `.mr-presenter:has(.mr-takeover--alert) .mr-pv-savers { opacity: 0; transition: opacity var(--mr-duration-fast); }`.
- (b) Move `.mr-qr-caption` into the QR column, above the plate: in `src/components/QrBlock/QrBlock.css`, set `flex-direction: column; align-items: flex-end; max-width: var(--mr-pv-qr)`. The card stops at the QR's left edge, so the vote ask is never covered.
- (c) Add an assertion that no `.mr-pv-item`, `.mr-pv-caption` or `.mr-qr-caption` box intersects `.mr-takeover`.

**F2 · The presenter empty state is a 140 px grey "$0"** (`presenter-empty-light-1440.png`). On a projector that reads as "Cribl saved nothing". In `src/views/Presenter/index.tsx`, when `.mr-pv-figure--muted` is set, render `$—` at 40 % opacity, or render `.mr-pv-figure-skeleton`. Change the caption to "Set prices to start the meter". Never show a display-size zero.

**F3 · The recovery takeover is not "the same card in green".** It is bottom-anchored and about 190 px tall, while the alert card is 476 px from y=540. Its sub-line repeats "Savings dropped: Payments API sampling" directly under "Recovered…", which contradicts the title. In light theme it is white on white with a 4 px green sliver, so it disappears on a projector.
- In `IncidentTakeover.css`, set `.mr-takeover--overlay.mr-takeover--recovered { min-height: calc(50vh - var(--mr-takeover-inset-bottom)); background: var(--mr-fill-saved-subtle); }`.
- In `TakeoverCard.tsx`, change the recovery sub-line to "Payments API sampling · $25 a day back · closed 3:02 AM".

**F4 · Dark-theme Settings nav: the active item is a near-white pill.** Measured on the `A.capra-VerticalNavigation…item` with `.mr-settings-nav-active`: background `rgb(237, 251, 251)`, text `rgb(0, 64, 64)`. It is the brightest element on a dark page, on every Settings screen.
- `src/views/Settings/Settings.css:56` forces `color.foreground.brand.strong`, a colour meant for light surfaces. The pale background is Capra's selected state. Either stop forcing the class and use the Capra default, or set it for both themes: `background: token('color.background.accent.selected'); color: token('color.foreground.default');`.
- Check both themes with the contrast walker afterwards.

**F5 · The SAMPLE DATA band is broken on phones and off-palette everywhere.**
- **Layout:** `src/components/common/common.css` `.mr-sample-band` switches to `flex-wrap: wrap` at ≤640 px. The 8 px dot then sits alone on row 1, the text wraps to leave "traffic." as an orphan, and the button takes row 3. The band ends up about 90 px tall, roughly 11 % of the phone viewport, on every tour screen, which is the judges' first 30 seconds. Fix: `display: grid; grid-template-columns: auto 1fr auto; align-items: center; column-gap: token('spacing.md')`. At ≤640 px use `grid-template-columns: auto 1fr` with the button in `grid-column: 2`, and use shorter copy on phones: "Sample data · nothing is written".
- **Colour:** it uses `color.background.highlight.*`, a purple that is a fifth hue. The brief (§5.6) specifies a subtle stripe in `color.background.warning.subtle`: `background: repeating-linear-gradient(135deg, token('color.background.warning.subtle') 0 8px, transparent 8px 16px)`. The header status dot should use the same neutral or warning colour.

**F6 · On the phone remote, the Demo tab is cut off ("Der").** `src/components/Shell/Shell.css` `.mr-topnav { overflow-x: auto; scrollbar-width: none }` scrolls six tabs with no affordance, so the tab the phone is used for is cut off at 390 px.
- In `TopNav.tsx`, on route change call `activeTab.scrollIntoView({ inline: 'nearest', block: 'nearest' })`.
- In `.mr-topnav`, add `mask-image: linear-gradient(90deg, #000 calc(100% - 24px), transparent)` when it overflows.
- In the demo build at ≤439 px, list "Demo" first.

**F7 · The page frame jumps between tabs.** The max-widths differ:
- Receipt: 1280 px (`Receipt.css` `.mr-receipt`)
- Settings: 1280 px
- Demo: 1200 px (`DemoConsole.css:13`)
- Flow, Ledger, What-if: 1600 px (`Shell.css:107`, `FlowScreen.css:8`)

At 1440 the page title sits at x=24 on Flow, Ledger and What-if, and at x=80 on Settings and the Receipt card. Switching tabs moves the whole left edge. The Receipt is also the only tab without a page title.
- Use one `.mr-page` container: `max-width: 1440px; margin-inline: auto; padding-inline: token('spacing.xl')`. Views can narrow their inner grid, but never the outer edge.
- Either every tab gets a `heading.lg` title or none does.

**F8 · The card system is not one system.**
- **(a) Shadows:** in light theme, Receipt cards are flat (1 px border only), while Flow, Ledger, Settings and What-if cards carry `shadow.low.down`. Incident cards inside the Alerts panel and the Ledger rail carry a second shadow, so shadowed cards sit inside shadowed cards.
- **(b) Severity stripe:** `.mr-inc::before` (`IncidentCard.css:21`) and `.mr-takeover::before` (`IncidentTakeover.css:34`) draw a 4–8 px severity stripe clipped by `radius.xl`. That is the most recognisable template tell there is, and on the takeover it curves at both corners.
- **(c) Dashed containers:** What-if puts dashed borders on containers, not only on projections (`WhatIf.css:12` `.mr-whatif`, `:188` preview card). Dashed is supposed to mean "projected".
- **(d) Ledger rail selection:** the selected alert in the rail stacks a 2 px blue ring, a red stripe and a shadow.

Fix:
- One `.mr-panel` rule for all cards: `border: 1px solid var(--mr-border-subtle); border-radius: token('radius.xl'); box-shadow: token('shadow.low.down')`.
- Nested cards get `box-shadow: none; background: token('color.background.neutral.subtle')`.
- Replace the stripe with the severity glyph plus a full-bleed header row in `--mr-fill-incident-*-subtle`.
- Dashed only on `.mr-flow-outline` and projected ribbons.
- Rail selection becomes `background: token('color.background.accent.selected')` with no ring.

**F9 · The Flow map is a plot, not a product, once there are real flows.**
- On the sample tour (28 flows) the map runs past the fold at 1440 and at 1920, so it is not "one picture".
- More than 12 `$2–$9 / day` plates stack in one column over crossing ribbons. "$36 saved" and "$40 saved" chips float between unrelated ribbons.
- The biggest shape on "the dollar map" is the S3-archive passthrough at $45/day.
- In light theme, `.mr-flow-band { fill-opacity: 0.4 }` (`FlowDiagram.css:146`) over the pastel ramp gives pink, lavender and mint that a projector will wash out.
- The legend swatch "Sent, priced at the destination" is siem-prod's pink, which implies every sent flow is pink.
- At 390 px the saved chips sit away from the ribbons they belong to.

Fix, in `FlowMap.tsx` / `FlowDiagram.css`:
- Fit the layout height to `min(content, innerHeight − header − 120)`.
- Fold flows under 2 % of would-have-paid into "Other · n flows" per source and destination.
- Draw a ribbon's `$ / day` plate only when the ribbon is at least 12 px thick. Thinner ribbons show it on hover or focus.
- Scale band opacity by price, e.g. `fill-opacity: clamp(0.2, 0.3 + 0.1 × $/GB, 0.6)`, so cheap passthrough fades back.
- In light theme set `fill-opacity: 0.55`.
- Change the legend swatch to a neutral band.
- At ≤640 px, replace the Sankey with a ranked list (source → destination, $/day, a saved-wedge mini bar) and put the map behind a "Show map" toggle.

**F10 · Colour is spent on chrome, not money.**
- Green for status: "Test alert sent (200)", "priced" and "declared" chips, "Pack applied", the "Ready" ring and the "No open alerts" dot.
- Red for non-incident states: "Remove", "Trim broken", and "Delivery blocked: host not authorized", which appears in red on an amber, medium-severity card.
- Blue info pills: "1-minute confirmation (demo profile)…".
- Purple for the sample state.
- ALL-CAPS letter-spaced chips: "SIMILAR STREAM", "PROJECTION" (`WhatIf.css:174`, `FlowDiagram.css:59`, `:329` `text-transform: uppercase`). These break the sentence-case rule.

The brief makes saved green the only green, and red and amber mean incident severity and nothing else. Fix:
- Statuses become neutral text with a check or dot glyph in `color.foreground.subtle`.
- Delivery problems use the incident's own severity colour, or neutral.
- Info notes become plain captions.
- Remove `text-transform: uppercase` and `letter-spacing` from those chips, so they read "Projection" and "Similar stream".

**F11 · The Ledger is mostly noise.** With the demo data, 7 of the 11 visible rows at 1440 (9 of 13 at 1920) are `0 B · $0 · No traffic` flows. They have raw-id labels ("Http", "In cribl http", "In splunk tcp", "Main", "Devnull"). Source and Route cells are truncated ("Windows DC security ev…") while Reduction and Trend have room to spare.
- `views/Ledger`: filter to "has traffic" by default, with a footer row "9 flows with no traffic · Show".
- Humanize internal ids ("Cribl HTTP (internal)"). N22 says `cribl`/`criblmetrics` inputs should be excluded anyway.
- `LedgerTable.css`: set column minimums of Source 18 %, Route 14 %, Pipeline 16 %.

**F12 · The change timeline hides its own story.** In the 24 h window, the whole regression (three commit diamonds, the dip and the spike) sits in the last ~15 px at the right edge. The diamonds overlap, and the red "named by an alert" diamond sits on top of the blue ones.
- `ChangeTimeline.tsx`: default the range to `[first marker − 30 min, now]` whenever every marker falls in the last 10 % of the range, or add a "1 h" option and pick it automatically.
- Stagger coincident diamonds into rows 6 px apart.

**F13 · The dot leaders don't read like a receipt.**
- **Presenter:** `.mr-pv-item-amount .mr-num { min-width: calc(var(--mr-pv-amount-ch, 6) * 0.62em) }` (`Presenter.css:270`) leaves a 20–60 px hole between the last dot and shorter amounts ($912, $640, $388, $121). `.mr-pv-leader { direction: rtl; overflow: hidden }` also clips the first dot into a fragment, which is visible before "CDN log aggregation".
- **Receipt:** `.mr-rlist-leader` (`ReceiptList.css:53`) is anchored on the left, so each row's dots stop somewhere different ("sampling . . .$640" touches the amount; "pack . . .  $400" leaves a gap).
- **Settings / Cribl cost:** leaders are solid rules, and it prints "-$35" with a hyphen instead of a minus sign.

Fix:
- Delete the presenter `min-width`. The flex row already right-aligns amount and unit.
- `.mr-rlist-leader { direction: rtl; padding-inline-end: 0.5ch; mask-image: linear-gradient(90deg, transparent 0 0.8ch, #000 0.8ch) }`.
- CostSection reuses ReceiptList and prints `−` (U+2212).

**F14 · Empty and waiting states are generic or thin, where the brief asks for "skeleton matching final layout".**
- The Receipt "Waiting for the first sweep" state is a stock sleeping-cloud illustration in a lone card, with about 700 px of blank page under it.
- Ledger "No flows yet" uses a stock folder illustration.
- The timeline empty state is a dashed box. The Alerts empty state is a dashed box with a green dot.
- Flow empty is text in an empty card.
- The 403 state says "Everything else on this page still works" over an otherwise blank page.

Fix, in `components/common/EmptyBlock.tsx`: use one pattern everywhere, a 40 % ghost of the real component plus one sentence and one action. That means the hero with `$—` and an empty receipt bar, three skeleton ledger rows, and a grey outline Sankey. Drop the illustrations. Render the other Receipt sections with their own states in 403, or change the copy.

**F15 · The Demo Console shows its scaffolding.**
- "Tier 2" chips (`panels.tsx:217`, `demo.tier2`) are planning jargon.
- "Budget pace · Needs a budget lever; not in this build" shows unfinished work.
- The disabled "Break the trim" is a filled grey block, which reads as more prominent than the enabled outline buttons.
- At desktop the status bar sits above the page title.
- A blue info pill repeats the demo-profile note that the incident card already carries.

Fix:
- Remove the tier chips, and hide scenes that are unsupported in this build.
- `DemoConsole.css`: disabled buttons keep the outline and use `color.foreground.disabled`, with no fill.
- At ≥900 px, put the status line in the header row to the right of "Demo Console". Keep it pinned on phones.
- Drop the info pill.

**F16 · The incident card's internal hierarchy.**
- The full card puts `$25 a day · $9,125 a year` bottom-right on the caption's baseline, cut off from the ratio. PRD 8.1 puts the money line first.
- The compact card stacks six lines in four weights and two link styles ("View in Ledger" underlined, "Show the Slack message ›").
- The Receipt's Alerts card wraps "Savings dropped: / Payments API sampling" to two lines next to a timestamp.

Fix, in `IncidentCard.css`:
- Put the money line directly under the ratio, left-aligned, in body-lg semibold.
- Compact card, in this order: glyph + title (1 line, ellipsis) · money line · commit line · one footer row with both actions as tertiary buttons.

**F17 · The cost-spike card annualizes a three-minute spike: "$35,808 a day · $13,069,920 a year".** Anyone in the room will laugh at an eight-figure yearly number. `core` payloads / `IncidentCard`: for `type: 'spike'`, show "$1,492 an hour above baseline · $35,808 if it runs a day" and drop the yearly figure.

**F18 · Tour toast and modals.**
- A high-severity regression toast uses the amber warning triangle, while cards use the red "!" square.
- The toast sits above the modal backdrop and covers the header status.
- The "Slack message sent…" and "Weekly receipt" modals are pinned about 64–90 px from the top instead of centred, and they cover the Receipt header row.

Fix: `Toasts.tsx` should map severity through `SeverityGlyph`, with z-index below the modal backdrop and `top: calc(header height + spacing.md)`. `TourDialog.tsx` should centre the dialog vertically.

**F19 · Slack preview.**
- **Dark avatar:** `.mr-slack-avatar` uses `color.neutral.12` / `neutral.1`, which flip in dark to a white "MR" tile, the brightest thing in the card. Use `background: token('color.background.neutral.solid.default')` with its on-solid foreground.
- **390 px, header glyph:** the glyph wraps onto its own line. Make `.mr-slack-header` `display: flex; gap: token('spacing.sm')` and give the glyph `flex: none`.
- **390 px, commit text:** it breaks mid-word ("mrd_pay_sam/ple"). Use `overflow-wrap: break-word; word-break: normal`.
- **390 px, weekly receipt:** the mono block shrinks to about 9 px. Keep it at 12 px with `overflow-x: auto`, because Slack does the same.

**F20 · First run.** The four "How it works" icons mix Cribl's filled product glyphs (`Stream`, `Destinations`) with outline icons (`ChartArea`, `BellOutlined`) (`HowItWorks/steps.ts`). Also, `.mr-fr-actions { grid-template-columns: repeat(2, 1fr) }` makes the primary and secondary buttons the same width, which flattens the choice. Use four icons from one family at one weight, and `grid-template-columns: auto auto; justify-content: start`.

**F22 · Blue underlined links as a fifth colour.** "See every flow in the Ledger", "View in Ledger" (×2 per card), "Set a price", "Show in table" and "What if…" appear across the money screens. On dark they read as browser-default links. Use Capra's subtle or neutral link style (underline on hover), and keep accent colour for one CTA per card. "What if…" should be a button: "Open What-if".

**F23 · Two type families on one meta line, plus a one-off size.**
- "splunk_hec · $2.50 / GB · $3,450 saved" mixes a mono id with sans text (`WhereMoneyGoes`).
- `.mr-rlist-per { font-size: 0.86em }` computes to 12.04 px next to 12 px captions.

Pick one family per line (sans with the id in subtle), and use `typography.body.sm` for units.

**F24 · Ledger on the phone.**
- The card list is a nested scroll region: the sixth card is cut off at the panel edge and the page scrolls inside the page.
- No-traffic cards read "Reduction — —" and carry the title "Main".

At ≤640 px, virtualize against the window (no fixed-height container), print a single "—", and title those cards with the source name.

**F25 · What-if grid alignment.** At 1440 the Treatment select ends at x≈965, the before/after strip at 927, and the "would read" card starts at 952. Nothing shares an edge. Put the controls on the same 12-column grid as the strip below: Stream spans 6 columns, Treatment 3, and the preview card starts at column 9.

**F28 · Evidence gaps.**
- `takeover-*-1440` and `settings-notifications-*-1920` exist only in `critic/`.
- Several specs write fixed `-1440` file names without gating on `project.name === 'chromium'` (`receipt.spec.ts:434/548/581/589`, `flow.spec.ts:144/146/212/217/227`; `ledger.spec.ts` already gates correctly). When the mobile project runs, it overwrites them with 390-wide DPR-3 images (seen: `receipt-state-403-light-1440.png` at 1170×2532), so what the grid shows depends on which project ran last.
- Gate every `-1440` shot on the chromium project, and add the two missing shots to `presenter.spec.ts` and `settings.spec.ts`.

Softer notes (not scored as ✗):
- **N1:** the Receipt hero leaves the right 55 % of the card empty at 1440 and 1920. Balance it by putting `Net after Cribl · Paid for itself` right-aligned on the caption row.
- **N2:** at rest, the presenter stage's lower-left quadrant (y 620–1030 at 1920) is empty, and the radial glow is invisible on a dark projector.
- **N3:** the dark takeover card (panel on application background) has almost no edge contrast on a projector. The F8 header band fixes this too.

## Top 15 highest-impact visual fixes (ranked)

1. **F1:** the takeover card covers saver rows 4–5, the hero caption and the QR vote caption at 1440 and 1920 (measured). The fix constrains the stage, not the card, so the existing spec stays green.
2. **F2:** the presenter empty state is a 140 px grey "$0". Show `$—` or a skeleton with "Set prices to start the meter".
3. **F3:** the recovery takeover should be the same card, same size, tinted `--mr-fill-saved-subtle`, with a sub-line that does not say "Savings dropped".
4. **F4:** the dark-theme Settings nav active item is rgb(237, 251, 251) with teal text. Fix it in `Settings.css:56`.
5. **F5:** the sample band on phones: dot orphaned, text orphaned, about 90 px tall. Also switch it from purple to the brief's striped warning.subtle.
6. **F6:** the Demo tab is cut off on the 390 px phone remote. Scroll it into view, add an edge fade, and list Demo first.
7. **F7:** one page frame, so left edges and titles stop jumping between tabs (1200, 1280 and 1600 px containers today).
8. **F8:** one card elevation. No nested shadows, no rounded severity stripes, and dashed borders only for projections.
9. **F9:** Flow: fit the viewport, aggregate small flows, draw $ plates only on ribbons 12 px or thicker, fade cheap passthrough, raise light-theme ribbon opacity, and use a list on phones.
10. **F10:** colour discipline. Green only for money, red and amber only for severity, no blue info pills or purple states, and chips in sentence case.
11. **F11:** Ledger defaults to flows with traffic, collapses the rest into one row, and humanizes internal ids.
12. **F12:** the change timeline auto-zooms to the window around its markers and staggers coincident diamonds.
13. **F13:** the dot leaders run to each amount. Remove the presenter's fixed-width amount, right-anchor the Receipt leaders, and use a real minus sign in the cost receipt.
14. **F14:** one empty-state pattern: a ghost of the real layout plus one line and one action, with no stock illustrations. Fix the 403 copy.
15. **F15:** Demo Console hygiene: no "Tier 2" chips or "not in this build" rows, outline-style disabled buttons, and the status line in the header on desktop.

## Verdict: would this win a design review?

**Not yet, but it is close.**

The Receipt and the presenter at rest already look better than most of what Cribl ships:
- The money palette is restrained.
- The perforated receipt edge and mono dot leaders give the product a real identity.
- The type system is clean (measured: Open Sans and Source Code Pro only, with tabular numerals on every figure).
- The Slack weekly receipt is genuinely designed.

A Cribl design team would stop the review in three places:
- **The payoff frame:** the takeover visibly collides with the stage. It slices a line of text in half and hides the vote ask at the moment the room is looking.
- **Dark theme:** the Settings nav pill is the brightest thing on the page.
- **The judges' first 30 seconds on a phone:** the sample band breaks apart.

Beyond those three, the app does not hold one frame, one card style or one colour meaning across tabs, and that reads as several builders rather than one product.

**F1, F4, F5 and F7 (with F2) would get it through the review. F8–F10 are what would make it win.**

## Open issues found during the pass (not visual, but they would come up in the review)

- **Settings / Where to send alerts copy contradicts D23.** It says "Meter Reader posts each alert to these endpoints through Cribl's proxy", shows a "declared" badge, and says "Packaged with this App. No setup needed". The release has no `proxies.yml`.
- **The release-build grid shows backend copy.** The Receipt and Ledger footers say "Sweeps run every minute in the background; this page reads the latest one." because the spec fixtures use `snapshot.mode: 'backend'`. The release runtime is `ui` (D12b), so the grid should be shot with `mode: 'ui'`.
- **The demo build footer reads `v1.0.0-demo`.** D22 says demo versions are plain numeric (1.0.1 is installed).
