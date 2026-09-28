// core/humanize.ts — Cribl object IDs → plain-words labels (SPEC 13 "Humanizing IDs").
// Lookup order: user overrides (settings.humanize) → DEMO_LABELS → the dictionary.

/** Exact labels for the demo rig's ids (SPEC 14.2), which the dictionary alone cannot produce. */
export const DEMO_LABELS: Readonly<Record<string, string>> = {
  mrd_pay_sample: 'Payments API sampling',
  mrd_win_xml_pack: 'Windows XML pack',
  mrd_win_docs_reduce: 'Windows XML reduction (aggressive)',
  mrd_k8s_noise: 'Kubernetes noise filter',
  mrd_passthrough: 'Passthrough (no reduction)',
  mrd_pan_pack: 'Palo Alto pack',
  mrd_vpc_pack: 'VPC Flow aggregation',
  // the rig's destinations, as demo/rig/destinations.json labels them (P1-I04: never slugs beside prose sources)
  mrd_siem_prod: 'SIEM (prod)',
  mrd_siem_apps: 'SIEM (apps)',
  mrd_analytics: 'Analytics',
  mrd_archive_s3: 'Archive (S3)',
  mrd_windows_dc: 'Windows DC security events',
  mrd_windows_workstations: 'Windows workstation events',
  mrd_pan_firewall: 'Palo Alto firewall',
  mrd_vpc_flow: 'AWS VPC Flow Logs',
  mrd_payments_api: 'Payments API',
  mrd_k8s_prod: 'Kubernetes prod',
};

/** Token dictionary (SPEC 13 plus the rig's vocabulary). Keys are lower-case tokens. */
export const HUMANIZE_DICTIONARY: Readonly<Record<string, string>> = {
  win: 'Windows',
  fw: 'firewall',
  k8s: 'Kubernetes',
  agg: 'aggregation',
  dedupe: 'duplicate suppression',
  trim: 'trimming',
  sample: 'sampling',
  pay: 'Payments',
  api: 'API',
  dc: 'DC',
  pan: 'Palo Alto',
  vpc: 'VPC',
  siem: 'SIEM',
  s3: 'S3',
  devnull: 'DevNull', // Cribl's built-in destination, spelled as the Ledger and Cribl's own UI spell it
  xml: 'XML',
  json: 'JSON',
  ocsf: 'OCSF',
  to: 'to',
  for: 'for',
  cdn: 'CDN',
  docs: 'docs',
  reduce: 'reduction',
  noise: 'noise filter',
  prod: 'prod',
};

/** Strips the demo/object prefixes `mrd_` and `mr_`. */
function stripPrefix(id: string): string {
  return id.replace(/^mrd?_/i, '');
}

/**
 * A route whose pipeline is a Pack carries `pack:<pack id>` (e.g. `pack:cribl-palo-alto-networks`). People know a
 * Pack by its Dispensary name, so the id reads as that name: the publisher prefix (`cribl-`, `cc-`) dropped, each
 * word title-cased unless the dictionary spells it (acronyms), then "pack" — 'Palo Alto Networks pack'.
 */
function packLabel(packId: string): string {
  const words = packId
    .replace(/^(?:cribl|cc)[-_]/i, '')
    .split(/[_\-\s]+/)
    .filter((t) => t.length > 0)
    .map((t) => HUMANIZE_DICTIONARY[t.toLowerCase()] ?? (t[0].toUpperCase() + t.slice(1)));
  return words.length > 0 ? `${words.join(' ')} pack` : packId;
}

/** Upper-cases the first character, leaving the rest (acronyms like 'API', 'SIEM') untouched. */
function capitalizeFirst(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/**
 * 'mrd_win_trim' → 'Windows trimming'; 'k8s_noise' → 'Kubernetes noise filter'.
 * `overrides` (settings.humanize) win, keyed by the raw id or by the id without its prefix.
 */
export function humanize(id: string, overrides?: Record<string, string>): string {
  if (typeof id !== 'string' || id.length === 0) return '';
  const stripped = stripPrefix(id);
  const override = overrides?.[id] ?? overrides?.[stripped];
  if (override !== undefined && override.trim() !== '') return override;
  const demo = DEMO_LABELS[id];
  if (demo !== undefined) return demo;
  const pack = /^pack:(.+)$/i.exec(id);
  if (pack) return packLabel(pack[1]);
  const tokens = (stripped || id)
    .split(/[_\-\s]+/)
    .filter((t) => t.length > 0)
    .map((t) => HUMANIZE_DICTIONARY[t.toLowerCase()] ?? t);
  if (tokens.length === 0) return id;
  return capitalizeFirst(tokens.join(' '));
}

/**
 * Humanizes the id inside an ObjectKey (`kind:group:id`), e.g.
 * 'pipe:default:mrd_pay_sample' → 'Payments API sampling'. Anything else is humanized as-is.
 */
/**
 * A route as people read it: the member's override, else the route's own name in Cribl (the inventory's `name`,
 * carried on the snapshot's flows as `routeName`), else its id humanized. core/sweep.ts names a route on an
 * incident the same way; "R VPC" is only ever the fallback.
 */
export function routeLabel(routeId: string, routeName: string | undefined, overrides?: Record<string, string>): string {
  const own = overrides?.[routeId];
  if (own !== undefined && own.trim() !== '') return own;
  const name = routeName?.trim();
  if (name) return humanize(name, overrides) || name;
  return humanize(routeId, overrides);
}

export function humanizeObjectKey(key: string, overrides?: Record<string, string>): string {
  const m = /^(?:in|route|pipe|out):[^:]*:(.+)$/.exec(key);
  return humanize(m ? m[1] : key, overrides);
}

/**
 * A commit author as people should read it (NOTIFY-3a issue 8). Commits made with an API credential carry the
 * OAuth client id as the author (`Zx9Q…gE@clients`): an opaque id that means nothing to a reader and need not
 * travel to Slack whole. Those read 'API client ··gE6x', the id's last four characters, so two automations (a GitOps
 * pipeline and a CI job, rules round 2) read apart without printing the id; a short id reads 'API client'. Anything
 * else is returned trimmed; empty reads 'unknown'.
 */
export function displayAuthor(author: string | undefined | null): string {
  const a = typeof author === 'string' ? author.trim() : '';
  if (a === '') return 'unknown';
  const client = /^([^@\s]+)@clients$/i.exec(a);
  if (client) {
    const id = client[1].replace(/[^A-Za-z0-9]/g, '');
    return id.length >= 12 ? `API client ··${id.slice(-4)}` : 'API client';
  }
  return a;
}
