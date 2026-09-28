// core/codec.ts — byte/text codecs shared by the KV layer and the adapters.
//
// Pure TypeScript with zero runtime dependencies. Everything platform-specific (CompressionStream,
// btoa/atob, TextEncoder) is reached through `globalThis` behind small local types, so this module runs
// unchanged in the App iframe, in Node ≥ 18 (tests, scripts) and in the App backend runtime, and falls
// back to a pure implementation wherever a global is missing.

/** gzip/gunzip over strings. `encoding` labels what `gzip()` really produces so a KV manifest never lies. */
export interface Codec {
  /** 'gzip' (default when omitted) or 'identity' (UTF-8 bytes, no compression). */
  readonly encoding?: 'gzip' | 'identity';
  gzip(s: string): Promise<Uint8Array>;
  gunzip(b: Uint8Array): Promise<string>;
}

// ─── UTF-8 ───────────────────────────────────────────────────────────────────
const utf8Encoder = new TextEncoder();

function utf8Decode(bytes: Uint8Array): string {
  // `fatal` turns invalid UTF-8 (corrupt or mis-decoded data) into an exception instead of U+FFFD soup.
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** UTF-8 byte length of `s` without allocating. Always ≥ `s.length`, so it is the safe size to cap on. */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4; // surrogate pair → one 4-byte code point
        i++;
      } else bytes += 3; // lone high surrogate encodes as U+FFFD (3 bytes)
    } else bytes += 3;
  }
  return bytes;
}

// ─── Hashing + canonical JSON ────────────────────────────────────────────────
/** 32-bit FNV-1a over the UTF-8 bytes of `s`, as 8 lowercase hex digits. Integrity check, not crypto. */
export function fnv1a(s: string): string {
  const bytes = utf8Encoder.encode(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * JSON.stringify with object keys sorted at every level, so logically equal values always hash equally.
 * Mirrors JSON.stringify semantics: `undefined`, functions and symbols are dropped from objects and become
 * `null` inside arrays; non-finite numbers become `null`.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value);
    return s === undefined ? 'null' : s;
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => (isOmitted(v) ? 'null' : stableStringify(v))).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    if (isOmitted(v)) continue;
    parts.push(JSON.stringify(k) + ':' + stableStringify(v));
  }
  return '{' + parts.join(',') + '}';
}

function isOmitted(v: unknown): boolean {
  return v === undefined || typeof v === 'function' || typeof v === 'symbol';
}

// ─── Base64 (no Buffer) ──────────────────────────────────────────────────────
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP: Int16Array = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) t[B64_ALPHABET.charCodeAt(i)] = i;
  return t;
})();
/** Bytes per btoa() call. A multiple of 3, so each piece encodes without inner '=' padding. */
const ENCODE_CHUNK = 3 * 8192;
/** Characters per atob() call. A multiple of 4, so each piece decodes independently. */
const DECODE_CHUNK = 4 * 8192;

type BinaryFn = (s: string) => string;

function globalFn(name: 'btoa' | 'atob'): BinaryFn | undefined {
  const fn = (globalThis as unknown as Record<string, unknown>)[name];
  return typeof fn === 'function' ? (fn as BinaryFn) : undefined;
}

function binaryString(bytes: Uint8Array): string {
  // fromCharCode.apply over a typed array chunk ≤ 24 KiB stays far below engine argument limits.
  return String.fromCharCode.apply(null, bytes as unknown as number[]);
}

/** Standard base64 (RFC 4648, with padding) of `bytes`. Uses btoa in chunks when present, else pure TS. */
export function toBase64(bytes: Uint8Array): string {
  const btoaFn = globalFn('btoa');
  if (btoaFn) {
    const pieces: string[] = [];
    for (let i = 0; i < bytes.length; i += ENCODE_CHUNK) pieces.push(btoaFn(binaryString(bytes.subarray(i, i + ENCODE_CHUNK))));
    return pieces.join('');
  }
  return toBase64Pure(bytes);
}

function toBase64Pure(bytes: Uint8Array): string {
  const out: string[] = [];
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out.push(B64_ALPHABET[(n >> 18) & 63], B64_ALPHABET[(n >> 12) & 63], B64_ALPHABET[(n >> 6) & 63], B64_ALPHABET[n & 63]);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out.push(B64_ALPHABET[(n >> 18) & 63], B64_ALPHABET[(n >> 12) & 63], '==');
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out.push(B64_ALPHABET[(n >> 18) & 63], B64_ALPHABET[(n >> 12) & 63], B64_ALPHABET[(n >> 6) & 63], '=');
  }
  return out.join('');
}

/** Decodes standard base64 (ASCII whitespace ignored). Throws on anything that is not valid base64. */
export function fromBase64(input: string): Uint8Array {
  const s = input.replace(/[\t\n\f\r ]+/g, '');
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error('invalid base64 input');
  const padding = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - padding);
  const atobFn = globalFn('atob');
  if (!atobFn) return fromBase64Pure(s, out);
  let o = 0;
  for (let i = 0; i < s.length; i += DECODE_CHUNK) {
    const bin = atobFn(s.slice(i, i + DECODE_CHUNK));
    for (let j = 0; j < bin.length; j++) out[o++] = bin.charCodeAt(j);
  }
  return out;
}

function fromBase64Pure(s: string, out: Uint8Array): Uint8Array {
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const a = B64_LOOKUP[s.charCodeAt(i)];
    const b = B64_LOOKUP[s.charCodeAt(i + 1)];
    const c = s[i + 2] === '=' ? 0 : B64_LOOKUP[s.charCodeAt(i + 2)];
    const d = s[i + 3] === '=' ? 0 : B64_LOOKUP[s.charCodeAt(i + 3)];
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

// ─── Codecs ──────────────────────────────────────────────────────────────────
interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}
interface ByteWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
interface ByteTransform {
  readonly readable: { getReader(): ByteReader };
  readonly writable: { getWriter(): ByteWriter };
}
type ByteTransformCtor = new (format: 'gzip') => ByteTransform;

function streamCtor(name: 'CompressionStream' | 'DecompressionStream'): ByteTransformCtor | undefined {
  const ctor = (globalThis as unknown as Record<string, unknown>)[name];
  return typeof ctor === 'function' ? (ctor as ByteTransformCtor) : undefined;
}

/** True when the runtime has CompressionStream + DecompressionStream (browsers, Node ≥ 18). */
export function hasCompressionStreams(): boolean {
  return streamCtor('CompressionStream') !== undefined && streamCtor('DecompressionStream') !== undefined;
}

async function pump(stream: ByteTransform, input: Uint8Array): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  // Read concurrently with the write: awaiting the write first can deadlock on backpressure.
  const writing = (async () => {
    await writer.write(input);
    await writer.close();
  })();
  // Corrupt input rejects both sides; the reader surfaces the error, so keep this one handled.
  writing.catch(() => undefined);
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      parts.push(value);
      total += value.byteLength;
    }
  }
  await writing;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/** gzip via the web-standard CompressionStream. Rejects when the runtime lacks it (see `detectCodec`). */
export const webCodec: Codec = {
  encoding: 'gzip',
  async gzip(s: string): Promise<Uint8Array> {
    const Ctor = streamCtor('CompressionStream');
    if (!Ctor) throw new Error('CompressionStream is not available in this runtime');
    return pump(new Ctor('gzip'), utf8Encoder.encode(s));
  },
  async gunzip(b: Uint8Array): Promise<string> {
    const Ctor = streamCtor('DecompressionStream');
    if (!Ctor) throw new Error('DecompressionStream is not available in this runtime');
    return utf8Decode(await pump(new Ctor('gzip'), b));
  },
};

/** No compression: UTF-8 bytes in, UTF-8 bytes out. For tests and runtimes without CompressionStream. */
export const identityCodec: Codec = {
  encoding: 'identity',
  async gzip(s: string): Promise<Uint8Array> {
    return utf8Encoder.encode(s);
  },
  async gunzip(b: Uint8Array): Promise<string> {
    return utf8Decode(b);
  },
};

/** The best codec this runtime supports: gzip when CompressionStream exists, identity otherwise. */
export function detectCodec(): Codec {
  return hasCompressionStreams() ? webCodec : identityCodec;
}
