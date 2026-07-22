# Environment Variables

Last updated: 2026-07-25 (Phase 10).

**Never commit a real value for any of these.** `.env`/`.env.local` are
gitignored; `.env.example` files hold names only. If you ever find a real
key in a committed `.env.example`, treat it as compromised — see
[SECURITY.md](SECURITY.md)'s rotation procedure.

## `web/.env.local` (copy from `web/.env.example`)

| Variable | Required | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | Yes | The Supabase project's URL. Different per environment (local/staging/production point at different projects). |
| `VITE_SUPABASE_ANON_KEY` | Yes | The **anon** key only — safe for a browser bundle by Supabase's own design (RLS is the real boundary). **Never** put the service_role key here; `web/src/lib/supabase.ts` never imports it and there is no code path in this app that could use it even if it were present. |
| `VITE_INGEST_URL` | No | Defaults to `http://localhost:8000`. The deployed ingest service's public URL in staging/production. |
| `VITE_ENVIRONMENT` | No | `local` \| `test` \| `staging` \| `production`. Defaults to `local`. Display/log-verbosity only — see `web/src/lib/env.ts`. Does **not** select which Supabase project is used; that's `VITE_SUPABASE_URL` alone. |
| `VITE_MAPTILER_KEY` | No | https://cloud.maptiler.com/account/keys/. Powers 4 of the Map page's 5 basemap modes (Operational Dark, Satellite Hybrid, Terrain, Minimal Grey GIS) via MapTiler's hosted vector styles. Unset → only "Operational Light" is selectable (the free MapLibre demo style, unchanged from before this key existed); the other modes show disabled with an explanatory tooltip rather than silently failing or faking a style. |

## `ingest/.env` (copy from `ingest/.env.example`)

| Variable | Required | Notes |
|---|---|---|
| `SUPABASE_URL` | Yes | Same project as the matching frontend deployment for that environment. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | **Server-side only.** Bypasses RLS entirely — this is the one credential in this whole system that can read/write anything. Never log it, never send it to the frontend, never put it in a client-visible response. See [SECURITY.md](SECURITY.md). |
| `OPENAQ_API_KEY` | Yes | https://explore.openaq.org/register |
| `DATA_GOV_API_KEY` | No | Official data.gov.in CPCB AQI API key, server-side only. https://data.gov.in — currently used only by the audit script `ingest/scripts/audit_data_gov_cpcb.py`; **not** wired into production ingest (`app/ingest.py` still runs on OpenAQ exactly as before). |
| `DELHI_OTD_API_KEY` | No | Delhi Open Transit Data real-time feed key, server-side only. https://otd.delhi.gov.in — audit-only for now (`ingest/scripts/audit_delhi_otd.py`); **not** wired into production ingest. |
| `ANTHROPIC_API_KEY` | Yes | Used by `classify.py` for report classification. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` | No | Optional (Phase 9). Unset → `notifications.py` uses the development-safe mock adapter (logs "would send", never claims a real delivery). `SMTP_PASSWORD` is a credential — same handling as the service_role key. |
| `ENVIRONMENT` | No | `local` \| `test` \| `staging` \| `production`. Defaults to `local`. Tags every structured log line and `job_runs` row — display/log metadata only, same as the frontend's `VITE_ENVIRONMENT`. |

## CI (GitHub Actions repo secrets, optional)

| Secret | Required | Notes |
|---|---|---|
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | No | Only used by the `hosted-drift-check` job in `.github/workflows/ci.yml`, which is purely informational (`continue-on-error: true`) and only runs on pushes to `main`. Skipped entirely if unset — CI never requires hosted credentials to pass. |

## What is safe to expose vs. never

**Safe in a browser bundle** (by Supabase's own design — RLS enforces the
real boundary): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.

**Never client-side, never logged, never in a committed file**:
`SUPABASE_SERVICE_ROLE_KEY`, `SMTP_PASSWORD`, `ANTHROPIC_API_KEY`,
`OPENAQ_API_KEY`, `DATA_GOV_API_KEY`, `DELHI_OTD_API_KEY` (no `VITE_`
equivalent exists or should ever exist for either — both are backend/
ingest-only credentials), `SUPABASE_ACCESS_TOKEN` (the CLI's personal access token —
distinct from the service_role key, never present in this repo's own
`.env.example` files since it's a per-developer credential, not a
per-project one).

## Key rotation procedure

1. Generate a new key in the Supabase dashboard (Settings → API →
   "Generate new service_role key" or similar for anon).
2. Update the value in every environment that uses it: Render dashboard
   (`ingest/.env`-equivalent env vars for each deployed service), Vercel
   dashboard (`web/.env.local`-equivalent), and your own local `.env`/
   `.env.local` files.
3. Revoke the old key in the Supabase dashboard once every environment is
   confirmed running on the new one (check each service's `/health` or a
   quick manual smoke check).
4. For SMTP credentials, rotate at the provider (SendGrid/SES/etc.) and
   update `SMTP_PASSWORD` the same way.
5. If a key was ever committed to git (even briefly, even in
   `.env.example`), rotate it immediately regardless of whether history was
   cleaned — assume it is permanently compromised the moment it touched a
   commit, since git history can be cloned before it's rewritten.
