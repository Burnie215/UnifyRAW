import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'http'

/**
 * Which build this is. `build:selfhost` sets VITE_MODE=hosted and
 * `build:online` sets VITE_MODE=online (see package.json). Every value except
 * `hosted`, including plain `npm run dev`, selects the online build. It must
 * not carry the old inline variant script because the CSP forbids it (§P6).
 */
const BUILD_VARIANT = process.env.VITE_MODE === 'hosted' ? 'selfhost' : 'online'
const BUILD_DATE = new Date().toISOString().slice(0, 10)

/**
 * Which commit this bundle was built from. The deploy tooling supplies it two
 * ways because there are two paths: as a docker build arg (SOURCE_COMMIT, when
 * the image builds the bundle itself) and in the environment of a preBuild
 * step (PROJECTS_SOURCE_COMMIT). A build started by hand has neither, and then
 * the stamp says so rather than pretending.
 */
const SOURCE_COMMIT = (process.env.SOURCE_COMMIT || process.env.PROJECTS_SOURCE_COMMIT || '').trim()
const SOURCE_DIRTY = process.env.SOURCE_DIRTY === '1' || process.env.PROJECTS_SOURCE_DIRTY === '1'
const BUILD_SOURCE = SOURCE_COMMIT && SOURCE_COMMIT !== 'unknown'
  ? `${SOURCE_COMMIT.slice(0, 12)}${SOURCE_DIRTY ? '+dirty' : ''}`
  : 'unknown'

/**
 * ES modules that ship as assets (libheif for HEIC, onnxruntime's glue for the
 * AI denoise) leave the build as .js, not .mjs. Static servers commonly know
 * .js but not .mjs - nginx 1.31 sent them as application/octet-stream, which
 * the browser refuses for a module - and a browser that once cached that
 * answer keeps it for the life of the immutable asset URL, so a changed name is
 * what reaches it.
 */
function moduleAssetsAsJs(asset: { names: string[] }): string {
  return asset.names.some((name) => name.endsWith('.mjs'))
    ? 'assets/[name]-[hash].js'
    : 'assets/[name]-[hash][extname]'
}

export default defineConfig({
  define: {
    __BUILD_DATE__: JSON.stringify(BUILD_DATE),
  },
  // Relative asset paths so the bundle works both at `/` (web) and at
  // `capacitor://localhost/` (mobile WebView).
  base: './',
  build: {
    rolldownOptions: { output: { assetFileNames: moduleAssetsAsJs } },
  },
  // The denoise worker is a bundle of its own and references onnxruntime's
  // glue itself; the rule above does not reach it.
  worker: {
    rolldownOptions: { output: { assetFileNames: moduleAssetsAsJs } },
  },
  // The bundle and the dev server read the shared sources directly; only
  // Node (backend, tsx) goes through packages/shared/dist.
  resolve: {
    alias: {
      '@photolib/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
    },
  },
  plugins: [
    react(),
    {
      // Stamps variant, date and source commit into the page, so one curl
      // answers both "which build is this" and "which code is in it". The
      // second question had no answer at all before, which is what made a
      // deploy from a working tree impossible to audit after the fact.
      name: 'photolib-build-stamp',
      transformIndexHtml() {
        return [{
          tag: 'meta',
          attrs: {
            name: 'photolib-build',
            content: `${BUILD_VARIANT} ${BUILD_DATE} ${BUILD_SOURCE}`,
          },
          injectTo: 'head',
        }]
      },
    },
    {
      name: 'api-proxy-fallback',
      configureServer(server) {
        // Dev-only proxy fallback when no backend is running.
        // In production, the backend handles /api/* routes.
        server.middlewares.use('/api/proxy', async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method === 'OPTIONS') {
            res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' })
            res.end()
            return
          }

          try {
            const chunks: Buffer[] = []
            for await (const chunk of req) chunks.push(chunk as Buffer)
            const body = JSON.parse(Buffer.concat(chunks).toString())

            const { url, method, headers, requestBody } = body as {
              url: string
              method?: string
              headers?: Record<string, string>
              requestBody?: string
            }

            const fetchRes = await fetch(url, {
              method: method ?? 'GET',
              headers: headers ?? {},
              body: requestBody ?? undefined,
            })

            const contentType = fetchRes.headers.get('content-type') ?? 'application/octet-stream'
            const buffer = Buffer.from(await fetchRes.arrayBuffer())

            res.writeHead(fetchRes.status, {
              'Content-Type': contentType,
              'Access-Control-Allow-Origin': '*',
            })
            res.end(buffer)
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: String(e) }))
          }
        })
      },
    },
  ],
  server: {
    proxy: {
      // When backend is running, proxy API calls to it
      '/api/files': 'http://localhost:3001',
      '/api/raw': 'http://localhost:3001',
      '/api/sync': 'http://localhost:3001',
      '/api/auth': 'http://localhost:3001',
      '/api/libraries': 'http://localhost:3001',
    },
  },
})
