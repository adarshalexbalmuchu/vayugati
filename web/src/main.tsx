import './lib/maplibreSetup'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// PWA installability only (Phase 12) - see public/sw.js's own comment for
// exactly what this does and doesn't provide. Skipped in dev: a service
// worker just adds friction (stale-module caching, extra devtools noise)
// to iterating on the app, and installability isn't a dev-mode concern.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
