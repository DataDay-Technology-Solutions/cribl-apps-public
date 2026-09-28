// src/components/common/Toasts.tsx — Capra's imperative toasts, mounted once. The `notify` API that opens them, and why it
// dedupes, positions and silences them on the stage, is in notify.tsx.

import { Toast } from '@capra/core';
import './Toasts.css';

/** Mount exactly once, at the root (Capra portals toasts into <body>, where `.dark` lives). */
export function ToastHost() {
  return <Toast.Provider />;
}
