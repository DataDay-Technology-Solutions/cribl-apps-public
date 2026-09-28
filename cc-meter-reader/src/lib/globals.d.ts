// Ambient declarations for the Cribl App Platform globals and the Vite build flags.
//
// The platform sets `CRIBL_API_URL` / `CRIBL_BASE_PATH` / `getCriblUser` on `window` when the app runs
// inside Cribl (AGENTS.md "Global Variables"). They are typed as OPTIONAL on purpose: outside Cribl
// (plain `vite` dev, Playwright, jsdom tests) they are undefined, and every reader must handle that.
// Read them through `src/lib/env.ts` rather than touching `window` directly.

export {};

declare global {
  /** Identity of the signed-in Cribl member (AGENTS.md "How to Get User Info"). */
  interface CriblUser {
    id: string;
    username: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    initials?: string;
  }

  interface Window {
    CRIBL_API_URL?: string;
    CRIBL_BASE_PATH?: string;
    /** Injected by the scaffold's dev server only (`__dev__<name>`). */
    CRIBL_APP_ID?: string;
    getCriblUser?: () => Promise<CriblUser>;
  }

  interface ImportMetaEnv {
    /** 'demo' compiles the Demo Console and demo settings in; anything else (or unset) is the release build. */
    readonly VITE_MR_BUILD?: string;
    /** '1' enables the in-browser MSW Cribl emulator in a production build (Playwright against `vite preview`). */
    readonly VITE_MR_MOCK?: string;
  }
}
