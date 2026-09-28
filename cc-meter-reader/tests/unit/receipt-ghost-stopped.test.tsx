// @vitest-environment jsdom
// The Receipt's empty ghost once nothing will load (craft review, round 2): under "Not metering: metrics access
// refused" (sweeps failing before the first figures) or an unreadable snapshot, the four cards say so in one still
// line instead of outlines that read as loading, and the hero drops its placeholder lines. While the App is merely
// waiting for its first sweep, the ghost keeps its outlines.

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ReceiptGhost } from '../../src/views/Receipt/Sections.tsx';

afterEach(() => cleanup());

describe('ReceiptGhost', () => {
  it('waiting: the layout as outlines, no stopped line', () => {
    const { container } = render(<ReceiptGhost state="waiting" caption="Waiting for the first sweep." />);
    expect(container.querySelectorAll('.mr-ghost')).toHaveLength(4);
    expect(container.querySelector('.mr-hero-aside--ghost')).not.toBeNull();
    expect(screen.queryAllByTestId('ghost-card-stopped')).toHaveLength(0);
    expect(container.querySelector('[data-stopped]')).toBeNull();
  });

  it('failing: every card says nothing will show until a sweep succeeds, with no outlines', () => {
    const { container } = render(<ReceiptGhost state="waiting" stopped="failing" caption="Not metering: metrics access refused." />);
    expect(container.querySelector('[data-state="waiting"]')?.getAttribute('data-stopped')).toBe('failing');
    expect(container.querySelectorAll('.mr-ghost')).toHaveLength(0);
    expect(container.querySelectorAll('.mr-skel')).toHaveLength(0);
    const lines = screen.getAllByTestId('ghost-card-stopped');
    expect(lines).toHaveLength(4);
    for (const l of lines) expect(l.textContent).toBe('Nothing to show until a sweep succeeds.');
    expect(screen.getByTestId('hero-caption').textContent).toBe('Not metering: metrics access refused.');
  });

  it('error: the cards wait on the saved figures, not on a sweep', () => {
    const { container } = render(<ReceiptGhost state="error" stopped="error" caption="Figures appear here once your role can read them." />);
    expect(container.querySelectorAll('.mr-ghost')).toHaveLength(0);
    const lines = screen.getAllByTestId('ghost-card-stopped');
    expect(lines).toHaveLength(4);
    expect(lines[0].textContent).toBe('Nothing to show until the saved figures can be read.');
  });
});
