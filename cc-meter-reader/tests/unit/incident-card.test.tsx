// @vitest-environment jsdom
// <IncidentCard> compact + full: callouts, cause, delivery, recovery, mute chip, Slack expansion, and the
// store fallback for endpoint names / timezone / demo mutes.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../core/settings.ts';
import type { DemoState, Incident, NotificationEndpoint } from '../../core/types.ts';
import { IncidentCard } from '../../src/components/IncidentCard/IncidentCard.tsx';
import { renderTemplate } from '../../src/components/IncidentCard/context.tsx';
import { StoreProvider } from '../../src/state/providers.tsx';
import { appLinkBase } from '../../src/lib/links.ts';
import { linkBaseFrom } from '../../core/runtime.ts';
import { createAppStore } from '../../src/state/store.ts';

const T = Date.parse('2026-09-30T16:42:03.000Z');
const iso = (deltaSec: number) => new Date(T + deltaSec * 1000).toISOString();

const SLACK: NotificationEndpoint = {
  id: 'ep_slack',
  name: 'Slack',
  url: 'https://hooks.slack.com/services/x',
  host: 'hooks.slack.com',
  format: 'slack',
  minSeverity: 'medium',
  weeklyReceipt: true,
  enabled: true,
};

function inc(over: Partial<Incident> = {}): Incident {
  return {
    id: 'inc_7f3a01',
    type: 'regression',
    severity: 'high',
    objectKey: 'pipe:default:mrd_pay_sample',
    label: 'Payments API sampling',
    outputId: 'mrd_siem_prod',
    openedAt: iso(0),
    cause: 'commit',
    commit: {
      hash: 'a1f3c9e5b2',
      message: 'demo: break the trim on mrd_pay_sample',
      author: 's.koelpin',
      committedAt: iso(-180),
      deployedAt: iso(-171),
      groupId: 'default',
      match: 'message',
    },
    before: 0.75,
    after: 0.5,
    impactPerDayM: 2_500_000,
    caughtInSec: 171,
    notes: ['demo-profile'],
    deliveries: [{ endpointId: 'ep_slack', status: 200, at: iso(2) }],
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('<IncidentCard variant="full">', () => {
  it('shows the SPEC 17 lines with their callouts', () => {
    const { container } = render(<IncidentCard incident={inc()} endpoints={[SLACK]} tz="UTC" nowMs={T + 9_000} />);
    expect(
      screen.getByRole('heading', {
        name: 'Savings dropped: Payments API sampling',
      }),
    ).toBeTruthy();
    expect(container.querySelector('[data-callout="per-day"]')?.textContent).toBe('$25 a day · $9,125 a year if left');
    expect(container.querySelector('[data-callout="commit"]')?.textContent).toBe(
      'a1f3c9e "demo: break the trim on mrd_pay_sample" · s.koelpin',
    );
    expect(container.querySelector('[data-callout="author"]')?.textContent).toBe('s.koelpin');
    expect(screen.getByText('Ratio fell from 75% to 50% at 4:42 PM')).toBeTruthy();
    expect(screen.getByText('change naming this pipeline')).toBeTruthy();
    expect(screen.getByText('deployed 4:39 PM')).toBeTruthy();
    expect(container.querySelector('.mr-inc-caught')?.textContent).toBe('Caught in 2:51');
    expect(container.querySelector('.mr-inc-caught')?.getAttribute('data-live')).toBeNull();
    expect(screen.getByText('Sent to Slack ✓ 4:42 PM')).toBeTruthy();
    expect(screen.getByText('1-minute confirmation (demo profile). Default is 3.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View in Ledger' }).getAttribute('href')).toBe('/ledger?object=pipe:default:mrd_pay_sample');
    expect(container.querySelector('article')?.getAttribute('data-tone')).toBe('high');
  });

  it('expands to the Slack message it sent', () => {
    const { container } = render(<IncidentCard incident={inc()} endpoints={[SLACK]} tz="UTC" nowMs={T} />);
    expect(container.querySelector('.mr-slack')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show the Slack message' }));
    expect(container.querySelector('.mr-slack-header')?.textContent).toBe('Savings dropped: Payments API sampling');
    expect(screen.getByRole('button', { name: 'Hide the Slack message' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('offers no Slack expansion when nothing went to Slack, unless asked', () => {
    const generic = {
      ...SLACK,
      id: 'ep_hook',
      format: 'generic' as const,
      name: 'Ops webhook',
    };
    const i = inc({
      deliveries: [{ endpointId: 'ep_hook', status: 200, at: iso(2) }],
    });
    render(<IncidentCard incident={i} endpoints={[generic]} tz="UTC" nowMs={T} />);
    expect(screen.queryByRole('button', { name: 'Show the Slack message' })).toBeNull();
    expect(screen.getByText('Sent to Ops webhook ✓ 4:42 PM')).toBeTruthy();
    cleanup();
    render(<IncidentCard incident={i} endpoints={[generic]} tz="UTC" nowMs={T} slackPreview="always" showLedgerLink={false} />);
    expect(screen.getByRole('button', { name: 'Show the Slack message' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'View in Ledger' })).toBeNull();
  });

  it('is live and says "Retrying" while the delivery fails; says so when no change is found', () => {
    const i = inc({
      cause: 'unknown',
      commit: undefined,
      caughtInSec: 120,
      deliveries: [{ endpointId: 'ep_slack', status: 503, at: iso(2) }],
    });
    const { container } = render(<IncidentCard incident={i} endpoints={[SLACK]} tz="UTC" nowMs={T + 30_000} />);
    expect(screen.getByText('No configuration change found nearby')).toBeTruthy();
    expect(screen.getByText('Delivery failed (503). Retrying.')).toBeTruthy();
    expect(container.querySelector('.mr-inc-caught')?.getAttribute('data-live')).toBe('true');
    // r2 ui-11 (R2 #14): the measured catch (caughtInSec 120), not a clock counting on while the retry is owed.
    expect(container.querySelector('.mr-inc-caught')?.textContent).toBe('Caught in 2:00');
    expect(container.querySelector('[data-callout="commit"]')).toBeNull();
  });

  it('shows the nearby caveat, a recovery, and a spike in dollars an hour', () => {
    render(
      <IncidentCard
        incident={inc({
          commit: { ...inc().commit!, match: 'nearby', deployedAt: iso(-300) },
        })}
        tz="UTC"
        nowMs={T}
      />,
    );
    expect(screen.getByText('nearby change')).toBeTruthy();
    expect(screen.getByText('A change was deployed 5 min earlier; it may not be the cause.')).toBeTruthy();
    cleanup();
    // D47: the closed card keeps its drop and adds where it recovered to; the recovery line names the same reading.
    const { container: closedCard } = render(<IncidentCard incident={inc({ closedAt: iso(300), recoveredTo: 0.75 })} tz="UTC" nowMs={T} />);
    expect(screen.getByText('Recovered · savings back to 75% · closed itself.')).toBeTruthy();
    expect(screen.getByText('Recovered 4:47 PM')).toBeTruthy();
    expect(closedCard.querySelector('.mr-inc-ratio-row')?.textContent).toBe('75%→50%recovered to 75%');
    expect(closedCard.querySelector('.mr-inc-recovered-to')?.textContent).toBe('recovered to 75%');
    expect(screen.getByText('Ratio fell from 75% to 50% at 4:42 PM')).toBeTruthy();
    cleanup();
    // Closed before D47: `after` held the reading at close — the recovery alone, no arrow, and the sentence names the close.
    const { container: legacyCard } = render(<IncidentCard incident={inc({ closedAt: iso(300), after: 0.75 })} tz="UTC" nowMs={T} />);
    expect(screen.getByText('Recovered · savings back to 75% · closed itself.')).toBeTruthy();
    expect(legacyCard.querySelector('.mr-inc-ratio-row')?.textContent).toBe('Recovered to 75%');
    expect(legacyCard.querySelector('.mr-inc-arrow')).toBeNull();
    expect(legacyCard.querySelector('.mr-inc-recovered-to--only')).not.toBeNull();
    expect(screen.getByText('Recovered to 75% at 4:47 PM')).toBeTruthy();
    cleanup();
    render(
      <IncidentCard
        incident={inc({
          type: 'spike',
          before: 41_200_000,
          after: 190_400_000,
        })}
        tz="UTC"
        nowMs={T}
      />,
    );
    expect(screen.getByText('Cost rose from $412 to $1,904 an hour at 4:42 PM')).toBeTruthy();
    expect(screen.getByText('/ hour')).toBeTruthy();
    cleanup();
    // The recovered-to figure spaces its unit like every other figure ("$119 / hour"), never "$119/ hour".
    const { container: recoveredSpike } = render(
      <IncidentCard incident={inc({ type: 'spike', before: 41_200_000, after: 190_400_000, closedAt: iso(300), recoveredTo: 11_900_000 })} tz="UTC" nowMs={T} />,
    );
    expect(recoveredSpike.querySelector('.mr-inc-recovered-to')?.textContent).toBe('recovered to $119 / hour');
  });
});

describe('<IncidentCard> closes that are not recoveries (founder-build r1 ui-6)', () => {
  it('a below-floor close is neutral and says so (M9)', () => {
    const { container } = render(
      <IncidentCard incident={inc({ before: 0.75, after: 0.25, closedAt: iso(300), notes: ['demo-profile', 'below-floor'] })} tz="UTC" nowMs={T} />,
    );
    expect(container.querySelector('.mr-inc')?.getAttribute('data-tone')).toBe('info');
    expect(screen.getByText('Closed · the drop fell under the alert floor · savings still at 25%.')).toBeTruthy();
    expect(screen.getByText('Closed 4:47 PM')).toBeTruthy();
    expect(container.textContent).not.toMatch(/Recovered/);
  });

  it('a closed good-news card never prints recovery copy (PACK_PAYOFF F1)', () => {
    const { container } = render(
      <IncidentCard incident={inc({ type: 'goodnews', severity: 'info', before: 0, after: 0.34, closedAt: iso(300) })} tz="UTC" nowMs={T} />,
    );
    expect(screen.getByText('Improvement held · savings at 34%.')).toBeTruthy();
    expect(screen.getByText('Closed 4:47 PM')).toBeTruthy();
    expect(container.textContent).not.toMatch(/Recovered|back to/);
  });

  it('an accepted regression keeps its day and its year (m15)', () => {
    const { container } = render(
      <IncidentCard incident={inc({ closedAt: iso(252), closedReason: 'accepted', closedBy: 'Steve Koelpin' })} tz="UTC" nowMs={T} />,
    );
    expect(container.textContent).toContain('a year if left');
    expect(container.textContent).not.toMatch(/while it lasted/);
  });

  it('the Slack preview links where the delivered message links (C2: linkBaseFrom, never the page origin)', () => {
    const w = window as unknown as { CRIBL_API_URL?: string; CRIBL_BASE_PATH?: string };
    const saved = { api: w.CRIBL_API_URL, base: w.CRIBL_BASE_PATH };
    w.CRIBL_API_URL = 'https://main-org.cribl.cloud/api/v1';
    w.CRIBL_BASE_PATH = '/app-ui/meter-reader';
    try {
      // The card's Slack preview is built on appLinkBase(): the sweep's own base (core/runtime.ts linkBaseFrom), so it
      // follows C2 (core-8 makes it /apps/a/meter-reader) and never the iframe's origin (jsdom: http://localhost).
      expect(appLinkBase()).toBe(linkBaseFrom('https://main-org.cribl.cloud/api/v1', '/app-ui/meter-reader'));
      expect(appLinkBase().startsWith('https://main-org.cribl.cloud/')).toBe(true);
      expect(appLinkBase()).not.toContain(window.location.origin);
      const { container } = render(<IncidentCard incident={inc()} tz="UTC" nowMs={T} slackPreview="always" />);
      fireEvent.click(screen.getByRole('button', { name: 'Show the Slack message' }));
      expect(container.querySelector('.mr-slack-actions')).not.toBeNull();
    } finally {
      w.CRIBL_API_URL = saved.api;
      w.CRIBL_BASE_PATH = saved.base;
    }
  });
});

describe('<IncidentCard variant="compact">', () => {
  it('fits the incident into four lines with the same callouts', () => {
    const { container } = render(<IncidentCard incident={inc()} variant="compact" endpoints={[SLACK]} tz="UTC" nowMs={T} />);
    expect(container.querySelector('.mr-inc-line')?.textContent).toBe('75% →  to 50%·$25 a day · $9,125 a year if left');
    expect(container.querySelector('[data-callout="commit"]')?.textContent).toBe('a1f3c9e');
    expect(container.querySelector('[data-callout="author"]')?.textContent).toBe('s.koelpin');
    expect(screen.getByText('change naming this pipeline')).toBeTruthy();
    expect(screen.getByText('Sent to Slack ✓ 4:42 PM')).toBeTruthy();
    expect(screen.getByText('4:42 PM', { selector: '.mr-inc-when' })).toBeTruthy();
  });

  it('shows the mute chip, a blocked host, and a recovery', () => {
    render(
      <IncidentCard
        incident={inc({
          deliveries: [
            {
              endpointId: 'ep_slack',
              status: 403,
              at: iso(2),
              error: 'host_not_authorized',
            },
          ],
        })}
        variant="compact"
        endpoints={[SLACK]}
        mutedUntil={iso(6 * 60)}
        nowMs={T}
      />,
    );
    expect(screen.getByText('muted after a demo change · 6 min')).toBeTruthy();
    expect(screen.getByText('Delivery blocked: host not authorized.')).toBeTruthy();
    cleanup();
    const { container: compactClosed } = render(<IncidentCard incident={inc({ closedAt: iso(60), recoveredTo: 0.74 })} variant="compact" nowMs={T} />);
    expect(screen.getByText('Recovered · savings back to 74% · closed itself.')).toBeTruthy();
    // D47: the drop it kept, then where it recovered to, then the money.
    expect(compactClosed.querySelector('.mr-inc-line')?.textContent).toBe('75% →  to 50%·recovered to 74%·$25 a day above normal while it lasted · 1\u00a0min');
    cleanup();
    // Closed before D47: the recovery alone, no arrow to a low it never kept.
    const { container: compactLegacy } = render(<IncidentCard incident={inc({ closedAt: iso(60), after: 0.74 })} variant="compact" nowMs={T} />);
    expect(compactLegacy.querySelector('.mr-inc-line')?.textContent).toBe('Recovered to 74%·$25 a day above normal while it lasted · 1\u00a0min');
    expect(compactLegacy.querySelector('.mr-inc-arrow-inline')).toBeNull();
    expect(screen.getByText('Recovered · savings back to 74% · closed itself.')).toBeTruthy();
  });
});

describe('store fallback', () => {
  it('reads endpoint names, the display timezone and demo mutes from the store when not passed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    const settings = {
      ...defaultSettings(iso(0), 'America/Chicago'),
      notifications: [{ ...SLACK, name: 'Slack #finops' }],
    };
    // A stored zone (the member saved Chicago). r3 ui-1: a settings-less workspace reads snapshot.zone (below).
    const store = createAppStore(settings, { settingsStored: true });
    const demoState = {
      muted: { 'pipe:default:mrd_pay_sample': iso(3 * 60) },
    } as unknown as DemoState;
    act(() => store.setState({ demoState }));
    render(
      <StoreProvider store={store}>
        <IncidentCard incident={inc()} variant="compact" />
      </StoreProvider>,
    );
    expect(screen.getByText('Sent to Slack #finops ✓ 11:42 AM')).toBeTruthy();
    expect(screen.getByText('muted after a demo change · 3 min')).toBeTruthy();
  });

  it('r3 ui-1: a settings-less live workspace times its alerts in the zone it was metered in (snapshot.zone)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    // The boot defaults carry the browser's zone (Los Angeles); the workspace was metered in New York.
    const settings = { ...defaultSettings(iso(0), 'America/Los_Angeles'), notifications: [{ ...SLACK, name: 'Slack #finops' }] };
    const store = createAppStore(settings, { snapshot: { zone: 'America/New_York' } as never });
    render(
      <StoreProvider store={store}>
        <IncidentCard incident={inc()} variant="compact" />
      </StoreProvider>,
    );
    expect(screen.getByText('Sent to Slack #finops ✓ 12:42 PM')).toBeTruthy();
  });
});

describe('renderTemplate', () => {
  it('puts nodes into placeholders and leaves unknown ones visible', () => {
    const { container } = render(<p>{renderTemplate('{a} and {b} and {c}', { a: <b>x</b>, b: 'y' })}</p>);
    expect(container.textContent).toBe('x and y and {c}');
    expect(container.querySelector('b')?.textContent).toBe('x');
  });
});

describe('one card rule (BEAUTY F8)', () => {
  it('puts the severity in a full-bleed header band, not a stripe; nested compact cards are flat', () => {
    const { container, rerender } = render(<IncidentCard incident={inc()} endpoints={[SLACK]} tz="UTC" />);
    const full = container.querySelector('.mr-inc')!;
    const head = full.querySelector(':scope > .mr-inc-head')!;
    // The band is the card's first child and holds the glyph and the title; the body follows it.
    expect(full.firstElementChild).toBe(head);
    expect(head.querySelector('[aria-label="High severity"]')).not.toBeNull();
    expect(head.querySelector('.mr-inc-title')!.textContent).toBe('Savings dropped: Payments API sampling');
    expect(full.querySelector(':scope > .mr-inc-body')).not.toBeNull();
    expect(full.className).toContain('mr-inc--full');
    rerender(<IncidentCard incident={inc()} variant="compact" endpoints={[SLACK]} tz="UTC" />);
    const compact = container.querySelector('.mr-inc')!;
    expect(compact.firstElementChild!.className).toBe('mr-inc-head');
    expect(compact.querySelector(':scope > .mr-inc-body')).not.toBeNull();
  });

  it('the compact status line names the landed webhook before the bell (NOTIFY-3a issue 1)', () => {
    render(
      <IncidentCard
        incident={inc({
          deliveries: [
            { endpointId: 'ep_slack', status: 200, at: iso(2) },
            { endpointId: 'cribl-bell', status: 200, at: iso(3) },
          ],
        })}
        variant="compact"
        endpoints={[SLACK]}
        tz="UTC"
      />,
    );
    expect(screen.getByText('Sent to Slack ✓ 4:42 PM')).toBeTruthy();
    expect(screen.queryByText(/Cribl notifications/)).toBeNull();
    cleanup();
    render(
      <IncidentCard incident={inc({ deliveries: [{ endpointId: 'cribl-bell', status: 200, at: iso(3) }] })} endpoints={[]} tz="UTC" />,
    );
    expect(screen.getByText('Sent to Cribl notifications ✓ 4:42 PM')).toBeTruthy();
  });
});
