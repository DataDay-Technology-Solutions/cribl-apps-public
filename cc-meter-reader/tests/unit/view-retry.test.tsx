// @vitest-environment jsdom
// OQ-12: React.lazy keeps a failed chunk's rejection for good; the view retries its fetch once, and the error
// boundary's Try again renders it anew (a page reload would end a tour, which lives in memory).
import { Suspense } from 'react';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ViewErrorBoundary } from '../../src/components/common/ViewErrorBoundary.tsx';
import { preloadable } from '../../src/lib/preload.ts';

describe('a view whose chunk fails to load', () => {
  it("a render whose chunk fails twice lands in the boundary, and Try again renders it once the chunk loads (OQ-12)", async () => {
    let fail = true;
    const factory = vi.fn(async () => {
      if (fail) throw new Error('Unable to preload CSS');
      return { default: () => <p>First run</p> };
    });
    const view = preloadable(factory);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ViewErrorBoundary>
        <Suspense fallback={<p>loading</p>}>
          <view.Component />
        </Suspense>
      </ViewErrorBoundary>,
    );
    await screen.findByText("This view couldn't load", undefined, { timeout: 3_000 });
    expect(factory).toHaveBeenCalledTimes(2); // the render retried once before giving up
    fail = false;
    await act(async () => {
      screen.getByRole('button', { name: 'Try again' }).click();
    });
    await screen.findByText('First run', undefined, { timeout: 3_000 });
    spy.mockRestore();
  });
});
