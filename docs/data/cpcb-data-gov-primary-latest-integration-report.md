# CPCB/data.gov — Preferred Latest-Reading Source Integration

**Type:** New reconciliation feature (backend client/matcher/reconciler + 3 UI surfaces, overlay-only). Does not touch OpenAQ historical backfill, `forecast.py`, RLS, or migrations.
**Date:** 2026-07-22

## Summary

Vayu Gati's **latest displayed readings** (Overview hotspot table, Sensors station status, Map station popups) now prefer the official CPCB/data.gov real-time feed over OpenAQ when a station is matched and CPCB's reading is fresh — falling back to the existing OpenAQ-sourced value otherwise. **OpenAQ's historical backfill and `forecast.py`'s training inputs are completely unchanged** — this integration only ever decides what number to *show* for "latest," never what data trains a forecast.

Every surface carries the required labels: **"Latest readings: CPCB/data.gov preferred · OpenAQ fallback."** and **"AQI computed using CPCB breakpoint logic."**

## Architecture

Same additive-overlay pattern as the Delhi OTD integration (see the companion report): no new Supabase table, no migration, no RLS change. The ingest service fetches, matches, and reconciles on a 10-minute scheduled job, caches the result in memory, and serves it from `GET /readings/latest`. The frontend fetches this independently, **alongside** its existing Supabase queries — never replacing them — and overlays the CPCB value at render time only when it's genuinely usable.

```
data.gov.in CPCB (paginated JSON) → data_gov_cpcb.py (fetch + parse + normalize pollutants)
                                  → station_matching.py (name → our station id, exact-match-after-normalization only)
                                  → latest_readings.py (reconcile vs. our own OpenAQ-sourced latest reading, per station)
                                  → main.py's _last_cpcb_reconcile cache, refreshed every 10 min
                                  → GET /readings/latest
                                  → web/src/lib/data.ts's fetchLatestReadingsPreferred()
                                  → Overview hotspot table / Sensors table+detail / Map popup+detail
```

## How station matching works

Data.gov.in's live station names don't exactly match our own `stations.name` values — not just the [documented CPCB-PDF misspellings](delhi-station-reconciliation.md) (Mundaka/Mundka, VivekVihar/Vivek Vihar, etc.), but also **authority-label mismatches only visible in the live feed** (e.g. CPCB reports `"IMD Lodhi Road, Delhi - IITM"` for the same physical station our own DB calls `"Lodhi Road, New Delhi - IMD"` — different authority tag, different word order).

`station_matching.normalize_station_name()`: lowercases, strips punctuation, drops a fixed noise-token set (`delhi`, `new`, `ncr`, `dpcc`, `cpcb`, `imd`, `iitm`), applies a small documented alias table for the known misspellings/concatenation artifacts, then sorts the remaining tokens so word order never matters. Two names match **only** if their normalized forms are byte-identical — never a fuzzy/distance-based guess, per the explicit "do not guess unsafe matches" requirement. Colliding normalizations (two of our own stations reducing to the same key) are excluded from the match index entirely rather than picked arbitrarily.

Verified against the real live feed during this integration: **34/34 of our own stations matched**, 0 collisions, 0 false positives found.

## How fallback works

For each of our 34 stations, `latest_readings.reconcile_latest()` computes:
- **`matched`** — a CPCB station name normalized to this station.
- **`cpcb_missing`** — matched, but CPCB had no recognized pollutant values for it.
- **`cpcb_stale`** / **`openaq_stale`** — reading older than 180 minutes (the same threshold already shared by `ops.ts`'s `STATION_STALE_MINUTES` and `overviewRules.ts`'s `HOTSPOT_READING_STALE_MINUTES`).
- **`value_mismatch`** — CPCB and OpenAQ AQI differ by more than 50 points on the same station.
- **`source_used`** — `cpcb` only when matched, not missing, and not stale; `openaq_fallback` otherwise. **Every one of our 34 stations always gets a row** — an unmatched or fully-unavailable CPCB reading never drops a station, it just falls back.

**A real bug caught and fixed during this integration:** data.gov.in's `last_update` field is `"DD-MM-YYYY HH:MM:SS"` in IST, not ISO 8601. The first implementation parsed it with `datetime.fromisoformat`, which silently failed and treated every CPCB reading as unparseable → permanently stale → 100% fallback to OpenAQ, even though the feed was actually fresh. Caught by running the real reconciliation and noticing all 34 stations showed `cpcb_stale` despite a fresh fetch — not assumed correct from the API docs. Fixed with an explicit IST-aware parser, covered by 3 new tests using the real timestamp format.

## AQI computation

When CPCB is the preferred source, `aqi.compute_aqi(pm25, pm10)` — the **same existing CPCB breakpoint function** already used everywhere else in this app — computes the AQI from CPCB's own PM2.5/PM10 concentrations. `data.gov.in`'s feed does not provide a composite AQI value directly (only per-pollutant `avg_value`/`min_value`/`max_value`), so this integration never claims to show "the official CPCB AQI," only "AQI computed using CPCB breakpoint logic" from CPCB's own concentration readings — exactly the required, honest framing.

## Files changed

| File | Change |
|---|---|
| `ingest/app/config.py` | `DATA_GOV_API_KEY` (added in the prior audit task; unchanged here). |
| `ingest/app/data_gov_cpcb.py` (new) | Paginated fetch (walks `offset` until `total` or a 2000-row safety cap), pollutant normalization (`PM2.5→pm25`, etc.; `NH3` parsed but has no home in our schema, same as `openaq.py`), `group_by_station()`. |
| `ingest/app/station_matching.py` (new) | `normalize_station_name()`, `build_match_index()`, `match_station()` - exact-match-after-normalization only. |
| `ingest/app/latest_readings.py` (new) | `reconcile_latest()` - the per-station comparison/flags/source-selection logic described above. |
| `ingest/app/db.py` | Added `get_all_stations()` and `get_latest_readings_by_station()` (read-only, per-station-loop pattern matching the frontend's own `fetchStationHealth()`). |
| `ingest/app/main.py` | `run_cpcb_reconcile()` (untracked, same `job_runs` CHECK-constraint reasoning as `run_transit`), scheduled every 10 min + on bootstrap, `GET /readings/latest`, `POST /readings/refresh`. Reuses the httpx-logging fixes already in place from the OTD integration. |
| `ingest/tests/test_station_matching.py` (new) | 13 tests, including the real live authority-label-mismatch cases found during this integration. |
| `ingest/tests/test_latest_readings.py` (new) | 15 tests: source selection, AQI computation, value-mismatch flagging, the IST-timestamp bug fix, and "every one of our stations always gets a row." |
| `web/src/lib/data.ts` | `LatestReadingReconciliation` type + `fetchLatestReadingsPreferred()` (best-effort, same pattern as `fetchTransportActivity`). |
| `web/src/components/overview/HotspotsRiskTable.tsx` | AQI cell prefers `cpcbAqi` when `sourceUsed==='cpcb'`, with a small source dot + tooltip; footer carries both required labels. |
| `web/src/pages/CommandView.tsx` | Independent `fetchLatestReadingsPreferred()` fetch, ward-keyed map passed to the table. |
| `web/src/components/sensors/SensorHealthTable.tsx` / `SensorDetailPanel.tsx` | Same source-dot treatment on the "Latest AQI" column and detail panel; column header tooltip carries the label. |
| `web/src/pages/SensorsView.tsx` | Independent fetch, overrides `aqi` + adds `readingSource` when building each row; static label line added. |
| `web/src/components/map/SelectedStationPanel.tsx` | `readingSource` on `SelectedStation`; AQI `dt` shows "(CPCB/data.gov)" / "(OpenAQ fallback)". |
| `web/src/pages/MapPage.tsx` | Independent fetch; station markers' `aqi` and popup text, and the selected-station detail panel, all prefer CPCB when usable. |

## Live verification numbers (this integration's own test run)

- **CPCB records fetched:** 315 (1 page via pagination; Delhi's real total).
- **Distinct CPCB stations in the feed:** 45 (11 of which we don't track at all — JNU, ITO, Pusa, IIT Delhi, Chandni Chowk, etc. — correctly left unmatched, not fabricated).
- **Our stations matched:** 34/34 (100%).
- **Stations using CPCB (fresh run):** 34/34.
- **Stations using OpenAQ fallback:** 0 in that run (all CPCB data was fresh); confirmed separately that every station correctly falls back to `openaq_fallback` when the key is unset or the API call fails (34/34 both times, no crash).
- **Unmatched stations:** 0.
- **Flags seen on a real run:** `openaq_stale` on 31/34 (our own OpenAQ feed happened to be stale at the time - independent of CPCB's freshness, and exactly consistent with what the Sensors page's own "31 stale stations" KPI already showed), `value_mismatch` on 3/34 (real, honest divergences - e.g. Wazirpur: CPCB AQI 304 vs. OpenAQ AQI 230 - flagged, not hidden or silently reconciled).

## Verification

- **`DATA_GOV_API_KEY` not in git diff**: confirmed via `git diff --check` (clean) and a repo-wide grep for the literal key string (zero matches in anything tracked or trackable — only the gitignored `ingest/.env` contains it).
- **`git diff --check`**: clean.
- **Ingest tests**: `pytest` 82/82 (28 new: 13 station-matching + 15 latest-readings).
- **Typecheck/tests/build**: `tsc -b` clean; `vitest run` 266/266 (unchanged - no new frontend pure-logic function needed here); `vite build` succeeds.
- **Overview, Sensors, Map load without console errors**: confirmed live (Playwright, real login) - zero console errors on all three.
- **Live screenshots confirm the actual UI**: Overview's hotspot table shows blue "CPCB-preferred" dots next to real AQI values (e.g. Wazirpur 302) plus the required footer label; Sensors' table and detail panel both show the same dot/label treatment (e.g. Alipur, Delhi - DPCC: AQI 102, "LATEST READINGS (CPCB/data.gov)"); Map's station detail panel shows "AQI 102" and "AQI (CPCB/data.gov) 102" side by side for the same station, confirming the override renders correctly end-to-end. (Map's tile rendering needed the established dev-only MapTiler-key workaround — see Known limitations below - restored immediately after the check.)

## Known limitations

- Sensors' existing "Stale" badge and "No reading in over 180 minutes" warning are about **OpenAQ's own** reading freshness (an existing, unrelated concept) - a station can correctly show both a "Stale" OpenAQ badge *and* a fresh CPCB-preferred AQI value at the same time. This is accurate, not contradictory, but reads as a mixed signal at a glance; a future pass could relabel the badge to be source-aware if this proves confusing in practice.
- If the live CPCB feed ever lists two station names that both normalize to the same one of our stations (not observed in this integration's own test run against 315 real records), the later one in iteration order silently wins - a documented, not crash-causing, limitation of `latest_readings.py`.
- Pollutant-level (PM2.5/PM10/NO2) values in the Overview hotspot table's non-AQI views still show the existing OpenAQ-sourced numbers unchanged - only the AQI column itself was switched to prefer CPCB, per the task's explicit "where safe" scoping and to keep this change's blast radius contained.
