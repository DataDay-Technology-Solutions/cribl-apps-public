// src/views/Presenter/testHook.ts — lets the Playwright presenter spec drive the store (pause polling, inject a
// snapshot and incidents) without a 10-minute detector warm-up. Mock/dev builds ONLY: the flag is tested
// inline, the same pattern as main.tsx's mock start, so a release build folds the condition to `false` and
// drops the body.

import { useEffect } from 'react';
import { useServices } from '../../state/react.tsx';

interface TestWindow {
  __MR_PRESENTER__?: { store: unknown; actions: unknown; stop: () => void };
}

export function usePresenterTestHook(): void {
  const services = useServices();
  useEffect(() => {
    if (!(import.meta.env.DEV || import.meta.env.VITE_MR_MOCK === '1')) return;
    const w = window as unknown as TestWindow;
    w.__MR_PRESENTER__ = {
      store: services.store,
      actions: services.actions,
      stop: () => services.stop(),
    };
    return () => {
      if (w.__MR_PRESENTER__?.store === services.store) delete w.__MR_PRESENTER__;
    };
  }, [services]);
}
