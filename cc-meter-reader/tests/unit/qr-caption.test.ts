// The presenter QR's default and its caption (OQ-04, D51, D58): the default is the App's home, the submission
// repository Cribl-Community/cc-meter-reader, and the caption says where the code goes; the Story's ask frame sends
// its code where its words do.

import { describe, expect, it } from 'vitest';
import { CIN_GROUP_URL, DEFAULT_QR_URL, askQrUrl, qrDestination, hostFromUrl } from '../../core/settings.ts';
import { presenterQrCaption } from '../../src/views/Presenter/qrCaption.ts';

describe('presenter QR (OQ-04, D51)', () => {
  it('defaults to the submission repository, Cribl-Community/cc-meter-reader (rules 3.2, 3.3; D58)', () => {
    expect(DEFAULT_QR_URL).toBe('https://github.com/Cribl-Community/cc-meter-reader');
    expect(hostFromUrl(DEFAULT_QR_URL)).toBe('github.com');
  });

  it("the Story's ask frame: the group its words name, unless a member set another link (D58)", () => {
    expect(askQrUrl(undefined)).toBe(CIN_GROUP_URL);
    expect(askQrUrl('')).toBe(CIN_GROUP_URL);
    expect(askQrUrl(DEFAULT_QR_URL)).toBe(CIN_GROUP_URL);
    expect(askQrUrl('https://github.com/DataDay-Technology-Solutions/cribl-apps-public/tree/main/cc-meter-reader')).toBe(CIN_GROUP_URL);
    expect(askQrUrl(CIN_GROUP_URL)).toBe(CIN_GROUP_URL);
    expect(askQrUrl(' https://www.example.com/x ')).toBe('https://www.example.com/x');
  });

  it('knows where a code goes: the Cribl Innovators Network, a Meter Reader repository, or another link', () => {
    expect(qrDestination(CIN_GROUP_URL).kind).toBe('group');
    expect(qrDestination('https://linkedin.com/groups/13052739/').kind).toBe('group');
    expect(qrDestination('https://www.linkedin.com/groups/999').kind).toBe('link');
    expect(qrDestination(DEFAULT_QR_URL).kind).toBe('repo');
    expect(qrDestination('').kind).toBe('repo'); // blank is the default
    expect(qrDestination(undefined).kind).toBe('repo');
    expect(qrDestination('https://github.com/someone/else')).toEqual({ kind: 'link', host: 'github.com' });
    expect(qrDestination('https://www.example.com/meter')).toEqual({ kind: 'link', host: 'example.com' });
  });

  it('captions the code with where it goes, and asks for nothing the code does not lead to', () => {
    expect(presenterQrCaption(DEFAULT_QR_URL)).toBe('Meter Reader · get the App on GitHub');
    expect(presenterQrCaption(CIN_GROUP_URL)).toBe('Meter Reader · join the Cribl Innovators Network');
    expect(presenterQrCaption('https://www.example.com/x')).toBe('Meter Reader · example.com');
    for (const url of [DEFAULT_QR_URL, CIN_GROUP_URL]) expect(presenterQrCaption(url)).not.toMatch(/vote|CriblCon/);
  });
});
