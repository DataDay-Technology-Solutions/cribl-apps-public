// @vitest-environment jsdom
// r2 ui-13 (FINDINGS_EXTRA IC-7): a priced workspace with no traffic read "Nothing metered this week yet." beside a hero
// that said "1,440 … minutes metered". The week card now says "No traffic this week yet."; a week whose traffic saved
// nothing says "Nothing saved this week yet."

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings } from '../../core/settings.ts';
import { AppProviders } from '../../src/state/providers.tsx';
import type { AppServices } from '../../src/state/services.ts';
import { createAppStore } from '../../src/state/store.ts';
import { WeekCard } from '../../src/views/Receipt/Sections.tsx';

afterEach(() => cleanup());

function renderWeek(savedM: number, whpM: number | undefined) {
  const store = createAppStore(defaultSettings('2026-09-28T00:00:00.000Z', 'America/Chicago'));
  const services = { store, actions: {} } as unknown as AppServices;
  render(
    <AppProviders services={services}>
      <MemoryRouter>
        <WeekCard data={{ status: 'ready', span: 'Sep 28', savedM, ...(whpM !== undefined ? { whpM } : {}), lines: [], sample: false }} tz="America/Chicago" />
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('r2 ui-13 (IC-7): the week card\'s empty line', () => {
  it('no traffic: "No traffic this week yet."', () => {
    renderWeek(0, 0);
    expect(screen.getByTestId('week-empty').textContent).toBe('No traffic this week yet.');
    expect(document.body.textContent).not.toContain('Nothing metered');
  });
  it('no figure for the week at all: the same words', () => {
    renderWeek(0, undefined);
    expect(screen.getByTestId('week-empty').textContent).toBe('No traffic this week yet.');
  });
  it('traffic that saved nothing: "Nothing saved this week yet."', () => {
    renderWeek(0, 12_345_000);
    expect(screen.getByTestId('week-empty').textContent).toBe('Nothing saved this week yet.');
  });
});
