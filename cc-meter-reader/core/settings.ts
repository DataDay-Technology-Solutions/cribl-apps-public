// core/settings.ts — Settings defaults, validation, hydration merge and migration (SPEC 5, 17).

import type { HeadlinePeriod, NotificationEndpoint, NotifyFormat, Settings, Severity, Thresholds } from './types.ts';
import { isValidTimeZone } from './time.ts';

export const SETTINGS_SCHEMA_VERSION = 1 as const;
export const MAX_NOTIFICATION_ENDPOINTS = 10;
/**
 * Default QR target on the presenter slide (SPEC 5): the App's home, the submission repository
 * Cribl-Community/cc-meter-reader (hackathon rules 3.2, 3.3; DECISIONS D58, which supersedes D51's staging-repo
 * default: the package a judge installs must point at the repository it was submitted from). scripts/package.mjs
 * PUBLIC_REPO holds the same home for the packaged README's links.
 */
export const DEFAULT_QR_URL = 'https://github.com/Cribl-Community/cc-meter-reader';
/** The Cribl Innovators Network group on LinkedIn: the demo org's presenter QR (STATE 0c, D51). */
export const CIN_GROUP_URL = 'https://www.linkedin.com/groups/13052739';

/**
 * Where a presenter QR goes, for its caption (OQ-04, D51): 'group' is the Cribl Innovators Network, 'repo' a
 * GitHub page of Meter Reader, 'link' anything else (the caption then names the host). Blank means the default.
 */
export function qrDestination(url: string | undefined): { kind: 'group' | 'repo' | 'link'; host: string } {
  const target = (url ?? '').trim() || DEFAULT_QR_URL;
  const host = hostFromUrl(target) ?? '';
  const bare = host.replace(/^www\./, '');
  let path = '';
  try {
    path = new URL(target).pathname.replace(/\/+$/, '');
  } catch {
    path = '';
  }
  if (bare === 'linkedin.com' && path === new URL(CIN_GROUP_URL).pathname) return { kind: 'group', host: bare };
  if (bare === 'github.com' && /meter-reader/i.test(path)) return { kind: 'repo', host: bare };
  return { kind: 'link', host: bare };
}

/**
 * The QR on the Story's closing ask frame (D58). Its words are "Join the Cribl Innovators Network." (D54) in every
 * build but the demo's, so the code goes where the words do: the group, unless a member set the presenter QR to
 * another link (a repository link, the default included, is replaced by the group: the frame asks nobody to star
 * a repository).
 */
export function askQrUrl(configured: string | undefined): string {
  const url = (configured ?? '').trim();
  return url && qrDestination(url).kind === 'link' ? url : CIN_GROUP_URL;
}

export const DEFAULT_THRESHOLDS: Readonly<Thresholds> = {
  regressionPoints: 15,
  regressionMinutes: 3,
  regressionCommitWindowMin: 30,
  spikeSigma: 3,
  spikeMinutes: 2,
  spikeMinCentsPerHour: 500,
  budgetWarnPct: 90,
  budgetAlertPct: 100,
  goodNewsPoints: 15,
  cooldownMinutes: 60,
  ewmaAlpha: 0.0014,
  warmupSamples: 10,
  recoveryMinutes: 5,
  regressionMinCentsPerDay: 500,
};

/**
 * SPEC 5 defaults, plus `thresholds.recoveryMinutes` 5 and `runtime` 'ui' (DECISIONS D11/D12b). The
 * Enterprise backend variant (`VITE_MR_RUNTIME=backend`, scripts/package.mjs) passes `runtime` 'backend'.
 * A stored settings document still wins over this default (mergeSettings).
 */
export function defaultSettings(nowIso: string, tz: string, runtime: Settings['runtime'] = 'ui'): Settings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    updatedAt: nowIso,
    displayTimezone: isValidTimeZone(tz) ? tz : 'UTC',
    headlinePeriodDefault: 'mtd',
    presenter: { headlinePeriod: 'annualized', qrUrl: DEFAULT_QR_URL },
    live: { pollSeconds: 10, presenterPollSeconds: 5 },
    budgets: {},
    thresholds: { ...DEFAULT_THRESHOLDS },
    goodNewsEnabled: false,
    excludedObjectKeys: [],
    includeInternal: false,
    notifications: [],
    humanize: {},
    demo: { enabled: false, replayMode: false, profile: true },
    runtime: runtime === 'backend' ? 'backend' : 'ui',
  };
}

/**
 * Whether the good-news rule runs (P2-W06): the member's switch, or the demo profile — under the demo profile a
 * pack applied on stage is announced like the break is, so the room watches the forecast land. Like the demo
 * profile's 1-minute confirmation it overrides the stored value without touching it; outside demo mode only
 * the switch counts.
 */
export function goodNewsActive(settings: Pick<Settings, 'goodNewsEnabled' | 'demo'>): boolean {
  return settings.goodNewsEnabled === true || (settings.demo?.enabled === true && settings.demo?.profile === true);
}

// ─── Validation ──────────────────────────────────────────────────────────────

export interface SettingsError {
  /** dotted path, e.g. 'thresholds.regressionPoints', 'notifications[0].url' */
  field: string;
  message: string;
}
export interface SettingsValidation {
  ok: boolean;
  errors: SettingsError[];
}

/** Plain-words names used in the SPEC 17 error copy ("Couldn't save: {field} must be …"). */
const FIELD_LABELS: Record<string, string> = {
  'thresholds.regressionPoints': 'regression points',
  'thresholds.regressionMinutes': 'regression minutes',
  'thresholds.regressionCommitWindowMin': 'commit window',
  'thresholds.spikeSigma': 'spike sigma',
  'thresholds.spikeMinutes': 'spike minutes',
  'thresholds.spikeMinCentsPerHour': 'minimum spike per hour',
  'thresholds.budgetWarnPct': 'budget warning percent',
  'thresholds.budgetAlertPct': 'budget alert percent',
  'thresholds.goodNewsPoints': 'good news points',
  'thresholds.cooldownMinutes': 'cooldown minutes',
  'thresholds.ewmaAlpha': 'baseline memory',
  'thresholds.warmupSamples': 'warm-up samples',
  'thresholds.recoveryMinutes': 'recovery minutes',
  'live.pollSeconds': 'refresh interval',
  'live.presenterPollSeconds': 'presenter refresh interval',
  criblCostCentsPerMonth: 'Cribl cost',
  savingsGoalCentsPerMonth: 'savings goal',
};

function label(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  const budget = /^budgets\.(.+)$/.exec(field);
  if (budget) return `budget for ${budget[1]}`;
  return field;
}

const nonNegative = (field: string): SettingsError => ({
  field,
  message: `Couldn't save: ${label(field)} must be 0 or more.`,
});
const between = (field: string, lo: number, hi: number): SettingsError => ({
  field,
  message: `Couldn't save: ${label(field)} must be between ${lo} and ${hi}.`,
});
const wholeAtLeastOne = (field: string): SettingsError => ({
  field,
  message: `Couldn't save: ${label(field)} must be a whole number of 1 or more.`,
});

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * DECISIONS D57 (hackathon rule 4.5: plain-text credentials in KV disqualify): a webhook URL carries its secret
 * (a Slack incoming webhook's token is its path), and App KV has no encryption a backend or a tab can read back,
 * so NO build stores a webhook URL. Settings keep only the Cribl channels (the bell, and notification targets by
 * id; their secrets stay in Cribl). Direct webhooks are the runner's alone, from URLs in its git-ignored .env
 * (core/env-webhooks.ts). The refusal a settings document with a webhook endpoint or any URL gets; core cannot
 * import the UI copy deck, so src/copy/en.ts `errors.webhookNotStored` repeats it and a test holds the two equal.
 */
export const WEBHOOK_NOT_STORED_MESSAGE =
  "Couldn't save: Meter Reader stores no webhook URL. Send through a Cribl notification target, or give the runner the URL in its .env (MR_WEBHOOKS).";

/**
 * The refusal a target id, an endpoint name or a humanize label gets when it reads as a token, a key or a password
 * rather than a Cribl id or words (rules round 2, rule 4.5): a UUID (a Splunk or Cribl HEC token, an Opsgenie key), a
 * long hex or lowercase-alphanumeric run (a PagerDuty integration or routing key, a Datadog API key), a JWT, a known
 * key prefix (SendGrid `SG.`, Stripe `sk_`/`rk_`, `sk-`), or a password-shaped word. src/copy/en.ts `errors.credentialNotStored`
 * repeats it and a test holds the two equal.
 */
export const CREDENTIAL_NOT_STORED_MESSAGE =
  "Couldn't save: that looks like a token, key or password, and Meter Reader stores no credential. Use the id the target has in Cribl, or plain words for a name.";

/**
 * The refusal a typed target id gets when the listed notification targets (GET /notification-targets) do not include it.
 * src/copy/en.ts `errors.unknownTarget` repeats it and a test holds the two equal.
 */
export const UNKNOWN_TARGET_MESSAGE = "Couldn't save: Cribl lists no notification target with this id. Choose one from the list.";

/** The refusal a target id gets when it is not shaped like a Cribl id (and not a URL or a token, which get the one above). */
export const TARGET_ID_SHAPE_MESSAGE =
  "Couldn't save: a target id has only letters, digits, _ and -, as Cribl lists it under notification targets.";

/**
 * A Cribl object id as the Leader writes one (a notification target's `id` included: `system_notifications`,
 * `ops_slack`, `mrd_webhook_site`): letters, digits, '_' and '-'. No URL, path, host or userinfo fits it.
 */
export const CRIBL_ID_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;

/** Token prefixes that are secrets on their own (Slack, GitHub, AWS access keys, PEM keys, bearer headers). */
const SECRET_TOKEN = /\bxox[abposr]-|\bxapp-|\bghp_|\bgho_|\bghs_|\bgithub_pat_|\bAKIA[0-9A-Z]{16}\b|-{5}BEGIN [A-Z ]*KEY|\bBearer\s+\S/;
/** A host with a path and no scheme: `hooks.slack.com/services/…` is a webhook's secret just the same. */
const HOST_WITH_PATH = /(?:^|[^A-Za-z0-9.@-])(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?\/\S/;
/** `user:password@host` without a scheme. */
const BARE_USERINFO = /(?:^|\s)[^\s:@/]+:[^\s@/]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/;
/** One unbroken run of 20+ letters and digits in both cases with digits: a random token, not a name a person gives. */
const RANDOM_TOKEN = /^(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{20,}$/;

/**
 * Rules round 2 (rule 4.5): token shapes the checks above let through, each a common credential format a member might
 * paste as a target id, a name or a label. Measured by a judge: a UUID (the Splunk HEC and Cribl HEC token format), a
 * 32-character lowercase hex key (a PagerDuty integration or routing key, a Datadog API key), a SendGrid key and a JWT
 * were all stored. Kept apart from looksLikeCredentialText because an endpoint's own id is a UUID the editor generates
 * (crypto.randomUUID) and must stay storable; everything a member types is checked against both.
 */
const UUID_TOKEN = /(?:^|[^0-9A-Za-z])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:$|[^0-9A-Za-z])/i;
/** A run of 24 or more hex digits (any case): API keys, integration keys, digests. */
const HEX_RUN = /(?:^|[^0-9A-Za-z])[0-9a-f]{24,}(?:$|[^0-9A-Za-z])/i;
/** A run of 24 or more lowercase letters and digits with at least one digit and one letter: a generated key. */
const LOWER_ALNUM_RUN = /(?:^|[^0-9A-Za-z])(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{24,}(?:$|[^0-9A-Za-z])/;
/** A JSON Web Token: base64url('{"…') header, a dot, a payload, a dot. */
const JWT_TOKEN = /(?:^|[^\w-])eyJ[\w-]+\.[\w-]+\./;
/** Key prefixes: SendGrid `SG.<id>.<secret>`, Stripe secret and restricted keys, `sk-` keys (OpenAI, Anthropic and others). */
const KEY_PREFIX = /(?:^|[^\w.])SG\.[\w-]{6,}|(?:^|[^A-Za-z0-9])[sr]k_(?:live|test)_\w+|(?:^|[^A-Za-z0-9])[sr]k_[A-Za-z0-9]{16,}|(?:^|[^A-Za-z0-9])sk-[\w-]{16,}/;
/**
 * One word of 8–64 characters, no spaces, mixing lower case, upper case, a digit and a symbol that is not '-', '_' or
 * '.': a password, not a name ('P@ssw0rd!' is refused; 'On-call (P1)', 'Splunk Cloud v2.1' and 'OpsPager2' are not).
 */
const PASSWORD_WORD = /^(?=\S*[a-z])(?=\S*[A-Z])(?=\S*\d)(?=\S*[^\sA-Za-z0-9._-])\S{8,64}$/;

/**
 * Whether member-typed text reads as a token, a key or a password (rules round 2, rule 4.5): a UUID, 24+ hex or
 * lowercase-alphanumeric characters in a row, a JWT, a known key prefix, or a password-shaped word. Settings refuse
 * such text as a target id, an endpoint name or a humanize label (or its key), on top of looksLikeCredentialText.
 * A heuristic: it refuses the formats above, it cannot recognise every secret.
 */
export function looksLikeSecretToken(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v === '') return false;
  return UUID_TOKEN.test(v) || HEX_RUN.test(v) || LOWER_ALNUM_RUN.test(v) || JWT_TOKEN.test(v) || KEY_PREFIX.test(v) || PASSWORD_WORD.test(v);
}

/** Text a member types that App KV may not hold: a URL, an address, userinfo, or any token shape (both screens). */
function unstorableText(value: unknown): boolean {
  return looksLikeCredentialText(value) || looksLikeSecretToken(value);
}

/**
 * Whether settings text could carry a credential into plain KV (hackathon rule 4.5, D57): any URL ('://', so a
 * webhook URL and a userinfo URL too), a scheme-less webhook address (a host followed by a path), `user:pass@host`,
 * a token with a known secret prefix, or a random-looking token. The settings document's free text (an endpoint's
 * name, a humanize label) and its ids refuse such text: App KV has no encryption a tab or a backend can read back.
 */
export function looksLikeCredentialText(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v === '') return false;
  return v.includes('://') || urlHasCredentials(v) || HOST_WITH_PATH.test(v) || BARE_USERINFO.test(v) || SECRET_TOKEN.test(v) || RANDOM_TOKEN.test(v);
}

/** A notification target id App KV may hold: shaped like a Cribl id and not a URL, token, key or password (D57, rule 4.5). */
export function isStorableTargetId(value: unknown): value is string {
  return typeof value === 'string' && CRIBL_ID_PATTERN.test(value) && !unstorableText(value);
}

/** Hosts whose URLs carry their secret in the path or query: a presenter QR never points at one (D57). */
const WEBHOOK_URL = [
  /^https?:\/\/hooks\.slack\.com\//i,
  /^https?:\/\/[^/?#]*\.webhook\.office\.com\//i,
  /^https?:\/\/outlook\.office(?:365)?\.com\/webhook/i,
  /^https?:\/\/(?:[^/?#]*\.)?discord(?:app)?\.com\/api\/webhooks\//i,
  /^https?:\/\/hooks\.zapier\.com\//i,
  /^https?:\/\/events\.pagerduty\.com\//i,
  /^https?:\/\/(?:[^/?#]*\.)?webhook\.site\//i,
  /^https?:\/\/maker\.ifttt\.com\/trigger\//i,
  /^https?:\/\/api\.telegram\.org\/bot/i,
];

/** Whether a URL is a known incoming-webhook address or carries userinfo (the presenter QR's narrow guard, D57). */
export function isWebhookUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  const u = url.trim();
  return urlHasCredentials(u) || WEBHOOK_URL.some((re) => re.test(u));
}

/** An endpoint App KV may hold (D57): the Cribl bell or a Cribl notification target. Anything else is a direct webhook. */
export function isStorableEndpoint(e: Pick<NotificationEndpoint, 'channel'> | null | undefined): boolean {
  return e?.channel === 'cribl-bell' || e?.channel === 'cribl-target';
}

/**
 * One endpoint as App KV may hold it, or undefined when it may not be held at all (D57, rule 4.5): the Cribl bell,
 * or a Cribl notification target whose id is shaped like a Cribl id; never a URL or a host; an id that is not a URL
 * or token; a name that is not a URL or token (the target id stands in for such a name); a well-formed lastTest only.
 */
function storableEndpoint(e: unknown): NotificationEndpoint | undefined {
  if (!isObj(e) || typeof e.id !== 'string' || e.id === '' || looksLikeCredentialText(e.id)) return undefined;
  const ep = e as Partial<NotificationEndpoint> & { id: string };
  if (!isStorableEndpoint(ep)) return undefined;
  if (ep.channel === 'cribl-target' && !isStorableTargetId(ep.criblTargetId)) return undefined;
  const out = normalizeEndpoint({ ...ep, url: '', host: '' });
  if (out.channel === 'cribl-bell') delete out.criblTargetId;
  if (unstorableText(out.name)) out.name = out.channel === 'cribl-target' ? (out.criblTargetId ?? '') : '';
  return out;
}

/** humanize labels App KV may hold: string labels that are not URLs or tokens, under keys that are not either. */
function storableLabels(map: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(map)) return out;
  for (const [k, v] of Object.entries(map)) if (typeof v === 'string' && !unstorableText(v) && !unstorableText(k)) out[k] = v;
  return out;
}

/**
 * The settings document as App KV may hold it (D57, rule 4.5): only the Cribl channels, each with no URL and no
 * host, a target id shaped like a Cribl id, and no URL or token in any endpoint's id or name or in a humanize label;
 * a presenter QR that is a known webhook address, or carries userinfo, goes back to the default. Every write of the
 * settings document goes through this (core/kv.ts `putSettings`), whatever the caller built — the Settings screen,
 * the runner's --setup, a backend — so no runtime can put a webhook URL or a token in plain KV.
 */
export function storableSettings(s: Settings): Settings {
  // A document with no endpoint list is left to the KV guard, which refuses it.
  if (!Array.isArray(s.notifications)) return s;
  const notifications = s.notifications.map(storableEndpoint).filter((e): e is NotificationEndpoint => e !== undefined);
  const out: Settings = { ...s, notifications };
  if (s.humanize !== undefined) out.humanize = storableLabels(s.humanize);
  if (s.presenter && isWebhookUrl(s.presenter.qrUrl)) out.presenter = { ...s.presenter, qrUrl: DEFAULT_QR_URL };
  return out;
}

/**
 * How many things in a stored settings document App KV must not hold (D57, rule 4.5): direct webhooks, endpoints
 * with a URL, a target id that is not id-shaped, a URL or token in an endpoint's id or name or in a humanize label,
 * a webhook-address presenter QR. The runner rewrites such a document through putSettings once at start-up.
 */
export function unstorableSettingsCount(s: Partial<Pick<Settings, 'notifications' | 'humanize' | 'presenter'>>): number {
  let n = 0;
  for (const e of Array.isArray(s.notifications) ? s.notifications : []) {
    const kept = storableEndpoint(e);
    if (!kept || (typeof e.url === 'string' && e.url !== '') || (typeof e.host === 'string' && e.host !== '') || kept.name !== e.name) n++;
  }
  if (isObj(s.humanize)) n += Object.keys(s.humanize).length - Object.keys(storableLabels(s.humanize)).length;
  if (s.presenter && isWebhookUrl(s.presenter.qrUrl)) n++;
  return n;
}

/**
 * Whether a URL carries userinfo (`https://user:password@host/…`): an '@' before the first '/', '?' or '#'
 * after the scheme. Such a URL would put a password in plain KV (README: "No token, password or API key is
 * stored in plain text anywhere"), so no webhook URL may carry one. An '@' in the path or query is not userinfo.
 */
export function urlHasCredentials(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test((url ?? '').trim());
}

/** Hostname of an https URL, or undefined when it is not one (a URL with a user name or password is not). No URL/DOM API needed. */
export function hostFromUrl(url: string): string | undefined {
  if (urlHasCredentials(url)) return undefined;
  const m = /^https:\/\/(\[[^\]]+\]|[^/?#:]+)(?::\d+)?(?:[/?#]|$)/i.exec((url ?? '').trim());
  return m ? m[1].toLowerCase() : undefined;
}

const SEVERITIES: Severity[] = ['info', 'medium', 'high'];
const FORMATS: NotifyFormat[] = ['generic', 'slack', 'servicenow'];
const PERIODS: HeadlinePeriod[] = ['mtd', 'today', '30d', 'annualized'];

/**
 * SPEC 5 validation: URLs https only; numbers finite and ≥ 0; regressionPoints 5–50;
 * ewmaAlpha 0.0005–0.5; live.pollSeconds 5–60; presenterPollSeconds 3–30; ≤ 10 endpoints.
 * Minute/sample counts must be whole numbers ≥ 1. Error copy follows SPEC 17.
 */
export interface ValidateOptions {
  /**
   * The notification target ids Cribl lists (GET /notification-targets), when that read succeeded: a Cribl target
   * whose id is not among them is refused (UNKNOWN_TARGET_MESSAGE). Omitted (the list is not loaded, or the read
   * failed): only the id's shape and the credential screens decide.
   */
  knownTargetIds?: readonly string[];
}

export function validateSettings(s: Settings, opts: ValidateOptions = {}): SettingsValidation {
  const errors: SettingsError[] = [];
  const t = s.thresholds ?? ({} as Thresholds);

  const numericThresholds: (keyof Thresholds)[] = [
    'regressionPoints',
    'regressionMinutes',
    'regressionCommitWindowMin',
    'spikeSigma',
    'spikeMinutes',
    'spikeMinCentsPerHour',
    'budgetWarnPct',
    'budgetAlertPct',
    'goodNewsPoints',
    'cooldownMinutes',
    'ewmaAlpha',
    'warmupSamples',
    'recoveryMinutes',
  ];
  const bad = new Set<string>();
  for (const k of numericThresholds) {
    const v = t[k];
    if (!isNum(v) || v < 0) {
      errors.push(nonNegative(`thresholds.${k}`));
      bad.add(k);
    }
  }
  if (!bad.has('regressionPoints') && (t.regressionPoints < 5 || t.regressionPoints > 50)) {
    errors.push(between('thresholds.regressionPoints', 5, 50));
  }
  if (!bad.has('ewmaAlpha') && (t.ewmaAlpha < 0.0005 || t.ewmaAlpha > 0.5)) {
    errors.push(between('thresholds.ewmaAlpha', 0.0005, 0.5));
  }
  for (const k of ['regressionMinutes', 'spikeMinutes', 'recoveryMinutes', 'warmupSamples'] as const) {
    if (!bad.has(k) && (!Number.isInteger(t[k]) || t[k] < 1)) errors.push(wholeAtLeastOne(`thresholds.${k}`));
  }

  const live = s.live ?? { pollSeconds: Number.NaN, presenterPollSeconds: Number.NaN };
  if (!isNum(live.pollSeconds) || live.pollSeconds < 0) errors.push(nonNegative('live.pollSeconds'));
  else if (live.pollSeconds < 5 || live.pollSeconds > 60) errors.push(between('live.pollSeconds', 5, 60));
  if (!isNum(live.presenterPollSeconds) || live.presenterPollSeconds < 0) errors.push(nonNegative('live.presenterPollSeconds'));
  else if (live.presenterPollSeconds < 3 || live.presenterPollSeconds > 30) errors.push(between('live.presenterPollSeconds', 3, 30));

  if (s.criblCostCentsPerMonth !== undefined && (!isNum(s.criblCostCentsPerMonth) || s.criblCostCentsPerMonth < 0)) {
    errors.push(nonNegative('criblCostCentsPerMonth'));
  }
  if (s.savingsGoalCentsPerMonth !== undefined && (!isNum(s.savingsGoalCentsPerMonth) || s.savingsGoalCentsPerMonth < 0)) {
    errors.push(nonNegative('savingsGoalCentsPerMonth'));
  }
  for (const [outputId, b] of Object.entries(s.budgets ?? {})) {
    if (!b || !isNum(b.centsPerMonth) || b.centsPerMonth < 0) errors.push(nonNegative(`budgets.${outputId}`));
  }

  if (!isValidTimeZone(s.displayTimezone)) {
    errors.push({ field: 'displayTimezone', message: "Couldn't save: display timezone must be an IANA timezone, like America/Chicago." });
  }
  if (!PERIODS.includes(s.headlinePeriodDefault)) {
    errors.push({ field: 'headlinePeriodDefault', message: "Couldn't save: choose a headline period." });
  }
  if (!s.presenter || !PERIODS.includes(s.presenter.headlinePeriod)) {
    errors.push({ field: 'presenter.headlinePeriod', message: "Couldn't save: choose a presenter headline period." });
  }
  if (s.presenter?.qrUrl !== undefined && s.presenter.qrUrl !== '' && hostFromUrl(s.presenter.qrUrl) === undefined) {
    errors.push({ field: 'presenter.qrUrl', message: 'QR link must start with https://' });
  } else if (isWebhookUrl(s.presenter?.qrUrl)) {
    // D57: a webhook address is a credential even on a QR; no settings field stores one.
    errors.push({ field: 'presenter.qrUrl', message: WEBHOOK_NOT_STORED_MESSAGE });
  }
  // D57 (rule 4.5): no humanize label, nor its key, is a URL or a token (no editor writes them; storableSettings
  // drops one on every write and mergeSettings on every read).
  if (isObj(s.humanize)) {
    for (const [k, v] of Object.entries(s.humanize)) {
      // The field never names the key: a key that is a URL would be echoed back.
      if (looksLikeCredentialText(k) || looksLikeCredentialText(v)) errors.push({ field: 'humanize', message: WEBHOOK_NOT_STORED_MESSAGE });
      else if (looksLikeSecretToken(k) || looksLikeSecretToken(v)) errors.push({ field: 'humanize', message: CREDENTIAL_NOT_STORED_MESSAGE });
    }
  }

  const endpoints = Array.isArray(s.notifications) ? s.notifications : [];
  if (endpoints.length > MAX_NOTIFICATION_ENDPOINTS) {
    errors.push({ field: 'notifications', message: `Couldn't save: at most ${MAX_NOTIFICATION_ENDPOINTS} notification endpoints.` });
  }
  const seenIds = new Set<string>();
  endpoints.forEach((e: NotificationEndpoint, i: number) => {
    const f = (k: string): string => `notifications[${i}].${k}`;
    if (!e || typeof e.id !== 'string' || e.id === '' || seenIds.has(e.id)) {
      errors.push({ field: f('id'), message: "Couldn't save: each endpoint needs a unique id." });
    } else if (looksLikeCredentialText(e.id)) {
      errors.push({ field: f('id'), message: WEBHOOK_NOT_STORED_MESSAGE });
    } else {
      seenIds.add(e.id);
    }
    if (typeof e?.name !== 'string' || e.name.trim() === '') {
      errors.push({ field: f('name'), message: "Couldn't save: give this endpoint a name." });
    } else if (looksLikeCredentialText(e.name)) {
      // D57 (rule 4.5): a name is shown and stored as plain text, so it is never a URL or a token.
      errors.push({ field: f('name'), message: WEBHOOK_NOT_STORED_MESSAGE });
    } else if (looksLikeSecretToken(e.name)) {
      errors.push({ field: f('name'), message: CREDENTIAL_NOT_STORED_MESSAGE });
    }
    // Cribl channels (DECISIONS D23) carry no URL; a target endpoint needs its target id instead. A direct webhook
    // is never stored at all (DECISIONS D57, rule 4.5): its URL is a credential, so it lives in the runner's .env.
    // The target id is the one free-text field a member types that reaches KV: it must be shaped like a Cribl id
    // (a webhook URL typed there is refused with the webhook copy, under the Target id field).
    if (e?.channel === 'cribl-target') {
      if (typeof e.criblTargetId !== 'string' || e.criblTargetId.trim() === '') {
        errors.push({ field: f('criblTargetId'), message: "Couldn't save: choose a Cribl notification target." });
      } else if (looksLikeCredentialText(e.criblTargetId)) {
        errors.push({ field: f('criblTargetId'), message: WEBHOOK_NOT_STORED_MESSAGE });
      } else if (!CRIBL_ID_PATTERN.test(e.criblTargetId)) {
        errors.push({ field: f('criblTargetId'), message: TARGET_ID_SHAPE_MESSAGE });
      } else if (looksLikeSecretToken(e.criblTargetId)) {
        errors.push({ field: f('criblTargetId'), message: CREDENTIAL_NOT_STORED_MESSAGE });
      } else if (opts.knownTargetIds && !opts.knownTargetIds.includes(e.criblTargetId)) {
        errors.push({ field: f('criblTargetId'), message: UNKNOWN_TARGET_MESSAGE });
      }
    } else if (e?.channel !== 'cribl-bell') {
      errors.push({ field: f('url'), message: WEBHOOK_NOT_STORED_MESSAGE });
    }
    if (e?.channel === 'cribl-target' || e?.channel === 'cribl-bell') {
      if (typeof e.url === 'string' && e.url !== '') errors.push({ field: f('url'), message: WEBHOOK_NOT_STORED_MESSAGE });
    }
    if (!FORMATS.includes(e?.format)) errors.push({ field: f('format'), message: "Couldn't save: choose a format." });
    if (!SEVERITIES.includes(e?.minSeverity)) errors.push({ field: f('minSeverity'), message: "Couldn't save: choose a minimum severity." });
  });

  return { ok: errors.length === 0, errors };
}

// ─── Hydration merge + migration ─────────────────────────────────────────────

/** Stored value when it has the same primitive type as the default, else the default. */
function pick<T>(stored: unknown, fallback: T): T {
  if (stored === undefined || stored === null) return fallback;
  if (typeof fallback === 'number') return (isNum(stored) ? stored : fallback) as T;
  return (typeof stored === typeof fallback ? stored : fallback) as T;
}

function pickPeriod(stored: unknown, fallback: HeadlinePeriod): HeadlinePeriod {
  return PERIODS.includes(stored as HeadlinePeriod) ? (stored as HeadlinePeriod) : fallback;
}

/**
 * Hydration safety: every stored value of the right type wins; every missing or mistyped field is
 * filled from `defaults` (nested objects field by field). Never throws.
 */
export function mergeSettings(stored: unknown, defaults: Settings): Settings {
  const s = isObj(stored) ? stored : {};
  const presenter = isObj(s.presenter) ? s.presenter : {};
  const live = isObj(s.live) ? s.live : {};
  const thresholds = isObj(s.thresholds) ? s.thresholds : {};
  const demo = isObj(s.demo) ? s.demo : {};

  const mergedThresholds = { ...defaults.thresholds };
  for (const k of Object.keys(defaults.thresholds) as (keyof Thresholds)[]) {
    (mergedThresholds as Record<string, number | undefined>)[k] = pick(thresholds[k], defaults.thresholds[k]);
  }

  const budgets: Settings['budgets'] = {};
  if (isObj(s.budgets)) {
    for (const [k, v] of Object.entries(s.budgets)) {
      if (isObj(v) && isNum(v.centsPerMonth)) budgets[k] = { centsPerMonth: v.centsPerMonth };
    }
  }
  // D57 (rule 4.5): a label that is a URL or a token is dropped on read (storableSettings drops it on write).
  const humanizeMap = storableLabels(s.humanize);

  // A webhook address or a userinfo URL is never a presenter QR (D57): the default stands in.
  const storedQr = typeof presenter.qrUrl === 'string' ? presenter.qrUrl : defaults.presenter.qrUrl;
  const qrUrl = isWebhookUrl(storedQr) ? DEFAULT_QR_URL : storedQr;
  const out: Settings = {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    updatedAt: pick(s.updatedAt, defaults.updatedAt),
    displayTimezone:
      typeof s.displayTimezone === 'string' && isValidTimeZone(s.displayTimezone) ? s.displayTimezone : defaults.displayTimezone,
    headlinePeriodDefault: pickPeriod(s.headlinePeriodDefault, defaults.headlinePeriodDefault),
    presenter: { headlinePeriod: pickPeriod(presenter.headlinePeriod, defaults.presenter.headlinePeriod), ...(qrUrl !== undefined ? { qrUrl } : {}) },
    live: {
      pollSeconds: pick(live.pollSeconds, defaults.live.pollSeconds),
      presenterPollSeconds: pick(live.presenterPollSeconds, defaults.live.presenterPollSeconds),
    },
    budgets: isObj(s.budgets) ? budgets : { ...defaults.budgets },
    thresholds: mergedThresholds,
    goodNewsEnabled: pick(s.goodNewsEnabled, defaults.goodNewsEnabled),
    excludedObjectKeys: Array.isArray(s.excludedObjectKeys)
      ? s.excludedObjectKeys.filter((k): k is string => typeof k === 'string')
      : [...defaults.excludedObjectKeys],
    includeInternal: pick(s.includeInternal, defaults.includeInternal),
    // D57: a stored direct webhook (written by a build before 1.0.14 / 1.1.0) is dropped on read, URL and all, as is
    // a target whose id is not shaped like a Cribl id (a URL typed as the target id before the rule 4.5 fix); the Cribl channels
    // keep no URL and no name is a URL: nothing a sweep or a tab reads can carry a webhook URL out of KV.
    notifications: (Array.isArray(s.notifications) ? s.notifications : defaults.notifications)
      .map(storableEndpoint)
      .filter((e): e is NotificationEndpoint => e !== undefined),
    humanize: isObj(s.humanize) ? humanizeMap : { ...defaults.humanize },
    demo: {
      enabled: pick(demo.enabled, defaults.demo.enabled),
      replayMode: pick(demo.replayMode, defaults.demo.replayMode),
      profile: pick(demo.profile, defaults.demo.profile),
    },
    runtime: s.runtime === 'backend' || s.runtime === 'ui' ? s.runtime : defaults.runtime,
  };
  const cost = isNum(s.criblCostCentsPerMonth) ? s.criblCostCentsPerMonth : defaults.criblCostCentsPerMonth;
  if (cost !== undefined) out.criblCostCentsPerMonth = cost;
  // The cost came from "Use this estimate" (list price × measured ingest): only beside a cost it describes.
  if (cost !== undefined && cost > 0 && s.criblCostEstimate === true) out.criblCostEstimate = true;
  // P1-F07 (loaned to WP-F): a member's "Mute for 24 hours" — kept when well formed, dropped otherwise.
  if (isObj(s.mutes)) {
    const mutes: NonNullable<Settings['mutes']> = {};
    for (const [k, v] of Object.entries(s.mutes)) {
      if (isObj(v) && typeof v.until === 'string') mutes[k] = typeof v.by === 'string' ? { until: v.until, by: v.by } : { until: v.until };
    }
    if (Object.keys(mutes).length > 0) out.mutes = mutes;
  }
  // The single-key shortcuts switch (P1-A09): kept only when stored as a boolean; absent means on.
  const keyboard = isObj(s.keyboard) ? s.keyboard : {};
  if (typeof keyboard.singleKeyShortcuts === 'boolean') out.keyboard = { singleKeyShortcuts: keyboard.singleKeyShortcuts };
  else if (defaults.keyboard) out.keyboard = { ...defaults.keyboard };
  if (isNum(s.savingsGoalCentsPerMonth) && s.savingsGoalCentsPerMonth > 0) out.savingsGoalCentsPerMonth = s.savingsGoalCentsPerMonth;
  return out;
}

/** Fills endpoint defaults (minSeverity 'medium', weeklyReceipt true, enabled true, host from the URL). */
export function normalizeEndpoint(e: Partial<NotificationEndpoint> & { id: string; url: string }): NotificationEndpoint {
  const out: NotificationEndpoint = {
    id: e.id,
    name: typeof e.name === 'string' ? e.name : '',
    url: e.url,
    host: hostFromUrl(e.url) ?? (typeof e.host === 'string' ? e.host : ''),
    format: FORMATS.includes(e.format as NotifyFormat) ? (e.format as NotifyFormat) : 'generic',
    minSeverity: SEVERITIES.includes(e.minSeverity as Severity) ? (e.minSeverity as Severity) : 'medium',
    weeklyReceipt: typeof e.weeklyReceipt === 'boolean' ? e.weeklyReceipt : true,
    enabled: typeof e.enabled === 'boolean' ? e.enabled : true,
  };
  // Only the three fields a test result has: nothing else rides along into KV on an endpoint.
  const lt: unknown = e.lastTest;
  if (isObj(lt) && typeof lt.at === 'string' && isNum(lt.status)) out.lastTest = { at: lt.at, status: lt.status, hostAuthorized: lt.hostAuthorized === true };
  // Delivery channel (DECISIONS D23, core/delivery.ts); absent means a direct webhook.
  if (e.channel === 'webhook' || e.channel === 'cribl-bell' || e.channel === 'cribl-target') out.channel = e.channel;
  // Kept as given, so validateSettings can name what is wrong with a typed id (the Settings editor builds its
  // endpoints here). What may reach or leave KV is storableEndpoint's call: it drops a target whose id is not a
  // Cribl id (D57, rule 4.5).
  if (typeof e.criblTargetId === 'string' && e.criblTargetId !== '') out.criblTargetId = e.criblTargetId;
  // A member's "it arrived" (rules round 2): kept only for the target id it confirmed, with a real time.
  if (
    out.criblTargetId !== undefined &&
    typeof e.confirmedAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(e.confirmedAt) &&
    Number.isFinite(Date.parse(e.confirmedAt)) &&
    e.confirmedTargetId === out.criblTargetId
  ) {
    out.confirmedAt = e.confirmedAt;
    out.confirmedTargetId = e.confirmedTargetId;
  }
  return out;
}

/**
 * Reads a stored settings value (object or JSON string) of any schemaVersion and returns a
 * current, complete Settings. Pre-v1 documents: `thresholds.ewmaAlpha` 0.2 (v1.1's mislabelled
 * five-minute memory) becomes the 24-hour 0.0014; everything missing is defaulted.
 */
export function migrateSettings(raw: unknown, nowIso = '1970-01-01T00:00:00.000Z', tz = 'UTC'): Settings {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
  }
  const defaults = defaultSettings(nowIso, tz);
  if (!isObj(value)) return defaults;
  const version = isNum(value.schemaVersion) ? value.schemaVersion : 0;
  let working: Record<string, unknown> = value;
  if (version < 1) {
    const th = isObj(value.thresholds) ? { ...value.thresholds } : undefined;
    if (th && th.ewmaAlpha === 0.2) th.ewmaAlpha = DEFAULT_THRESHOLDS.ewmaAlpha;
    working = { ...value, ...(th ? { thresholds: th } : {}) };
  }
  return mergeSettings(working, defaults);
}
