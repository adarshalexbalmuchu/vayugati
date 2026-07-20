/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  readonly VITE_INGEST_URL?: string
  /** local | staging | production (plan §4's environment separation) - see web/src/lib/env.ts */
  readonly VITE_ENVIRONMENT?: string
  /** MapTiler API key for the Map page's basemap switcher - see web/src/lib/basemaps.ts */
  readonly VITE_MAPTILER_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Injected by vite.config.ts's `define` at build time - see web/src/lib/env.ts. */
declare const __BUILD_SHA__: string
declare const __BUILD_TIME__: string
