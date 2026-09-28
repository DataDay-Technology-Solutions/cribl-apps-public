// @vitest-environment jsdom
// The Receipt hero's range picker (src/views/Receipt/RangePicker.tsx): the fifth toggle item opens the popover
// (and re-opens it while Custom is selected), the fields open filled with the window Apply would use, a quick pick
// fills them with its own window and applies as a relative range, an edited window applies as an absolute one
// (a pre-filled instant survives an unedited Apply on a fall-back night), the preview says what will be summed,
// an inverted or emptied window can't apply and says why, Cancel and Escape close it and hand focus back, and
// sample data disables Custom.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RangeSpec } from '../../core/range.ts';
import { HOUR_MS } from '../../core/time.ts';
import { RangeControl, type RangeControlProps } from '../../src/views/Receipt/RangePicker.tsx';

const NOW = Date.parse('2026-09-26T17:34:56.000Z'); // 12:34:56 PM in Chicago

beforeAll(() => {
  // jsdom lacks these; Capra's overlays touch them.
  window.matchMedia ??= ((query: string) =>
    ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) as unknown as MediaQueryList);
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
});

function setup(over: Partial<RangeControlProps> = {}) {
  const onPeriod = vi.fn();
  const onApplyRange = vi.fn();
  const utils = render(<RangeControl period="mtd" onPeriod={onPeriod} onApplyRange={onApplyRange} tz="UTC" nowMs={NOW} {...over} />);
  return { ...utils, onPeriod, onApplyRange };
}

/**
 * The toggle's items are react-aria toggle buttons (role radio in a single-selection group). While the popover
 * is open react-aria hides everything outside it from the accessibility tree, so the query allows hidden nodes.
 */
function toggle(name: string): HTMLElement {
  const group = screen.getByRole('radiogroup', { name: 'Headline period', hidden: true });
  return within(group).getByRole('radio', { name, hidden: true });
}

async function openPicker(): Promise<HTMLElement> {
  fireEvent.click(toggle('Custom'));
  return screen.findByRole('dialog', { name: 'Custom range' });
}

const field = (dialog: HTMLElement, label: string): HTMLInputElement => within(dialog).getByLabelText(label) as HTMLInputElement;
const apply = (dialog: HTMLElement): HTMLElement => within(dialog).getByRole('button', { name: 'Apply' });

describe('RangeControl', () => {
  it('shows the four periods plus Custom, and a period press reports the period', () => {
    const { onPeriod, onApplyRange } = setup();
    expect(within(screen.getByRole('radiogroup', { name: 'Headline period' })).getAllByRole('radio').map((b) => b.textContent)).toEqual(['MTD', 'Today', '30 days', 'Annualized', 'Custom']);
    expect(toggle('MTD').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle('Today'));
    expect(onPeriod).toHaveBeenCalledWith('today');
    expect(onApplyRange).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Pressing the selected period again changes nothing and opens nothing.
    fireEvent.click(toggle('MTD'));
    expect(onPeriod).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Custom opens the picker filled with the last 6 h, ready to apply as an exact window', async () => {
    const { onApplyRange } = setup();
    const dialog = await openPicker();
    expect(toggle('Custom').getAttribute('aria-checked')).toBe('true');
    expect(field(dialog, 'From').value).toBe('2026-09-26T11:34');
    expect(field(dialog, 'To').value).toBe('2026-09-26T17:34');
    expect(within(dialog).queryByRole('radio', { checked: true })).toBeNull();
    expect(screen.getByTestId('range-preview').textContent).toBe('Summed minute-exact as Sep 26, 11:34 AM–5:34 PM (6 h).');
    expect(apply(dialog)).toHaveProperty('disabled', false);
    fireEvent.click(apply(dialog));
    expect(onApplyRange).toHaveBeenCalledWith({ kind: 'absolute', fromMs: Date.parse('2026-09-26T11:34:00Z'), toMs: Date.parse('2026-09-26T17:34:00Z') } satisfies RangeSpec);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a quick pick fills the fields with its window and applies a relative range', async () => {
    const { onApplyRange } = setup({ tz: 'America/Chicago' });
    const dialog = await openPicker();
    fireEvent.click(within(dialog).getByRole('radio', { name: '7 days' }));
    expect(within(dialog).getByRole('radio', { name: '7 days' }).getAttribute('aria-checked')).toBe('true');
    expect(field(dialog, 'From').value).toBe('2026-09-19T12:34');
    expect(field(dialog, 'To').value).toBe('2026-09-26T12:34');
    // Whole hours, ending at the last whole hour: 168 h exactly.
    expect(screen.getByTestId('range-preview').textContent).toBe('Summed in whole hours as Sep 19, 12:00 PM–Sep 26, 12:00 PM (7 days).');
    fireEvent.click(apply(dialog));
    expect(onApplyRange).toHaveBeenCalledWith({ kind: 'relative', hours: 168 } satisfies RangeSpec);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('an edited window applies as UTC minutes from wall time in the display timezone, and clears the quick pick', async () => {
    const { onApplyRange } = setup({ tz: 'America/Chicago' });
    const dialog = await openPicker();
    fireEvent.click(within(dialog).getByRole('radio', { name: '6 h' }));
    fireEvent.change(field(dialog, 'From'), { target: { value: '2026-09-25T10:00' } });
    expect(within(dialog).getByRole('radio', { name: '6 h' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.change(field(dialog, 'To'), { target: { value: '2026-09-25T14:00' } });
    expect(screen.getByTestId('range-note').textContent).toBe('Times are in America/Chicago. Windows older than 24 hours are summed in whole hours; older than 31 days, in whole UTC days.');
    expect(screen.getByTestId('range-preview').textContent).toBe('Summed in whole hours as Sep 25, 10:00 AM–2:00 PM (4 h).');
    fireEvent.click(apply(dialog));
    expect(onApplyRange).toHaveBeenCalledWith({ kind: 'absolute', fromMs: Date.parse('2026-09-25T15:00:00Z'), toMs: Date.parse('2026-09-25T19:00:00Z') });
  });

  it('says how many history documents Apply will read: the hybrid plan with the sweep cursor, the single-family one without', async () => {
    const through = Date.parse('2026-09-26T17:34:00Z');
    setup({ tz: 'America/Chicago', meteredThroughMs: through });
    let dialog = await openPicker();
    fireEvent.click(within(dialog).getByRole('radio', { name: '30 days' }));
    // Hour rows at the two ragged edges, day rows between (api-budget F2) — not the 31 hour documents.
    expect(screen.getByTestId('range-reads').textContent).toBe('Reads 4 history documents.');
    fireEvent.click(within(dialog).getByRole('radio', { name: '24 h' }));
    expect(screen.getByTestId('range-reads').textContent).toBe('Reads 4 history documents.');
    fireEvent.click(within(dialog).getByRole('radio', { name: '1 h' }));
    expect(screen.getByTestId('range-reads').textContent).toBe('Reads 2 history documents.');
    // A window lying in the future reads nothing, so there is no count.
    fireEvent.change(field(dialog, 'From'), { target: { value: '2026-09-27T10:00' } });
    fireEvent.change(field(dialog, 'To'), { target: { value: '2026-09-27T12:00' } });
    expect(screen.getByTestId('range-preview').textContent).toBe('This window is in the future: nothing has been metered in it yet.');
    expect(screen.queryByTestId('range-reads')).toBeNull();
    cleanup();
    // No cursor yet (meta not read): the plan is the single-family one, and the count says so.
    setup({ tz: 'America/Chicago' });
    dialog = await openPicker();
    fireEvent.click(within(dialog).getByRole('radio', { name: '30 days' }));
    expect(screen.getByTestId('range-reads').textContent).toBe('Reads 31 history documents.');
  });

  it('previews the widening an exact window gets', async () => {
    setup({ tz: 'America/Chicago', collectingSinceMs: Date.parse('2026-08-01T00:00:00Z') });
    const dialog = await openPicker();
    fireEvent.change(field(dialog, 'From'), { target: { value: '2026-08-22T00:00' } });
    fireEvent.change(field(dialog, 'To'), { target: { value: '2026-08-24T00:00' } });
    // Two Chicago days, 35 days back: whole UTC days, which read as times in Chicago.
    expect(screen.getByTestId('range-preview').textContent).toBe('Summed in whole UTC days as Aug 21, 7:00 PM–Aug 24, 7:00 PM (3 days).');
  });

  it('previews the clip to when collecting began', async () => {
    setup({ tz: 'America/Chicago', collectingSinceMs: Date.parse('2026-09-26T16:00:00Z') });
    await openPicker();
    // The default last 6 h starts before collecting began: the preview starts where the rows do.
    expect(screen.getByTestId('range-preview').textContent).toBe('Summed minute-exact as Sep 26, 11:00 AM–12:34 PM (1.6 h).');
  });

  it('an inverted window cannot apply and says why; an emptied field asks for both ends', async () => {
    const { onApplyRange } = setup();
    const dialog = await openPicker();
    fireEvent.change(field(dialog, 'From'), { target: { value: '2026-09-25T14:00' } });
    fireEvent.change(field(dialog, 'To'), { target: { value: '2026-09-25T10:00' } });
    expect(apply(dialog)).toHaveProperty('disabled', true);
    expect(screen.getByTestId('range-note').textContent).toBe('The start must be before the end.');
    expect(screen.queryByTestId('range-preview')).toBeNull();
    fireEvent.click(apply(dialog));
    expect(onApplyRange).not.toHaveBeenCalled();
    fireEvent.change(field(dialog, 'To'), { target: { value: '' } });
    expect(apply(dialog)).toHaveProperty('disabled', true);
    expect(screen.getByTestId('range-note').textContent).toBe('Enter a start and an end.');
  });

  it('opens pre-filled with the active exact window; Cancel closes without applying; Custom pressed again re-opens', async () => {
    const { onApplyRange } = setup({ range: { kind: 'absolute', fromMs: Date.parse('2026-09-25T10:00:00Z'), toMs: Date.parse('2026-09-25T14:00:00Z') } });
    expect(toggle('Custom').getAttribute('aria-checked')).toBe('true');
    // Custom is already selected: pressing it is an empty selection to react-aria, which re-opens the picker.
    const dialog = await openPicker();
    expect(field(dialog, 'From').value).toBe('2026-09-25T10:00');
    expect(field(dialog, 'To').value).toBe('2026-09-25T14:00');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onApplyRange).not.toHaveBeenCalled();
    expect(toggle('Custom').getAttribute('aria-checked')).toBe('true'); // the range is still active
  });

  it('re-applying an unedited window keeps its instants: the second 1:30 AM of a fall-back night stays the second', async () => {
    // 2026-11-01 01:30 happens twice in Chicago; 07:30Z is the second (CST). The field shows '2026-11-01T01:30'
    // for both, and parsing that string alone would give the first (06:30Z).
    const fromMs = Date.parse('2026-11-01T07:30:00Z');
    const toMs = Date.parse('2026-11-01T09:00:00Z');
    const { onApplyRange } = setup({ tz: 'America/Chicago', nowMs: Date.parse('2026-11-02T12:00:00Z'), range: { kind: 'absolute', fromMs, toMs } });
    const dialog = await openPicker();
    expect(field(dialog, 'From').value).toBe('2026-11-01T01:30');
    fireEvent.click(apply(dialog));
    expect(onApplyRange).toHaveBeenCalledWith({ kind: 'absolute', fromMs, toMs });
    // Editing the other field re-parses only that one.
    onApplyRange.mockClear();
    const again = await openPicker();
    fireEvent.change(field(again, 'To'), { target: { value: '2026-11-01T04:00' } });
    fireEvent.click(apply(again));
    expect(onApplyRange).toHaveBeenCalledWith({ kind: 'absolute', fromMs, toMs: Date.parse('2026-11-01T10:00:00Z') });
  });

  it('a relative range opens with its quick pick selected and its current window in the fields', async () => {
    setup({ range: { kind: 'relative', hours: 168 } });
    const dialog = await openPicker();
    expect(within(dialog).getByRole('radio', { name: '7 days' }).getAttribute('aria-checked')).toBe('true');
    expect(field(dialog, 'From').value).toBe('2026-09-19T17:34');
    expect(field(dialog, 'To').value).toBe('2026-09-26T17:34');
    expect(Date.parse(`${field(dialog, 'To').value}:00Z`) - Date.parse(`${field(dialog, 'From').value}:00Z`)).toBe(168 * HOUR_MS);
  });

  it('Escape closes the picker and focus returns to the toggle', async () => {
    setup();
    const custom = toggle('Custom');
    custom.focus();
    const dialog = await openPicker();
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    });
    const from = field(dialog, 'From');
    from.focus();
    fireEvent.keyDown(from, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(custom));
    expect(custom.getAttribute('aria-checked')).toBe('false'); // no range applied: back to the period
  });

  it('sample data: Custom is disabled and nothing opens', () => {
    setup({ customDisabled: true, customHintId: 'hint' });
    expect(toggle('Custom')).toHaveProperty('disabled', true);
    fireEvent.click(toggle('Custom'));
    expect(screen.queryByRole('dialog')).toBeNull();
    // The hidden anchor is out of the tab order and disabled too.
    const anchor = screen.getByRole('button', { name: 'Change the custom range' });
    expect(anchor).toHaveProperty('disabled', true);
    expect(anchor.getAttribute('aria-describedby')).toBe('hint');
  });

  it('the hidden anchor is never in the tab order', async () => {
    setup();
    expect(screen.getByRole('button', { name: 'Change the custom range' }).getAttribute('tabindex')).toBe('-1');
    await openPicker();
  });
});
