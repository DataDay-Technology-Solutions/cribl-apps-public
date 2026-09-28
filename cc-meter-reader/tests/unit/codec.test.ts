import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import {
  detectCodec,
  fnv1a,
  fromBase64,
  hasCompressionStreams,
  identityCodec,
  stableStringify,
  toBase64,
  utf8ByteLength,
  webCodec,
} from '../../core/codec.ts';

const nodeB64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

function randomBytes(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('utf8ByteLength', () => {
  it('matches TextEncoder for ASCII, 2-, 3- and 4-byte characters', () => {
    for (const s of ['', 'abc', 'é', '€', '💸', 'a€💸é', '{"k":"välue 💰"}']) {
      expect(utf8ByteLength(s)).toBe(new TextEncoder().encode(s).length);
    }
  });
  it('counts a lone surrogate as the 3-byte replacement character', () => {
    expect(utf8ByteLength('\ud800')).toBe(3);
    expect(utf8ByteLength('\ud800x')).toBe(4);
    expect(utf8ByteLength('\udc00')).toBe(3);
  });
  it('is never smaller than the UTF-16 length (property)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        expect(utf8ByteLength(s)).toBeGreaterThanOrEqual(s.length);
        expect(utf8ByteLength(s)).toBe(new TextEncoder().encode(s).length);
      }),
    );
  });
});

describe('fnv1a', () => {
  it('matches the published 32-bit FNV-1a vectors', () => {
    expect(fnv1a('')).toBe('811c9dc5');
    expect(fnv1a('a')).toBe('e40c292c');
    expect(fnv1a('foobar')).toBe('bf9cf968');
  });
  it('is 8 lowercase hex digits and hashes UTF-8 bytes', () => {
    expect(fnv1a('💸')).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a('é')).not.toBe(fnv1a('e'));
  });
});

describe('stableStringify', () => {
  it('sorts keys at every level and keeps array order', () => {
    expect(stableStringify({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}');
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });
  it('mirrors JSON.stringify for undefined, functions and non-finite numbers', () => {
    expect(stableStringify({ a: undefined, f: () => 1, s: Symbol('x'), n: Number.NaN })).toBe('{"n":null}');
    expect(stableStringify([undefined, () => 1, 1])).toBe('[null,null,1]');
    expect(stableStringify(undefined)).toBe('null');
    expect(stableStringify('x')).toBe('"x"');
  });
  it('agrees with JSON.stringify on key-sorted input (property)', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        expect(JSON.parse(stableStringify(v))).toEqual(JSON.parse(JSON.stringify(v) ?? 'null'));
      }),
    );
  });
});

describe('base64', () => {
  it('encodes like Buffer for every byte value and every tail length', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(toBase64(all)).toBe(nodeB64(all));
    for (let n = 0; n < 7; n++) expect(toBase64(all.subarray(0, n))).toBe(nodeB64(all.subarray(0, n)));
  });
  it('round-trips 1 MB (multiple btoa/atob chunks)', () => {
    const bytes = randomBytes(1_000_003);
    const b64 = toBase64(bytes);
    expect(b64).toBe(nodeB64(bytes));
    expect(fromBase64(b64)).toEqual(bytes);
  });
  it('uses the pure implementation when btoa/atob are missing', () => {
    vi.stubGlobal('btoa', undefined);
    vi.stubGlobal('atob', undefined);
    const bytes = randomBytes(70_001, 3);
    const b64 = toBase64(bytes);
    expect(b64).toBe(nodeB64(bytes));
    expect(fromBase64(b64)).toEqual(bytes);
    for (let n = 0; n < 5; n++) {
      const part = bytes.subarray(0, n);
      expect(toBase64(part)).toBe(nodeB64(part));
      expect(fromBase64(nodeB64(part))).toEqual(part);
    }
  });
  it('ignores ASCII whitespace and rejects invalid input', () => {
    expect(fromBase64('aGVs\nbG8=')).toEqual(new TextEncoder().encode('hello'));
    expect(() => fromBase64('abc')).toThrow(/invalid base64/);
    expect(() => fromBase64('ab$c')).toThrow(/invalid base64/);
    expect(() => fromBase64('a===')).toThrow(/invalid base64/);
  });
  it('round-trips arbitrary bytes (property)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 5000 }), (b) => {
        expect(fromBase64(toBase64(b))).toEqual(b);
        expect(toBase64(b)).toBe(nodeB64(b));
      }),
    );
  });
});

describe('codecs', () => {
  it('webCodec gzips (magic 1f 8b), compresses JSON well and round-trips unicode', async () => {
    const text = JSON.stringify({ flows: Array.from({ length: 2000 }, (_, i) => ({ key: `default|in_${i % 7}|r|p|o`, v: i })), note: 'välue 💸' });
    const gz = await webCodec.gzip(text);
    expect(gz[0]).toBe(0x1f);
    expect(gz[1]).toBe(0x8b);
    expect(gz.length).toBeLessThan(text.length / 3);
    expect(await webCodec.gunzip(gz)).toBe(text);
    expect(await webCodec.gunzip(await webCodec.gzip(''))).toBe('');
  });
  it('webCodec rejects corrupt and truncated gzip without an unhandled rejection', async () => {
    await expect(webCodec.gunzip(new TextEncoder().encode('not gzip at all'))).rejects.toThrow();
    const gz = await webCodec.gzip('x'.repeat(10_000));
    await expect(webCodec.gunzip(gz.subarray(0, gz.length - 12))).rejects.toThrow();
  });
  it('identityCodec is UTF-8 in, UTF-8 out and rejects invalid UTF-8', async () => {
    expect(identityCodec.encoding).toBe('identity');
    expect(await identityCodec.gunzip(await identityCodec.gzip('a€💸'))).toBe('a€💸');
    await expect(identityCodec.gunzip(Uint8Array.from([0xff, 0xfe]))).rejects.toThrow();
  });
  it('detectCodec picks gzip when CompressionStream exists, identity otherwise', async () => {
    expect(hasCompressionStreams()).toBe(true);
    expect(detectCodec()).toBe(webCodec);
    vi.stubGlobal('CompressionStream', undefined);
    expect(hasCompressionStreams()).toBe(false);
    expect(detectCodec()).toBe(identityCodec);
    await expect(webCodec.gzip('x')).rejects.toThrow(/CompressionStream is not available/);
    vi.unstubAllGlobals();
    vi.stubGlobal('DecompressionStream', undefined);
    await expect(webCodec.gunzip(new Uint8Array())).rejects.toThrow(/DecompressionStream is not available/);
  });
});
