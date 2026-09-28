// @vitest-environment jsdom
// Settings → Where to send alerts and Alerts, the WP-G2 models (EPIC_AUDIT P0-10, P1-G05, P1-G07, P1-G09):
// the channel a new endpoint starts on, which endpoint errors show before a Save attempt, the "Last test"
// caption, the weekly run when only the default bell took the receipt, the four new Alerts fields, the
// objects "Leave out" offers, and the save bar's failure line.

import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings } from '../../core/settings.ts';
import type { FlowFigures, NotificationEndpoint, Settings } from '../../core/types.ts';
import {
  applyEndpoints,
  countEndpointErrors,
  draftFromEndpoint,
  lastTestCaption,
  newEndpointDraft,
  visibleEndpointErrors,
} from '../../src/components/EndpointEditor/model.ts';
import { alertsDirtyFields, alertsDraftFrom, applyAlerts, excludableLabel, excludableObjects } from '../../src/views/Settings/model.ts';
import { weeklyView } from '../../src/views/Settings/weekly.ts';
import { onWriteOutcome, reportWrite, saveFailureLine } from '../../src/views/Settings/hooks.ts';

const NOW_ISO = '2026-09-26T12:00:00.000Z';
const DEFAULTS: Settings = defaultSettings(NOW_ISO, 'UTC');

describe('P0-10 / D57: a new endpoint is always a Cribl notification target', () => {
  it('starts as a target with no id, medium severity, weekly receipt on, and stores no URL', () => {
    expect(newEndpointDraft('a')).toMatchObject({ channel: 'cribl-target', criblTargetId: '', saved: false, weeklyReceipt: true });
    const next = applyEndpoints(DEFAULTS, [{ ...newEndpointDraft('a'), name: 'Ops', criblTargetId: 'ops_slack' }]).next;
    expect(next.notifications).toEqual([
      expect.objectContaining({ id: 'a', channel: 'cribl-target', criblTargetId: 'ops_slack', url: '', host: '', weeklyReceipt: true }),
    ]);
  });
});

describe('P1-G05: endpoint errors wait for a left field or a Save attempt', () => {
  const fresh = [newEndpointDraft('n1')];
  const { errors } = applyEndpoints(DEFAULTS, fresh);

  it('a fresh endpoint has errors, none of them on show', () => {
    expect(countEndpointErrors(errors)).toBe(2); // name + target id
    expect(visibleEndpointErrors(fresh, errors, {}, false)).toEqual({});
  });

  it('a left field shows its own error only; a Save attempt shows them all', () => {
    const shown = visibleEndpointErrors(fresh, errors, { n1: ['name'] }, false);
    expect(Object.keys(shown[0] ?? {})).toEqual(['name']);
    expect(countEndpointErrors(shown)).toBe(1);
    expect(countEndpointErrors(visibleEndpointErrors(fresh, errors, {}, true))).toBe(2);
  });

  it('ten fresh endpoints show nothing (never "Fix 16 fields")', () => {
    const ten = Array.from({ length: 10 }, (_, i) => newEndpointDraft(`n${i}`));
    const all = applyEndpoints(DEFAULTS, ten).errors;
    expect(countEndpointErrors(all)).toBe(20);
    expect(countEndpointErrors(visibleEndpointErrors(ten, all, {}, false))).toBe(0);
  });

  it('a saved endpoint keeps showing its errors as they appear', () => {
    const saved: NotificationEndpoint = { id: 's1', name: 'Ops', url: '', host: '', format: 'generic', minSeverity: 'medium', weeklyReceipt: true, enabled: true, channel: 'cribl-target', criblTargetId: 'ops_slack' };
    const cleared = { ...draftFromEndpoint(saved), name: '' };
    const e1 = applyEndpoints(DEFAULTS, [cleared]).errors;
    expect(visibleEndpointErrors([cleared], e1, {}, false)[0]?.name).toMatch(/name/);
    const noTarget = { ...draftFromEndpoint(saved), criblTargetId: '' };
    const e2 = applyEndpoints(DEFAULTS, [noTarget]).errors;
    expect(visibleEndpointErrors([noTarget], e2, {}, false)[0]?.criblTargetId).toMatch(/target/);
  });
});

describe('P1-G09: the last test reads as sent or failed, never a bare number', () => {
  it('names the outcome', () => {
    expect(lastTestCaption({ at: NOW_ISO, status: 200, hostAuthorized: true }, '2 min ago')).toBe('Last test sent (200) · 2 min ago');
    expect(lastTestCaption({ at: NOW_ISO, status: 208, hostAuthorized: true }, 'just now')).toBe('Last test sent (208) · just now');
    expect(lastTestCaption({ at: NOW_ISO, status: 403, hostAuthorized: false }, '1 h ago')).toBe('Last test failed (403) · 1 h ago');
    expect(lastTestCaption({ at: NOW_ISO, status: 0, hostAuthorized: true }, '5 min ago')).toBe('Last test failed (no response) · 5 min ago');
  });
});

describe('P1-G09: the weekly receipt counts the default bell', () => {
  const hook: NotificationEndpoint = { id: 'hook', name: 'Ops Slack', url: '', host: '', format: 'generic', minSeverity: 'medium', weeklyReceipt: true, enabled: true, channel: 'cribl-target', criblTargetId: 'ops_slack' };
  const log = (endpointId: string, status: number) => ({ endpointId, event: 'receipt.weekly' as const, status, attempt: 1, at: NOW_ISO, kind: 'notify' as const });

  it('only the bell, and this Leader has no bell for the App: the bell line, never "0 endpoints"', () => {
    const v = weeklyView({ sent: 0, endpoints: 0, calls: 2, deliveries: [] }, []);
    expect(v.tone).toBe('warn');
    expect(v.summary).toBe('Not sent: the Cribl bell is the only endpoint with Weekly receipt on, and it is not available to this App here.');
    expect(v.summary).not.toContain('0 endpoints');
    expect(v.lines).toEqual([
      { endpointId: 'cribl-bell', text: 'Cribl notifications: not delivered, the Cribl bell is not available to this App here', ok: false, skipped: true },
    ]);
  });

  it('the bell delivered reads as an endpoint like any other', () => {
    expect(weeklyView({ sent: 1, endpoints: 1, calls: 3, deliveries: [log('cribl-bell', 200)] }, [])).toMatchObject({
      tone: 'ok',
      summary: 'Sent to 1 endpoint.',
      lines: [{ text: 'Cribl notifications: sent (200)', ok: true }],
    });
  });

  it('beside an attempted endpoint the skip stays quiet (D27); a stored bell is never "skipped"', () => {
    expect(weeklyView({ sent: 1, endpoints: 1, calls: 3, deliveries: [log('hook', 200)] }, [hook]).lines).toEqual([
      { endpointId: 'hook', text: 'Ops Slack: sent (200)', ok: true },
    ]);
    const storedBell: NotificationEndpoint = { ...hook, id: 'cribl-bell', name: 'Cribl notifications', url: '', host: '', channel: 'cribl-bell', weeklyReceipt: false };
    // Nothing took the receipt: the line says which switch to turn on, never "none of the 0 endpoints".
    expect(weeklyView({ sent: 0, endpoints: 0, calls: 1, deliveries: [] }, [storedBell])).toEqual({
      tone: 'warn',
      summary: 'No enabled endpoint has Weekly receipt on. Turn it on for an endpoint above and save, then send.',
      lines: [],
    });
  });
});

describe('P1-G09: the four new Alerts fields', () => {
  it('reads the stored thresholds, the D26 floor defaulting to $5 a day', () => {
    const draft = alertsDraftFrom(DEFAULTS);
    expect(draft).toMatchObject({ regressionFloorPerDay: '5', recoveryMinutes: '5', warmupSamples: '10', excludedObjectKeys: [] });
    const noFloor: Settings = { ...DEFAULTS, thresholds: { ...DEFAULTS.thresholds } };
    delete noFloor.thresholds.regressionMinCentsPerDay;
    expect(alertsDraftFrom(noFloor).regressionFloorPerDay).toBe('5');
    expect(alertsDraftFrom({ ...DEFAULTS, thresholds: { ...DEFAULTS.thresholds, regressionMinCentsPerDay: 1250 } }).regressionFloorPerDay).toBe('12.50');
  });

  it('writes the floor in cents, recovery and warm-up as whole minutes, and the excluded objects', () => {
    const draft = alertsDraftFrom(DEFAULTS);
    const { next, errors } = applyAlerts(DEFAULTS, {
      ...draft,
      regressionFloorPerDay: '12.50',
      recoveryMinutes: '7',
      warmupSamples: '20',
      excludedObjectKeys: ['pipe:default:lab', 'in:default:test', 'pipe:default:lab'],
    });
    expect(errors).toEqual({});
    expect(next.thresholds).toMatchObject({ regressionMinCentsPerDay: 1250, recoveryMinutes: 7, warmupSamples: 20 });
    expect(next.excludedObjectKeys).toEqual(['pipe:default:lab', 'in:default:test']);
    // Nothing else moves.
    expect(next.thresholds.regressionPoints).toBe(DEFAULTS.thresholds.regressionPoints);
  });

  it('refuses a blank or junk floor, a fractional recovery and a zero warm-up', () => {
    const draft = alertsDraftFrom(DEFAULTS);
    expect(applyAlerts(DEFAULTS, { ...draft, regressionFloorPerDay: '' }).errors['thresholds.regressionMinCentsPerDay']).toMatch(/minimum regression per day/);
    expect(applyAlerts(DEFAULTS, { ...draft, regressionFloorPerDay: 'five' }).errors['thresholds.regressionMinCentsPerDay']).toBeDefined();
    expect(applyAlerts(DEFAULTS, { ...draft, recoveryMinutes: '1.5' }).errors['thresholds.recoveryMinutes']).toMatch(/whole number/);
    expect(applyAlerts(DEFAULTS, { ...draft, warmupSamples: '0' }).errors['thresholds.warmupSamples']).toMatch(/whole number of 1 or more/);
    expect(applyAlerts(DEFAULTS, { ...draft, regressionFloorPerDay: '0' }).next.thresholds.regressionMinCentsPerDay).toBe(0);
  });

  it('counts a field dirty by value: excluded objects compare by content', () => {
    const stored = alertsDraftFrom(DEFAULTS);
    expect(alertsDirtyFields({ ...stored, excludedObjectKeys: [] }, stored)).toEqual([]);
    expect(alertsDirtyFields({ ...stored, excludedObjectKeys: ['pipe:default:lab'], recoveryMinutes: '6' }, stored).sort()).toEqual(['excludedObjectKeys', 'recoveryMinutes']);
  });
});

describe('P1-G09: what "Leave out" offers', () => {
  const flow = (groupId: string, inputId: string, routeId: string, pipelineId: string, outputId: string) =>
    ({ key: `${groupId}|${inputId}|${routeId}|${pipelineId}|${outputId}`, groupId, inputId, routeId, pipelineId, outputId }) as FlowFigures;

  it('lists every object the flows touch, by kind then name, minus those already left out', () => {
    const flows = [flow('default', 'mrd_pay_api', 'r_pay', 'mrd_pay_sample', 'mrd_siem_apps'), flow('default', 'mrd_pay_api', 'r_pay', '-', 'devnull')];
    const all = excludableObjects(flows, []);
    expect(all.map((o) => o.kind)).toEqual(['in', 'route', 'pipe', 'out', 'out']);
    expect(all.find((o) => o.key === 'pipe:default:mrd_pay_sample')?.label).toBe('Pipeline · Payments API sampling');
    expect(all.some((o) => o.key.startsWith('pipe:default:-'))).toBe(false);
    const rest = excludableObjects(flows, ['pipe:default:mrd_pay_sample']);
    expect(rest.map((o) => o.key)).not.toContain('pipe:default:mrd_pay_sample');
    expect(excludableObjects(undefined, [])).toEqual([]);
  });

  it('names the group only when two groups share a name, and honours label overrides', () => {
    const flows = [flow('east', 'syslog', '-', '-', 'out1'), flow('west', 'syslog', '-', '-', 'out2')];
    const labels = excludableObjects(flows, []).filter((o) => o.kind === 'in').map((o) => o.label);
    expect(labels).toEqual(['Source · Syslog (east)', 'Source · Syslog (west)']);
    expect(excludableLabel('pipe:default:mrd_pay_sample', { mrd_pay_sample: 'Pay trim' })).toBe('Pipeline · Pay trim');
  });
});

describe('P1-G07: the save bar keeps a failed save', () => {
  const seen: (string | null)[] = [];
  const sections: (string | null)[] = [];
  const off = onWriteOutcome((line, section) => {
    seen.push(line);
    sections.push(section);
  });
  afterEach(() => {
    seen.length = 0;
    sections.length = 0;
  });

  it('reports the failure line, then null once a save goes through; background writes stay out of the bar', () => {
    expect(saveFailureLine({ ok: false, reason: 'error', error: { kind: 'forbidden', status: 403, message: 'Forbidden', at: 0 } })).toBe("Couldn't save (403). Try again.");
    expect(saveFailureLine({ ok: false, reason: 'not-hydrated' })).toBeNull();
    reportWrite({ ok: false, reason: 'error', error: { kind: 'server', status: 500, message: 'boom', at: 0 } });
    reportWrite({ ok: false, reason: 'error', error: { kind: 'forbidden', status: 403, message: 'Forbidden', at: 0 } }, { bar: false });
    reportWrite({ ok: true });
    expect(seen).toEqual(["Couldn't save (500). Try again.", null]);
    expect(sections).toEqual([null, null]);
    // The section that asked travels with the outcome, so the frame files it under that bar.
    reportWrite({ ok: false, reason: 'error', error: { kind: 'forbidden', status: 403, message: 'Forbidden', at: 0 } }, { section: 'alerts' });
    expect(sections.at(-1)).toBe('alerts');
    const heard = seen.length;
    off();
    reportWrite({ ok: true });
    expect(seen).toHaveLength(heard);
  });
});
