// A notification target's 2xx is Cribl accepting the alert, not the target receiving it (craft review, round 1): the
// incident card says "Handed to Cribl for …"; the bell and a runner's direct webhook keep "Sent to …".

import { describe, expect, it } from 'vitest';
import type { DeliveryRef, NotificationEndpoint } from '../../core/types.ts';
import { deliveryLine } from '../../src/components/IncidentCard/model.ts';

const at = '2026-09-27T16:42:00.000Z';
const ok = (endpointId: string): DeliveryRef => ({ endpointId, status: 200, at }) as DeliveryRef;
const endpoint = (id: string, name: string, channel?: NotificationEndpoint['channel']): NotificationEndpoint =>
  ({ id, name, url: '', host: '', format: 'generic', minSeverity: 'medium', weeklyReceipt: true, enabled: true, ...(channel ? { channel } : {}) }) as NotificationEndpoint;

describe('deliveryLine wording by channel', () => {
  const endpoints = [endpoint('t1', 'FinOps alerts', 'cribl-target'), endpoint('w1', 'Ops webhook')];

  it('a notification target reads "Handed to Cribl for"', () => {
    expect(deliveryLine(ok('t1'), { endpoints, tz: 'UTC' }).text).toBe('Handed to Cribl for FinOps alerts ✓ 4:42 PM');
  });

  it('a direct webhook keeps "Sent to"', () => {
    expect(deliveryLine(ok('w1'), { endpoints, tz: 'UTC' }).text).toBe('Sent to Ops webhook ✓ 4:42 PM');
  });
});
