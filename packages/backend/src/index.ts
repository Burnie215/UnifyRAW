import express from 'express';
import cors from 'cors';
import { proxyRouter } from './routes/proxy.js';
import { filesRouter } from './routes/files.js';
import { rawRouter, startRawMaintenance } from './routes/raw.js';
import { authRouter } from './routes/auth.js';
import { syncRouter } from './routes/sync.js';
import { librariesRouter } from './routes/libraries.js';
import {
  requireAdmin,
  requireAuth,
  validateAuthConfiguration,
} from './middleware/auth.js';
import { createCorsOptions } from './middleware/cors-policy.js';
import { selfhostSecurityHeaders } from './security/csp.js';
import { parseTrustProxy, warnForwardedWithoutTrustProxy } from './security/trust-proxy.js';
import { bodyTooLargeHandler } from './middleware/body-errors.js';
import { closeDb, initDb } from './services/db.js';
import { persistOnShutdown } from './services/shutdown.js';
import { initializeAuthAccounts } from './services/auth-accounts.js';
import {
  isMissingJavaScriptAsset,
  STALE_ASSET_RECOVERY_MODULE,
} from './stale-asset-recovery.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MODE = process.env.MODE ?? 'hosted';
const SYNC_ONLY = process.env.SYNC_ONLY === 'true';
const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? './data/photolib.db';
const ALLOWED_ROOTS = (process.env.ALLOWED_ROOTS ?? '').split(',').filter(Boolean);
const LIBRARY_ROOTS = (
  process.env.PHOTOLIB_LIBRARY_ROOTS ?? process.env.ALLOWED_ROOTS ?? ''
).split(',').map((root) => root.trim()).filter(Boolean);

const app = express();

app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));
app.use(warnForwardedWithoutTrustProxy());
app.use(cors(createCorsOptions()));
app.use(selfhostSecurityHeaders());

// Health check
app.get('/api/health', (_req, res) => res.json({ ok: true, role: SYNC_ONLY ? 'sync' : 'photolib' }));

if (SYNC_ONLY) {
  // Sync-as-a-Service mode: only auth + sync routes. No proxy, no files, no
  // catalog, no static frontend. Multi-user: every sync request must be
  // authenticated; AUTH_MODE=disabled is rejected for this deployment mode.
  app.use('/api/auth', authRouter);
  app.use('/api/sync', requireAuth, syncRouter);
  app.get('/', (_req, res) => res.json({ service: 'photolib-sync', endpoints: ['/api/auth', '/api/sync'] }));
} else {
  // Full PhotoLib backend. Explicit AUTH_MODE=disabled is intended only for
  // local single-user development and uses the implicit '_anon' sync owner.
  // These routes expose global server filesystem, network and decoder
  // resources. Non-admin sync accounts must never gain access to them.
  app.use('/api/proxy', requireAdmin, proxyRouter);
  app.use('/api/files', requireAdmin, filesRouter(ALLOWED_ROOTS));
  app.use('/api/raw', requireAdmin, rawRouter);
  startRawMaintenance();
  app.use('/api/libraries', requireAdmin, librariesRouter({
    allowedRoots: LIBRARY_ROOTS,
    managedRoot: process.env.PHOTOLIB_MANAGED_ROOT,
    thumbnailRoot: process.env.PHOTOLIB_THUMB_ROOT
      ?? path.join(path.dirname(DB_PATH), 'thumbs'),
    databasePath: DB_PATH,
    maxImportBytes: parseNonNegativeInteger(process.env.PHOTOLIB_MAX_IMPORT_BYTES),
  }));

  app.use('/api/auth', authRouter);
  app.use('/api/sync', requireAuth, syncRouter);

  // Serve frontend in production (Docker layout: backend=/app/backend, frontend=/app/frontend/dist)
  const frontendPath = path.join(__dirname, '../frontend/dist');
  app.use(express.static(frontendPath));
  // An already-open tab can still reference a lazy chunk from the previous
  // deployment. Existing assets were handled by express.static above; for a
  // missing JS module, return a non-cacheable recovery module instead of a
  // terminal 404. This also repairs clients running code from before the
  // client-side preload-error handler existed.
  app.get('/assets/{*path}', (req, res) => {
    if (isMissingJavaScriptAsset(req.path)) {
      res
        .status(200)
        .type('application/javascript')
        .set('Cache-Control', 'no-store, max-age=0')
        .set('X-PhotoLib-Asset-Recovery', 'reload')
        .send(STALE_ASSET_RECOVERY_MODULE);
      return;
    }
    res.status(404).end();
  });
  // SPA fallback: anything else returns index.html so the React router can
  // resolve client-side routes. Asset paths (/assets/*) and API paths
  // (/api/*) are excluded — for those, a missing file is a real 404,
  // never the HTML shell (would otherwise confuse the browser with a
  // wrong MIME type for stale bundle URLs).
  app.get('/{*path}', (req, res) => {
    if (req.path.startsWith('/assets/') || req.path.startsWith('/api/')) {
      res.status(404).end();
      return;
    }
    res.sendFile(path.join(frontendPath, 'index.html'));
  });
}

app.use(bodyTooLargeHandler);

async function start() {
  validateAuthConfiguration();
  await initDb(DB_PATH);
  initializeAuthAccounts();
  const server = app.listen(PORT, () => {
    console.log(`PhotoLib backend running on port ${PORT} (mode: ${MODE})`);
    if (ALLOWED_ROOTS.length > 0) {
      console.log(`Allowed file roots: ${ALLOWED_ROOTS.join(', ')}`);
    }
    if (LIBRARY_ROOTS.length > 0) {
      console.log(`Configured library roots: ${LIBRARY_ROOTS.length}`);
    }
  });
  persistOnShutdown(server, closeDb);
}

start().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
