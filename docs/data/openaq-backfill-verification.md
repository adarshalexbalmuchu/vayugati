# OpenAQ Historical Backfill — Verification Report

**Type:** Read-mostly verification audit. No migrations were created. No live data was modified except two explicitly-scoped, idempotent verification calls documented in [Section 4](#4-live-ingest-safety-check) (a live-ingest smoke test that only refreshes the current hour, and a 1-day read-only OpenAQ API probe) — both safe, both reversible by nature (idempotent upserts / pure reads).
**Date:** 2026-07-20
**Commit audited:** `1b17906` "Add OpenAQ historical backfill and fix silent 1000-row cap in forecast history reads" (merged via PR #1 from `RAK2315/ml/real-data-backfill`, fast-forwarded into `main` at `9f9724c`).

---

## 1. Summary

The backfill is **safe, idempotent, and forecast-ready for 9 of the 11 resolved Delhi stations**. The upsert key (`station_id, ts`) exactly matches the real database's `unique(station_id, ts)` constraint on `readings`, and the table is intentionally "wide" (pollutants are columns, not rows), so pollutant identity does not need to be part of the key — this was confirmed correct by schema inspection, not assumed. Live data confirms zero duplicate rows, zero negative/implausible values, and 100% hour-aligned timestamps. A live smoke-test of the unmodified hourly ingest path completed successfully after this PR's changes.

Two real, concrete findings surfaced during this audit, detailed below — **neither blocks proceeding**, but both are worth acting on:
1. **2 of 11 configured stations (Anand Vihar, Punjabi Bagh) have zero backfilled history** — root-caused to an upstream OpenAQ data-availability gap (confirmed via a direct, read-only API test), not a bug in this codebase.
2. **15 pre-existing stray rows from 2021–2022 sit in `readings`**, unrelated to this backfill (evidence below), and already excluded from every current query path (forecast/attribution only ever look back 30 days) — but worth a data-hygiene note.

**Recommendation: safe to proceed to the next phase.**

---

## 2. Files inspected

| File | Change |
|---|---|
| `ingest/app/db.py` | `+_fetch_all()` (paginates past PostgREST's silent 1000-row cap via `.range()`), `+bulk_upsert_readings()` (batched upsert, 500 rows/chunk, same conflict target as the existing single-row path) |
| `ingest/app/openaq.py` | `+get_sensor_hours()` — historical hourly-aggregate fetch per sensor, paginated, 500-page hard safety cap |
| `ingest/scripts/backfill_history.py` (new) | CLI backfill script: `--days`/`--only`/`--dry-run`/`--pause` flags, reuses `stations.yaml`, mirrors `app/ingest.py`'s `_ensure_station` exactly |

No other file under `ingest/` (or anywhere else) was touched by this commit — confirmed via `git show --stat`.

## 3. Stations, pollutants, date range, tables, conflict target

| Item | Finding |
|---|---|
| **Table(s) written** | `readings` only, via `bulk_upsert_readings()`. `stations` was not written to (all 11 configured stations already existed from live ingest; `_ensure_station` only inserts on a cache miss). |
| **Upsert conflict target** | `station_id, ts` — confirmed to exactly match `readings`' real schema constraint: `unique (station_id, ts)` (`supabase/schema.sql:61`). |
| **Stations covered (with real backfilled data)** | **9 of 11** resolved stations: Narela, Bawana, Mundka, Wazirpur, Rohini, Okhla, Jahangirpuri, Vivek Vihar, Dwarka. (Matches the commit message's own claim of "9 Delhi wards.") |
| **Stations configured but NOT backfilled** | **Anand Vihar, Punjabi Bagh** — see [Section 6](#6-root-cause-anand-vihar--punjabi-bagh-have-zero-history) for root cause. |
| **Stations correctly excluded (unresolved)** | R.K. Puram, Mayapuri — no `openaq_location_id`, correctly skipped by both the backfill and live ingest (`stations_skipped_no_id`), consistent with the existing "DO NOT GUESS" policy. |
| **Pollutants covered** | All 6: `pm25`, `pm10`, `no2`, `so2`, `co`, `o3`, plus computed `aqi`. Non-null coverage across the 9 real-backfilled stations: pm25 97.8%, pm10 98.5%, no2 99.6%, so2 98.4%, co 98.8%, o3 98.5%, aqi 98.9% (of 11,912 rows). No pollutant is meaningfully under-covered relative to the others. |
| **Date range (real backfill)** | `2026-05-21T13:00:00Z` → `2026-07-20T14:00:00Z` — 61 days, matching the script's `--days 60` default plus the partial current day. |

## 4. Idempotency check

**Is the upsert key correct given the table shape?** Yes. `readings` stores one row per `(station_id, ts)` with every pollutant as its own column (`pm25 double precision`, `pm10 double precision`, ... — see schema above) — it is a **wide** table, not a long/narrow one. A single hour's reading for a station legitimately contains all 6 pollutants **in one row**, so pollutant identity is encoded in the *column*, not the *row* — it correctly does **not** need to be part of the uniqueness key. `station_id, ts` is sufficient and correct.

**Does the backfill's row-merge logic respect this?** Yes. `backfill_station()` builds one dict per hour (`by_hour[ts][col] = val`) by merging every sensor (pollutant) for a station before writing, then upserts one row per hour — identical in shape to the pre-existing live-ingest path's `_ingest_station()`, which does the exact same per-hour merge. Both call sites even share a byte-identical `_hour_floor_utc()` implementation, so a live-ingested hour and a backfilled hour for the same real-world hour always compute the same `ts` — no near-duplicate-but-not-identical rows are possible.

**Does a partial-column upsert risk clobbering columns it doesn't mention?** No — verified by design, not assumed. PostgREST's upsert only sets the columns present in the JSON payload for that row; a payload of `{"station_id": 5, "ts": ..., "pm25": 42}` (missing pm10/no2/etc., e.g. because a sensor hadn't reported for that hour) updates only `pm25` on conflict and leaves any pre-existing values in the other columns untouched. This is the exact same partial-merge pattern the *existing* live-ingest path has already relied on safely — the backfill introduces no new risk here, it reuses an established, already-correct pattern.

**Live verification (11,912 real backfill rows, `>= 2026-01-01`):**

| Check | Result |
|---|---|
| Duplicate `(station_id, ts)` pairs | **0** |
| Rows with negative or implausibly extreme values (e.g. pm25 > 1000, pm10 > 2000, any pollutant < 0) | **0** |
| Rows not aligned to an exact hour boundary | **0** |
| Timezone consistency | All timestamps stored as `timestamptz` (inherently UTC-normalized by Postgres); every value produced by `_hour_floor_utc()` is explicitly UTC before being written — confirmed consistent between the backfill and live-ingest code paths. |

**Live smoke-test of the unmodified live-ingest path** (`app/ingest.py`'s `run()`, called once, for real, against the live project): completed successfully — `readings_upserted: 24`, zero errors on the OpenAQ/readings side. (4 of 13 weather/Open-Meteo calls hit a TLS handshake timeout, but this is a sandboxed-environment networking artifact, not related to this PR — each station's ingestion is independently try/excepted, so those 4 failures were caught, logged, and didn't affect the other 9 wards' weather or any station's readings.) **Live ingest is confirmed unaffected by this merge.**

## 5. Gaps and coverage

| Ward | Rows | Coverage of 1,442-hour window | Max single continuous gap |
|---|---|---|---|
| Narela | 1,316 | 91.3% | 53h |
| Bawana | 1,304 | 90.4% | 53h |
| Mundka | 1,346 | 93.3% | 53h |
| Wazirpur | 1,327 | 92.0% | 53h |
| Rohini | 1,346 | 93.3% | 53h |
| Okhla | 1,303 | 90.4% | 53h |
| Jahangirpuri | 1,326 | 92.0% | 53h |
| Vivek Vihar | 1,303 | 90.4% | 53h |
| Dwarka | 1,341 | 93.0% | 53h |

**Every station's single worst gap is identical — exactly 53 hours, from `2026-06-23T10:00Z` to `2026-06-25T15:00Z`.** That's not independent sensor noise (nine unrelated devices don't coincidentally share an identical max-gap length); it's a real, city-wide outage in the underlying CPCB/DPCC network (or an OpenAQ-side ingestion gap) affecting every Delhi station simultaneously for ~2.2 days. This is an honest reflection of real monitoring-network downtime, not a defect in the backfill script — flagging it here so it isn't mistaken for one later.

## 6. Root cause: Anand Vihar & Punjabi Bagh have zero history

Both stations are live-monitored today (real `external_ref`/OpenAQ location IDs, both present in `stations.yaml`, both configured normally) but returned **zero rows** from the historical backfill. Diagnosed with a direct, read-only OpenAQ API probe (the API key was used only in the request header, never printed or logged):

| Location | `get_location()` sensors | `get_sensor_hours()` for a 1-day test window |
|---|---|---|
| Anand Vihar (loc 10487) | 6 sensors (co, no2, o3, pm10, pm25, so2) — normal | **0 rows** |
| Punjabi Bagh (loc 6357) | 6 sensors — normal | **0 rows** |
| Narela (control, loc 10485) | 18 sensors (parameter list duplicated, likely device-replacement history) | **24/24 rows** — full day, no gaps |

The location/sensor metadata resolves cleanly for both stations (not a broken `openaq_location_id`), and the exact same code path works perfectly against a control station in the same test. This points to an **upstream OpenAQ gap**: these two sensors' hourly aggregation isn't available via `/sensors/{id}/hours`, for reasons outside this codebase (possibly a newer/recently-recalibrated device whose historical rollup hasn't been computed yet, or a gap specific to OpenAQ's own pipeline for these two IDs). **This is not a bug in `ingest/`.**

## 7. Data hygiene note: 15 pre-existing stray rows (unrelated to this backfill)

`readings` also contains 15 rows dated 2021-09-20, 2022-10-16, and 2022-10-30/31 — far outside any window this backfill (or live ingest) would ever request. Evidence these **predate and are unrelated to** the backfill PR:

- They carry the **lowest `id` values in the entire table** (1–25, out of 11,927 total rows) — `id` is a `bigserial`, assigned in insertion order, so these were the very first rows ever written to this table.
- 9 of them share the **exact same timestamp** (`2022-10-31T00:00:00Z`), one per station, each with severe pollution values (AQI 370–438) — a pattern (perfect synchronization across independent real devices, uniformly severe readings) far more consistent with manually-seeded demo/test data than real sensor telemetry.
- No fixture file anywhere in the repository contains these dates or values (`grep`-checked against `ingest/tests/fixtures/` and the whole repo).
- The backfill's OpenAQ requests only ever covered `2026-05-21` onward — there is no code path in this PR that could have produced a 2021/2022 timestamp.

**Practical impact: none.** `attribution.py` and `forecast.py` both call `get_readings_history(hours=24*30)` — a fixed 30-day lookback from *now* — which never reaches back far enough to include 2021/2022 data regardless of this issue. These rows are inert. Recommended as a housekeeping item for a future pass (see [Section 9](#9-fixes-required)), not a blocker.

## 8. Forecast readiness

`forecast.py`'s `MIN_TRAIN_ROWS = 24 * 10 = 240` (~10 days) is the threshold below which it falls back to diurnal-persistence instead of training a real LightGBM model.

**All 9 backfilled wards clear this threshold for every one of the 6 pollutants**, with wide margin — the single lowest count observed across all ward×pollutant combinations is **1,239** (Narela, o3), still ~5.2x the threshold. There is no pollutant or ward in the backfilled set that is "borderline."

| | Result |
|---|---|
| Stations with sufficient data (≥240 rows, every pollutant) | Narela, Bawana, Mundka, Wazirpur, Rohini, Okhla, Jahangirpuri, Vivek Vihar, Dwarka (**9/9 backfilled stations**) |
| Stations with insufficient data | Anand Vihar, Punjabi Bagh (**0 real rows** — not "insufficient," genuinely empty; R.K. Puram and Mayapuri were never backfilled since they have no resolved station at all) |
| Pollutants with enough history everywhere | All 6 (pm25, pm10, no2, so2, co, o3) |
| **Recommended first pollutant to forecast** | **PM2.5** — matches `city_config.pollutant_priority`'s existing priority-1 ordering, matches `aqi.compute_aqi()`'s existing PM-only design, and is the pollutant the PR's own commit message already validated end-to-end ("Jahangirpuri PM2.5 validated to 48h"). |

## 9. Fixes required

No bug requires a code fix to proceed. Two follow-ups are recommended, smallest-safe-fix first:

1. **Re-run the backfill for the 2 missing stations once OpenAQ's history becomes available**: `python scripts/backfill_history.py --days 60 --only "Anand Vihar" --only "Punjabi Bagh"`. Safe to run repeatedly (idempotent) — worth a periodic retry (e.g., weekly) rather than a one-time fix, since the root cause is upstream and its timeline is unknown. Not executed as part of this audit, since it isn't needed to unblock forecast work on the other 9 wards.
2. **(Optional, low-priority) Clean up the 15 stray 2021/2022 rows** identified in Section 7, purely for data hygiene — they have zero effect on any current query path, so this is not urgent.

No change to `on_conflict` targets, no schema migration, and no change to the live-ingest path are needed — all verified correct as-is.

## 10. Recommendation

**Safe to proceed to the next phase.** The backfill is idempotent (zero duplicates, correct conflict target matching the real DB constraint), does not threaten live ingest (confirmed via a real smoke test), and gives the forecast model a clean, sufficiently large, real historical dataset for 9 of the city's 11 monitored wards — comfortably past the training-data threshold for every pollutant. The 2-station gap and the legacy stray rows are both understood, both non-blocking, and both have a clear, minimal path to resolution whenever convenient.
