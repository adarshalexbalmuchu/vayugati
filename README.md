# Vayu Gati

*Jankari se karyavahi tak* — the intelligence and accountability layer on top of
Delhi's pollution-response loop. Full plan: [docs/build-plan.md](docs/build-plan.md).

**Current state: Phase 0** — auth + role routing shell, shared map, and hourly
ingestion of station readings (OpenAQ v3) and weather (Open-Meteo) into Supabase.

## Repo layout

```
vayugati/
├── Makefile                        # Supabase CLI convenience targets
├── supabase/
│   ├── schema.sql               # the database baseline (run first, verbatim)
│   └── migrations/              # additive changes, CLI-managed going forward
│       └── 20260714000000_weather.sql   # weather table (idempotent)
├── ingest/                      # Python 3.11 + FastAPI, hourly ingestion
│   ├── stations.yaml            # station list — adding a station is one line
│   ├── requirements.txt
│   ├── .env.example
│   └── app/
│       ├── main.py              # FastAPI app + hourly scheduler
│       ├── ingest.py            # one ingestion pass
│       ├── openaq.py            # OpenAQ v3 client
│       ├── open_meteo.py        # Open-Meteo client
│       ├── aqi.py               # Indian (CPCB) AQI from PM2.5/PM10
│       ├── db.py                # Supabase writes (service_role)
│       └── config.py
├── web/                         # React 18 + TS + Vite + Tailwind + MapLibre
│   ├── .env.example
│   └── src/
│       ├── lib/supabase.ts      # anon-key client
│       ├── lib/auth.tsx         # session + profile (role, ward)
│       ├── components/
│       │   ├── MapView.tsx      # ONE shared map (Delhi placeholder)
│       │   ├── WardCard.tsx     # ONE shared ward card
│       │   ├── ViewShell.tsx    # Phase 0 layout: card + map
│       │   └── RequireRole.tsx  # role-gated routes
│       └── pages/               # Login, CitizenView, FieldView, CommandView
└── docs/build-plan.md
```

## Manual setup (do these once)

### 1. Supabase project

1. Create a project at https://supabase.com/dashboard.
2. SQL editor → paste and run `supabase/schema.sql` (creates enums, tables,
   RLS, and seeds the 13 hotspot wards).
3. SQL editor → paste and run `supabase/migrations/20260714000000_weather.sql`.
   (Or apply it with the CLI — see *Supabase CLI* below. It's idempotent, so
   running it both ways is harmless.)
4. Settings → API: note the **Project URL**, **anon key**, and
   **service_role key**.

### 2. OpenAQ

- Get a free v3 API key: https://explore.openaq.org/register
- Fill in `ingest/stations.yaml` with the OpenAQ **location ids** of the 13
  hotspot stations (search each station at https://explore.openaq.org — the id
  is the number in the URL). Stations with a null id are skipped until filled.

### 3. Env files

```bash
cp ingest/.env.example ingest/.env      # SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAQ_API_KEY
cp web/.env.example web/.env.local      # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
```

The web app uses the **anon key only**. The ingest service uses the
**service_role key** (it writes readings/weather, bypassing RLS) — keep it
server-side, never in `/web`.

### 4. Test users and roles

Sign up in the web app (or create users in Authentication → Users). A profile
row is auto-created on first login with role `citizen`. Promote roles and
assign wards in the SQL editor:

```sql
update profiles set role = 'field_officer',
  ward_id = (select id from wards where name = 'Bawana')
where id = (select id from auth.users where email = 'officer@example.com');

update profiles set role = 'commander'
where id = (select id from auth.users where email = 'commander@example.com');
```

## Run

### Ingest (start this first — history accumulates from day one)

```bash
cd ingest
python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --port 8000
```

- Pulls once at startup, then at minute :10 of every hour (UTC).
- `GET /health` — status + last run summary. `POST /run` — trigger a pass now.
- Deploy: any small Python host (Railway / Render / Fly), same env vars.

### Web

```bash
cd web
npm install
npm run dev
```

Login routes by role: `citizen → /citizen`, `field_officer → /field`,
`commander`/`admin` → `/command`. Each view is a Phase 0 stub: the ward card
("Logged in as {role} — ward: {ward}") over a shared MapLibre map centered on
Delhi. Deploy: Vercel, root directory `web`, the two `VITE_*` env vars.

## Connecting the project

Two independent ways to connect to Supabase. They do different jobs — the CLI
is a developer workflow, MCP gives an AI agent live access.

### Supabase CLI (developer workflow — migrations + typed client)

The model here: `schema.sql` is the one-time baseline you applied by hand;
`supabase/migrations/` holds additive changes, CLI-managed from now on and
written idempotently so a push is safe even against a manually-applied DB.

Run these on **your machine** (they need your token; never paste it in chat):

```bash
# 1. install the CLI (macOS shown; see supabase.com/docs for Linux/Windows/npx)
brew install supabase/tap/supabase

# 2. from the repo root — creates supabase/config.toml for your CLI version
#    (leaves schema.sql and migrations/ untouched)
supabase init

# 3. log in, then link this repo to your hosted project
supabase login
supabase link --project-ref <your-project-ref>   # ref = the subdomain in your project URL

# 4. apply migrations (safe even though weather was applied in the dashboard)
make db-push        # == supabase db push

# 5. generate a typed DB client for the web app
make gen-types      # writes web/src/lib/database.types.ts
```

After `make gen-types`, make the web client type-safe (optional, one line in
`web/src/lib/supabase.ts`):

```ts
import type { Database } from './database.types'
export const supabase = createClient<Database>(url, anonKey)
```

New schema changes from here on: `supabase migration new <name>`, edit the
generated file, `make db-push`. The linked project ref is stored in
`supabase/.temp/` (gitignored).

### Supabase MCP (live DB access for Claude)

This lets Claude read/inspect your database directly during a session — verify
the schema landed, confirm `readings` is filling once ingestion runs, run
ad-hoc queries. Configured project-scoped in `.mcp.json` (committed, so it
travels with the repo) and pinned to **read-only**.

The server is already in `.mcp.json`:

```json
{ "mcpServers": { "supabase": {
  "type": "http",
  "url": "https://mcp.supabase.com/mcp?project_ref=<ref>&read_only=true"
} } }
```

To use it, authenticate **in a local terminal** (not the IDE extension or a web
session — the OAuth flow needs a real terminal):

```bash
claude          # start Claude Code in the repo
/mcp            # select the supabase server → Authenticate
```

- `read_only=true` is deliberate: schema changes go through CLI migrations, not
  ad-hoc through Claude. Drop that param from `.mcp.json` only if you actually
  want Claude to be able to write.
- `project_ref` is not a secret (it's the subdomain of your project URL), so
  committing `.mcp.json` is safe. No token is stored in the repo — auth is
  per-user via the OAuth flow above.
- Optional Supabase agent skills: `npx skills add supabase/agent-skills`.

## Notes

- The `weather` migration is the only thing beyond `schema.sql`: the plan ingests
  Open-Meteo hourly but `readings` has no weather columns, so weather lands in
  its own additive `weather` table (per ward, per hour) — needed as forecast
  features in Phase 2. Nothing in `schema.sql` was modified.
- Basemap is the free MapLibre demo style — swap in a proper style (e.g.
  MapTiler) when the map starts carrying data.
- Phases 1–4 (report loop, forecast, attribution, command intelligence) are
  deliberately not built yet. See docs/build-plan.md.
