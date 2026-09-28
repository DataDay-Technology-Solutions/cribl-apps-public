// @vitest-environment jsdom
// "Compare with…" in the range picker (P2-W13, src/views/Receipt/RangePicker.tsx): the select offers nothing, the
// previous period, the same window a week earlier and the recent commits; a choice previews both windows and the
// documents both reads take and applies with ?vs=; a commit fills the window with the 24 h after its deploy; a
// comparison that can't be made says why and Apply waits.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HOUR_MS, formatLocalDateTimeInput } from '../../core/time.ts';
import { RangeControl, type RangeControlProps } from '../../src/views/Receipt/RangePicker.tsx';

const NOW = Date.parse('2026-09-26T17:34:56.000Z');
const SINCE = NOW - 40 * 24 * HOUR_MS;
const DEPLOY = Date.parse('2026-09-25T11:20:30.000Z');
const COMMITS = [{ hash: '805b12c0d9e1f2a3', message: 'demo: break the trim on mrd_pay_sample', atMs: DEPLOY }];

beforeAll(() => {
  window.matchMedia ??= ((query: string) =>
    ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) as unknown as MediaQueryList);
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => cleanup());

function setup(over: Partial<RangeControlProps> = {}) {
  const onApplyRange = vi.fn();
  render(<RangeControl period="mtd" onPeriod={vi.fn()} onApplyRange={onApplyRange} tz="UTC" nowMs={NOW} collectingSinceMs={SINCE} meteredThroughMs={NOW - 30_000} commits={COMMITS} {...over} />);
  return { onApplyRange };
}

async function openPicker(): Promise<HTMLElement> {
  const group = screen.getByRole('radiogroup', { name: 'Headline period', hidden: true });
  fireEvent.click(within(group).getByRole('radio', { name: 'Custom', hidden: true }));
  return screen.findByRole('dialog', { name: 'Custom range' });
}

/** react-aria keeps a native <select> behind the Capra SelectField; choosing through it is what a form fill does. */
function choose(dialog: HTMLElement, key: string): void {
  const select = dialog.querySelector('select') as HTMLSelectElement | null;
  if (!select) throw new Error('no hidden select');
  fireEvent.change(select, { target: { value: key } });
}

const apply = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'Apply' });

describe('Compare with… in the range picker', () => {
  it('offers nothing, the previous period, a week earlier and the recent commits', async () => {
    setup();
    const dialog = await openPicker();
    const options = [...(dialog.querySelector('select') as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toEqual(expect.arrayContaining(['none', 'prev', 'week', 'commit:805b12c0d9e1f2a3']));
  });

  it('the previous period previews both windows and the documents both reads take, and applies with it', async () => {
    const { onApplyRange } = setup();
    const dialog = await openPicker();
    fireEvent.click(within(dialog).getByRole('radio', { name: '7 days' }));
    choose(dialog, 'prev');
    await waitFor(() => expect(within(dialog).getByTestId('range-compare-preview').textContent).toMatch(/^Compared with Sep 12, .*\(7 days\)\.$/));
    expect(within(dialog).getByTestId('range-reads').textContent).toMatch(/^Reads \d+ history documents for both windows\.$/);
    fireEvent.click(apply(dialog));
    expect(onApplyRange).toHaveBeenCalledWith({ kind: 'relative', hours: 168 }, { kind: 'prev' });
  });

  it('a week earlier of a 30-day window says why it can not be made, and Apply waits', async () => {
    const { onApplyRange } = setup();
    const dialog = await openPicker();
    fireEvent.click(within(dialog).getByRole('radio', { name: '30 days' }));
    choose(dialog, 'week');
    await waitFor(() => expect(within(dialog).getByTestId('range-compare-refused').textContent).toBe('A week earlier compares windows of 7 days or less.'));
    expect(apply(dialog).hasAttribute('disabled') || apply(dialog).getAttribute('aria-disabled') === 'true').toBe(true);
    fireEvent.click(apply(dialog));
    expect(onApplyRange).not.toHaveBeenCalled();
  });

  it('a commit fills the window with the 24 h after its deploy and applies with its hash', async () => {
    const { onApplyRange } = setup();
    const dialog = await openPicker();
    choose(dialog, 'commit:805b12c0d9e1f2a3');
    const from = within(dialog).getByLabelText('From') as HTMLInputElement;
    const to = within(dialog).getByLabelText('To') as HTMLInputElement;
    await waitFor(() => expect(from.value).toBe(formatLocalDateTimeInput(Date.parse('2026-09-25T11:20:00.000Z'), 'UTC')));
    expect(to.value).toBe(formatLocalDateTimeInput(Date.parse('2026-09-26T11:20:00.000Z'), 'UTC'));
    expect(within(dialog).getByTestId('range-preview').textContent).toContain('Summed in whole hours as Sep 25, 12:00 PM–Sep 26, 11:00 AM (23 h).');
    fireEvent.click(apply(dialog));
    expect(onApplyRange).toHaveBeenCalledWith(
      { kind: 'absolute', fromMs: Date.parse('2026-09-25T11:20:00.000Z'), toMs: Date.parse('2026-09-26T11:20:00.000Z') },
      { kind: 'commit', hash: '805b12c0d9e1f2a3' },
    );
  });

  it('re-opens with the comparison it applied', async () => {
    setup({ range: { kind: 'relative', hours: 24 }, vs: { kind: 'prev' } });
    const dialog = await openPicker();
    expect((dialog.querySelector('select') as HTMLSelectElement).value).toBe('prev');
    expect(within(dialog).getByTestId('range-compare-preview').textContent).toMatch(/^Compared with /);
  });
});
