// backend/lib/build-info.ts — what a backend bundle records as its build. The backend bundle has no
// `import.meta.env` / `process.env` (PLATFORM_NOTES §4.3), so the build flag is a constant here: the demo
// packager (`scripts/package.mjs --demo`) rewrites BUILD to 'demo' in its staged copy.

import type { Build } from '../../core/types.ts';
import { version } from '../../package.json';

export const APP_VERSION: string = typeof version === 'string' ? version : '0.0.0';
export const BUILD: Build = 'release';
