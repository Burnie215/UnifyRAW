/**
 * The app itself, loaded by ./main.tsx once the page is known to be a secure
 * context. Everything that used to sit in main.tsx lives here unchanged, except
 * the chunk recovery: that has to be armed before this module loads, so a
 * deployment that removed this very chunk still ends in one reload.
 */
import { createRoot } from 'react-dom/client'
import './index.css'
import './i18n'
import App from './App.tsx'
import { applyBrandToDocument } from './brand'

applyBrandToDocument()

// Registered here rather than as an inline <script> in index.html: the online
// build ships under a CSP without 'unsafe-inline', which blocked it silently
// (measured 2026-09-05 — the page stayed blank).
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined)
}

createRoot(document.getElementById('root')!).render(
  <App />,
)

// Cache the route-level chunks while the app is idle. The service
// worker then retains the current generation for tabs which remain open
// across a later deployment, without delaying first paint.
const warmLazyRoutes = () => {
  void Promise.allSettled([
    import('./components/PhotoEditor'),
    import('./components/AppDialogs'),
  ])
}

if (typeof window.requestIdleCallback === 'function') {
  window.requestIdleCallback(warmLazyRoutes, { timeout: 10_000 })
} else {
  globalThis.setTimeout(warmLazyRoutes, 3_000)
}
