// src/copy/en.ts — every user-facing string ships from here (SPEC 17), organized by screen.
//
// Rules for authors:
// - Sentence case everywhere, no exclamation marks, no emoji (PRD 8.8 item 11). The ✓ glyph in
//   delivery lines is the one typographic exception SPEC 17 itself uses.
// - Placeholders are `{name}`. Callers pass pre-formatted values (money, bytes, times) — this module
//   never formats numbers, so a string can't silently disagree with the formatter in `src/lib/format.ts`.
// - Plurals are `{ one, other }` pairs resolved by `tn()`: every string that counts something ("{n} days")
//   is a pair, even when the count is never 1 today.
// - Units (P1-Y01): prose says "a day" / "an hour" ("$24 a day"); labels and figures say "/ day", "/ hour",
//   "/ GB", with a space on each side of the slash. Percentages take no space ("10%"). Durations in
//   toggles abbreviate hours and spell out days ("24 h", "7 days"). In a sentence a figure and its unit
//   abbreviation are joined with a no-break space ('45\u00a0s apart', 'after {minutes}\u00a0min'), so a line
//   never wraps between them.
// - Straight apostrophes only ('), never ’. Sentence case: object nouns are lowercase mid-sentence
//   ("each source's counter", "a destination"); names keep their capitals (Cribl, Splunk Cloud, the
//   App's views and sections as they read on screen: Receipt, Ledger, Flow, Prices, Demo Console).
// - No Oxford comma ("what it cost and what Cribl saved"). "Configuration", not "config". The noun is
//   "would-have-paid" (hyphenated); the verb phrase stays "you would have paid". The stage is the
//   "presenter view", never "presenter mode".
// - `tests/unit/copy-style.test.ts` holds these rules, and fails on a key nothing references.
// - Story captions are the canonical wording (≤ 12 words per line; SPEC 15 tests it). `scripts/story.ts`
//   and the video captions read the same beat table, so edit them here only together with that table.
// - The words core/ writes into receipts and notifications (Copy receipt, the weekly receipt, Slack, ServiceNow,
//   the bell) live in core/strings.ts, re-exported below: core/ builds without src/ (the runner, the Enterprise
//   backend), so it cannot import this file; this file stays the one index of user-facing text (EPIC_AUDIT P1-F05).
export { CORE_STRINGS, CREDIT_STRINGS, PAYLOAD_STRINGS, RECEIPT_STRINGS } from '../../core/strings.ts';
import { AUTHOR_STRINGS as CORE_STRINGS_AUTHOR } from '../../core/strings.ts';

// ─── Demo-build-only copy ────────────────────────────────────────────────────
//
// SPEC 13 / 16: the release bundle carries no Demo Console. `t()` resolves keys at runtime, so the bundler
// cannot tree-shake unused branches of `en`; instead these two sections are selected by the build flag
// INLINE at their use in `en` below (the same pattern as src/router.tsx). Vite replaces the flag with a
// constant, the ternary folds, and the literals below are dropped from the release bundle. The flag is
// read with `import.meta.env?.` (verified to fold the same way) so that a plain-Node reader of this
// module — e.g. a caption script run with tsx, where `import.meta.env` is undefined — does not throw.
//
// Consequence: whenever VITE_MR_BUILD is not 'demo' (the release build, and vitest unless a test sets
// the flag) these sections are empty and `t('demo.*')` / `t('shortcuts.lever.*')` return the key itself.
// Nothing in the release build renders them. Key typing (`CopyKey`) is unchanged in both builds.

const DEMO_CONSOLE_COPY = {
  breakTitle: 'Break the trim on {pipeline}?',
  breakBody: 'This commits and deploys a real change to a demo-tagged pipeline. Meter Reader will not touch anything else.',
  breakConfirm: 'Break the trim',
  cancel: 'Cancel',
  trimBroken: 'Trim broken. Watching for the drop — about four minutes at the default confirmation.',
  trimBrokenProfile: 'Trim broken. Watching for the drop — about two minutes with the demo profile.',
  trimRestored: 'Trim restored.',
  rateSet: 'Rate set to 5×. Settles in about 2 minutes.',
  title: 'Demo Console',
  weeklyNow: 'Weekly receipt now',
  resetEverything: 'Reset everything',
  resetBaselines: 'Reset baselines',

  // ── Demo Console view (PRD 8.7, DESIGN_BRIEF 5.7, SPEC 11 / 13 / 17) ──
  subtitle: 'Packs, the trim, scenes and resets for a live demo. Share this build only with the people running the demo: its write grants cover every pipeline, route and source in the workspace.',
  statusAria: 'Demo status',
  state: {
    live: 'Metering live',
    waiting: 'Waiting for the first sweep',
    stale: 'Metering stale',
    offline: 'Leader unreachable',
    rateLimited: 'Rate limited',
    replay: 'Replay on',
    sample: 'Sample data',
    connecting: 'Connecting',
    failing: 'Not metering',
    notMetering: 'Not metering yet',
    signedOut: 'Signed out',
    noAccess: 'No access',
  },
  lastSweep: 'last sweep {ago}',
  noSweep: 'no sweep yet',
  openAlerts: { one: '{n} open alert', other: '{n} open alerts' },
  ready: 'Ready',
  readyHint: 'One lever at a time. Each is a real commit and deploy.',
  stage: {
    preparing: 'checking the Leader budget…',
    saving: 'saving the change…',
    committing: 'committing…',
    deploying: 'deploying…',
    recording: 'recording the commit…',
    sending: 'sending…',
  },
  retrying: 'Retrying in {countdown}',
  retryReason: {
    budget: 'The Leader budget is spent for this minute.',
    in_flight: 'Another lever is still running.',
    locked: 'A sweep is writing right now.',
    rate_limited: 'Rate limited by the Leader.',
  },
  cancelRetry: 'Cancel retry',
  remote: '{lever} is running on another device',
  remoteHint: 'Levers here wait until it returns.',
  disabledTitle: 'Demo mode is off',
  disabledOff: 'Demo mode is off. Turn it on under Settings → Demo.',
  openSettings: 'Open Demo settings',
  sampleOff: 'Levers are off while sample data is showing.',
  profileOff: 'Default confirmation: 3 minutes. Turn on the demo profile for 1.',

  sections: {
    alert: 'Alert',
    scenes: 'Scenes',
    levers: 'Levers',
    packs: 'Apply the pack',
    trim: 'Break the trim',
    rate: 'Datagen rate',
    tools: 'Reset and tools',
  },

  noAlerts: 'No open alerts',
  noAlertsBody: 'Break the trim or run a scene. The alert lands here and on the presenter view.',
  nextAlertIn: 'Next alert expected in ~{eta}',
  nextAlertDue: 'Alert due any moment',
  nextAlertBasis: 'based on measured lag of {lag}',
  nextAlertCause: {
    trim: 'Trim broken {ago}',
    rate: 'Payments API spiked {ago}',
  },
  nextAlertLead: 'Next alert expected in',

  scene: {
    savings: { title: 'Savings', body: 'Apply the pack, watch the wedge, revert' },
    regression: { title: 'Regression', body: 'Break the trim, alert, restore' },
    savingsX3: { title: 'Savings ×3', body: 'Windows, Palo Alto, VPC Flow, 45\u00a0s apart' },
    spike: { title: 'Cost spike', body: 'Payments API ×5, alert, calm' },
    budget: { title: 'Budget pace', body: 'Push SIEM (prod) past its budget' },
    full: { title: 'Full show', body: 'Regression, spike, weekly receipt' },
  },
  sceneMinutes: '~{n} min',
  startScene: 'Start',
  startSceneLabel: 'Start the {scene} scene',
  abort: 'Abort and restore',
  abortHint: 'Restores everything this scene changed.',
  aborting: 'Restoring…',
  sceneRunning: '{scene} scene',
  stepOf: 'Step {n} of {total}',
  step: {
    applying: 'Applying the pack',
    applied: 'Pack applied',
    narrowing: 'Waiting for the ribbon to narrow',
    holding: 'Holding',
    reverting: 'Reverting the pack',
    breaking: 'Breaking the trim',
    waitingAlert: 'Waiting for the alert',
    restoring: 'Restoring the trim',
    waitingRecovery: 'Waiting for the incident to close itself',
    spiking: 'Spiking payments-api ×5',
    waitingSpike: 'Waiting for the cost-spike alert',
    calming: 'Calming payments-api',
    pausing: 'Pausing',
    sendingReceipt: 'Sending the weekly receipt',
    done: 'Finishing',
  },
  // The scene card's run of show: timed beats with a caret on what happens next (P2-W18 slice 2).
  show: {
    title: 'Run of show',
    beat: {
      applyPack: 'Apply the pack · {stream}',
      revertPack: 'Revert · {stream}',
      breakTrim: 'Break the trim',
      restoreTrim: 'Restore the trim',
      spike: 'Spike {source} ×{multiplier}',
      calm: 'Calm {source} to 1×',
      narrowed: 'The ribbon narrows',
      narrowedAll: 'All three ribbons narrow',
      alertLands: 'Alert lands',
      spikeAlertLands: 'Cost-spike alert lands',
      closesItself: 'Alert closes itself',
      receipt: 'Weekly receipt sent',
    },
    estimate: '~{time}',
    done: 'done',
    basis: 'Times from the start of the scene; ~ marks an estimate.',
  },
  progressBroke: 'Broke the trim {ago} · alert expected in ~{eta}',
  progressBrokeDue: 'Broke the trim {ago} · alert due any moment',
  progressLeft: '{left} left',
  progressWaitsUpTo: 'waits up to {left} more',
  sceneStarted: '{scene} scene started.',
  sceneFinished: '{scene} scene finished.',
  sceneAborted: '{scene} scene aborted. Everything it changed is restored.',
  sceneAbortFailed: '{scene} scene aborted, but something could not be restored. Use Reset everything.',
  sceneTimeout: 'Waited 6 minutes without the expected change; moving on.',
  sceneFailed: '{scene} scene paused: {reason}. Abort restores what it changed.',
  sceneRunningAlready: 'A scene is already running.',
  sceneFailedTitle: 'Paused',
  sceneDismissed: '{scene} scene dismissed. Nothing was restored.',

  // A scene a console left in demo/state is never resumed on its own (REVIEW-3a #8).
  left: {
    title: 'A scene was left running',
    detail: '{scene} · step {n} of {total} · started {ago}',
    moved: 'last step {ago}',
    next: 'Resume runs next: {step}',
    restores: 'Abandon and restore undoes:',
    nothing: 'It has not changed anything in Cribl yet.',
    resume: 'Resume',
    abandon: 'Abandon and restore',
    abandonedTitle: 'A scene was abandoned',
    abandonedBody: 'Nothing moved for 30 minutes, so nothing was restored automatically.',
    restoreTitle: 'Restore what it changed:',
    restore: 'Restore what it changed',
    dismiss: 'Dismiss',
    dismissHint: 'Dismiss forgets the scene and leaves Cribl as it is.',
  },

  alertEta: 'Alert expected in ~{eta} after a break',
  lagMeasured: 'measured lag',
  lagEstimate: 'estimate until the lag is measured',

  // Every volatile lever and scene start asks first (REVIEW-3a #7; src/demo/confirm.ts).
  confirm: {
    deploys: 'Commits and deploys to worker group {group}.',
    noDeploy: 'Nothing in Cribl changes.',
    route: 'Route for {stream}',
    pipelineChange: 'pipeline {from} → {to}',
    applyTitle: 'Apply the {pack} to {stream}?',
    applyBody: 'Points one demo-tagged route at its pack pipeline. Nothing else changes.',
    applyConfirm: 'Apply the pack',
    aggressiveTitle: 'Go aggressive on {stream}?',
    aggressiveBody: 'Points one demo-tagged route at the aggressive pipeline. Nothing else changes.',
    aggressiveConfirm: 'Go aggressive',
    revertTitle: 'Revert the pack on {stream}?',
    revertAllTitle: 'Revert every applied pack?',
    revertBody: 'Puts each route back on the pipeline it ran before. Detection is muted there for 10 minutes.',
    revertConfirm: 'Revert',
    revertAllConfirm: 'Revert all',
    breakNote: 'Alert expected in ~{eta} ({basis}).',
    restoreTitle: 'Restore the trim on {pipeline}?',
    restoreBody: 'Puts the [mr-trim] function back exactly as it was. The alert closes itself once savings recover.',
    restoreAction: 'enable the [mr-trim] function again',
    restoreConfirm: 'Restore',
    spikeTitle: 'Spike {source} ×{multiplier}?',
    spikeBody: 'Raises one demo Datagen source above its normal rate. A cost-spike alert follows.',
    spikeConfirm: 'Spike ×{multiplier}',
    calmTitle: 'Calm {source} to 1×?',
    calmBody: 'Puts the demo Datagen source back to its normal rate.',
    calmConfirm: 'Calm',
    rateChange: 'Datagen rate {from}× → {to}×',
    rateBack: 'Datagen rate back to 1×',
    resetTitle: 'Reset everything to baseline?',
    resetBody: 'Restores what the demo broke and closes its alerts. Applied packs stay; Revert all undoes those. Detection is muted on what changed for 10 minutes.',
    resetConfirm: 'Reset everything',
    budget: 'Budget for {output}',
    budgetAction: 'put back the budget a scene changed',
    alerts: 'Open demo alerts',
    alertsAction: 'close',
    scene: 'The scene in progress',
    sceneAction: 'clear',
    baselinesTitle: 'Reset the detection baselines?',
    baselinesBody: 'Meter Reader forgets what normal looks like and re-learns it from the next 10 minutes of traffic. Alerts wait until it has.',
    baselines: 'Detection baselines',
    baselinesAction: 'delete',
    baselinesConfirm: 'Reset baselines',
    weeklyTitle: 'Send the weekly receipt now?',
    weeklyBody: "Sends this week's receipt to every endpoint with the weekly receipt on.",
    endpoint: 'Endpoint {name}',
    weeklyAction: 'send the receipt',
    weeklyConfirm: 'Send now',
    sceneTitle: 'Start the {scene} scene?',
    sceneBody: {
      one: '{steps}. About {n} minute; every change is a real commit and deploy on a demo-tagged object, and Abort restores all of it.',
      other: '{steps}. About {n} minutes; every change is a real commit and deploy on a demo-tagged object, and Abort restores all of it.',
    },
    sceneConfirm: 'Start the scene',
    sceneRoute: 'pipeline {from} → {to}, then back',
    sceneTrim: 'disable the [mr-trim] function, then restore it',
    sceneRate: 'Datagen rate 1× → {to}×, then back to 1×',
    sceneReceipt: 'send the weekly receipt at the end',
  },

  stream: {
    windows_workstations: 'Windows workstations',
    pan_firewall: 'Palo Alto firewalls',
    vpc_flow: 'AWS VPC Flow Logs',
  },
  packName: {
    windows_workstations: 'Windows XML pack',
    pan_firewall: 'Palo Alto pack',
    vpc_flow: 'VPC Flow aggregation',
  },
  level: {
    raw: 'Raw',
    pack: 'Pack applied',
    aggressive: 'Aggressive',
  },
  apply: 'Apply',
  revert: 'Revert',
  applyTo: 'Apply the pack to {stream}',
  revertOn: 'Revert the pack on {stream}',
  goAggressive: 'Go aggressive',
  revertAll: 'Revert all',
  saving: '{pct} saved',
  notMeasured: 'not measured yet',
  measuring: 'measuring the new ratio…',
  keyHint: 'Key {key}',

  trimTarget: 'Payments API sampling',
  trimIntact: 'Trim intact',
  trimBrokenState: 'Trim broken',
  breakTrim: 'Break the trim',
  restore: 'Restore',
  breakAffects: 'Pipeline {pipeline}',
  breakAction: 'disable the [mr-trim] function',

  rateNormal: '1× · normal',
  rateSpiked: '{multiplier}× · spiked',
  rateAffects: 'Source {source}',
  spike: 'Spike ×5',
  calm: 'Calm',

  replay: 'Replay',
  replayOn: 'Metering pauses and screens play the recorded run.',
  replayOff: 'Screens show live metering.',
  replaySaveFailed: "Couldn't change Replay: {reason}",
  tour: 'Start the tour',
  story: 'Play the story',
  storyLive: 'Story (live run)',
  openPresenter: 'Open presenter',
  presenterHint: 'Lever keys work on the presenter view too.',
  // The page lever becomes the countdown after a break (EPIC_AUDIT P2-W18).
  alertIn: 'Alert in ~{eta}',
  // The phone's one-line "what the room sees" strip under the status line (P2-W18).
  projector: 'Projector: {amount}',
  projectorQuiet: 'no alert',
  projectorAlert: 'alert open',
  // "On the projector": a live thumbnail of the presenter view on the laptop console (P2-W18 slice 2).
  onStage: {
    title: 'On the projector',
    caption: 'What the presenter view shows now',
    aria: 'The presenter view shows {amount} saved, {basis}. {state}',
    takeover: 'Takeover on screen · clears in {left}, or on any key',
    recovery: 'Recovery card on screen · {left} left',
    alertOpen: 'Alert open · the takeover has cleared',
    quiet: 'No alert on screen',
  },
  // The lever ledger: the last five levers, each a real attributed commit (P2-W18 slice 2).
  ledger: {
    title: 'Lever ledger',
    caption: 'The last five levers. Each is a real commit and deploy, named for who pulled it.',
    empty: 'No levers pulled yet. Each one lands here with its commit id and who pulled it.',
    lever: {
      applyPack: 'Apply the pack',
      revertPack: 'Revert the pack',
      breakTrim: 'Break the trim',
      restoreTrim: 'Restore the trim',
      spike: 'Spike ×{multiplier}',
      calm: 'Calm to 1×',
      setRate: 'Rate {multiplier}×',
      resetAll: 'Reset everything',
    },
    deployed: 'deployed',
    committed: 'committed',
    caught: 'caught in {duration}',
    commit: 'Commit {hash}',
  },

  packApplied: 'Pack applied to {stream}. The ribbon narrows in about 2 minutes.',
  aggressiveApplied: 'Go aggressive on Windows workstations. The saved wedge grows in about 2 minutes.',
  packReverted: 'Pack reverted on {stream}. Detection is muted there for 10 minutes.',
  revertedAll: { one: 'Reverted {n} stream. Detection is muted there for 10 minutes.', other: 'Reverted {n} streams. Detection is muted there for 10 minutes.' },
  nothingApplied: 'No pack is applied; nothing to revert.',
  rateCalm: 'Rate back to 1×.',
  resetDone: 'Everything is back to baseline. Detection is muted on what changed for 10 minutes.',
  baselinesReset: 'Baselines reset. Meter Reader re-learns from the next 10 minutes.',
  weeklyNone: 'No endpoint has the weekly receipt turned on. Add one under Where to send alerts.',
  weeklyFailed: "Couldn't send the weekly receipt: {reason}",
  alreadyThere: 'Already in that state; nothing changed.',
  retryCancelled: 'Retry cancelled. Nothing changed.',
  gaveUpBudget: 'The Leader stayed busy; nothing changed. Try again in a minute.',
  leverFailed: "Couldn't finish {lever}: {reason}",
  chipBusy: 'A lever is running. Try again when it returns.',
} as const;

const DEMO_LEVER_COPY = {
  applyWindows: 'Apply the pack: Windows',
  applyPaloAlto: 'Apply the pack: Palo Alto',
  applyVpc: 'Apply the pack: VPC Flow',
  aggressive: 'Go aggressive (Windows)',
  revertAll: 'Revert all',
  breakTrim: 'Break the trim',
  restore: 'Restore',
  spike: 'Spike payments-api ×5',
  calm: 'Calm',
  weekly: 'Weekly receipt now',
  reset: 'Reset everything',
} as const;

/** Settings → Demo and "Load demo prices" (demo build only; gated like the two above). */
const SETTINGS_DEMO_COPY = {
  description: 'Controls for the live demo rig. This section exists only in the demo build.',
  simulated:
    'The demo destinations "SIEM (prod)", "SIEM (apps)", "Analytics" and "Archive (S3)" are simulated: they are DevNull outputs, so nothing leaves the workspace. "Load demo prices" under Prices fills in their preset rates.',
  mode: 'Demo mode',
  modeHint: 'Shows the Demo Console and turns on the demo levers.',
  profile: 'Demo profile',
  profileHint: 'While demo mode is on, alerts confirm after 1 minute. Stored thresholds are untouched.',
  replay: 'Replay',
  replayHint: 'Shows the recorded run instead of metering live. This tab stops sweeping while replay is on.',
  resetBaselines: 'Reset baselines',
  resetHint: 'Deletes the learned baselines so alerts re-learn from the next sweeps.',
  resetNeedsDemo: 'Turn on demo mode and save to reset baselines.',
  resetTitle: 'Reset baselines?',
  resetBody: 'Meter Reader deletes the baselines it learned. Spike and regression alerts stay quiet until it re-learns, about 10 sweeps.',
  resetAffects: 'Learned baselines',
  resetAction: "delete the baselines document from this App's KV store",
  resetDone: 'Baselines reset. Re-learning from the next sweep.',
  loadPrices: 'Load demo prices',
  pricesLoaded: 'Demo prices filled in. Save changes to apply them.',
} as const;

/** Presenter scene indicator (PRD 8.7 "Presenter sync"); demo build only, gated like the two above. */
const DEMO_SCENE_COPY = {
  indicator: '{scene} scene · alert expected in ~{eta}',
  indicatorDue: '{scene} scene · alert due any moment',
  indicatorNoEta: '{scene} scene · {step}',
  label: 'Demo scene in progress',
  names: {
    savings: 'Savings',
    regression: 'Regression',
    spike: 'Cost spike',
    budget: 'Budget pace',
    receipt: 'Weekly receipt',
    full: 'Full show',
  },
} as const;

/** What-if "Apply for real" (DESIGN_BRIEF 5.9); demo build only, gated like the sections above. */
const WHATIF_DEMO_COPY = {
  apply: 'Apply for real',
  confirmTitle: 'Apply the {treatment} to {stream}?',
  confirmBody: 'This commits and deploys a real change to a demo-tagged route. Meter Reader will not touch anything else.',
  affects: 'Point this route at {pipeline}, commit and deploy',
  applied: 'Applied. Measuring the real ratio as sweeps arrive.',
  onlyRig: "Apply for real works on the demo rig's raw streams.",
  demoOff: 'Turn on demo mode in Settings to apply this for real.',
} as const;

export const en = {
  app: {
    name: 'Meter Reader',
  },

  // The builder's signature, wherever a builder signs his work; src/components/common/Credit.tsx sets the name a touch
  // stronger. `{name}` is core/strings.ts CREDIT_STRINGS.builder, the name the receipts, the alert messages and the
  // report card sign with (tests/unit/credit.test.ts keeps them one name).
  credit: {
    /** The shell footer, beside the version and the build. */
    footer: 'Meter Reader · built by {name}',
    /** The first-run card, on the eyebrow's line. */
    firstRun: 'Built by {name}',
    /** Settings → Runtime: what this is and who built it. */
    aboutLabel: 'About',
    about: 'Meter Reader {version} · built by {name} · Apache\u00a02.0\u00a0license',
    /** The presenter view, after the wordmark: "Meter Reader by Steve Koelpin". */
    byline: 'by {name}',
    /** Story mode's title beat, under the title. */
    storyTitle: 'Built by {name}',
    /** Story mode's summary beat, its kicker. */
    signature: 'Meter Reader by {name}',
  },

  nav: {
    ariaLabel: 'Meter Reader sections',
    receipt: 'Receipt',
    flow: 'Flow',
    whatif: 'What if',
    ledger: 'Ledger',
    settings: 'Settings',
    demo: 'Demo',
    skipToContent: 'Skip to content',
    /** The browser tab's title outside Cribl (P1-A09). */
    documentTitle: '{view} – Meter Reader',
    firstRun: 'Get started',
    report: 'Report card',
    // Tab badges (P2-W21): the accessible names of a tab that carries one.
    ledgerAlerts: { one: 'Ledger, {n} open alert', other: 'Ledger, {n} open alerts' },
    settingsUnpriced: { one: 'Settings, {n} destination unpriced', other: 'Settings, {n} destinations unpriced' },
  },

  status: {
    live: 'Live',
    stale: 'Stale',
    offline: 'Offline',
    sample: 'Sample data',
    replay: 'Replay',
    connecting: 'Connecting',
    waiting: 'Waiting for the first sweep',
    rateLimited: 'Rate limited',
    // P0-07 / P1-D01: sweeps failing, nothing can meter yet, the session expired, the role can't read the App's data.
    failing: 'Not metering',
    notMetering: 'Not metering yet',
    signedOut: 'Signed out',
    noAccess: 'No access',
    failingSince: 'since {time}',
    nextSweepIn: 'next sweep in {countdown}',
    reload: 'Reload',
    updatedAgo: 'updated {ago}',
    rateLimitedBackoff: 'checking every 60\u00a0s until {time}',
    // P1-E01's metering back-off: no sweep calls Cribl before this time (meta.rateLimitedUntil), so no countdown.
    meteringResumesAt: 'metering resumes at {time}',
    short: {
      connecting: 'Connecting',
      waiting: 'Waiting',
      live: 'Live',
      stale: 'Stale',
      rateLimited: 'Limited',
      offline: 'Offline',
      sample: 'Sample',
      replay: 'Replay',
      failing: 'Failing',
      notMetering: 'Unpriced',
      signedOut: 'Signed out',
      noAccess: 'No access',
    },
  },

  footer: {
    buildRelease: 'release',
    buildDemo: 'demo build',
    lastSweep: 'Last sweep {ago} · {calls} calls · {duration}',
    lastSweepNoStats: 'Last sweep {ago}',
    noSweepYet: 'No sweep yet',
    noGoodSweepSince: 'No sweep has succeeded since {time}',
    runtimeUi: 'Meters every minute while open',
    runtimeBackend: 'Sweeps run every minute in the background; this page reads the latest one.',
    sampleMode: 'Showing sample data',
    // Who metered the last sweep (meta.lastSweepOwner; src/state/selectors.ts meteredBy).
    runtimeRunner: 'Metered every minute by the runner',
    runtimeRunnerHost: 'Metered every minute by the runner on {host}',
    runtimeThisTab: 'Metered by this tab, every minute',
    runtimeOtherTab: 'Metered by another open tab, every minute',
    runtimeScheduledBackend: 'Metered every minute by the scheduled backend',
    runtimeNoPrices: 'Set prices to start the meter',
    // P1-D03: the last meter went quiet (its last sweep is over 5 minutes old).
    runtimeRunnerSilent: 'The runner stopped sweeping {ago}',
    runtimeRunnerSilentHost: 'The runner on {host} stopped sweeping {ago}',
    runtimeBackendSilent: 'The scheduled backend stopped sweeping {ago}',
    // P1-D01: settings unreadable, so this tab does not meter and cannot tell who does.
    runtimeUnreadable: 'Metering starts once Meter Reader can read its settings',
  },

  time: {
    justNow: 'just now',
    secondsAgo: '{n} s ago',
    minutesAgo: '{n} min ago',
    hoursAgo: '{n} h ago',
    daysAgo: { one: '{n} day ago', other: '{n} days ago' },
    durationMs: '{n} ms',
    durationSeconds: '{n} s',
    durationMinutes: '{m} min {s} s',
  },

  units: {
    perDay: '/ day',
    perYear: '/ year',
    perHour: '/ hour',
    points: { one: '{n} point', other: '{n} points' },
  },

  firstRun: {
    title: 'Meter Reader prices every data flow and shows what Cribl saves.',
    setPrices: 'Set prices to start the meter',
    tour: 'Tour with sample data',
    watchStory: 'Watch the 90-second story',
    rolesTitle: 'What it needs',
    // App QA m4: the whole of what the Review App screen lists, in one line: reads, and the notification writes.
    rolesBody:
      'It reads configuration and metrics, and posts alerts to the Cribl bell and, once you connect one, to a notification target. It never changes a pipeline, route, source or destination.',
    collectingSince: 'Collecting since {time}',
    // The card's meter (P2-W27): a dimmed "$–––,–––" that rolls to the sample's figure when the tour button is
    // hovered or focused, the same number the tour's Receipt opens on.
    meterIdle: 'Your number, once prices are set',
    meterSample: 'The sample workspace, month to date',
    meterIdleLabel: 'Saved by Cribl: no figure until prices are set.',
    meterSampleLabel: 'Saved by Cribl in the sample workspace: {amount} month to date.',
  },

  howItWorks: {
    step1: 'Reads every flow, every minute',
    step2: 'Prices it at the destination',
    step3: 'Shows what Cribl saved',
    step4: 'Alerts in dollars',
  },

  story: {
    title: 'Meter Reader — a Cribl App that turns your data flows into a dollar receipt, and tells you who broke it.',
    summary: {
      line1: 'Priced every flow at its destination',
      line2: 'Caught a bad change in {caughtIn}',
      line3: 'Named the commit and the person',
      line4: 'Sent leadership the receipt',
    },
    captions: {
      hook: 'You bought Cribl to save money. Can you show it?',
      howItWorks: ['Every minute, Meter Reader reads every flow through Cribl.'],
      // The dollar map (P2-W11): the second line's figure is the drawn group's saved $ a day.
      flow: ['It prices each one at what its destination charges.', 'Where the pipeline cuts bytes, it cuts dollars: {flowSaved} a day.'],
      meter: ['You would have paid {whp}. You paid {paid}.', 'Saved by Cribl: {saved}.'],
      change: 'An admin ships a pipeline change. Meter Reader sees the commit.',
      watching: ['Meter Reader never changes a pipeline, route, source or destination.', 'It watches the savings ratio, minute by minute.'],
      alert: [
        'Savings dropped {points} points on this pipeline.',
        'Commit {hash}, deployed by {user}.',
        '{perDay} a day. {perYear} a year. Caught in {caughtIn}.',
      ],
      slack: 'In Slack, with a name on it.',
      restore: ['Restore the change. The savings come back.', 'The incident closes itself.'],
      receipt: 'A weekly receipt goes to leadership. They never open Cribl.',
      // The story's sign-off, then the ask: two lines, each short enough to hold the caption rail on a phone. The name
      // never breaks across the caption's lines (a no-break space). D54: the vote ask is the demo build's alone (the
      // stage and the hallway); the release build, and every document scripts/story.ts writes in plain Node
      // (story.json, story-live.json, VIDEO_SCRIPT.md, captions.srt), signs off with the network to join. The flag is
      // tested inline so the release bundle drops the vote line (src/story/doc.ts swaps it back in on the demo build).
      ask:
        import.meta.env?.VITE_MR_BUILD === 'demo'
          ? ['Meter Reader by Steve\u00a0Koelpin.', 'Customer track · vote in the CriblCon app.']
          : ['Meter Reader by Steve\u00a0Koelpin.', 'Join the Cribl Innovators Network.'],
    },
    exitHint: 'Press Esc or any key to exit',
    // On a touch screen (no keys): a tap anywhere on the frame exits, as does a swipe down or the ×.
    exitHintTouch: 'Tap to exit',
    // The quiet source chip in the top bar (the presenter's, in place of the SAMPLE DATA band).
    replayChip: 'Replay · recorded {date}',
    // The watching chart names what its shaded loss costs (the alert card's own $ a day).
    watchLoss: 'Losing {perDay} a day',
    // P2-W12: the hero's savings rate chip while the story's alert is open, then once it has recovered.
    rateDrop: '−{perDay} / day',
    rateBack: '+{perDay} / day back',
    rateDropTitle: 'The savings rate is down {perDay} a day while the alert is open',
    rateBackTitle: 'The savings rate is back up {perDay} a day',
    // P2-W12: the watching beat's clock, from the deploy to the moment the alert lands (the card's "Caught in").
    watchClock: '{duration} since the deploy',
  },

  meter: {
    caption: 'Saved by Cribl',
    period: {
      mtd: 'month to date',
      today: 'today',
      '30d': 'last 30 days',
      annualized: 'annualized run rate',
    },
    periodToggle: {
      mtd: 'MTD',
      today: 'Today',
      '30d': '30 days',
      annualized: 'Annualized',
      custom: 'Custom',
      ariaLabel: 'Headline period',
    },
    annualizedFrom: { one: 'annualized run rate, from the last {n} day', other: 'annualized run rate, from the last {n} days' },
    collecting: 'collecting since {time}',
    // P0-23: how much of the period the hero's figure covers, when that is not all of it.
    coverage: { one: '{metered} of {expected} minute metered ({pct})', other: '{metered} of {expected} minutes metered ({pct})' },
    coverageUnderOne: 'under 1%',
    // The custom range picker (core/range.ts; src/views/Receipt/RangePicker.tsx) and the hero while a range shows.
    range: {
      pickerLabel: 'Custom range',
      openPicker: 'Change the custom range',
      quickLabel: 'Quick picks',
      quick: { '1h': '1 h', '6h': '6 h', '24h': '24 h', '7d': '7 days', '30d': '30 days' },
      absoluteTitle: 'Or an exact window',
      from: 'From',
      to: 'To',
      timezoneNote: 'Times are in {tz}. Windows older than 24 hours are summed in whole hours; older than 31 days, in whole UTC days.',
      // r3 ui-5 (H9): a large estate keeps minute documents for fewer hours (meta.minuteRetentionHours).
      timezoneNoteHours: 'Times are in {tz}. Windows older than {hours} hours are summed in whole hours; older than 31 days, in whole UTC days.',
      // What Apply will sum, for the draft as it stands: "Summed in whole hours as Sep 19, 2:00 PM–Sep 26, 2:00 PM (7 days)."
      preview: {
        minute: 'Summed minute-exact as {words}.',
        hour: 'Summed in whole hours as {words}.',
        day: 'Summed in whole UTC days as {words}.',
        future: 'This window is in the future: nothing has been metered in it yet.',
      },
      incomplete: 'Enter a start and an end.',
      invalid: 'The start must be before the end.',
      apply: 'Apply',
      cancel: 'Cancel',
      sampleHint: 'Custom ranges read metered history, so they are off while a recording replays.',
      // "Sep 26, 10:00 AM–2:00 PM (4 h)"
      words: '{span} ({duration})',
      durationMinutes: '{n} min',
      durationHours: '{n} h',
      durationDays: { one: '{n} day', other: '{n} days' },
      // The caption's exactness: how the rows relate to the window that was asked for.
      exactMinute: 'minute-exact',
      exactHour: 'whole hours · {metered} of {expected} minutes metered',
      exactHourWidened: 'widened to whole hours · {metered} of {expected} minutes metered',
      exactDay: { one: 'whole UTC days · {metered} of {n} day metered', other: 'whole UTC days · {metered} of {n} days metered' },
      exactDayWidened: { one: 'widened to whole UTC days · {metered} of {n} day metered', other: 'widened to whole UTC days · {metered} of {n} days metered' },
      throughLastHour: 'through the last whole hour',
      throughLastDay: 'through the last whole UTC day',
      clippedEnd: 'ends at the last whole minute',
      clippedRetention: { one: 'history is kept for {n} month', other: 'history is kept for {n} months' },
      future: 'this window is in the future',
      empty: 'nothing was metered in this window',
      rate: '≈ {amount} a day at this rate',
      loading: 'Reading the range',
      failed: "Couldn't read this range's history.",
      retry: 'Retry',
      // The read budget (api-budget F2): what Apply will read, and a 429 from the Leader (no Retry into the limit).
      reads: { one: 'Reads {n} history document.', other: 'Reads {n} history documents.' },
      rateLimited: 'Cribl is rate limiting Meter Reader. This range reads again at {time}.',
      held: 'rate limited by Cribl, updates at {time}',
      // Compare with… (P2-W13): the picker's choice, the hero's second figure, the change and why a comparison can't be made.
      compare: {
        label: 'Compare with',
        none: 'Nothing',
        prev: 'The previous period',
        week: 'The same window a week earlier',
        weekTooLong: 'The same window a week earlier (7 days or less)',
        commitsTitle: '24 h before and after a commit',
        commitItem: '{hash} · {message} · {time}',
        // What the baseline is called in a sentence ("Compared with the previous 7 days") and on its bar.
        name: { prev: 'the previous {duration}', week: 'the same window a week earlier', commit: 'the time before {hash}' },
        row: { current: 'This range', after: 'After {hash}', prev: 'The previous {duration}', week: 'A week earlier', before: 'Before {hash}' },
        eyebrow: 'Compared with {name}',
        preview: 'Compared with {words}.',
        reads: { one: 'Reads {n} history document for both windows.', other: 'Reads {n} history documents for both windows.' },
        // "$1,610 → $1,832" and the signed change beside it; per day when the windows are compared per day.
        fromTo: '{from} → {to}',
        perDay: '{amount} a day',
        delta: '{amount} ({pct})',
        flat: 'No change',
        // The saved share of each window (dollars): volume can move the dollars one way and the share the other.
        shareLine: 'Share of dollars saved {from} → {to} ({points})',
        // What the change's percentage is a share of (every percentage names its basis).
        pctBasis: 'of what {name} saved',
        pctBasisPerDay: 'of what {name} saved a day',
        notes: {
          realignedHour: 'whole hours, to compare like with like',
          realignedDay: 'whole UTC days, to compare like with like',
          gap: 'the {bucket} of the deploy, {span}, is left out of both',
          gapBucket: { minute: 'minute', hour: 'hour', day: 'UTC day' },
          perDay: "compared per day at each window's rate: they were metered for different lengths of time",
          perDayClipped: "compared per day at each window's rate: the earlier window starts before collecting began",
          clipped: 'the earlier window starts before collecting began',
        },
        empty: 'Nothing was metered in {name}, so there is nothing to compare with.',
        refused: {
          future: 'This window is in the future, so there is nothing to compare yet.',
          weekTooLong: 'A week earlier compares windows of 7 days or less.',
          overlap: 'This range starts before {hash} was deployed, so it holds time from before the change.',
          noCommit: 'Commit {hash} is not in the recent change timeline.',
          tooShort: 'This window is too short to compare in whole hours.',
          beforeCollecting: 'Nothing was metered before {since}, so there is nothing to compare with.',
          tooManyReads: {
            one: 'Comparing would read {n} history document, more than the {cap} one range may read. Pick a shorter range.',
            other: 'Comparing would read {n} history documents, more than the {cap} one range may read. Pick a shorter range.',
          },
        },
        loading: 'Reading {name}',
        failed: "Couldn't read {name}.",
        rateLimited: 'Cribl is rate limiting Meter Reader. The comparison reads again at {time}.',
        held: 'rate limited by Cribl, the comparison updates at {time}',
        // The stacked bars: each window's money, and the bar's accessible name.
        barLine: 'Would have paid {whp} · paid {paid} · {pct} saved',
        barLinePerDay: 'A day at this rate: would have paid {whp} · paid {paid} · {pct} saved',
        barLabel: '{name}: would have paid {whp}, paid {paid}, saved {saved}',
        rowSaved: '{amount} saved',
        movers: 'What moved',
        moversPerDay: 'What moved, per day',
        moversCaption: 'Saved per pipeline in this range, and the change',
      },
    },
  },

  receipt: {
    wouldHavePaid: 'You would have paid {amount}',
    paid: 'You paid {amount}',
    savedPct: '{pct} saved',
    // The basis of that percentage (the hover and Show the math say it): dollars for the period, not bytes —
    // the Ledger's "volume reduced" is a share of bytes, and the Flow map prices a day at current rates.
    savedPctBasis: 'of dollars, {period}',
    // P1-F02: measured (bytes dropped) vs assumed (data credited at another destination's price).
    split: 'By reduction {reduced} · by diversion {diverted}',
    splitHint: 'Diversion credits data sent somewhere cheaper at the price of the destination it would have gone to without Cribl',
    net: 'Net after Cribl {amount}',
    payback: 'Paid for itself {multiple}×',
    // P1-F11: a prepaid entitlement (per GB/day subscription, commitment tier, credit pool) is resized at renewal.
    entitlement: {
      one: '{vendors} is billed as a prepaid entitlement: its share of these dollars is realized at renewal, not on the next bill.',
      other: '{vendors} are billed as prepaid entitlements: their share of these dollars is realized at renewal, not on the next bill.',
    },
    // Payback under 1×: "Paid for itself 0.4×" reads as a boast; say what share of Cribl's cost the savings cover.
    paybackPartial: 'Covered {pct} of its cost',
    copy: 'Copy receipt',
    reportCard: 'Report card',
    copied: 'Receipt copied.',
    copyFailed: "Couldn't copy the receipt. Select the text and copy it manually.",
    weeklySent: { one: 'Weekly receipt sent to {n} endpoint.', other: 'Weekly receipt sent to {n} endpoints.' },
  },

  sections: {
    trend: 'Saved over the last 30 days',
    destinations: 'Where the money goes',
    topSavers: "What's saving the most",
    math: 'Show the math',
  },

  // ── Receipt view (PRD 8.1, DESIGN_BRIEF 5.1, SPEC 8 / 13 / 17) ──
  receiptView: {
    heroLabel: 'Saved by Cribl',
    // P1-F10: what the dollars are priced at — the member's own rates everywhere, or some typical list prices still.
    // The hero's one price-basis chip (P1-F10; P2-W20's second chip beside the caption said the same, review W2).
    priceBasis: {
      contract: 'at your contract rates',
      preset: 'at typical list prices',
      contractHint: 'Every destination carrying money is priced at the rate you entered under Settings → Prices.',
      presetHint: '{custom} of {total} destinations at your own rates, the rest at typical list prices. Enter your contract rates under Settings → Prices.',
    },
    howToggle: 'How this number is made',
    // Founder-build r1 ui-3 (FINDINGS_EXTRA (b)): under the hero on the annualized run rate only, this workspace's
    // measured rate projected to 1, 5 and 10 TB a day (src/views/Receipt/atScale.ts). It names its basis (every flow and
    // priced destination here), so it never reads as the one-pack figure quoted elsewhere; {basis} is priceBasis.
    atScale: {
      line: "At your scale, at this workspace's measured rate (its mix of flows and priced destinations): {rungs} a year, projected {basis}.",
      rung: '{tb}\u00a0TB a day ≈ {amount}',
    },
    // The hero's right column at >= 1024 px (P1-H01): the other periods as receipt lines (buttons that switch to
    // them), then what a day saves at current rates.
    // A destination's monthly statement (P2-W25): this month against last, the budget, the counterfactual, the
    // prices that applied, and when in the week it saves (core/heatmap.ts).
    statement: {
      title: '{label}: statement',
      regionLabel: 'The statement for {label}',
      subtitle: '{type} · {price} / GB',
      monthsTitle: 'This month and last',
      colItem: 'Per month',
      whp: 'Would have paid',
      paid: 'Paid',
      saved: 'Saved',
      noMonth: 'Not metered',
      monthsNote: 'From the running totals: each month is what was metered in it, at the prices in force at the time.',
      monthsSample: 'Sample data has this month only; last month appears once your own metering has a month behind it.',
      monthsFailed: "The running totals can't be read right now, so this month is the Receipt's month to date and last month is not shown.",
      now: 'Now {volumeIn} in and {volumeOut} out per day, at current rates.',
      budgetTitle: 'Budget',
      budget: '{budget} a month · paid on pace for {projected} ({pct} of budget)',
      budgetNone: 'No budget is set for this destination. Add one under Settings → Budgets.',
      pricesTitle: 'Prices that applied',
      priceFrom: 'From {date}',
      priceCommitted: 'committed {price} / GB',
      priceNone: 'No price has been set for this destination.',
      heatTitle: 'When it saves: the last 7 days, hour by hour',
      heatSample: 'The hour-by-hour map reads your own rollups, so it shows once metering is live.',
      heatLoading: 'Reading the last 7 days…',
      heatFailed: "The hour rollups can't be read right now.",
      heatEmpty: 'Nothing was saved here in the last 7 days.',
      copy: 'Copy statement',
      copied: 'Statement copied.',
      copyFailed: "Couldn't copy the statement. Select the figures and copy them instead.",
      close: 'Close',
      textTitle: 'Meter Reader — statement',
      textBudget: 'Budget {budget} a month · on pace for {projected}',
      textPrice: 'Priced at {price} / GB',
    },
    heatmap: {
      label: 'Saved per hour over the last 7 days, {label}: most at {top} ({amount})',
      labelEmpty: 'Saved per hour over the last 7 days: nothing saved',
      readout: '{when}: saved {saved} · would have paid {whp} · paid {paid}',
      readoutEmpty: '{when}: not metered',
      hint: 'Point at an hour, or focus the map and use the arrow keys.',
      top: '{rank}. {when} · {amount}',
      topLabel: 'The three biggest hours',
      scaleLow: 'less',
      scaleHigh: 'more saved',
    },
    // The month-to-date pace toward the savings goal (P2-W20, core/goal.ts).
    goal: {
      label: 'Pace toward the savings goal',
      ahead: 'On pace for {projected} by {date} · goal {goal}',
      behind: 'Behind pace: on track for {projected} by {date}, {gap} short of the {goal} goal',
      early: 'Goal {goal} this month · the pace shows after an hour of metering',
      tick: 'goal',
    },
    // Which prices the figures use (P2-W20): typical list prices until every priced destination has a rate an admin entered.
    // "This week so far" (P2-W20): Monday to now, the same span last week, and a preview of Monday's message.
    week: {
      title: 'This week so far',
      caption: '{span}',
      captionHours: '{span} · through the last whole hour',
      vsPrior: '{pct} on the same days last week',
      linesLabel: 'This week, by what saves it',
      sampleLines: 'Line items read your own rollups, so they show once metering is live.',
      // r2 ui-13 (IC-7): said beside a hero that counts the minutes metered, so never "nothing metered".
      empty: 'No traffic this week yet.',
      emptySaved: 'Nothing saved this week yet.',
      failed: "This week's rollups can't be read right now.",
      preview: "Preview Monday's message",
      previewTitle: "Monday's message, so far",
      previewNote: 'What the weekly receipt would say if it were sent now. Send one from Settings → Where to send alerts.',
      close: 'Close',
      settings: 'Send from Settings',
    },
    aside: {
      label: 'Every period at a glance',
      mtd: 'Month to date',
      today: 'Today',
      '30d': 'Last 30 days',
      annualized: 'Annualized',
      show: 'Show {period}: {amount}',
      now: 'A day at current rates',
      nowLabel: 'Saved per day at current rates',
    },
    annualizedPartial: 'annualized run rate, projected from today so far · settles after the first full day',
    // Less than one whole day metered (craft review, round 1): the run rate is a projection from a few minutes or
    // hours of traffic, and says how few, so a first-day CFO never reads it as a measured year.
    annualizedProjectedMinutes: {
      one: 'annualized run rate, projected from the last {n} minute of traffic · settles after the first full day',
      other: 'annualized run rate, projected from the last {n} minutes of traffic · settles after the first full day',
    },
    annualizedProjectedHours: {
      one: 'annualized run rate, projected from the last {n} hour of traffic · settles after the first full day',
      other: 'annualized run rate, projected from the last {n} hours of traffic · settles after the first full day',
    },
    // The pill beside that caption: the What-if's and the Flow map's word for a figure that is not measured yet.
    projectionPill: 'Projection',
    barLabel: 'You would have paid {whp}: paid {paid}, saved {saved}',
    // P2-W08: the receipt bar as a projection (the What-if hero).
    projection: {
      paid: 'You would pay {amount}',
      delta: '{amount} from this change',
      barLabel: 'You would have paid {whp}: you would pay {paid} and save {saved}, {delta} of it from this change',
    },
    netPerYear: 'Net after Cribl {amount} / year',
    // No Cribl cost is set (usefulness review, round 2): the net and payback at Cribl's list price on the measured
    // ingest (core/presets.ts suggestCriblCost), always labelled as an estimate, with the way to enter the real cost.
    estimate: {
      net: 'Net after Cribl ≈ {amount}',
      netPerYear: 'Net after Cribl ≈ {amount} / year',
      payback: 'Paid for itself ≈{multiple}× at list price',
      paybackPartial: 'Covered ≈{pct} of its cost at list price',
      basis: "Estimate at Cribl's list price: {volume} a day × {list} per GB ≈ {amount} a month.",
      // A cost saved from the estimate (core's Settings.criblCostEstimate): still an estimate until the contract cost replaces it.
      basisSaved: "Cribl cost {cost} a month, an estimate at Cribl's list price.",
      link: 'Set your contract cost',
    },
    // What the net line's cost covers (core/net.ts): the period's metered span, or a year for the run rate.
    netBasis: 'Cribl cost {cost}, prorated to the {span} metered',
    netBasisYear: 'Cribl cost {cost} a year',
    netSpanDays: { one: '{n} day', other: '{n} days' },
    netSpanHours: { one: '{n} hour', other: '{n} hours' },
    netSpanMinutes: { one: '{n} minute', other: '{n} minutes' },
    unavailableSection: 'the savings figures',
    unavailableCaption: "Figures appear here once your role can read Meter Reader's savings.",
    // The ghost's sentence for the other failure kinds (the 403 one above is only for a role that can't read).
    unavailableCaptionRateLimited: 'Figures appear after the next sweep.',
    unavailableCaptionServer: 'Figures appear here once Cribl answers again.',
    unavailableCaptionUnauthorized: 'Figures appear here once you sign in to Cribl again.',
    // "How this number is made": how the bytes behind every figure are measured (DECISIONS D20), one short
    // paragraph under the four steps, chosen by snapshot.attributionSummary. Show the math has the full detail.
    howMeasuredTitle: 'Where the bytes come from',
    howMeasured: {
      reconciled:
        "Bytes in are each source's own counter and bytes out each destination's: Cribl's exact counters. A pipeline with no functions passes bytes through unchanged. When one destination takes several reshaped flows, Cribl's per-route estimates split its bytes between them.",
      route: "Bytes are Cribl's per-route counters: in where each route receives data, out after its pipeline, before the destination.",
      pipeline: "Bytes are Cribl's per-pipeline counters: in at the pipeline's input, out at its output.",
      proportional:
        "Bytes out are each destination's own counter, shared across the flows that feed it in proportion to their bytes in.",
      routeOnly: 'Some routes report bytes without a named source; those flows are priced at the route.',
    },
    howPriced:
      'Would have paid prices the bytes in at the destination they would reach without Cribl; paid prices the bytes out where they actually go. Saved is the difference.',
    waitingCaption: 'Waiting for the first sweep. Figures appear about a minute after metering starts.',
    // Before any figures, while sweeps fail (craft review, round 1): the hero says why instead of "waiting", so it
    // never contradicts the "Not metering" notice above it. One short reason per failure kind.
    notMeteringCaption: 'Not metering: {reason}. Figures appear after the first sweep that succeeds.',
    // The ghost's four cards once nothing will load (craft review, round 2): a still line, never outlines that read
    // as loading. 'failing': sweeps fail before the first figures; 'error': the saved figures can't be read.
    ghostCardEmpty: {
      failing: 'Nothing to show until a sweep succeeds.',
      error: 'Nothing to show until the saved figures can be read.',
    },
    notMeteringReason: {
      'metrics-forbidden': 'metrics access refused',
      forbidden: 'configuration access refused',
      unauthorized: 'the Cribl session expired',
      'rate-limited': 'Cribl is rate limiting Meter Reader',
      budget: 'sweeps are over their call budget',
      'time-budget': 'sweeps are running out of time',
      storage: "Meter Reader's storage refused a write",
      server: 'Cribl answered with an error',
      network: "Cribl can't be reached",
      unknown: 'sweeps are failing',
    },
    // Under the hero (P0-07, P1-D03, P1-D06): why the number is not moving, or cannot.
    notMeteringSince: 'Not metering since {time}',
    staleTitle: 'Not updated since {time}',
    staleBody: 'The last sweep ran {ago}. These figures stop there until metering runs again.',
    zeroPricedTitle: 'Every destination is priced at $0',
    zeroPricedBody: 'Nothing can count as saved until a destination has a price above $0.',
    // FOUNDER_PLAN row 14 (founder-build r1 ui-11): the mixed $0 case — a pipeline reduces data into a destination priced
    // at $0 (DevNull is free once any price is saved), so nothing counts as saved; name it, and the way to Prices.
    zeroRow: {
      one: '{names} is priced at $0, so what your pipelines remove before it counts as $0 saved. Price it, or set what it stands in for, under Prices.',
      other: '{names} are priced at $0, so what your pipelines remove before them counts as $0 saved. Price them, or set what they stand in for, under Prices.',
    },
    setPrices: 'Set prices',
    trend: {
      // The chart's accessible name names the window the heading does, then how much of it is collected (P1-H06).
      chartLabel: 'Saved per day, last 30 days · {days} collected',
      chartDays: { one: '{n} day', other: '{n} days' },
      caption: 'Daily savings · diamonds mark configuration deploys',
      // A workspace younger than the 30-day window: the chart starts the day collecting began, and the card says
      // so in its title (not "the last 30 days") and counts the days in its caption (P0-18).
      titleSince: 'Saved per day since {date}',
      captionSince: {
        one: '{n} day metered so far · diamonds mark configuration deploys',
        other: '{n} days metered so far · diamonds mark configuration deploys',
      },
      learningTitle: 'Learning your savings',
      learningBody: {
        one: 'The trend fills in as each day completes. {n} day collected so far.',
        other: 'The trend fills in as each day completes. {n} days collected so far.',
      },
      learningBodyNone: 'The trend starts once the first whole day of metering completes.',
      // Whole days collected, and every one of them $0 saved: a sentence, not a flat line under a $1 axis.
      captionEmpty: 'Daily savings',
      emptyTitle: 'Nothing saved yet',
      emptyBody: 'Savings appear once a pipeline reduces what reaches a priced destination.',
      // The first day, when collecting began after its midnight: its bar is short because it is partial.
      tipPartial: 'Partial day: metered from {time}',
      tipSaved: 'Saved',
      tipWhp: 'Would have paid',
      tipPaid: 'Paid',
      tipRatio: '{pct} saved',
      tipDeploy: '{hash} "{message}" · {author}',
      tipMoreDeploys: { one: '+{n} more deploy', other: '+{n} more deploys' },
      // P2-W07 (c): the largest priced configuration change in the window, at its diamond; the Ledger's figure.
      annotation: '{amount} / day · {hash}',
      // …when it landed today, after the last whole day the line draws: its diamond sits past the line's end.
      annotationToday: '{amount} / day · {hash}, today',
      annotationAria: 'Largest priced change: {amount} / day since {hash}',
      legendSaved: 'Saved per day',
      legendDeploy: 'Config deploy',
      // The hollow point on a first day that began after midnight (P0-18).
      legendPartial: 'Partial first day',
    },
    topSavers: {
      // The list holds only the flows with savings (up to five): the caption counts them, and with one line
      // or none it names the basis alone.
      caption: 'Savings per day, at current rates',
      captionTop: 'Top {n} by savings per day, at current rates',
      emptyTitle: 'No savings yet',
      emptyBody: 'Savings appear once a pipeline reduces what reaches a priced destination.',
      openInCribl: 'Open {label} in Cribl',
      // A saver's ratio is saved ÷ would-have-paid: dollars at current rates, not bytes (it was "{pct} reduced").
      savedShare: '{pct} saved at current rates',
      listLabel: 'Top savers',
      viewAll: 'See every flow in the Ledger',
      // The receipt's bottom lines (P1-H04): what the rest of the flows save, and every flow together.
      others: { one: '{n} other flow', other: '{n} other flows' },
      // A folded snapshot (usefulness review, round 2): the rest also holds the Other row's smaller flows.
      othersFolded: { one: '{n} other flow and {folded} smaller ones', other: '{n} other flows and {folded} smaller ones' },
      othersFoldedNoCount: { one: '{n} other flow and the smaller ones', other: '{n} other flows and the smaller ones' },
      othersOnlyFolded: { one: '{n} smaller flow', other: '{n} smaller flows' },
      othersOnlyFoldedNoCount: 'The smaller flows',
      total: 'All flows',
      totalsLabel: 'Every flow',
    },
    destinations: {
      caption: 'Paid and saved per day at each destination, at current rates',
      savedPerDay: '{amount} saved',
      pricePerGb: '{price} / GB',
      // A destination priced from a preset says so in place of its output type ("devnull" told nobody why $2.25).
      pricedAs: 'priced as {preset}',
      withoutCribl: 'Without Cribl → {target}',
      withoutCriblNowhere: 'Without Cribl → nowhere',
      emptyTitle: 'No destinations yet',
      emptyBody: 'Destinations appear after the first sweep reads your worker groups.',
      // P1-D06: destinations were read, but none of them carries any money.
      emptyZeroTitle: 'No money flows yet',
      emptyZeroBody: { one: 'The sweep read {n} destination, priced at $0 or with no traffic.', other: 'The sweep read {n} destinations, all priced at $0 or with no traffic.' },
      setPrice: 'Set a price',
      rowLabel: '{label}: paid {paid} and saved {saved} per day',
      // The head figure names itself (P1-H05): "paid $2,550 / day".
      paidHead: 'paid {amount}',
      // A destination's name opens its statement (P2-W25).
      openStatement: 'Open the statement for {label}',
      // The counterfactual as a shape (P2-W25): the hatched part of the bar is what the other destination's price adds.
      ghostLabel: 'Hatched: what {target} would have charged for the same bytes',
      legendPaid: 'Paid',
      legendSaved: 'Saved',
    },
    alerts: {
      title: 'Alerts',
      caption: 'Open alerts, most severe first',
      emptyTitle: 'No open alerts',
      emptyBody: "Meter Reader watches every flow's savings ratio minute by minute.",
      more: { one: '{n} more open alert', other: '{n} more open alerts' },
      // With nothing open, the card says what it is watching and what closed today (P1-H04), not 300 px of air.
      watchTitle: 'Watching now',
      watchLabel: 'What Meter Reader is watching',
      watchRoutes: 'Savings ratio',
      watchSources: 'Cost spikes',
      watchBudgets: 'Budget pace',
      routes: { one: '{n} route', other: '{n} routes' },
      sources: { one: '{n} source', other: '{n} sources' },
      destinations: { one: '{n} destination', other: '{n} destinations' },
      closedTitle: 'Closed in the last 24 hours',
      closedLabel: 'Alerts closed in the last 24 hours',
    },
    math: {
      title: 'Show the math',
      intro: 'Every figure on the Receipt comes from these formulas and prices. Values are live for {period}.',
      introRange: 'Every figure on the Receipt comes from these formulas and prices. Values are the sum for {period}.',
      formulasTitle: 'The formulas',
      whpFormula: 'Would have paid = bytes in × price',
      paidFormula: 'Paid = bytes out × price',
      savedFormula: 'Saved by Cribl = would have paid − paid',
      ratioFormula: 'Savings ratio = saved ÷ would have paid',
      savedValues: '{whp} − {paid} = {saved}',
      ratioValues: '{saved} ÷ {whp} = {pct}',
      // Why this percentage differs from the Ledger's and the Flow map's: each has its own basis.
      ratioBasis: "{pct} is a share of dollars, {period}. The Ledger's volume reduced is a share of bytes, and the Flow map prices one day at current rates.",
      // P1-F02: which dollars are measured (bytes dropped) and which rest on a price (a diversion credit).
      splitTitle: 'Measured and assumed',
      splitMtd: 'Saved by reduction {reduced} · by diversion {diverted}, month to date',
      splitRates: 'At current rates: {reduced} a day by reduction · {diverted} a day by diversion',
      splitBody:
        "Reduction is bytes a pipeline dropped, priced at the destination's own price: measured. Diversion credits data sent somewhere cheaper at the price of the destination it would have gone to without Cribl: an assumption you set under Prices.",
      // P1-F03: pipelines that grow bytes (enrichment, GeoIP) cost more than the data would have without Cribl.
      addedLine: { one: 'Cost added by Cribl on {n} flow: {amount} a day', other: 'Cost added by Cribl on {n} flows: {amount} a day' },
      addedBody: 'These pipelines send out more than comes in, so they cost more than the data would have without Cribl. Saved never counts below $0; this is the other side, shown rather than netted.',
      perDestinationTitle: 'At each destination, per day at current rates',
      // Month to date the rows are the month's own totals, so they add up to the hero (P1-F09).
      perDestinationTitleMtd: 'At each destination, month to date',
      perDestinationRateNote: "Per day at current rates means the last hour × 24: where the money goes now. These rows are a rate, so they don't add up to the figure above.",
      destNow: 'Now {volumeIn} in and {volumeOut} out per day, at current rates.',
      reconcileMatch: 'These rows add up to the figures above: {whp} would have paid − {paid} paid = {saved} saved month to date.',
      reconcileDiffer: 'These rows add up to {rows} saved; the figure above is {saved}. The {gap} difference was saved at destinations no longer listed.',
      destWhp: '{volume} in × {price} = {amount}',
      destPaid: '{volume} out × {price} = {amount}',
      destSaved: '{whp} − {paid} = {amount} saved',
      counterfactualSame: 'Without Cribl this data would go to this destination.',
      counterfactualOther: 'Without Cribl this data would go to {target}, so would have paid uses its price.',
      // P1-F01: the counterfactual destination has no price, so the credit is unknown rather than a real $0.
      counterfactualUnpriced: '{target} has no price yet, so this data is credited $0 until it has one. What it pays here still counts.',
      counterfactualNone: 'Without Cribl this data would go nowhere, so it never counts as savings.',
      preset: 'Preset: {preset} (a typical list price, not a quote)',
      customPrice: 'Custom price',
      // P1-F10: a rate the member entered beside the preset's typical list price it replaced.
      yourRate: 'Your rate · {preset} list {list}',
      setBy: 'set by {user}',
      unpriced: 'Unpriced: not included in any figure until a price is set.',
      destinationsNone: 'No destinations are priced yet.',
      // Net of Cribl (core/net.ts, DECISIONS D48): saved minus what Cribl itself cost over the same span.
      netTitle: 'Net after Cribl',
      // Founder-build r2 ui-8 (BO-5): no contract cost set, so the net is the hero's list-price estimate.
      netTitleEstimate: 'Net after Cribl (estimate)',
      netFormula: "Net after Cribl = saved − Cribl's cost for the same span",
      netValues: '{saved} − {cost} = {net}',
      paybackFormula: "Paid for itself = saved ÷ Cribl's cost",
      paybackValues: '{saved} ÷ {cost} = {multiple}×',
      netCostLine: 'Cribl cost: {monthly} a month, from Settings → Cribl cost. That is {perDay} a day (× 12 months ÷ 365 days).',
      netSpanLine: 'Prorated to the {span} metered since {from}: {cost}.',
      netSpanLineSince: "Prorated to the {span} metered since {from}, when collecting began: {cost}. Days before metering began aren't charged, because their savings weren't counted either.",
      netYearLine: 'The annualized run rate is a year, so its cost is a year of Cribl: {monthly} × 12 = {cost}.',
      netRateLine: "At the {volume} a day this workspace receives, that is {rate} per GB. Cribl's published Enterprise Cloud Worker list price is {list} per GB, billed on the bytes Cribl receives: a pipeline's reduction lowers the destination's bill, not Cribl's.",
      // Without an exact bytes-received figure (a Source on several routes), the list price alone.
      netListLine: "Cribl's published Enterprise Cloud Worker list price is {list} per GB, billed on the bytes Cribl receives: a pipeline's reduction lowers the destination's bill, not Cribl's.",
      netNone: 'No Cribl cost is set. Add what you pay Cribl each month under Settings → Cribl cost to see net savings and how many times Cribl paid for itself.',
      netRangeNone: 'A custom range is a closed window, so it is shown gross: net after Cribl shows on month to date, today, 30 days and the annualized run rate.',
      // The drawer's scrolling content is a focusable region, so a keyboard can scroll it (WCAG 2.1.1).
      regionLabel: 'The formulas, prices and assumptions',
      measuredTitle: 'Where bytes are measured',
      basis: {
        reconciled:
          "Bytes in are each source's own counter, shared across its routes by Cribl's per-route counts; bytes out are each destination's own counter. Both are exact Cribl counters, measured before compression. A flow through a pipeline with no enabled functions counts its bytes out equal to its bytes in. When one destination receives several reshaped flows, its measured bytes are split between them by Cribl's per-route estimates. Two fallbacks: a source whose routes add up to more than 10% away from its own counter keeps the per-route counts, and a destination that counts more events than its flows sent (other traffic reaches it) keeps the per-route estimates, as does one whose bytes are under half or over twice what its flows explain when Cribl reports no event counts.",
        route: 'Paid is measured at the route output, after the pipeline and before the destination.',
        pipeline: 'Paid is measured at the pipeline output.',
        proportional:
          "Paid is measured at the destination: its out-bytes include serialization and format overhead and are measured before compression (Stream Monitoring docs). Each destination's bytes are shared across its flows by their bytes in.",
        routeOnly: 'Some routes report bytes without a named source; those flows are priced at the route.',
      },
      unitsTitle: 'Units',
      gbLine: '1\u00a0GB = 1,000,000,000 bytes (decimal gigabytes).',
      roundingLine: 'Money is summed in thousandths of a cent per flow per minute and shown in whole dollars; the ticking meter also shows cents.',
      annualizedTitle: 'Annualized run rate',
      annualizedLine:
        'Saved over the last 30 days (today included) ÷ the minutes metered in them × 525,600 minutes a year = {amount} a year. Minutes when nothing was metering count on neither side.',
      annualizedPartialLine: 'Less than one whole day collected: saved so far ÷ minutes collected × 525,600 minutes = {amount} a year.',
      // Founder-build r2 ui-1 (BO-3): would have paid and paid each scale by saved's own factor over the same days, so
      // spend that saves nothing (a destination marked as going nowhere) is never hidden inside paid.
      annualizedTrendNote: 'Would have paid and paid are annualized over the same days and minutes as saved: each is this rate × its own total ÷ saved over those days.',
      annualizedRatioNote: 'Would have paid and paid scale this rate by their own totals ÷ saved over the last 30 days.',
      // 1.1.4 (judge path g): the rate saved nothing, so there is no saved figure to scale by.
      annualizedRateNote: 'Nothing was saved over these days, so would have paid and paid are their own run rates: each total ÷ the same minutes metered × 525,600 minutes a year.',
      // Founder-build r1 ui-3: the arithmetic behind "At your scale" (annualized run rate only).
      atScaleTitle: 'At your scale (projected)',
      atScaleRate: '{saved} saved a day ÷ {volume} received a day ≈ {perGb} saved per GB received, at current rates (the last hour × 24, every flow and priced destination).',
      atScaleRung: '{tb}\u00a0TB a day: {perGb} × {gb}\u00a0GB × 365 days = {exact} a year, shown as {amount} (two significant figures).',
      atScaleNote: "A projection, not a measurement: it assumes more data would be cut in the same proportion, and priced at the same destinations, as this workspace's flows are now.",
      liveTitle: 'Between sweeps',
      liveLine: 'The meter adds {rate} a minute (the last completed minute of savings) since the sweep at {time}, then eases to each new sweep.',
      liveStatic: 'The annualized run rate changes once a day, so the meter holds still.',
      // A custom range (core/range.ts): the sum, the read plan, the snapping rule.
      rangeTitle: 'Custom range',
      rangeFormula: 'Saved by Cribl = Σ saved over every row in the window, per flow, priced when it was metered',
      rangeValues: '{flows} flows · {rows} rows · {saved}',
      rangePlan: 'Read plan: {granularity} rows · {read}, {missing}',
      // A hybrid read (api-budget F2): the window's own rows at the ragged edges, the next coarser rows between.
      rangePlanHybrid: 'Read plan: {fine} rows at the edges, {coarse} rows between · {read}, {missing}',
      rangeHybrid: {
        minute: 'Whole hours are read from hour rows, the exact sums of their minute rows; there the minutes metered are those of the busiest flow in each hour.',
        hour: 'Whole UTC days are read from day rows, the exact sums of their hour rows; a day with a row counts as 1,440 minutes metered.',
      },
      rangePlanRead: { one: '{n} document read', other: '{n} documents read' },
      rangePlanMissing: { one: '{n} missing', other: '{n} missing' },
      rangePlanNoneMissing: 'none missing',
      rangeMinutes: '{metered} of {expected} minutes metered',
      rangeDays: '{metered} of {expected} days metered',
      rangeGranularity: { minute: 'minute', hour: 'hour', day: 'day' },
      rangeSnapMinute: 'Minute rows are exact: the window is summed to the minute.',
      rangeSnapHour: 'Hour rows widen the window to whole hours and stop at the last whole hour (the hour in progress has no row yet): a row counts when its hour starts inside the window.',
      rangeSnapDay: 'Day rows widen the window to whole UTC days and stop at the last whole UTC day (the day in progress has no row yet).',
      rangeLiveStatic: 'A custom range is a closed window, so the meter holds still.',
      // Compared with… (P2-W13): both windows' saved, the change and its share of the baseline, and the basis.
      compareTitle: 'Compared with {name}',
      compareFormulaSum: 'Change = saved in this range − saved in {name}',
      compareFormulaRate: 'Change per day = saved a day in this range − saved a day in {name}',
      compareValues: '{current} − {baseline} = {change}',
      comparePctFormula: 'Change as a share = change ÷ what {name} saved',
      comparePctValues: '{change} ÷ {baseline} = {pct}',
      compareRead: 'Read for the comparison: {read}, {missing}',
      compareBasisSum: 'Both windows are the same length and were metered alike, so their sums are compared.',
      compareBasisRate: "The windows differ in length or in how much of them was metered, so each is taken as a day at its own rate: saved ÷ minutes metered × 1,440, or ÷ days metered in day rows.",
      close: 'Close',
    },
    states: {
      loading: 'Loading the receipt',
    },
  },

  unpriced: {
    banner: {
      one: '{n} destination is unpriced. Set prices to include it.',
      other: '{n} destinations are unpriced. Set prices to include them.',
    },
    link: 'Set prices',
    badge: 'unpriced',
  },

  flow: {
    title: 'Flow',
    subtitle: 'Cribl Insights shows this map in bytes. This is dollars.',
    // The byte map (P2-W02): what Insights draws, one press away from what it costs.
    // (as long as the dollar line, so the toggle never moves the map's frame)
    subtitleBytes: 'Bytes, the way Cribl Insights draws it. Switch to dollars.',
    // P2-W16: the savings as a place, incidents on their ribbons, destinations as chips that isolate their paths.
    sink: {
      name: 'Removed by Cribl',
      caption: '{amount} / day',
      captionBytes: '{volume} / day removed',
      aria: 'Removed by Cribl: {saved} saved per day, pooled from every flow a pipeline trims. Press Enter to pin every saving path.',
    },
    incident: {
      open: '−{amount} / day since {time}',
      openCommit: '−{amount} / day since {time} · {commit}',
      recovered: 'Recovered at {time}',
      short: '−{amount} / day · {commit}',
      shortNoCommit: '−{amount} / day',
    },
    chips: {
      aria: 'Destinations: select one to show only its paths',
      chip: '{amount} / day · {price} / GB',
      chipUnpriced: '{amount} / day',
    },
    // The map on stage (P2-W10): /flow?stage=1, F on the Flow view; P or Escape comes back.
    stage: {
      enter: 'Present',
      eyebrow: 'Flow · {group}',
      aria: 'The flow map for {group}, on stage',
      leave: 'Leave the stage (P)',
    },
    weight: {
      aria: 'What band width measures',
      label: 'Width',
      dollars: 'Dollars',
      bytes: 'Bytes',
    },
    hoverIn: 'In {volume} / day',
    hoverOut: 'Out {volume} / day',
    hoverSaved: 'Saved {amount} / day',
    hoverNow: 'Paying now {amount} / hour, {multiple}× baseline',
    empty: 'Set a price to see dollars on this map',
    emptyBody: 'The map prices every flow at its destination. Add a price for at least one destination to draw it.',
    setPrices: 'Set prices',
    noTrafficTitle: 'No priced traffic in {group}',
    noTrafficBody: 'Flows appear here once a priced destination receives data. Meter Reader reads every minute.',
    mapAria: 'Flow map for {group}: sources, pipelines and destinations, priced in dollars per day',
    mapAriaBytes: 'Flow map for {group}: sources, pipelines and destinations, sized in bytes per day',
    group: 'Worker group',
    groupStatic: 'Worker group · {group}',
    whatIfToggle: 'What if…',
    // The What-if on the Flow view (P1-I06 slice 2): one compact bar over the same map; the calculator is /whatif.
    whatIfBar: {
      aria: 'What if, on this map',
      open: 'Open the calculator',
      basisLine: 'Projection · {basis}: {pct} fewer bytes',
      noEstimate: 'No estimate yet for this treatment. The calculator says why.',
      noTraffic: 'This stream had no traffic in the last hour.',
    },
    legendPaid: 'Width is dollars a day: would have paid, then paid',
    legendSaved: 'Removed by the pipeline, saved at current rates',
    // The phone's legend (P1-I05): the same two shapes in a line each, never five caption lines.
    legendPaidShort: 'Width is dollars a day',
    legendSavedShort: 'Hatched is saved',
    legendPaidBytes: 'Width is bytes a day: in, then out (paler = cheaper per GB)',
    legendSavedBytes: 'Removed by the pipeline',
    legendPaidBytesShort: 'Width is bytes a day',
    legendSavedBytesShort: 'Hatched is removed',
    legendProjected: 'Projected',
    // D55: each source has its own hue; past the largest few, one neutral instead of a repeated hue (a note sentence,
    // not a legend item: a third legend item wraps the footer at 1440 and costs the fitted map its rows)
    tailNote: { one: 'Sources past the largest are grey.', other: 'Sources past the {n} largest are grey.' },
    showing: 'Showing the {shown} largest of {total} flows by would-have-paid.',
    seeLedger: 'See every flow in the Ledger',
    // Why flows are not drawn, one bucket each (P1-I04); only an unpriced destination links to Settings.
    undrawn: {
      unpriced: { one: '{n} flow goes to a destination without a price.', other: '{n} flows go to destinations without a price.' },
      zero: { one: '{n} flow priced at $0 is not drawn.', other: '{n} flows priced at $0 are not drawn.' },
      noTraffic: { one: '{n} flow had no traffic in the last hour.', other: '{n} flows had no traffic in the last hour.' },
    },
    plateWhp: '{amount} / day',
    plateSaved: '{amount} saved',
    plateVolume: '{volume} / day',
    plateRemoved: '{volume} removed',
    captionIn: '{volume} / day in',
    captionOut: '{amount} / day',
    captionOutBytes: '{volume} / day out',
    unattributed: 'Unattributed sources',
    noPipeline: 'No pipeline',
    other: {
      source: { one: '{n} smaller flow', other: '{n} smaller flows' },
      sourceBytes: { one: '{n} low-cost flow', other: '{n} low-cost flows' },
      pipe: 'Their pipelines',
      part: '{n} of the {total} smaller flows',
      path: "Flows under {pct} of this map's would-have-paid, grouped by destination.",
    },
    grouped: {
      one: '{n} flow under {pct} of would-have-paid is grouped.',
      other: '{n} flows under {pct} of would-have-paid are grouped.',
    },
    list: {
      aria: 'Flows in {group}, largest would-have-paid first. Select one to show it on the receipt.',
      showMap: 'Show map',
      showList: 'Show list',
      saved: '{amount} saved',
      nothingSaved: 'Nothing removed yet',
    },
    keyboardHint: 'Arrow keys move between nodes. Tab goes on to each flow. Enter pins a path. Escape clears.',
    nodeAria: '{kind} {name}. {whp} would have paid, {saved} saved per day. Press Enter to pin its path.',
    // A ribbon, reached with Tab after the nodes (P1-I05): one flow's receipt for a keyboard user.
    ribbonAria: 'Flow from {source} through {pipeline} to {destination}. {whp} would have paid, {saved} saved per day. Press Enter to pin it.',
    kind: {
      in: 'Source',
      pipe: 'Pipeline',
      out: 'Destination',
    },
    card: {
      title: 'Receipt',
      allTitle: 'All flows in {group}',
      allHint: 'Hover or focus a source, pipeline or destination to trace its path.',
      listHint: 'Tap a flow to see its receipt.',
      flowCount: { one: '{n} flow', other: '{n} flows' },
      in: 'In',
      out: 'Out',
      whp: 'Would have paid',
      paid: 'Paid',
      saved: 'Saved',
      now: 'Paying now',
      baseline: '{multiple}× baseline',
      // The map's percentage is dollars at current rates (the Receipt's is dollars for a period, the Ledger's bytes).
      savedPct: '{pct} saved at current rates',
      openPipeline: 'Open pipeline in Cribl',
      pinned: 'Pinned · Esc to release',
      projection: 'Projection',
    },
    projectionChip: 'Projection',
  },

  whatif: {
    title: 'What if',
    subtitle: 'See what a pack would save on a stream before anyone changes the configuration.',
    stream: 'Stream',
    treatment: 'Treatment',
    streamOption: '{source} → {destination}',
    treatments: {
      'pack-windows': 'Windows XML pack',
      'pack-panos': 'Palo Alto + syslog packs',
      'pack-vpc': 'VPC Flow aggregation pack',
      'aggressive-windows': 'Go aggressive: Windows XML reduction',
      custom: 'Custom: drop a share of bytes',
    },
    drop: 'Drop {pct} of what this stream sends today',
    dropAria: "Share of today's bytes to drop",
    compare: {
      title: 'Before and after',
      savedDay: 'Saved / day',
      savedYear: 'Saved / year',
      ratio: 'Savings ratio',
      volume: 'Sent / day',
      new: 'New',
      newAria: 'Nothing saved today',
      pointsUnit: 'points',
      before: 'Before',
      projected: 'Projected',
      measured: 'Measured',
      measuring: 'Waiting',
      measuringAria: 'Waiting for the next sweep to measure it',
    },
    range: '{low}–{high}',
    hero: {
      label: 'Saved by Cribl would read',
      caption: 'annualized, {delta}',
      // Founder-build r2 ui-7 (IC-2): the figure rests on the workspace at today's rates, the strip's basis, and says so.
      captionCurrent: 'a year at current rates, {delta}',
      from: 'from {amount} today',
      noRunRate: 'This stream alone would add {amount} a year.',
      midpoint: 'at the middle of the documented range',
    },
    basisLabel: {
      'dry-run': 'Dry run',
      similar: 'Similar stream',
      documented: 'Documented range',
      custom: 'Your assumption',
    },
    basis: {
      'dry-run': 'Measured by dry run on {events} sample events of this source: {inBytes} in, {outBytes} out through {pipeline}.',
      'dry-run-sample': 'Measured by dry run on {events} events of the sample {sample}: {inBytes} in, {outBytes} out through {pipeline}.',
      similar: 'Measured on a similar stream: {object} runs this treatment at {pct} today.',
      documented: 'Documented: {range} ({source}). Shown as a range until it is measured here.',
      custom: 'Your assumption: drop {pct} of what this stream sends today.',
    },
    noBasisTitle: 'No estimate yet for the {treatment}',
    noBasisBody:
      'Cribl documents this pack as “significantly reduce” without a number, and no stream here runs it yet. Meter Reader uses the measured ratio as soon as one does.',
    noTraffic: 'This stream had no traffic in the last hour, so there is nothing to project.',
    noStreams: 'Price a destination to project savings on its streams.',
    empty: 'Set a price to project what a pack would save',
    emptyBody: 'What if prices every stream at its destination. Add a price for at least one destination to project savings on its streams.',
    loading: 'Loading What if',
    alreadyRuns: 'This stream already runs this treatment. Its measured ratio is {pct}.',
    // Founder-build r1 ui-4 (FOUNDER_PLAN row 2b): a Pack attached alone that is only part of the treatment (Cribl's Palo
    // Alto Networks pack without the syslog pack). {pack} is the Pack's name ('Palo Alto Networks').
    alreadyRunsPack: 'This stream already runs the {pack} pack. Its measured ratio is {pct}.',
    savesLess: 'This stream already saves more than the treatment would; the projection shows the difference.',
    math: {
      title: 'Show the math',
      whp: 'Would have paid',
      whpLine: '{volume} × {price} / GB',
      out: 'Sent after',
      outLine: '{volume} × (1 − {pct})',
      outDropLine: '{volume} × (1 − {pct})',
      paid: 'Paid after',
      paidLine: '{volume} × {price} / GB',
      saved: 'Saved / day',
      perYear: 'Saved / year',
      perYearLine: '{amount} × 365',
      dryRunNote:
        "A dry run sends up to 200 of the source's sample events (under 90\u00a0KB) through the pipeline with Cribl's preview API and weighs each event's _raw, as the destination receives it. Nothing is saved. Sampling and aggregation save more at full volume than on a sample.",
    },
    projectionNote: 'A projection. Nothing changes until someone applies it in Cribl.',
    dryRun: {
      label: 'Measure on this source',
      button: 'Dry run on sample events',
      again: 'Dry run again',
      running: 'Running the pipeline on sample events…',
      reason: {
        'no-sample': 'No dry run: this source has no sample file of its own to run through the pipeline.',
        'no-pipeline': 'No dry run: no pipeline in this worker group implements this treatment yet.',
        forbidden: 'No dry run: this App is not allowed to use the preview API here (HTTP {status}).',
        unavailable: "No dry run: Cribl's preview API did not answer.",
        empty: 'No dry run: the sample had no events to measure.',
        failed: 'The dry run failed (HTTP {status}).',
        failedNoStatus: 'The dry run failed: Cribl could not be reached.',
      },
      // P2-W26: a Source with no sample of its own can be measured on one of the group's samples.
      pick: {
        label: 'Measure on a sample from this worker group',
        placeholder: 'Pick a sample',
        item: '{sample} · from {source}',
      },
      fallback: {
        similar: 'The estimate stays on the similar stream.',
        documented: 'The estimate stays on the documented range.',
        none: 'There is still no estimate.',
      },
    },
    projectedVsActual: 'Projected {projected}, measured {measured} after {minutes}\u00a0min',
    waitingForSweep: 'Applied. Waiting for the next sweep to measure it.',
    applied: {
      clock: '{clock} since the change',
      title: 'Projected against measured',
      heroLabel: 'Saved by Cribl now reads',
      heroCaption: 'annualized, live',
      streamMeasured: 'This stream, measured: {delta} a year',
      streamProjected: 'Projected: {delta} a year',
      basis: "Measured on the last metered minute since the change, priced at today's volume and price.",
    },
    // P1-F13: a pack only projects on the source it is written for.
    fits: {
      windows: 'Windows event sources',
      panos: 'Palo Alto firewall syslog',
      vpc: 'VPC Flow Logs',
    },
    notApplicable: {
      title: 'The {treatment} does not fit {stream}',
      body: 'It is written for {fits}, so it would project savings from events this stream never sends. Nothing is projected.',
      trySuggested: 'Try the {treatment}',
      tryCustom: 'Try a custom drop',
    },
    // P2-W23: the treatment tiles and the unclaimed savings.
    tiles: {
      range: {
        documented: '{range} documented',
        none: 'No published number',
        custom: 'Your drop: {pct}',
      },
      desc: {
        'pack-windows': 'XML to JSON; keeps the Splunk TA and CIM working.',
        'pack-panos': 'Strips syslog headers and unused fields.',
        'pack-vpc': 'Aggregates and suppresses repeat flows.',
        'aggressive-windows': 'The Cribl Docs reduction: more savings, less compatibility.',
        custom: 'Drops a share of what the stream sends today.',
      },
      runs: { one: 'Runs on {n} stream here · {pct}', other: 'Runs on {n} streams here · {pct}' },
      runsNoPct: { one: 'Runs on {n} stream here', other: 'Runs on {n} streams here' },
      notYet: 'Not running here yet',
      notFit: 'Not for this stream: written for {fits}',
    },
    unclaimed: {
      title: 'Biggest unclaimed savings',
      caption: 'Each stream here with the next pack written for it, by what it would add a year.',
      line: '{treatment} on {stream}',
      aria: 'Load the {treatment} on {stream} in the calculator: {amount} a year',
      none: 'Every stream here already runs the pack written for it.',
      // Founder-build r1 ui-4 (FOUNDER_PLAN row 2, HUNGER #5): why the list is empty (core/whatif.ts unclaimedEmptyReason);
      // `none` shows only when every stream a pack fits runs it.
      noneFit: 'No stream here is one these packs are written for (Windows event logs, Palo Alto firewall syslog, VPC Flow Logs). A custom drop works on any stream.',
      noBasis: 'The streams a pack fits have no estimate yet: no similar stream here runs it, and the pack publishes no range.',
      savesMore: 'The streams a pack fits already save at least what it would add.',
      listLabel: 'Biggest unclaimed savings, largest first',
    },
    // P2-W06: the good-news takeover (WhatIf/LandedCard.tsx).
    landed: {
      chip: 'What-if',
      at: 'Landed {time}',
      in: 'Landed {duration} after the deploy',
    },
  },

  // Demo build only; see WHATIF_DEMO_COPY above.
  whatifDemo: (import.meta.env?.VITE_MR_BUILD === 'demo' ? WHATIF_DEMO_COPY : {}) as typeof WHATIF_DEMO_COPY,

  ledger: {
    title: 'Ledger',
    columns: {
      source: 'Source',
      route: 'Route',
      pipeline: 'Pipeline',
      destination: 'Destination',
      // The Ledger's wide table, when its flows span two or more worker groups (P1-K01).
      group: 'Worker group',
      in: 'In',
      out: 'Out',
      trend: 'Trend',
    },
    searchPlaceholder: 'Search flows',
    mutedChip: 'muted after a demo change · {minutes} min',
    // P1-F07: a member's "Mute for 24 hours" — how long is left, in hours once it is an hour or more.
    mutedMemberChip: 'muted · {left} left',
    mutedLeftHours: '{n} h',
    mutedLeftMinutes: '{n} min',
    // The Ledger's muted chip reads whole in its column (P1-K05); the sentence is its hover title.
    mutedChipShort: 'Muted · {minutes} min',
    mutedTitle: 'Muted after a demo change · {minutes} min left',
    empty: 'No flows yet',
    emptyFiltered: 'No flows match these filters',

    // ── Ledger view (PRD 8.3, DESIGN_BRIEF 5.4) ──
    subtitle: 'Every flow priced at its destination: what it would have cost, what it cost and what Cribl saved.',
    emptyBody: 'Meter Reader lists every flow here after its first sweep prices them.',
    emptySetPrices: 'Set prices',
    emptyFilteredBody: 'Try a different search, or clear the filters to see every flow.',
    // The snapshot could not be read and none is on screen (P1-K06): the error notice says why, once.
    unreadable: "Flows can't be listed right now",
    unreadableBody: 'The table fills in as soon as the latest snapshot can be read.',
    tableLabel: 'Flows',
    count: { one: '{n} flow', other: '{n} flows' },
    countFiltered: '{shown} of {total} flows',
    // A snapshot over its size cap (core/snapshot.ts compactSnapshot) lists the largest flows and sums the rest on one
    // Other row (usefulness review, round 2). The sweep still meters and watches every flow.
    fold: {
      notice: 'The {shown} largest of {total} flows are listed; the other {other} are summed on the “Other” row. Every flow is metered and watched.',
      noticeNoTotal: 'The {shown} largest flows are listed; the rest are summed on the “Other” row. Every flow is metered and watched.',
      otherRow: { one: 'Other · {n} smaller flow', other: 'Other · {n} smaller flows' },
      otherRowNoCount: 'Other · the smaller flows',
    },
    totalFlows: { one: 'Total · {n} flow', other: 'Total · {n} flows' },
    // P1-F03: flows that send out more than came in cost more than they would have without Cribl.
    addedLine: { one: 'Cost added by Cribl on {n} flow: {amount} / day', other: 'Cost added by Cribl on {n} flows: {amount} / day' },
    // The Receipt's custom range on the Ledger (P2-W14): the money columns sum the window instead of a day's rate.
    window: {
      summed: "Money columns sum {words}, the Receipt's custom range.",
      loading: "Summing the Receipt's custom range…",
      error: "The Receipt's custom range couldn't be summed, so the money columns show per-day rates.",
      retry: 'Retry',
      perDay: 'Show per day',
      unlisted: {
        one: "{n} flow metered in this window isn't in the latest sweep · {amount} saved",
        other: "{n} flows metered in this window aren't in the latest sweep · {amount} saved",
      },
      // The same line when the snapshot is folded: most of these are the Other row's flows, summed here by name.
      unlistedFolded: {
        one: '{n} flow metered in this window is not listed one by one (on the “Other” row, or no longer swept) · {amount} saved',
        other: '{n} flows metered in this window are not listed one by one (on the “Other” row, or no longer swept) · {amount} saved',
      },
      stripBasis: 'Summed over {words}',
    },
    // The money strip over the table (P2-W17): the listed flows' totals, per day at the last hour's rate.
    strip: {
      label: 'Money per day, for the listed flows',
      basis: "Per day at the last hour's rate",
      whp: 'Would have paid',
      paid: 'Paid',
      saved: 'Saved',
      whpCaption: 'Without Cribl',
      shareCaption: '{pct} of would have paid',
      // The workspace's savings ratio (every flow, 5-minute buckets) now against the same time yesterday.
      deltaUp: '+{points} since this time yesterday',
      deltaDown: '−{points} since this time yesterday',
      deltaLevel: 'Level with this time yesterday',
    },
    openInCribl: 'Open pipeline {pipeline} in Cribl',
    sortBy: 'Sort by {column}',
    trendLabel: { one: 'Savings ratio over the last {n} minute, from {from} to {to}', other: 'Savings ratio over the last {n} minutes, from {from} to {to}' },
    trendEmpty: 'No trend yet',
    noPipeline: 'No pipeline',
    objectHidden: 'The linked flow is hidden by the current filters.',
    objectMissing: "The linked object isn't in the latest sweep.",
    // A ?dest= / ?group= value the latest sweep does not know is not applied (P1-K05): every row stays listed.
    destMissing: "Destination {id} isn't in the latest sweep, so every destination is listed.",
    groupMissing: "Worker group {id} isn't in the latest sweep, so every group is listed.",
    showAll: 'Clear filters',
    loading: 'Loading flows',
    // Flows with no traffic fold into one summary row under the table (BEAUTY F11).
    quiet: {
      hidden: { one: '{n} flow with no traffic in the last hour', other: '{n} flows with no traffic in the last hour' },
      shown: { one: '{n} flow with no traffic in the last hour is listed', other: '{n} flows with no traffic in the last hour are listed' },
      show: 'Show',
      hide: 'Hide',
    },
    columnsExtra: {
      flow: 'Flow',
      // A share of bytes (1 − out ÷ in), never dollars: named so it cannot be read as the Receipt's "% saved".
      reduction: 'Volume reduced',
      reductionHint: '{pct} less volume: bytes out against bytes in, not dollars',
      // P1-F02: a diversion credit is not bytes dropped; P1-F03: a pipeline that grows bytes reads negative.
      diverted: 'diverted',
      divertedHint: 'Without Cribl this data would go to {target}: its savings are credited at that price, not bytes dropped',
      inflatingHint: '{pct} more volume out than in: this pipeline adds data',
      whpPerDay: 'Would have paid',
      paidPerDay: 'Paid',
      savedPerDay: 'Saved',
      status: 'Status',
      perDay: '/ day',
    },
    filters: {
      searchLabel: 'Search flows',
      searchHint: 'Press / to search',
      clearSearch: 'Clear search',
      state: 'Status',
      stateAll: 'All statuses',
      destination: 'Destination',
      destinationAll: 'All destinations',
      group: 'Worker group',
      groupAll: 'All groups',
      clear: 'Clear filters',
      optionCount: '{label} ({n})',
    },
    states: {
      ok: 'OK',
      regression: 'Savings dropped',
      spike: 'Cost spike',
      budget: 'Over budget pace',
      goodnews: 'Savings improved',
      unpriced: 'Unpriced',
      learning: 'Learning',
      muted: 'Muted',
      idle: 'No traffic',
    },
    timeline: {
      title: 'Change timeline',
      caption: 'Savings ratio across every flow, with each commit that shipped',
      rangeLabel: 'Time range',
      range24h: '24 h',
      range7d: '7 days',
      // Zoomed to the window around the commits (BEAUTY F12): the default whenever the last 24 h has commits.
      rangeFit: 'Changes',
      fitCaption: 'from {time}, around the latest changes',
      since: 'since {time}',
      last24h: 'last 24 hours',
      last7d: 'last 7 days',
      // The chart group's accessible name (P1-K04): reads for every range ("from 4:49 PM, around the latest changes").
      chartName: { one: 'Savings ratio, {range}, {n} commit marked', other: 'Savings ratio, {range}, {n} commits marked' },
      markerLabel: 'Commit {hash} by {author}, {time}',
      hint: 'Select a commit marker to see who shipped it and what moved.',
      // The chart group's description for assistive tech (P1-K04): how to reach the commit markers.
      keyboardHint: 'Each commit is a button: Tab to it, then press Enter to see who shipped it and what moved.',
      readout: '{time} · {pct} saved',
      // A Ledger row's pointer is on this flow (P2-W17).
      linkedReadout: '{label} · {pct} saved now',
      emptyTitle: 'No history yet',
      emptyBody: 'The savings ratio appears here after a few sweeps.',
      unavailableTitle: "History can't be read right now",
      unavailableBody: 'The savings ratio returns with the next snapshot read.',
      weekEmpty: 'Seven days of history appear after a week of metering.',
      noCommits: 'No commits in this range.',
      committed: 'committed {time}',
      deployed: 'deployed {time}',
      by: 'by {author}',
      filesTitle: 'Files touched',
      filesNone: 'No file list for this commit',
      moreFiles: '+{n} more',
      movedTitle: 'What moved',
      movedNone: 'No flow moved more than a few points after this commit.',
      movedNow: 'now {after}',
      close: 'Close',
      legendRatio: 'Savings ratio',
      legendCommit: 'Commit',
      legendCause: 'Named by an alert',
      // Every commit priced (P2-W07): the commit card's dollar line, its basis, and the chart's annotation.
      impactLine: '{amount} a day since this deploy',
      impactYear: '{amount} a year',
      impactMoved: { one: '{n} flow moved', other: '{n} flows moved' },
      impactFlat: 'No measurable change since this deploy',
      impactUnpriced: 'Not priced: nothing measures this change on its own',
      // Each basis at today's volume (the card and the list's caption say so once).
      impactBasis: {
        alert: 'Priced by the alert that names it',
        flows: 'Priced from the flows that moved',
        workspace: "Every flow's ratio, the hour either side",
        daily: 'The next day against a like day before',
      },
      impactVolume: "at today's volume",
      // A workspace or daily price measures every flow's shift around the deploy, not this change's own flows: it is
      // shown for what it is and never credited or blamed on the commit (not in the net, the annotation or a headline).
      impactShiftLine: 'The whole workspace moved {amount} a day after this deploy',
      unattributed: "Unattributed: the whole workspace's shift, not this change's own flows",
      movedPerDay: '{amount} / day',
      annotation: '{amount} / day since {hash} · {author}',
      changes: {
        title: 'Changes',
        caption: "Every commit of the last 7 days, priced by what moved after it, at today's volume",
        // The snapshot keeps the newest commits only (30, fewer once compacted): said when the 7 days held more.
        captionLatest: {
          one: "The latest commit of the last 7 days (the snapshot keeps the newest only), priced by what moved after it, at today's volume",
          other: "The latest {n} commits of the last 7 days (the snapshot keeps the newest only), priced by what moved after them, at today's volume",
        },
        listLabel: 'Commits of the last 7 days, priced',
        empty: 'No commits in the last 7 days.',
        flat: 'no measurable change',
        unpriced: 'not priced',
        meta: '{author} · deployed {time}',
        metaCommitted: '{author} · committed {time}',
        net: 'Net of the priced changes',
        // Said under the net when some rows are unattributed workspace shifts (they are not in it).
        netNote: 'Unattributed workspace shifts are not in the net.',
        // Usefulness review, round 2: a drop priced from its alert that closed by recovering no longer runs per day.
        recovered: 'Recovered {time}',
        recoveredBy: 'Recovered {time}, reverted by {hash}',
        undid: 'Undid {hash}',
        netNoteSettled: 'A drop that recovered, and the change that undid it, are not in the net.',
        rowLabel: 'Commit {hash} by {author}, {impact}. Show it on the change timeline.',
      },
    },
    rail: {
      title: 'Alerts',
      /** After the count beside the title, for screen readers only ("Alerts 2 open"). */
      countSuffix: 'open',
      caption: 'Open and recent alerts, with where they were sent',
      open: 'Open',
      recent: 'Recent · last 24 hours',
      emptyTitle: 'No open alerts',
      emptyBody: {
        one: 'Meter Reader is watching {n} flow and alerts when the money moves the wrong way.',
        other: 'Meter Reader is watching {n} flows and alerts when the money moves the wrong way.',
      },
      emptyBodyNoFlows: 'Alerts appear here when the money moves the wrong way, with where each one was sent.',
      unavailableTitle: "Alerts can't be read right now",
      unavailableBody: 'They show here again with the next snapshot read.',
      showInTable: 'Show in table',
    },
  },

  // A commit's author (src/lib/author.ts; usefulness review, round 2): an API-made commit's author is an OAuth client
  // id, so it reads as that client, by the last four characters of its id, until a member names it.
  // r2 ui-15 (H3): the one set of words, core's (core/strings.ts AUTHOR_STRINGS, printed by core/humanize.ts displayAuthor).
  commits: {
    apiClient: CORE_STRINGS_AUTHOR.apiClient,
    unknownAuthor: CORE_STRINGS_AUTHOR.unknownAuthor,
  },
  incidents: {
    // The compact card's eyebrow over the object's name (P1-H04): the kind, then the time.
    eyebrow: {
      regression: 'Savings dropped',
      spike: 'Cost spike',
      budget: 'Over budget pace',
      goodnews: 'Savings improved',
    },
    ratioFell: 'Ratio fell from {before} to {after} at {time}',
    noChange: 'No configuration change found nearby',
    nearbyChange: 'A change was deployed {minutes}\u00a0min earlier; it may not be the cause.',
    sentTo: 'Sent to {endpoint} ✓ {time}',
    // A notification target's line (craft review, round 1): Cribl accepted it for delivery; the App cannot see further.
    handedTo: 'Handed to Cribl for {endpoint} ✓ {time}',
    deliveryFailed: 'Delivery failed ({status}). Retrying.',
    viewInLedger: 'View in Ledger',
    perDayPerYear: '{perDay} a day · {perYear} a year',
    // What an incident costs, worded as the report card words it (report.card.impact): only an open regression is
    // projected to a year, and only as what it would cost if nobody fixed it. A spike is transient by nature and a
    // closed incident is over, so neither is ever annualized (a recovered spike is not a seven-figure yearly cost).
    impact: {
      open: '{perDay} a day · {perYear} a year if left',
      spike: '{perDay} a day above normal while it lasts',
      closed: '{perDay} a day above normal while it lasted · {duration}',
      closedNoDuration: '{perDay} a day above normal while it lasted',
      // Founder-build r2 ui-4 (FINDINGS_R2 #2, C3): closed by the $/day floor, not recovered: the savings are still where
      // they fell, so never "while it lasted" and never a year. Worded as every channel words it (core/strings.ts
      // impact.belowFloor: the bell, a notification target, Slack).
      belowFloor: 'fell under the {floor}/day floor; savings still at {after}',
      belowFloorGeneric: 'fell under the {floor}/day floor',
    },
    caughtIn: 'Caught in {duration}',
    recovered: 'Recovered · savings back to {pct} · closed itself.',
    caughtOnCatchUp: 'caught on catch-up',

    // ── Incident card + takeover (PRD 8.1, DESIGN_BRIEF 5.2 / 5.8, SPEC 10 / 17) ──
    kind: {
      pipe: 'pipeline',
      route: 'route',
      in: 'source',
      out: 'destination',
    },
    cause: {
      files: 'change to this {kind}',
      message: 'change naming this {kind}',
      nearby: 'nearby change',
      table: 'route table edited',
    },
    // The shared route table was edited in this commit, but this route's own entry is not confirmed changed.
    tableCaveat: "The commit edited the route table; this {kind}'s entry is unchanged or not confirmed, so it may not be the cause.",
    commitShort: '{hash} "{message}" · {author}',
    commitBy: '{hash} by {author}',
    // The takeover (P1-B02): the commit message on its own line under "a1f3c9e by s.koelpin"; the green card
    // names the change that restored the savings, or says they are back at their baseline.
    commitQuoted: '"{message}"',
    restoredBy: 'Restored in {hash} by {author}',
    backAtBaseline: 'Back at its baseline since {time}',
    // P2-W15: the drawn drop on the incident cards (the chart's accessible name).
    watch: {
      label: 'Savings ratio by minute: at {before} until the change at {time}, lower after it',
      labelRecovered: 'Savings ratio by minute: at {before} until the change at {time}, lower after it, then back',
    },
    // P2-W03: what the incident has cost so far, counting on the red card; frozen on the green one.
    lostSinceDeploy: 'Lost since the deploy',
    lostSinceStart: 'Lost since it started',
    costBeforeRecovered: 'Cost {amount} before it recovered',
    deployedAt: 'deployed {time}',
    committedAt: 'committed {time}',
    openedAt: 'Opened {time}',
    recoveredAt: 'Recovered {time}',
    measure: {
      ratio: 'savings ratio',
      perHour: 'cost per hour',
      budget: 'of budget, projected',
    },
    spikeRose: 'Cost rose from {before} to {after} an hour at {time}',
    budgetPace: 'Projected at {after} of budget at {time}',
    ratioRose: 'Ratio rose from {before} to {after} at {time}',
    // Closed incidents keep their drop and add where they recovered to (DECISIONS D47): "76% → 49% ·
    // recovered to 89%". One closed before D47 kept no drop, so only the recovery shows — leading the line, in
    // sentence case (`recoveredToLead`) — and its sentence names the close instead of the fall.
    recoveredTo: 'recovered to {value}',
    recoveredToLead: 'Recovered to {value}',
    recoveredToAt: 'Recovered to {value} at {time}',
    deliveryFailedFinal: 'Delivery failed ({status}).',
    deliveryNoResponse: 'Delivery failed (no response). Retrying.',
    deliveryBlocked: 'Delivery blocked: host not authorized.',
    deliveryUnavailable: 'Not delivered: Cribl notification API unavailable ({status}).',
    deliveryNotPermitted: 'Not delivered: Cribl notification API refused ({status}).',
    deliveryMore: { one: '+{n} more endpoint', other: '+{n} more endpoints' },
    endpointFallback: {
      slack: 'Slack',
      generic: 'webhook',
      servicenow: 'ServiceNow',
    },
    recoveredSpike: 'Recovered · cost back to {amount} an hour · closed itself.',
    recoveredBudget: 'Recovered · back under budget pace · closed itself.',
    recoveredGeneric: 'Recovered · closed itself.',
    // Founder-build r1 ui-6: closes that are not recoveries. M9: the drop fell under the $/day alert floor, so the alert
    // closed with the savings still where they fell (D47). Row 9 / PACK_PAYOFF F1: good news never "recovers".
    closedBelowFloor: 'Closed · the drop fell under the alert floor · savings still at {pct}.',
    closedBelowFloorGeneric: 'Closed · the drop fell under the alert floor.',
    goodNewsHeld: 'Improvement held · savings at {pct}.',
    goodNewsHeldGeneric: 'Improvement held.',
    // The green recovery takeover (BEAUTY F3: the same card, in green).
    savingAgain: 'Saving {perDay} a day again · {perYear} a year',
    openFor: 'Alert open for {duration}',
    showSlack: 'Show the Slack message',
    hideSlack: 'Hide the Slack message',
    dismiss: 'Dismiss',
    dismissHint: 'Press any key to dismiss',
    severity: {
      high: 'High severity',
      medium: 'Medium severity',
      info: 'Information',
      recovered: 'Recovered',
    },
    arrow: 'to',
    // P1-F07: what a member can do with an open alert, and how it reads once they have (core/incidents.ts).
    actions: {
      menu: 'Alert actions',
      accept: 'Accept as the new normal',
      acceptHint: 'Stop alerting and learn {level} as normal',
      acceptHintPlain: 'Stop alerting and learn this level as normal',
      mute: 'Mute for 24 hours',
      muteHint: 'Nothing new opens on it until {day}, {time}',
      exclude: 'Leave out of metering',
      excludeHint: 'For test pipelines and lab sources',
      acceptTitle: 'Accept this as the new normal?',
      acceptBody:
        'Meter Reader closes this alert and learns {level} as normal for this {kind}, so this change stops alerting. A new drop from there alerts as usual.',
      excludeTitle: 'Leave {label} out of metering?',
      excludeBody:
        'Flows through this {kind} stop being metered, priced and alerted on, and their dollars leave every total. Bring it back under Settings → Alerts.',
      acceptConfirm: 'Accept',
      excludeConfirm: 'Leave out',
      cancel: 'Cancel',
      locked: 'A sweep is writing right now. Try again in a moment.',
      pending: 'Saved. The alert closes at the next sweep.',
      failed: "Couldn't close this alert ({error}). Nothing was changed.",
      alreadyClosed: 'This alert had already closed.',
    },
    closedBy: {
      accepted: 'Accepted as the new normal by {by}',
      muted: 'Muted by {by}',
      excluded: 'Left out of metering by {by}',
    },
    closedByAnon: {
      accepted: 'Accepted as the new normal',
      muted: 'Muted',
      excluded: 'Left out of metering',
    },
    closedAt: 'Closed {time}',
    mutedUntil: 'muted until {day}, {time}',
  },

  settings: {
    title: 'Settings',
    groups: {
      prices: 'Prices',
      budgets: 'Budgets',
      criblCost: 'Cribl cost',
      alerts: 'Alerts',
      notifications: 'Where to send alerts',
      demo: 'Demo',
    },
    helperPrices: 'Enter what each destination charges per GB. Estimates are fine; you can change them at any time.',
    helperPresets: 'Presets are starting points: typical list pricing, not a quote. Enter your contract rate.',
    save: 'Save changes',
    saved: 'Changes saved',
    saveFailed: "Couldn't save changes ({status}). Nothing was changed.",
    notHydrated: 'Still loading your saved settings. Try again in a moment.',
    sendTest: 'Send a test alert',

    // ── Settings view (src/views/Settings, PriceTable, EndpointEditor) ──
    subtitle: 'What each destination costs, when Meter Reader raises an alert and where the alert goes.',
    navLabel: 'Settings sections',
    sectionPicker: 'Section',
    runtimeGroup: 'Runtime',
    discard: 'Discard',
    unsaved: { one: '{n} unsaved change', other: '{n} unsaved changes' },
    noChanges: 'No unsaved changes',
    fixErrors: { one: 'Fix {n} field to save.', other: 'Fix {n} fields to save.' },
    /** The save bar keeps a failed save's line until the next attempt (the toast can be dismissed). */
    saveFailedBar: "Couldn't save ({status}). Try again.",
    /** Rail marker (visually hidden) and phone-picker label for a section with unsaved changes. */
    navUnsaved: 'Unsaved changes',
    sectionUnsaved: '{section} · unsaved',
    // Founder-build r1 ui-5 (FINDINGS_R1 M1): leaving Settings in the App while a section has unsaved changes asks first
    // (src/lib/navGuard.ts); the dialog lists the sections whose edits would be discarded.
    leaveGuard: {
      title: 'Leave Settings with unsaved changes?',
      body: 'These sections have changes that are not saved yet. Leaving discards them; nothing has been written.',
      action: 'unsaved changes are discarded',
      stay: 'Stay',
      leave: 'Leave without saving',
    },
    readOnlySample: 'Settings are read-only while sample data is showing. Clear sample data to edit them.',
    readOnlyLoading: 'Still loading your saved settings. Saving is available once they arrive.',
    errors: {
      decimals: "Couldn't save: {field} can have at most 3 decimal places.",
      tooLarge: "Couldn't save: {field} is too large.",
    },
    units: {
      points: 'points',
      minutes: 'min',
      sigma: 'σ',
      percentOfBudget: '% of budget',
      perHour: '/ hour',
      perDay: '/ day',
      perMonth: '/ month',
      dollar: '$',
    },
    prices: {
      colDestination: 'Destination',
      colPreset: 'Preset',
      colPrice: '$ / GB',
      colCounterfactual: 'Without Cribl this data would go to',
      fieldCommitted: 'committed price',
      priced: 'priced',
      meta: '{id} · {type} · {group}',
      // r2 ui-15 (r1 core-12, M12): a router that splits its traffic across destinations reads unpriced; say how to price it.
      routerHint: "Splits its traffic across destinations: price it at its destinations' rate.",
      // P1-G03: the id only when the name does not already say it.
      metaTypeGroup: '{type} · {group}',
      count: { one: '{n} destination', other: '{n} destinations' },
      unpricedCount: { one: '{n} unpriced', other: '{n} unpriced' },
      allPriced: 'All priced',
      // r2 ui-13 (IC-6): the destination list is the last inventory read (every 10 minutes), so a new one takes a moment.
      newDestinations: 'New destinations appear within a few minutes · Sweep now to check',
      // r3 ui-3 (FINDINGS_R3 #8): before the first prices there is no Sweep now; the list re-reads itself every minute.
      newDestinationsUnpriced: 'New destinations appear here within a minute',
      // The preset picker and its info popover (core/presets.ts PRESET_NOTES).
      presetOption: '{preset} · typical {typical} / GB · range {low}–{high}',
      presetOptionFree: '{preset} · No destination charge',
      // The picker's option under its name (P0-20: a name and a caption, never a wrapped sentence).
      presetOptionCaption: 'typical {typical} / GB · range {low}–{high}',
      presetGroupListed: 'Typical list prices',
      presetGroupOther: 'Other',
      // The picker's own-rate choice and the row notes for a rate that is not a preset's typical (P1-G01).
      customPreset: 'Custom price',
      customPresetCaption: 'Your contract rate, not a list price',
      customPresetOption: '{preset} · {caption}',
      customNote: 'Custom price · typical {typical}',
      customNoteNoPreset: 'Not a list price',
      presetInfo: 'About the {preset} price',
      presetInfoTitle: '{preset} · typical {typical} / GB',
      presetRange: 'Typical range {low}–{high} per GB',
      presetRangeFree: 'No destination charge',
      presetConfidence: {
        published: "From the vendor's published prices",
        reported: 'From reseller price lists and third-party reports',
        estimate: 'Estimated from published prices, with the assumptions stated',
      },
      presetSources: 'Sources',
      presetBasis: 'How this price is worked out',
      presetNote: '{typical} typical · {low}–{high}',
      presetDisclaimer: 'Typical list pricing, not a quote. Enter your contract rate.',
      // Under every $ / GB field (P0-19: 1.0 hides the committed column; the price is the contract rate).
      priceHelper: 'Your contract rate',
      // A never-priced row with another field changed: nothing on it is saved without a price (P0-19).
      priceNeeded: "Couldn't save: enter a price.",
      // P1-G03: short inline errors under the narrow price field (the save bar says the rest: "Fix 1 field to save.").
      priceErrorNumber: 'Enter a number, 0 or more.',
      priceErrorDecimals: 'At most 3 decimals.',
      priceErrorTooLarge: 'Too large.',
      useSuggested: 'Use suggested prices',
      // The price field's placeholder when the row's preset has no price to suggest (Internal / free): '0.00' read as a price (P0-04).
      noSuggestedPrice: '—',
      suggestedFilled: { one: 'Filled {n} suggested price. Review it, then save.', other: 'Filled {n} suggested prices. Review them, then save.' },
      // Row 12: after "See your own number" (the suggested prices were filled): a destination that only archives data
      // saves nothing by being priced like a SIEM.
      archiveHint: 'Archive-only data? Choose Nowhere.',
      cfSame: 'This destination',
      cfNone: 'Nowhere (archive-only data)',
      // P1-F01: a destination with no price yet credits diverted data at $0 until it has one.
      cfNoPrice: '{name} (no price yet)',
      // r1 ui-9 (m4): a free output type (DevNull) priced at $0 by D33 once any price is saved, as its own row reads.
      cfFree: '{name} (free, $0)',
      versionNote: 'Saving adds a price version that takes effect now. Minutes already metered keep their prices.',
      lastChanged: 'Prices last changed {ago}',
      // P2-W24: who saved the newest version (window.getCriblUser), and each destination's own history.
      lastChangedBy: 'Prices changed by {user} {ago}',
      historyToggle: 'Price history ({n})',
      // The vendor-tile preset picker (P2-W24).
      presetSearch: 'Search presets',
      presetSearchPlaceholder: 'Vendor or destination type',
      presetSuggested: 'Suggested for this destination',
      presetTileCaption: 'typical {typical} / GB',
      presetNoMatch: 'No preset matches "{query}". Custom price takes your own rate.',
      presetPicker: '{column}, {row}: {preset}',
      historyBy: 'by {user}',
      neverChanged: 'No prices saved yet',
      // P2-W09: the live receipt. Each row: the last sweep's delivered GB/day at the typed price; the card: the receipt
      // those prices would print. A never-priced workspace's first save starts the meter.
      receiptLine: '{volume} × {price}',
      // The figure; its unit follows as a secondary-text " / day" (units.perDay).
      receiptAmount: '~ {amount}',
      receiptUnderDollar: '< $1',
      receiptWas: 'was {amount}',
      receiptTitle: 'At these prices',
      receiptBasis: {
        one: "The last sweep's traffic, {n} destination priced",
        other: "The last sweep's traffic, {n} destinations priced",
      },
      receiptWhp: 'Would have paid',
      receiptPaid: 'Paid',
      receiptSaved: 'Saved by Cribl',
      startMeter: 'Start the meter',
      startNote: 'Meters every minute from the moment you save',
      meterStarted: 'The meter is running. The first reading lands in a few seconds.',
      seeReceipt: 'See the receipt',
      diffTitle: 'To save',
      diffNew: 'unpriced',
      diffFree: 'free',
      diffCounterfactual: 'without Cribl: {label}',
      diffAria: '{before} to {after}',
      diffMore: { one: '+ {n} more', other: '+ {n} more' },
      saveShortcut: '{keys} saves',
      waitingTitle: 'Reading your destinations',
      waitingBody: 'Meter Reader lists every destination after its first sweep reads your configuration. This takes a few seconds.',
      emptyTitle: 'No destinations to price',
      emptyBody: 'Meter Reader lists the destinations in your worker groups. Add one in Cribl Stream, then sweep again.',
      inventorySection: 'your destinations',
      pricesSection: 'prices',
    },
    budgets: {
      description: 'A monthly budget per destination. Meter Reader alerts when the month is on pace to pass it.',
      fieldBudget: 'budget',
      colBudget: 'Budget per month',
      colPace: 'This month',
      placeholder: 'No budget',
      pace: 'On pace for {amount} this month',
      paceOfBudget: '{pct} of budget',
      mtd: '{amount} paid so far',
      noSpend: 'No spend measured this month yet',
      thresholds: 'Warns at {warn}% and alerts at {alert}% of budget. Change these under Alerts.',
      paceAria: 'Projected spend as a share of the budget',
    },
    cost: {
      description: 'Optional. What you pay Cribl each month. When set, the Receipt adds net savings and how many times Cribl paid for itself.',
      fieldCost: 'Cribl cost',
      label: 'Cribl cost per month',
      placeholder: 'Not set',
      clearHint: 'Leave empty to hide net savings.',
      previewTitle: 'Month to date with this cost',
      previewEmpty: 'Enter a monthly cost to preview net savings.',
      previewNoData: 'The preview appears after the first priced sweep.',
      savedMtd: 'Saved by Cribl',
      proratedCost: 'Cribl cost so far',
      net: 'Net after Cribl',
      payback: 'Paid for itself',
      paybackValue: '{multiple}×',
      basis: 'Cost prorated to day {day} of {days}.',
      // With a snapshot: the minutes metered this month, the same span as the savings (and the Receipt's net).
      basisMetered: 'Cost prorated to the {span} metered this month, the same span as the savings.',
      // An optional monthly savings goal (P2-W20): the Receipt's month-to-date pace strip reads against it.
      fieldGoal: 'Savings goal',
      goalLabel: 'Savings goal per month',
      goalHint: "Optional. The Receipt's month to date shows the pace toward it. Leave empty to hide it.",
      // A suggestion from this workspace's own ingest at Cribl's published list price (usefulness review, round 1).
      // Only a suggestion: nothing is stored until an admin saves it; a contract rate replaces it.
      suggest: "At Cribl's list price: {volume} a day received × {list} per GB × 365 ÷ 12 ≈ {amount} a month. Enter your contract rate if it differs.",
      suggestSource: "Cribl's published Enterprise Cloud Worker list price: 0.32 credits per GB received, at $1 a credit.",
      suggestUse: 'Use {amount}',
      // Usefulness review, round 2: a cost saved at the suggestion is kept as an estimate (Settings.criblCostEstimate).
      suggestAsEstimate: 'Saved at this figure, the cost is marked as an estimate on the Receipt and the report until you enter your contract rate.',
    },
    alerts: {
      description: 'When Meter Reader opens an alert. Changes apply from the next sweep.',
      regressionTitle: 'Savings regression',
      regressionHint: "A pipeline's savings ratio drops against its baseline. A commit deployed within the window is named in the alert.",
      regressionPoints: 'Ratio drop',
      regressionMinutes: 'Confirmed after',
      commitWindow: 'Commit window',
      /** thresholds.regressionMinCentsPerDay (D26): a drop must cost at least this much a day to open. */
      regressionFloor: 'Minimum',
      spikeTitle: 'Cost spike',
      spikeHint: "A source's cost per hour rises above its baseline by at least the minimum.",
      spikeSigma: 'Above baseline',
      spikeMinutes: 'Confirmed after',
      spikeMinPerHour: 'Minimum',
      budgetTitle: 'Budget pace',
      budgetHint: 'Set budgets per destination under Budgets.',
      budgetWarn: 'Warn at',
      budgetAlert: 'Alert at',
      baselineTitle: 'Baseline and repeats',
      memory: 'Baseline memory',
      memory1h: '1 hour',
      memory6h: '6 hours',
      memory24h: '24 hours',
      memory7d: '7 days',
      cooldown: 'Re-notify every',
      baselineHint: 'How far back the baseline remembers, how long a new object learns before it can alert and how long a recovery holds before the alert closes itself.',
      /** thresholds.warmupSamples: one sample per metered minute. */
      warmup: 'Learns for',
      /** thresholds.recoveryMinutes */
      recovery: 'Closes after',
      goodNewsTitle: 'Good news',
      goodNews: 'Tell me when a change saves money',
      goodNewsHint: 'Off by default. Sends an info alert when a commit raises the savings ratio and it holds.',
      // settings.excludedObjectKeys: core/flows.ts drops every flow through them, so they are neither metered nor alerted on.
      excludedTitle: 'Left out of metering',
      excludedHint: 'Flows through these objects are not metered, priced or alerted on. Use it for test pipelines and lab sources.',
      excludedAdd: 'Leave out',
      excludedPickerHint: 'Choose a source, route, pipeline or destination.',
      excludedNone: 'Nothing is left out.',
      excludedWaiting: 'The list fills in after the first priced sweep.',
      // Usefulness review, round 2: GitOps or CI-managed Cribl commits through the API, so an alert's author is an OAuth
      // client. A name here shows in its place on the cards, the timeline and the Changes list (src/lib/author.ts).
      clientsTitle: 'API clients',
      clientsHint:
        'Commits made through the API name an OAuth client, not a person. Give each one the name of the pipeline or team behind it, and the App shows that name in its place.',
      clientsPlaceholder: 'GitOps pipeline',
      excludedOption: '{kind} · {label}',
      /** Two objects with the same name in different Worker Groups. */
      excludedOptionGroup: '{kind} · {label} ({group})',
      objectKinds: { in: 'Source', route: 'Route', pipe: 'Pipeline', out: 'Destination' },
    },
    notify: {
      description:
        'Alerts at or above the minimum severity go to the Cribl notification bell and to the Cribl notification targets below. Up to 10 endpoints.',
      add: 'Add endpoint',
      limit: 'Meter Reader supports up to 10 endpoints.',
      emptyTitle: 'No endpoints yet. Alerts still reach the Cribl bell.',
      /** The same line while the bell is switched off: nothing leaves the App, so say where alerts still show. */
      emptyTitleBellOff: 'No endpoints yet, and the Cribl bell is off: alerts show only in Meter Reader.',
      emptyBody:
        'Add an endpoint and pick a Cribl notification target: Slack, PagerDuty, email, Amazon SNS or a webhook, with its secrets kept in Cribl.',
      /**
       * DECISIONS D57: no build stores a webhook URL. The runner's direct webhooks, named from meta.deliveryWebhooks
       * (names and hosts only), or the one line that says where direct webhooks live.
       */
      runnerWebhooks: {
        title: 'Direct webhooks',
        none: "Meter Reader stores no webhook URL. Direct webhooks are sent only by the runner, from URLs in the runner's own .env file (MR_WEBHOOKS).",
        some: "The runner also sends alerts to these direct webhooks, from URLs in its own .env file (Meter Reader stores no webhook URL):",
        line: '{name} · {host}',
      },
      unnamed: 'New endpoint',
      name: 'Name',
      namePlaceholder: 'Ops Slack',
      // Rule 4.5 (D57): a name is shown, never followed, so it may not be a web address (it would put the URL in KV).
      nameNoUrl: "Couldn't save: a name can't be a web address. Meter Reader stores no URL.",
      minSeverity: 'Minimum severity',
      severityInfo: 'Info',
      severityMedium: 'Medium',
      severityHigh: 'High',
      weekly: 'Weekly receipt',
      weeklyHint: 'Mondays, 12:00 UTC',
      /**
       * 'ui' runtime: the first metering after Monday 12:00 UTC sends it, any day that week, marked late after the first
       * day (D12b, D63; core/weekly.ts WEEKLY_AUTO_WINDOW_MS and WEEKLY_ON_TIME_MS).
       */
      weeklyHintUi: 'After Monday 12:00 UTC, any day that week',
      enabled: 'Enabled',
      remove: 'Remove',
      removeTitle: 'Remove {name}?',
      removed: 'Endpoint removed',
      lastTestOk: 'Last test sent ({status}) · {ago}',
      lastTestFailed: 'Last test failed ({status}) · {ago}',
      lastTestNoResponse: 'Last test failed (no response) · {ago}',

      // ── Delivery channels (DECISIONS D23; core/delivery.ts). Moved here from EndpointEditor/copy.ts. ──
      channels: {
        intro:
          'Alerts go to the Cribl notification bell by default. To reach Slack, PagerDuty, email or a webhook, pick a Cribl notification target your administrator set up; its secrets stay in Cribl.',
        channelTarget: 'Cribl notification target',
        bell: {
          name: 'Cribl notifications',
          title: 'Cribl notifications (bell)',
          pill: 'no setup',
          body: 'Alerts at or above the minimum severity appear in the Cribl notification bell, in the Cribl header, for everyone in this workspace. On by default.',
          sent: 'Posted to the Cribl notification bell ({status}). Open the bell in the Cribl header to see it.',
          already: 'Already in the Cribl notification bell.',
        },
        target: {
          pill: 'via Cribl',
          label: 'Notification target',
          placeholder: 'Choose a target',
          idLabel: 'Target id',
          idPlaceholder: 'ops-slack',
          // Rule 4.5 (D57): the id field holds a Cribl id, never a URL; the check runs before anything is stored or sent.
          idShape: "Couldn't save: a target id is letters, digits, _ and - only. Meter Reader stores no URL here: type the id the target has in Cribl.",
          hint: 'An administrator configures targets in Cribl under Settings → Notification targets. Meter Reader stores only the target id; the Slack URL, PagerDuty key or SMTP password stay in Cribl.',
          load: 'Load targets',
          loadHint:
            "Type the target id, or load the list. Loading asks Cribl for every notification target in this workspace, and Cribl returns each target's full configuration to this browser, webhook URLs included. Meter Reader keeps only each target's id, type and description.",
          loading: 'Loading notification targets…',
          loaded: { one: '{n} notification target loaded. Pick it, or type an id.', other: '{n} notification targets loaded. Pick one, or type an id.' },
          typeInstead: 'Type an id instead',
          none: 'No notification targets yet. When an administrator adds one in Cribl, it appears here.',
          loadFailed: "Couldn't list notification targets ({status}). Type the target id instead.",
          checking: 'Checking the connection…',
          ready: 'Connected. Alerts reach {target} through Cribl.',
          // Founder-build r1 ui-5 (M1): the relay exists but this endpoint is not stored, so no alert goes here yet.
          readyUnsaved: 'Connected in Cribl · Save changes to send alerts here',
          missing: 'Not connected yet. Connecting adds a small relay in Cribl Search: a saved search that never runs, and one notification.',
          checkFailed: "Couldn't check the connection ({status}).",
          connect: 'Connect',
          connectTitle: 'Connect {target} to Meter Reader?',
          connectBody:
            'Meter Reader creates these objects in Cribl Search so it can hand alerts to this target. Nothing is scheduled, nothing is replaced and nothing else changes. You can delete them in Cribl Search at any time.',
          connectConfirm: 'Connect',
          connected: 'Target connected',
          connectFailed: "Couldn't connect the target ({status}). {detail}",
          searchLabel: 'Saved search',
          searchAction: 'create; never scheduled',
          notificationLabel: 'Search notification',
          notificationAction: 'create; sends to {target}',
          sent: 'Handed to Cribl for {target} ({status}). Cribl delivers it from its notification service.',
          // A 200 means Cribl accepted it, not that the target received it (craft review, round 1).
          didItArrive: "Did it arrive? If not, check the target in Cribl (Settings → Notification targets): Meter Reader can see only that Cribl accepted it.",
          // Craft review, round 2: delivery rests on the relay's event-id convention (measured on Cribl 4.20.1), so a
          // 200 is not proof. A member says it arrived; the target reads unconfirmed until then (core's confirmedAt).
          arrived: 'It arrived',
          confirmed: 'Arrival confirmed {ago}',
          unconfirmed: 'Unconfirmed: send a test and say whether it arrived.',
          notConnected: 'Connect this target first, then send a test.',
          /** Beside the disabled test button while the target's relay is missing. */
          connectFirst: 'Connect first',
          chooseFirst: 'Choose a target to send a test.',
          previewTitle: 'What the target receives',
          removeBody: 'Meter Reader stops sending alerts to this target. The target and its relay in Cribl Search stay as they are.',
          removeAction: 'stop sending alerts to this target',
        },
        typeLabels: {
          slack: 'Slack',
          pagerduty: 'PagerDuty',
          smtp: 'Email',
          email: 'Email',
          sns: 'Amazon SNS',
          webhook: 'Webhook',
          bulletin_message: 'Cribl bell',
        },
        notPermitted: "Cribl refused the request ({status}). An administrator grants this App's notification permissions when installing or sharing it.",
        notAvailable: 'This workspace has no such Cribl API ({status}). Cribl notification channels need Cribl.Cloud.',
        failed: 'Test alert failed ({status}).',
        noResponse: 'Test alert failed (no response).',
      },

      // ── Weekly receipt (SPEC 11, 12.4; DECISIONS D12b) ──
      weeklyReceipt: {
        title: 'Weekly receipt',
        bodyUi:
          "Last week's receipt goes to every endpoint with Weekly receipt on, automatically the first time the App meters after Monday 12:00 UTC, any day that week (marked late after the first 24 hours).",
        bodyBackend: "The App backend sends last week's receipt every Monday at 12:00 UTC to every endpoint with Weekly receipt on.",
        send: 'Send the last 7 days now',
        sendHint: 'Covers the seven days before today, to every enabled endpoint with Weekly receipt on.',
        lastAuto: 'Last sent automatically {time}',
        sent: { one: 'Sent to {n} endpoint.', other: 'Sent to all {n} endpoints.' },
        partial: { one: 'Sent to {sent} of {n} endpoint.', other: 'Sent to {sent} of {n} endpoints.' },
        noneSent: { one: 'Not sent: the endpoint did not accept it.', other: 'Not sent: none of the {n} endpoints accepted it.' },
        noEndpoints: 'No enabled endpoint has Weekly receipt on. Turn it on for an endpoint above and save, then send.',
        rateLimited: 'Rate limited by the Leader. Try again in a minute.',
        busy: 'A weekly receipt is already being sent.',
        failed: "Couldn't send the weekly receipt: {error}",
        endpointSent: '{name}: sent ({status})',
        endpointFailed: '{name}: failed ({status})',
        endpointNoResponse: '{name}: no response',
        /** The default bell, skipped quietly on a Leader without the bell API or one that refuses it (D27). */
        endpointSkipped: '{name}: not delivered, the Cribl bell is not available to this App here',
        /** Only the default bell takes the receipt, and this Leader has no bell for the App (D27). */
        bellOnlyUnavailable: 'Not sent: the Cribl bell is the only endpoint with Weekly receipt on, and it is not available to this App here.',
      },
    },
    runtime: {
      description: 'Where metering runs and how the last sweep went.',
      label: 'Metering runs in',
      ui: 'This browser tab',
      backend: 'App backend, on a schedule',
      uiNote: "Meters every completed minute while this app is open (it checks twice a minute); when you reopen it, it catches up from Cribl's metrics history.",
      metering: 'Metering in this tab',
      notMeteringReplay: 'Paused while replay is on',
      notMeteringSample: 'Paused while sample data is showing',
      notMeteringWaiting: 'Starts once your settings load',
      notMeteringNoPrices: 'Starts as soon as prices are saved',
      sweepNoPrices: 'Set prices to start the meter.',
      setPricesLink: 'Set prices',
      lastSweep: 'Last sweep',
      calls: 'Leader calls',
      duration: 'Duration',
      sweeps: 'Sweeps so far',
      collecting: 'Collecting since',
      lastError: 'Last sweep error: {error}',
      nextManual: 'Sweep now is available again in {seconds}\u00a0s.',
      notLive: 'Sweep now is off while sample data is showing.',
    },
    // Demo build only; see SETTINGS_DEMO_COPY above.
    demoPanel: (import.meta.env?.VITE_MR_BUILD === 'demo' ? SETTINGS_DEMO_COPY : {}) as typeof SETTINGS_DEMO_COPY,
  },

  // Demo build only; see DEMO_CONSOLE_COPY above.
  demo: (import.meta.env?.VITE_MR_BUILD === 'demo' ? DEMO_CONSOLE_COPY : {}) as typeof DEMO_CONSOLE_COPY,

  // Demo build only; see DEMO_SCENE_COPY above.
  scene: (import.meta.env?.VITE_MR_BUILD === 'demo' ? DEMO_SCENE_COPY : {}) as typeof DEMO_SCENE_COPY,

  demoProfile: {
    notice: '1-minute confirmation (demo profile). Default is 3.',
  },

  sweep: {
    now: 'Sweep now',
    running: 'Sweeping',
    rateLimited: 'Cribl is rate limiting Meter Reader. Next sweep in {countdown}.',
    // While the sweeps back off (P1-E01, meta.rateLimitedUntil): what happened, in the past tense, and when metering
    // resumes. The limit may have lifted already; the back-off still skips the minutes until then.
    rateLimitedBackoff: 'Cribl rate-limited Meter Reader at {since}. Metering resumes at {time}.',
    backgroundNote: 'Sweeps run every minute in the background; this page reads the latest one.',
    throttled: 'Sweep now is available again in {seconds}\u00a0s.',
    done: 'Sweep finished · {calls} calls · {duration}',
    skippedLocked: 'Another tab is sweeping right now. This page will show its result.',
    // P0-07: what a failed sweep's error code means (src/state/selectors.ts classifySweepError). Never the raw code.
    failure: {
      metricsForbiddenGeneric: "Couldn't read Cribl's metrics: your role can't view them. Ask an administrator for Monitoring access.",
      forbidden: "Your role can't read part of the Cribl configuration a sweep needs. Ask an administrator for access.",
      unauthorized: 'Your Cribl session has expired. Reload the page to sign in again.',
      rateLimited: 'Cribl is rate limiting Meter Reader. The next sweep tries again.',
      budget: "A sweep used this minute's budget of Cribl API calls. The next sweep picks up where it stopped.",
      timeBudget: 'A sweep ran out of time. The next sweep picks up where it stopped.',
      storage: "A sweep couldn't save to Meter Reader's storage. The next sweep tries again.",
      server: 'Cribl answered a sweep with an error ({status}). The next sweep tries again.',
      serverNoStatus: 'Cribl answered a sweep with an error. The next sweep tries again.',
      network: "A sweep couldn't reach Cribl. The next sweep tries again.",
      unknown: 'A sweep failed. The next sweep tries again.',
      nextSweep: 'Next sweep in {countdown}.',
    },
  },

  errors: {
    metricsForbidden: "Couldn't read metrics for {group}: your role can't view them. Ask an administrator for Monitoring access.",
    fieldNumber: "Couldn't save: {field} must be 0 or more.",
    // core/settings.ts WEBHOOK_NOT_STORED_MESSAGE (D57: no build stores a webhook URL; tests hold the two equal).
    webhookNotStored:
      "Couldn't save: Meter Reader stores no webhook URL. Send through a Cribl notification target, or give the runner the URL in its .env (MR_WEBHOOKS).",
    // core/settings.ts CREDENTIAL_NOT_STORED_MESSAGE and UNKNOWN_TARGET_MESSAGE (rules round 4, rule 4.5; tests hold them equal).
    credentialNotStored:
      "Couldn't save: that looks like a token, key or password, and Meter Reader stores no credential. Use the id the target has in Cribl, or plain words for a name.",
    unknownTarget: "Couldn't save: Cribl lists no notification target with this id. Choose one from the list.",
    unauthorizedTitle: 'Your session has expired',
    unauthorizedBody: 'Reload the page to sign in to Cribl again.',
    forbiddenTitle: "You don't have access to this",
    forbiddenBody: "Your role can't read {section}. Ask an administrator for access. Everything else on this page still works.",
    forbiddenBodyGeneric: "Your role can't read this data. Ask an administrator for access. Everything else on this page still works.",
    // 403 when nothing else on the page can work either (BEAUTY F14: only say what still works when something does).
    forbiddenBodyOnly: "Your role can't read {section}. Ask an administrator for access.",
    forbiddenBodyOnlyGeneric: "Your role can't read this data. Ask an administrator for access.",
    rateLimitedTitle: 'Cribl is rate limiting Meter Reader',
    rateLimitedBody: 'Meter Reader is checking less often for the next 5 minutes.',
    // Under the title 'Rate limited by the Leader': together they read as DESIGN_BRIEF §6's one sentence.
    rateLimitedNextSweep: 'Next sweep in {countdown}.',
    serverTitle: "Couldn't reach Cribl",
    serverBody: 'Showing the last good data, updated {ago}.',
    serverBodyNoData: 'Nothing to show yet. Meter Reader will keep trying.',
    serverToast: "Couldn't reach Cribl ({status}). Showing the last good data.",
    networkTitle: 'Connection lost',
    networkBody: 'Showing the last good data. Meter Reader will reconnect on its own.',
    bootTitle: "Meter Reader couldn't start",
    bootBody: 'Open Meter Reader from Apps in Cribl. If it is already open there, reload the page.',
    viewCrashedTitle: "This view couldn't load",
    viewCrashedBody: 'Try again, or reload the page if it keeps failing. The rest of Meter Reader still works.',
    tryAgain: 'Try again',
    reload: 'Reload',
    retry: 'Try again',
  },

  // ── Report card (/report): the view, and every word of the document it downloads (core/report.ts ReportCopy) ──
  report: {
    view: {
      title: 'Report card',
      subtitle: 'The savings on one page for leadership: download it, paste it into an email, or show it in a walk-through.',
      back: 'Back to the receipt',
      periodLabel: 'Period',
      period: { mtd: 'Month to date', today: 'Today', '30d': '30 days', range: 'Custom range' },
      rangeHint: 'The custom range from the Receipt: {words}',
      preparedFor: 'Prepared for',
      preparedForPlaceholder: 'For example, finance leadership',
      note: 'Note',
      notePlaceholder: 'Optional: one or two sentences of context for the reader',
      fieldsHint: 'Not saved anywhere: these go into this report only.',
      actionsLabel: 'Report card actions',
      downloadPdf: 'Download PDF',
      downloadHtml: 'Download HTML',
      downloadCsv: 'Download CSV',
      copyEmail: 'Copy for email',
      downloaded: 'Downloaded {file}.',
      downloadFailed: "Couldn't create the file. Try again.",
      copied: 'Report copied. Paste it into an email.',
      copiedText: 'Report copied as plain text. Paste it into an email.',
      copyFailed: "Couldn't copy the report. Download the HTML file and attach it instead.",
      previewLabel: 'Report card preview',
      previewCaption: 'The preview is the file you download.',
      sampleNote: 'Sample data: the report is marked as a sample on every page.',
      checksLabel: 'Before you send it',
      checkListPrices: 'The figures use typical list prices, not your contract rates. An admin can enter contract rates in Settings → Prices.',
      checkNoCost: 'No Cribl cost is set, so the report shows no return. An admin can enter the monthly cost in Settings → Cribl cost.',
      // FOUNDER_PLAN row 13 (founder-build r1 ui-11): one click saves the list-price estimate the check quotes, flagged as
      // an estimate (the same save as Settings → Cribl cost's "Use this estimate"); a contract figure replaces it.
      useEstimate: 'Use the list-price estimate',
      estimateSaved: 'Saved the list-price estimate as your Cribl cost. Enter your contract cost under Settings → Cribl cost.',
      // …with the list-price estimate the Receipt shows (usefulness review, round 2); the document itself prints no estimate.
      checkNoCostEstimate:
        "No Cribl cost is set, so the report shows no return. At Cribl's list price ({volume} a day × {list} per GB ≈ {amount} a month), Cribl pays for itself ≈{multiple}× at the annualized run rate. An admin can enter the contract cost in Settings → Cribl cost.",
      checkNoCostEstimatePartial:
        "No Cribl cost is set, so the report shows no return. At Cribl's list price ({volume} a day × {list} per GB ≈ {amount} a month), the savings cover ≈{pct} of it at the annualized run rate. An admin can enter the contract cost in Settings → Cribl cost.",
      checkUnpriced: {
        one: '{names} has no price and is left out of the figures. An admin can set one in Settings → Prices.',
        other: '{names} have no price and are left out of the figures. An admin can set them in Settings → Prices.',
      },
      waiting: 'The report card needs the first sweep. It is ready once Meter Reader has metered a minute.',
      unavailable: 'The report card is unavailable until the figures load.',
      rangeLoading: 'Reading the custom range…',
      rangeFailed: "Couldn't read the custom range. The report shows month to date instead.",
      newer: 'Newer figures arrived at {time}. The report keeps the ones it opened with until you update.',
      update: 'Update figures',
    },
    doc: {
      brand: 'Meter Reader',
      title: 'Cribl savings report card',
      preparedFor: 'Prepared for {name}',
      preparedBy: 'Prepared by {name}',
      generated: 'Generated {time}',
      asOf: 'Figures as of {time}',
      sampleBanner: 'Illustrative figures from the Meter Reader tour workspace, not a real Cribl organization.',
      sampleWatermark: 'SAMPLE DATA',
      noteLabel: 'Note',
      period: { mtd: 'Month to date', today: 'Today', '30d': 'Last 30 days', range: 'Custom range' },
      periodCaption: { mtd: 'month to date', today: 'today', '30d': 'the last 30 days' },
      collectingSince: 'collecting since {date}',
      heroLabel: 'Saved by Cribl, {period}',
      heroWhp: 'You would have paid {amount}',
      heroPaid: 'You paid {amount}',
      heroDollarPct: '{pct} of dollars saved',
      heroBasis: {
        list: {
          one: 'At typical list prices for {n} destination, not contract rates (see Prices used).',
          other: 'At typical list prices for {n} destinations, not contract rates (see Prices used).',
        },
        mixed: {
          one: 'At typical list prices for {list} of {n} destination, not contract rates, and at rates an admin entered for the rest (see Prices used).',
          other: 'At typical list prices for {list} of {n} destinations, not contract rates, and at rates an admin entered for the rest (see Prices used).',
        },
        custom: 'At the rates an admin entered (see Prices used).',
      },
      legend: { paid: 'Paid', saved: 'Saved by Cribl', whp: 'Would have paid: the whole bar' },
      kpi: {
        runRate: 'Annual run rate',
        runRateUnit: 'a year',
        runRateMonthly: 'About {amount} a month',
        runRateFrom: { one: 'from the last {n} day', other: 'from the last {n} days' },
        // Less than a day metered: core/report.ts prints this as is (no placeholders), so it names no minute count.
        runRateToday: 'projected from under a day of traffic · settles after the first full day',
        roi: 'Cribl paid for itself',
        roiValue: '{multiple}×',
        roiEvery: 'Every $1 of Cribl saved {amount}',
        roiPct: 'ROI {pct} (net ÷ cost)',
        netPeriod: 'Net after Cribl {amount}, {period}',
        netRunRate: 'Net after Cribl {amount} a year',
        roiUnset: 'Not shown',
        roiUnsetHint: 'The Cribl cost was not provided.',
        volume: 'Data volume',
        volumeUnit: 'less data',
        volumeFlow: '{in} a day would have reached your destinations → {out} did',
        volumeBasis: "by volume, at the last hour's rate",
        volumeNone: 'No traffic',
        protection: 'Protection',
        protectionValue: { one: '{n} alert caught', other: '{n} alerts caught' },
        protectionUnit: { one: 'alert caught', other: 'alerts caught' },
        protectionNone: 'No alerts',
        protectionWindow: 'in the last 24 hours only',
        protectionAtRisk: '{amount} a day at risk until fixed',
        protectionRecovered: '{amount} a day above normal, now recovered',
        protectionCaught: 'fastest caught in {time}',
        protectionQuiet: 'No regressions or cost spikes',
      },
      trend: {
        title: 'Saved per day, {period}',
        empty: 'The chart appears after a second day of history.',
        oneDay: 'One day in this period: the figure above is the whole of it.',
        soFar: '{day}, so far',
        peak: 'Best day {amount}',
        aria: { one: '{title}: {n} day, the best {amount}', other: '{title}: {n} days, the best {amount}' },
      },
      top: {
        title: "What's saving the most",
        caption: { one: "The top saver, per day at the last hour's rate (× 24)", other: "The top {n} savers, per day at the last hour's rate (× 24)" },
        captionOf: "The top {n} of {total} savers, per day at the last hour's rate (× 24)",
        none: 'Nothing is saving yet.',
      },
      destinations: {
        title: 'Where the money goes',
        caption: "Each destination, per day at the last hour's rate (× 24)",
        unpricedNote: {
          one: '{names} has no price, so it is not counted.',
          other: '{names} have no price, so they are not counted.',
        },
        none: 'No destination carries money yet.',
        total: 'All priced destinations, per day',
        planWith: "Per day at the last hour's rate, which moves with the time of day. To plan, use the annual run rate: {annual} a year, {basis}.",
        gap: {
          one: 'Saved is {amount} more than would have paid minus paid: {names} is paid for but saves nothing, and a cost is never counted as a negative saving.',
          other: 'Saved is {amount} more than would have paid minus paid: {names} are paid for but save nothing, and a cost is never counted as a negative saving.',
        },
      },
      protection: {
        title: 'Protection',
        captionPeriod: 'Savings regressions and cost spikes Meter Reader caught, {period}',
        captionLast24h: 'Savings regressions and cost spikes Meter Reader caught in the last 24 hours (the alert history on hand)',
        summaryOpen: '{alerts} · {amount} a day at risk until fixed',
        summaryRecovered: '{alerts} · all recovered',
        fastest: ' · fastest caught in {fastest}, median {median}',
        none: 'No savings regression or cost spike in this window.',
      },
      cols: {
        whatItDoes: 'What it does',
        flow: 'Flow',
        volumeReduced: 'Volume reduced',
        savedPerDay: 'Saved / day',
        destination: 'Destination',
        pricedAs: 'Priced as',
        pricePerGb: '$ / GB',
        gbPerDay: 'Per day, in → out',
        whp: 'Would have paid',
        paid: 'Paid',
        saved: 'Saved',
        caught: 'Caught in',
        range: 'Typical range',
        basis: 'Basis',
        source: 'Source',
      },
      flowMore: '{first} + {n} more',
      flowArrow: '{from} → {to}',
      gbPerDayValue: '{in} → {out}',
      unpriced: 'No price set',
      pricedAsYourRate: '{preset}, your rate',
      yourRate: 'Your rate',
      counterfactualOther: 'Without Cribl it would go to {destination} at {price} / GB',
      counterfactualOtherUnpriced: 'Without Cribl it would go to {destination}',
      counterfactualNone: 'Without Cribl it would go nowhere: not counted as savings',
      alert: { regression: 'Savings dropped: {label}', spike: 'Cost spike: {label}' },
      measure: {
        ratio: '{before} → {after} of dollars saved',
        ratioRecovered: '{before} → {after} of dollars saved, recovered to {recovered}',
        recoveredOnly: 'from {before} of dollars saved, recovered to {recovered}',
        spike: '{before} → {after} an hour',
        spikeRecovered: '{before} → {after} an hour, back to {recovered}',
        spikeBackTo: 'back to {recovered} an hour',
      },
      impact: {
        open: '{perDay} a day above normal until fixed (about {perYear} a year if left)',
        closed: '{perDay} a day above normal while it lasted · {duration} from alert to recovery',
        closedNoDuration: '{perDay} a day above normal while it lasted',
      },
      commit: 'Commit {hash} “{message}” by {author}',
      noCommit: 'No configuration change found',
      status: { open: 'Open', recovered: 'Recovered' },
      methodology: {
        title: 'How these numbers are made',
        period: {
          mtd: 'Month to date adds up every metered minute since the first of the month ({tz}).',
          today: 'Today adds up every metered minute since midnight ({tz}).',
          '30d': 'The last 30 days add up every metered minute of the last 30 local days, today included ({tz}).',
          range: 'The custom range adds up the rows metered in {span} ({tz}), priced when they were metered.',
        },
        runRate: 'The annual run rate is dollars saved ÷ minutes metered × 525,600, {basis}.',
        pricesTitle: 'Prices used',
        pricesCaption: 'Per GB at each destination. A typical list price is a starting point, not a quote; a rate an admin enters replaces it.',
        confidence: {
          published: "Vendor's published price",
          reported: 'Reseller filings and reports',
          estimate: 'Estimate from published figures',
        },
        customBasis: 'Entered by an admin for {destination}',
        meteredBasis: 'The price {destination} was metered at',
        counterfactual:
          '“Would have paid” prices the bytes each source sent at the destination they would reach without Cribl: normally the same destination{others}. A flow an admin marks as going nowhere without Cribl is not counted. “Paid” prices the bytes Cribl delivered; saved is the difference.',
        counterfactualOthers: ', or another one an admin names ({list})',
        counterfactualOtherItem: '{destination} is priced as if its data went to {target}',
        bytes: {
          reconciled:
            "Bytes come from Cribl's own counters. Every source's and every destination's count is exact; only the split inside a destination fed by several reshaped flows uses Cribl's per-route estimates.",
          route: "Bytes come from Cribl's per-route counters, before and after each route's pipeline.",
          pipeline: "Bytes come from Cribl's counters before and after each pipeline.",
          proportional: "Some flows have no route counters; they take a proportional share of their source's and destination's bytes, so their reduction is an upper bound.",
          'route-only': "Bytes come from Cribl's per-route counters; pipelines are attributed by the routes that use them.",
        },
        currentRates:
          "Top savers, destinations and data volume are per day at the last hour's rate (× 24), so they move with the time of day; the annual run rate does not. Data volume counts the bytes each destination would have received without Cribl, so a source sent to two destinations counts twice.",
        notCounted:
          "Not counted: search-side savings, workload (SVC) pricing effects, storage beyond each destination's price and staff time; these would add to the savings. Typical list prices are usually above negotiated contract rates, which would lower them; a rate an admin entered is used as entered.",
        criblCost:
          "Net after Cribl subtracts the Cribl cost an admin entered ({amount} a month; it should include the license and any infrastructure Cribl runs on), prorated to the minutes metered for month to date and × 12 for the run rate. ROI is the net savings ÷ that cost. Cribl Stream bills the bytes it receives, so a pipeline's reduction lowers the destination's bill, not Cribl's.",
        criblCostUnset: 'No Cribl cost was provided, so the net after Cribl and the return are not shown.',
        // Founder-build r1 ui-11 (row 13): the methodology line when the cost is the list-price estimate (Settings'
        // criblCostEstimate). For core/report.ts to print when card.cribl.estimate (handoff in OUT/r1-ui.md).
        criblCostEstimate:
          "Net after Cribl subtracts an estimate of the Cribl cost ({amount} a month: Cribl's published list price on the ingest Meter Reader measured, not a contract figure), prorated to the minutes metered for month to date and × 12 for the run rate. ROI is the net savings ÷ that cost. An admin replaces it with the contract cost under Settings → Cribl cost.",
      },
      about: {
        title: 'About this report',
        workspace: 'Workspace',
        workspaceUnknown: 'Not reported by Cribl',
        groups: 'Worker groups',
        collectingSince: 'Collecting since',
        asOf: 'Figures as of',
        generated: 'Generated',
        meteredBy: 'Metered by',
        version: 'Made with',
        data: 'Data',
        dataLive: 'Live, from the workspace above',
        dataSample: 'Sample data from the tour workspace',
        versionValue: '{brand} {version}',
        versionDemo: '{brand} {version} (demo build)',
      },
      meteredBy: {
        runner: 'the Meter Reader runner',
        runnerHost: 'the Meter Reader runner on {host}',
        tab: 'an open Meter Reader tab',
        backend: 'the scheduled Meter Reader backend',
        unknown: 'not recorded',
      },
      /** Price sources by web host (a host that isn't listed shows as itself). */
      sourceNames: [
        { host: 'applytosupply.digitalmarketplace.service.gov.uk', name: 'UK G-Cloud filing' },
        { host: 'prices.azure.com', name: 'Azure price list' },
        { host: 'pricing.us-east-1.amazonaws.com', name: 'AWS price list' },
        { host: 'datadoghq.com', name: 'Datadog pricing' },
        { host: 'elastic.co', name: 'Elastic pricing' },
        { host: 'sumologic.com', name: 'Sumo Logic pricing' },
        { host: 'newrelic.com', name: 'New Relic pricing' },
        { host: 'cribl.io', name: 'Cribl pricing' },
        { host: 'docs.snowflake.com', name: 'Snowflake docs' },
        { host: 'flexera.com', name: 'Flexera report' },
        { host: 'assets.ctfassets.net', name: 'Cribl pricing guide' },
      ],
      footer: '{brand} {version} · {workspace} · generated {time}',
      footerNoWorkspace: '{brand} {version} · generated {time}',
      // The builder's signature on every page, under the footer ({name}: core/strings.ts CREDIT_STRINGS.builder).
      credit: 'Made with Meter Reader, built by {name}',
      page: 'Page {n} of {total}',
      csv: {
        record: { flow: 'flow', destination: 'destination' },
        headers: [
          'Record',
          'Name',
          'Worker group',
          'Source',
          'Pipeline',
          'Destination',
          'Priced as',
          'Would-have-paid price $ / GB',
          'Paid price $ / GB',
          'GB / day in',
          'GB / day out',
          'Volume reduced %',
          'Would-have-paid $ / day',
          'Paid $ / day',
          'Saved $ / day',
        ],
      },
      text: {
        topSavers: "What's saving the most, per day",
        destinations: 'Where the money goes, per day',
        protection: 'Protection',
      },
    },
  },

  sampleBand: {
    text: 'Sample data. This is how Meter Reader looks once it is metering your traffic.',
    clear: 'Clear sample data',
    replayText: 'Replay of a recorded run. Numbers are from the real demo workspace.',
    stopReplay: 'Stop replay',
    // The band reads like a receipt stamp (P2-W27): the stamp, then the note after it; phones (≤ 640 px) keep the
    // stamp and the tour's beat, and the full sentence stays in the DOM for screen readers (BEAUTY F5).
    stamp: 'Sample data',
    replayStamp: 'Replay',
    note: 'How Meter Reader looks once it is metering your traffic. Nothing is written to your workspace.',
    replayNote: 'A recorded run. Numbers are from the real demo workspace.',
    beat: 'Tour · beat {beat} of {beats}',
    beatShort: '{beat} of {beats}',
    // FOUNDER_PLAN row 12: once the tour has played to its end, the way to the member's own number (Prices, filled).
    meterYours: 'See your own number',
  },

  // ── First run + Tour with sample data (PRD 8.5, DESIGN_BRIEF 5.6, SPEC 15 / 17) ──
  tour: {
    eyebrow: 'Cost visibility for Cribl Stream',
    lede: 'See in dollars what every pipeline saves at its destination, and who changed it when the savings drop.',
    howTitle: 'How it works',
    actionsLabel: 'Get started',
    // Non-breaking spaces keep each count with its noun ("40 sources" never splits across lines).
    tourNote: 'The tour plays a sample enterprise workspace: {sources}\u00a0sources, {destinations}\u00a0destinations, {days}\u00a0days of history.',
    tourSafe: 'Nothing is written to your workspace.',
    storyNote: 'No sound needed. Captions tell the story.',
    startFailed: "Couldn't start the tour: {reason}",
    toast: {
      regressionBody: '{perDay} a day · {perYear} a year. Commit {hash} by {author}, caught in {caughtIn}.',
      spikeBody: '{perDay} a day above normal. No configuration change found nearby.',
      // Founder-build r1 ui-7 (m1): a Cribl notification target (D57) — Cribl accepted it for delivery.
      handed: 'Handed to Cribl for {endpoint} ✓ {time}',
      recoveredTitle: 'Savings back: {label}',
      weeklyTitle: 'Weekly receipt ready · {label}',
      // r2 ui-11 (IC-14 residue): the receipt goes wherever the weekly receipt is on (the bell, a Cribl target), not "in Slack".
      weeklyBody: 'Saved by Cribl {amount}. Leadership gets this without opening Cribl.',
      viewMessage: 'View message',
      viewReceipt: 'View receipt',
      viewInLedger: 'View in Ledger',
    },
    dialog: {
      // m1: what a Cribl notification target received (plain text), as Settings' "What the target receives" shows it.
      targetTitle: 'Handed to Cribl for {endpoint}',
      targetCaption: 'What the target receives: plain text, which Cribl delivers to the channel behind it. Meter Reader stores only the target id.',
      receiptTitle: 'Weekly receipt · {label}',
      // Non-breaking spaces keep the last three words together (no lone "Cribl." on the dialog's second line).
      receiptCaption: 'Sent after Monday 12:00\u00a0UTC while Meter Reader is metering. Leadership never\u00a0opens\u00a0Cribl.',
      close: 'Close',
    },
    // FOUNDER_PLAN row 11: the savings drop lands as the takeover card on the Receipt (src/tour/TourTakeover.tsx).
    takeover: {
      label: 'Sample alert',
      note: 'Sample data. Nothing is written to your workspace.',
      dismissHint: 'Press Esc to dismiss',
    },
  },

  presenter: {
    // The QR's caption says where the code goes (OQ-04, D51): its " · " parts become lines above the code.
    qrCaption: {
      repo: 'Meter Reader · get the App on GitHub',
      group: 'Meter Reader · join the Cribl Innovators Network',
      link: 'Meter Reader · {host}',
    },
    exitHint: 'P leaves the presenter view · ? shows keys',

    // ── Presenter view (PRD 8.1, 8.8 item 8; DESIGN_BRIEF 5.2) ──
    viewLabel: 'Presenter view',
    captionToday: 'annualized run rate, from today so far',
    // Less than one whole day metered (REVIEW-3a #12: tested on the raw day count, like the Receipt).
    annualizedFromHours: { one: 'annualized run rate, from the last {n} hour', other: 'annualized run rate, from the last {n} hours' },
    annualizedFromMinutes: { one: 'annualized run rate, from the last {n} minute', other: 'annualized run rate, from the last {n} minutes' },
    topSavers: "What's saving the most",
    topSaversEmpty: 'Top savers appear after the first priced sweep.',
    // W3-STAGE-1: an open regression's drop beside the saver it names (the line keeps its own figure).
    saverDrop: '−{perDay}',
    saverDropHidden: 'Down {perDay} a day while the alert is open.',
    saverDropTitle: 'Down {perDay} a day while the alert on this line is open',
    waiting: 'Waiting for the first sweep',
    noPrices: 'Set prices to start the meter',
    // The hero before there is a figure (BEAUTY F2: never a display-size zero).
    emptyFigure: '$—',
    emptyLabel: 'Saved by Cribl: no figure yet. {status}',
    unreachable: "Couldn't reach Cribl. Showing the last good data.",
    live: 'Live',
    updated: 'updated {ago}',
    // P0-08: the stage's data status when nothing has been priced yet, and when a rate-limited poll retries.
    statusUnpriced: 'Not metering yet',
    nextCheck: 'next check {time}',
    sampleChip: 'Sample data',
    replayChip: 'Replay',
    qrAlt: 'QR code: {url}',
    // The stage's Meter announces its own amount ("<label>: $1,284,435"), so its label names only the period.
    heroMeterLabel: 'Saved by Cribl, {period}',
    /** The stage's polite live region, every 30 s (P1-A09). */
    heroAnnounce: 'Saved by Cribl: {amount}, {period}',
    // P2-W04: the stage at rest — the month's receipt bar and the last 30 days, where the incident card lands.
    rest: {
      label: 'This month at a glance',
      barTitle: 'Month to date',
      // Completed days only (today is partial and left out), so it never reads as a second, different "last 30 days"
      // under the hero's run-rate caption, which counts today.
      trendTitle: 'Saved per day, the last {days} full days',
      trendPeak: 'best day {amount}',
    },
    // P2-W19: the chip M shows on the stage.
    chimeOn: 'Chime on',
    chimeOff: 'Chime off',
    // P2-W01: the running total under the hero, from $0.00 when the stage opens (cents: the brief's one exception).
    session: {
      label: 'Saved since you started watching',
      perSecond: '~{amount} a second',
      perMinute: '~{amount} a minute',
      perHour: '~{amount} an hour',
      paused: 'paused until the data is live again',
    },
    // P1-B03: the stage's own key list ("?" on stage), scaled to be read from the back of the room.
    keys: {
      title: 'Presenter keys',
      leave: 'Leave the presenter view',
      story: 'Story mode',
      show: 'Show these keys',
      card: 'When an alert card is up, any key dismisses it.',
      // P2-W19: the takeover's chime (off by default).
      chime: 'Chime when an alert lands (on or off)',
      close: 'Any key closes this list.',
    },
  },

  slackPreview: {
    appName: 'Meter Reader',
    appBadge: 'App',
    avatar: 'MR',
    label: 'Slack message preview',
    glyph: {
      high: 'Red circle',
      medium: 'Orange circle',
      recovered: 'Green circle',
      info: 'Blue circle',
      receipt: 'Receipt',
    },
    empty: 'Nothing to preview',
  },

  shortcuts: {
    title: 'Keyboard shortcuts',
    close: 'Close',
    groupEverywhere: 'Everywhere',
    // Demo build only (P1-B04): the release bundle carries no demo lever words; gated like `lever` below.
    groupDemo: import.meta.env?.VITE_MR_BUILD === 'demo' ? 'Demo levers (demo mode on)' : '',
    presenter: 'Presenter view',
    story: 'Story mode',
    sheet: 'Show this list',
    search: 'Search',
    // Modifier chords and view-only keys (the README's keyboard map lists the same).
    palette: 'Go to anything (⌘K works too)',
    diagnostics: 'Diagnostics',
    groupViews: 'On one view',
    flowStage: 'Flow: the map on stage',
    chime: 'Presenter view: the alert chime on or off',
    note: 'Shortcuts work when no text field is focused.',
    // The off switch (WCAG 2.1.4, P1-A09).
    singleKey: 'Single-key shortcuts',
    // The lever keys exist on the demo build only (P1-B04: the release bundle carries no lever words).
    singleKeyOn:
      import.meta.env?.VITE_MR_BUILD === 'demo'
        ? 'P, Y, ?, / and the lever keys work whenever no text field has focus.'
        : 'P, Y, ?, / and the other single keys work whenever no text field has focus.',
    singleKeyOff: 'Off: letters and symbols type nothing here. Esc still closes. Ctrl+K or ⌘K opens every action.',
    singleKeySample: 'Change this on live data: the setting is saved for this workspace.',
    singleKeyFailed: "Couldn't save the setting. Try again.",
    chipPresenterOn: 'Presenter view on',
    chipPresenterOff: 'Presenter view off',
    chipStoryOn: 'Story mode',
    // Demo build only; see DEMO_LEVER_COPY above.
    lever: (import.meta.env?.VITE_MR_BUILD === 'demo' ? DEMO_LEVER_COPY : {}) as typeof DEMO_LEVER_COPY,
  },

  // The ⌘K palette (P2-W22): find anything on screen, run any action, with or without single-key shortcuts.
  palette: {
    title: 'Go to anything',
    placeholder: 'Type a flow, a page or an action',
    inputLabel: 'Search pages, flows and actions',
    empty: 'Nothing matches “{query}”.',
    hint: '↑ ↓ to move · Enter to open · Esc to close',
    openHint: 'Ctrl+K or ⌘K opens this from anywhere',
    groups: {
      actions: 'Actions',
      goto: 'Go to',
      sources: 'Sources',
      pipelines: 'Pipelines',
      destinations: 'Destinations',
      // Demo build only (P1-B04): the release bundle carries no demo lever words.
      levers: import.meta.env?.VITE_MR_BUILD === 'demo' ? 'Demo levers (demo mode on)' : '',
    },
    booth: 'Story on a booth screen',
    boothHint: 'Full screen, dark, the cursor hidden; loops until a key',
    search: 'Search the Ledger',
    report: 'Report card',
    diagnostics: 'Diagnostics',
    sweepNow: 'Sweep now',
    inLedger: 'Its row in the Ledger',
    price: 'Its price in Settings',
    sweeping: 'Sweeping now',
  },

  // The live pulse (P2-W21): the status popover, the footer's sweep strip.
  pulse: {
    open: 'Sweep details',
    title: 'Sweeps in the last hour',
    next: 'Next sweep in {countdown}',
    nextExpected: 'Next sweep expected in {countdown}',
    due: 'Next sweep due now',
    overdue: 'Next sweep is {countdown} late',
    noNext: 'No sweep is scheduled',
    sample: 'Sample data: nothing is metered',
    seen: { one: '{n} sweep seen', other: '{n} sweeps seen' },
    seenSince: 'since {time}',
    median: 'median {duration}',
    calls: '{calls} Leader calls a sweep',
    failed: { one: '{n} failed', other: '{n} failed' },
    chartLabel: 'Leader calls per sweep over the last 60 minutes',
    axisStart: '60 min ago',
    axisEnd: 'now',
    none: 'No sweep has landed since this tab opened.',
    stripNext: 'next {countdown}',
    stripNextExpected: 'next ≈ {countdown}',
  },

  // The ?diag=1 / Shift+D support panel (P1-A08). Its row names stay technical on purpose (a support paste).
  diag: {
    label: 'Diagnostics',
    title: 'Meter Reader diagnostics · Shift+D or Esc to close',
    copy: 'Copy diagnostics',
    copied: 'Copied',
    copyFailed: "Couldn't copy",
    close: 'Close diagnostics',
  },

  confirm: {
    cannotUndo: 'This cannot be undone.',
    affects: 'This affects:',
    cancel: 'Cancel',
    failed: "Couldn't finish: {reason}",
  },

  empty: {
    noData: 'No data yet',
    noDataBody: 'Meter Reader shows figures after its first sweep.',
  },

  common: {
    close: 'Close',
    dash: '—',
    loading: 'Loading',
    and: 'and',
  },
} as const;

// ─── Typed lookup ────────────────────────────────────────────────────────────

type Copy = typeof en;

/** A `{ one, other }` plural pair. */
interface PluralForms {
  readonly one: string;
  readonly other: string;
}

type Join<K extends string, P extends string> = `${K}.${P}`;

/** Dotted paths to every plain string leaf (plural pairs and caption arrays are excluded). */
export type CopyKey = StringPaths<Copy>;
type StringPaths<T> = {
  [K in keyof T & string]: T[K] extends string
    ? K
    : T[K] extends readonly string[]
      ? never
      : T[K] extends PluralForms
        ? never
        : T[K] extends object
          ? Join<K, StringPaths<T[K]>>
          : never;
}[keyof T & string];

/** Dotted paths to every plural pair. */
export type PluralKey = PluralPaths<Copy>;
type PluralPaths<T> = {
  [K in keyof T & string]: T[K] extends string
    ? never
    : T[K] extends readonly string[]
      ? never
      : T[K] extends PluralForms
        ? K
        : T[K] extends object
          ? Join<K, PluralPaths<T[K]>>
          : never;
}[keyof T & string];

/** Dotted paths to every string that may be a single line or a caption sequence. */
export type LinesKey = LinesPaths<Copy>;
type LinesPaths<T> = {
  [K in keyof T & string]: T[K] extends string
    ? K
    : T[K] extends readonly string[]
      ? K
      : T[K] extends PluralForms
        ? never
        : T[K] extends object
          ? Join<K, LinesPaths<T[K]>>
          : never;
}[keyof T & string];

export type CopyVars = Readonly<Record<string, string | number>>;

function lookup(path: string): unknown {
  let node: unknown = en;
  for (const part of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Replaces `{name}` placeholders with `vars[name]`. A placeholder without a value is left as-is so a
 * missing variable is visible in review and in screenshots instead of silently rendering "undefined".
 */
export function interpolate(template: string, vars?: CopyVars): string {
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : String(value);
  });
}

/** Looks up a string by dotted key and interpolates `{placeholders}`. */
export function t(key: CopyKey, vars?: CopyVars): string {
  const value = lookup(key);
  if (typeof value !== 'string') {
    // Unreachable with a typed key; kept so a stale key from a JSON fixture never crashes a render.
    return key;
  }
  return interpolate(value, vars);
}

/** Plural lookup: picks `one` when `count === 1`, else `other`, and exposes `{n}` = count. */
export function tn(key: PluralKey, count: number, vars?: CopyVars): string {
  const value = lookup(key) as PluralForms | undefined;
  if (!value || typeof value !== 'object') return key;
  const template = count === 1 ? value.one : value.other;
  return interpolate(template, { n: count, ...vars });
}

/** Caption sequences (SPEC 15): always returns an array of interpolated lines. */
export function tLines(key: LinesKey, vars?: CopyVars): string[] {
  const value = lookup(key);
  if (typeof value === 'string') return [interpolate(value, vars)];
  if (Array.isArray(value)) return value.map((line: string) => interpolate(line, vars));
  return [key];
}
