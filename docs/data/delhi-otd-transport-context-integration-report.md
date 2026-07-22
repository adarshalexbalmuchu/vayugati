# Delhi Open Transit Data — Transport-Activity Context Layer Integration

**Type:** New context-layer feature (backend fetcher/summarizer + 3 UI surfaces). No AQI calculation, forecast.py, RLS, or migration changes.
**Date:** 2026-07-22

## Summary

Vayu Gati now shows real-time Delhi public-transport activity (via Delhi Open Transit Data's GTFS-realtime feed) as an explicit **context layer** on Overview, the Hotspot table, and Map — never as pollution evidence, congestion measurement, or vehicular-emission attribution. Every surface carries the same two required labels verbatim: **"Public transport activity via Delhi Open Transit Data."** and **"Context layer only — not proof of emissions or congestion."**

## Architecture

No new Supabase table, no migration, no RLS change. The ingest FastAPI service fetches and decodes the real-time feed on a 5-minute scheduled job (`run_transit`, same pattern as the existing `run_ops`), computes a derived, ward-level summary in memory, and serves it from a new read-only `GET /transit/activity` endpoint. The frontend polls that endpoint independently of its Supabase queries — a failure or missing key there never blocks or blanks the rest of Overview/Map.

```
Delhi OTD (protobuf) → delhi_otd.py (decode, in-memory only)
                     → transit_activity.py (pure summary: counts + per-ward buckets)
                     → main.py's _last_transit cache, refreshed every 5 min
                     → GET /transit/activity
                     → web/src/lib/data.ts's fetchTransportActivity() (best-effort, 8s timeout)
                     → Overview card / Hotspot table column / Map layer
```

Raw per-vehicle data (id, exact trip, exact position) **never reaches the browser at all** — only city-wide counts and a per-ward vehicle-count/activity-level bucket, matching "derived summary only."

## Two key-leak bugs found and fixed during this integration

Both were caught by directly testing the failure paths (missing key, API failure) before considering this done, not assumed safe from code review alone.

1. **httpx's own INFO-level request logging.** `main.py` calls `logging.basicConfig(level=logging.INFO)`; httpx logs every request's full URL — including the `?key=...` query parameter — at INFO. Running `run_transit()` printed the real key to stdout. **Fixed**: `logging.getLogger("httpx").setLevel(logging.WARNING)` (and `httpcore`) added once in `main.py`, covering every module in the process.
2. **Exception string embedding the request URL.** `delhi_otd.py`'s error handler used `logger.warning(..., exc_info=True)`; `httpx.HTTPStatusError`'s own string representation includes the full request URL (key included) in both its `str()` and its traceback. **Fixed**: now logs only `exc.response.status_code` / `type(exc).__name__`, never the exception object or its traceback, for any httpx error in this module.

Both fixes were verified by deliberately triggering the failure path again afterward and grepping the output for the literal key string — clean both times. **The real `DELHI_OTD_API_KEY` was printed to this session's tool output once, before fix #1 was applied and verified.** It was never committed and never appears in any tracked file, but given it was exposed in a terminal session, I'd recommend rotating it as a precaution — I can't fully guarantee no part of that output is retained anywhere outside this repo.

## Files changed

| File | Change |
|---|---|
| `ingest/app/config.py` | `DELHI_OTD_API_KEY` env var (optional, not in `require_env()`). |
| `ingest/.env.example` | Placeholder line. |
| `docs/ENVIRONMENT_VARIABLES.md` | Documented, added to the never-client-side list. |
| `ingest/requirements.txt` | Added `gtfs-realtime-bindings>=2` (tiny, pure-Python, one dependency: `protobuf`; no conflicts with existing pins). |
| `ingest/app/delhi_otd.py` (new) | Real-time client: fetch + protobuf decode, in-memory only, never raises (`None` on any failure). |
| `ingest/app/transit_activity.py` (new) | Pure derivation: `summarize_activity()` (live buses, active routes, per-ward count/level via haversine buffer) and `unavailable_summary()`. |
| `ingest/tests/test_transit_activity.py` (new) | 10 tests: haversine, counting, buffer exclusion, missing-coordinate wards skipped (not fabricated), activity-level buckets, required disclaimer text, unavailable-state shape. |
| `ingest/app/db.py` | Added `get_hotspot_wards()` (read-only, mirrors the frontend's `is_hotspot=true` scope). |
| `ingest/app/main.py` | `run_transit()` (untracked — `job_runs.job_name` has a hard CHECK constraint on 6 fixed values; adding a 7th needs a migration this integration avoids, same precedent as the existing `attribution.run()` call), scheduled every 5 min + on bootstrap, `GET /transit/activity`, `POST /transit/refresh` (manual trigger, matches `/run`/`/intel`/`/ops`), and the two logging fixes above. |
| `web/src/lib/data.ts` | `TransportActivitySummary`/`TransportActivityWard` types + `fetchTransportActivity()` (best-effort, 8s timeout, same pattern as `classifyReport`). |
| `web/src/components/overview/TransportActivityPanel.tsx` (new) | Overview card: live buses tracked, active routes, both required labels. |
| `web/src/pages/CommandView.tsx` | Wired the panel into the bottom row (now 4 cards); independent `useAsync`. |
| `web/src/components/overview/HotspotsRiskTable.tsx` | New "Transit Activity" column — per-ward badge, "—" (not fabricated) when a ward isn't in the current summary. |
| `web/src/lib/mapMarkers.ts` | `TRANSIT_ACTIVITY_HEX` — a new teal palette, deliberately distinct from AQI/status/source-attribution colours so it never reads as a severity signal. |
| `web/src/components/map/MapLayerControl.tsx` | New `transitActivity` layer, off by default, disabled until real data exists (same `*Available` prop pattern as `dispatchZones`/`citizenReports`). |
| `web/src/components/map/MapLegend.tsx` | Legend entries + both required disclaimer sentences when the layer is on. |
| `web/src/pages/MapPage.tsx` | Independent `useAsync` fetch; ward-positioned markers only (no per-vehicle data ever reaches the browser), vehicle count as badge text, both labels in the popup. |

## Verification

- **Key not in git diff**: `git diff --check` clean; repo-wide grep for the literal key string returns zero matches in any tracked or trackable file.
- **App works with `DELHI_OTD_API_KEY` missing**: `run_transit()` with the key cleared returns `unavailable_summary` with `unavailable_reason` set and `live_buses_tracked: None` — confirmed directly, no crash.
- **App works if the Delhi OTD API fails**: same, confirmed by pointing the client at a real 404 URL — degrades to the same unavailable shape, no crash, no stack trace with the key in it (post-fix).
- **Typecheck**: `tsc -b` clean.
- **Tests**: `vitest run` 266/266 (unchanged — no frontend pure-logic function needed a new test here, the new logic is presentational); `pytest` (ingest) 53/53 (10 new).
- **Build**: `vite build` succeeds.
- **Live check**: real authenticated call against the actual feed (4,000–4,700+ live vehicles, 1,200+ routes across runs — real-world traffic naturally fluctuates between calls). Overview shows the new card + hotspot-table column with real per-ward counts; Map's "Public transport activity" toggle renders real teal ward markers with vehicle counts and the correct popup labels. Zero console errors on either page.

## Known limitations

- Ward scoring uses a fixed 3km buffer from each hotspot ward's centroid — a documented heuristic, not a precise service-area boundary.
- The `none`/`low`/`medium`/`high` activity buckets are simple, documented count thresholds (0 / ≤5 / ≤15 / 16+), not derived from any historical baseline — there isn't one yet.
- The summary refreshes every 5 minutes; a request between refreshes sees the previous cycle's numbers, not a live-to-the-second count.
