// src/App.tsx — the React root: providers, the toast host and the router. All wiring (theme bridge,
// runtime, hydration, polling, the meter loop) happens in main.tsx before the first render.

import { AppRouter } from './router.tsx';
import { ToastHost } from './components/common/Toasts.tsx';
import { AppProviders } from './state/providers.tsx';
import type { AppServices } from './state/services.ts';

export interface AppProps {
  services: AppServices;
}

export default function App({ services }: AppProps) {
  return (
    <AppProviders services={services}>
      <ToastHost />
      <AppRouter />
    </AppProviders>
  );
}
