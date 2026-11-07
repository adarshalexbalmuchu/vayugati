import { execSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Build-identifying constants (plan §15: "add a deployment version/build
// identifier"). Read once at build time, not runtime — falls back to
// 'unknown' rather than failing the build when .git is unavailable (a
// shallow-clone edge case on some CI runners), since a missing build id is
// a much smaller problem than a broken deploy.
function gitShortSha(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'unknown'
  }
}

export default defineConfig({
  plugins: [react()],
  // MapLibre 6 starts its worker from a file next to the library (new URL(..., import.meta.url)); pre-bundling breaks that path.
  optimizeDeps: { exclude: ['maplibre-gl'] },
  define: {
    __BUILD_SHA__: JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? gitShortSha()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
})
