import { defineConfig, type IndexHtmlTransformContext, type IndexHtmlTransformResult, type ViteDevServer } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'path'
import react from '@vitejs/plugin-react'
// @ts-ignore
import { servePackageTgz } from '@cribl/apps/package'
// @ts-ignore
import { backendPreviewPlugin, backendWatchPlugin } from '@cribl/apps/preview'

const packageEndpointPlugin = () => ({
  name: 'vite-plugin-package-endpoint',
  configureServer(server: ViteDevServer) {
    server.middlewares.use('/package.tgz', (req: IncomingMessage, res: ServerResponse) => {
      void servePackageTgz(req, res, server.config.root)
    })
  },
})

const WATCHED_CONFIG_FILES = ['package.json', 'config/proxies.yml', 'config/policies.yml', 'config/schedules.yml', 'config/backend.yml'];
const CONFIG_CHANGED_HMR_EVENT = 'cribl:config-changed';

const CONFIG_CHANGED_BRIDGE = `
import { createHotContext } from '/@vite/client';
const hot = createHotContext('cribl:config-watcher');
hot.on('${CONFIG_CHANGED_HMR_EVENT}', (data) => {
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'CRIBL_APP_CONFIG_CHANGED', file: data && data.file }, '*');
  }
  window.location.reload();
});
`;

const injectScriptFromQueryPlugin = () => {
  let initScriptUrl: string | null = null;
  return {
    name: 'inject-script-from-query',
    configureServer(server: ViteDevServer) {
      const root = server.config.root;
      const watched = WATCHED_CONFIG_FILES.map((rel) => join(root, rel));
      server.watcher.add(watched);
      server.watcher.on('change', (file) => {
        const idx = watched.indexOf(file);
        if (idx === -1) return;
        server.ws.send(CONFIG_CHANGED_HMR_EVENT, { file: WATCHED_CONFIG_FILES[idx] });
      });
    },
    transformIndexHtml(html: string, ctx: IndexHtmlTransformContext): IndexHtmlTransformResult{
      const url = new URL(ctx.originalUrl ?? '/', 'https://localhost');
      initScriptUrl = initScriptUrl || url.searchParams.get('init');
      const root = process.cwd();
      let appName;
      try {
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { name?: string };
        appName = pkg.name;
      } catch {
        /* ignore missing or invalid package.json */
      }
      appName = appName || 'unknown';
      const tags: Array<{ tag: string; attrs?: Record<string, string>; children?: string; injectTo: 'head-prepend' }> = [];
      tags.push({
        tag: 'script',
        children: `window.CRIBL_APP_ID = '__dev__${appName}';`,
        injectTo: 'head-prepend' as const,
      });
      if (ctx.server) {
        tags.push({
          tag: 'script',
          attrs: { type: 'module' },
          children: CONFIG_CHANGED_BRIDGE,
          injectTo: 'head-prepend' as const,
        });
      }
      if (initScriptUrl) {
        tags.push({
          tag: 'script',
          attrs: { src: initScriptUrl, type: 'text/javascript' },
          injectTo: 'head-prepend' as const,
        });
      }
      return { html, tags };
    },
  };
};

/**
 * MSW's worker (public/mockServiceWorker.js) serves only the in-browser Cribl emulator (VITE_MR_MOCK=1, dev
 * and Playwright). A build that does not run the mock drops it from the output, so a plain
 * `VITE_MR_BUILD=release npm run build:ui` dist matches what scripts/package.mjs ships.
 */
const dropMockWorkerPlugin = () => {
  let outDir = 'dist';
  return {
    name: 'mr-drop-mock-worker',
    apply: 'build' as const,
    configResolved(config: { root: string; build: { outDir: string } }) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      if (process.env.VITE_MR_MOCK !== '1') rmSync(join(outDir, 'mockServiceWorker.js'), { force: true });
    },
  };
};

/**
 * Every bare module the browser code imports, pre-bundled when the dev server starts (D40). Most of them are
 * reached only through a lazy view or the mock (d3-sankey from Flow, the virtualizer from Ledger, qrcode from the
 * presenter, msw from the emulator). When the optimizer met one of those for the first time mid-run (a reused
 * `node_modules/.vite` cache skips the start-up scan), it re-optimized, answered the old URLs "504 Outdated
 * Optimize Dep" and reloaded every open page, so Firefox and WebKit failed the lazy view's import in flight: one
 * wave-2 run served two optimizer hashes. tests/unit/wave3-harness-deps.test.ts fails when an import is missing here.
 */
export const PREBUNDLED_DEPS = [
  '@capra/core',
  '@capra/icons',
  '@tanstack/react-virtual',
  'd3-sankey',
  'd3-shape',
  'msw',
  'msw/browser',
  'qrcode/lib/core/qrcode.js',
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-dev-runtime',
  'react/jsx-runtime',
  'react-router-dom',
];

export default defineConfig({
  plugins: [react(), packageEndpointPlugin(), injectScriptFromQueryPlugin(), backendWatchPlugin(), backendPreviewPlugin(), dropMockWorkerPlugin()],
  base: './',
  optimizeDeps: { include: PREBUNDLED_DEPS },
  server: {
    cors: true,
    // Playwright writes traces, screenshots and its HTML report under tests/report while tests run; an .html file
    // changing there made Vite reload every open page mid-test (Firefox then fails the in-flight lazy view import).
    watch: { ignored: ['**/tests/report/**'] },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // Every npm package whose code lands in the bundle, with its declared license and license text (rule 4.7: the
    // minifier strips the notices). scripts/package.mjs renders this into static/THIRD-PARTY-LICENSES.md, adds the
    // fonts' OFL, and removes the JSON from the package.
    license: { fileName: '.vite/third-party-licenses.json' },
  }
})
