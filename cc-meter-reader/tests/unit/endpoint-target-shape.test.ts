// Rule 4.5 (DECISIONS D57), the editor's layer: a webhook URL typed into "Target id" (or used as an endpoint's name)
// never reaches App KV from Settings → Where to send alerts. applyEndpoints flags it whatever core validation says,
// and the Save handler writes nothing while any error stands (NotificationsSection onSave).

import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../../core/settings.ts';
import type { Settings } from '../../core/types.ts';
import { applyEndpoints, isTargetIdShaped, looksLikeUrl, newEndpointDraft } from '../../src/components/EndpointEditor/model.ts';
import { t } from '../../src/copy/en.ts';

const DEFAULTS: Settings = defaultSettings('2026-09-27T12:00:00.000Z', 'UTC');
// Shaped like a Slack incoming webhook; the token is fake.
const SLACK_LIKE = 'https://hooks.slack.com/services/mock-team/mock-hook/not-a-real-secret';

describe('target id shape', () => {
  it('accepts Cribl ids: letters, digits, _ and -', () => {
    for (const id of ['mrd_slack_finops', 'ops-slack', 'system_notifications', 'A1', ' padded_id ']) expect(isTargetIdShaped(id)).toBe(true);
  });

  it('refuses URLs, paths, spaces, dots and anything over 512 characters', () => {
    for (const id of [SLACK_LIKE, 'hooks.slack.com/services/mock-team/mock-hook/x', 'user:pass@host', 'two words', 'a.b', '', 'x'.repeat(513)]) expect(isTargetIdShaped(id)).toBe(false);
  });
});

describe('web address in a name', () => {
  it('flags schemes and host/path shapes', () => {
    for (const s of [SLACK_LIKE, 'see hooks.slack.com/services/mock-team/mock-hook/x', 'ftp://x', 'example.com:8443/hook']) expect(looksLikeUrl(s)).toBe(true);
  });

  it('leaves ordinary names alone', () => {
    for (const s of ['Ops Slack', 'FinOps alerts', 'SRE / on-call', 'PagerDuty (EU)', 'v2 team', 'Slack #finops']) expect(looksLikeUrl(s)).toBe(false);
  });
});

describe('applyEndpoints refuses a URL before anything is stored', () => {
  it('a webhook URL in Target id is an error on that field, with the id-shape message', () => {
    const { errors } = applyEndpoints(DEFAULTS, [{ ...newEndpointDraft('a'), name: 'Ops', criblTargetId: SLACK_LIKE }]);
    expect(errors[0]?.criblTargetId).toBe(t('settings.notify.channels.target.idShape'));
    expect(errors[0]?.name).toBeUndefined();
  });

  it('a web address as the name is an error on the name', () => {
    const { errors } = applyEndpoints(DEFAULTS, [{ ...newEndpointDraft('a'), name: SLACK_LIKE, criblTargetId: 'ops_slack' }]);
    expect(errors[0]?.name).toBe(t('settings.notify.nameNoUrl'));
    expect(errors[0]?.criblTargetId).toBeUndefined();
  });

  it('a well-formed target endpoint has no error', () => {
    const { errors } = applyEndpoints(DEFAULTS, [{ ...newEndpointDraft('a'), name: 'Ops Slack', criblTargetId: 'mrd_slack_finops' }]);
    expect(errors).toEqual({});
  });

  it('the messages say no URL is stored and never leak the typed value', () => {
    for (const m of [t('settings.notify.channels.target.idShape'), t('settings.notify.nameNoUrl')]) {
      expect(m).toMatch(/stores no URL/);
      expect(m).not.toContain('hooks.slack.com');
    }
  });
});
