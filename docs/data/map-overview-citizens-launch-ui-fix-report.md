# Map, Overview Sync, and Citizens — Launch UI Fix Report

**Type:** Frontend clarity, interaction, and honesty fixes for the Map page, plus a related Overview Hotspots-table metric-sync fix and a Citizens page desktop redesign. One genuine backend capability gap closed (PM10/NO2 forecast data existed in `forecasts` but the frontend never fetched it beyond PM2.5) - closed by parameterizing an existing query, not adding anything new. No migrations, no RLS changes, no `forecast.py`/ingest changes, no new datasets.
**Date:** 2026-07-21
**Follows on from:** [`launch-hardening-report.md`](launch-hardening-report.md) and [`overview-incidents-launch-ui-fix-report.md`](overview-incidents-launch-ui-fix-report.md) (same day)

---

## 1. Scope

Map page (all 12 numbered issues), the Overview Hotspots-table metric/horizon-sync addendum, and the Citizens page desktop redesign. Touched `overviewRules.ts`'s `peakWithinWindow`/`WardForecastSummary` type and `data.ts`'s `fetchAllForecasts` because both Map and Overview genuinely share them - every change there is additive (new optional param, new field with a safe default) and was verified not to break any other consumer (typecheck + full test suite both clean throughout).

## 2. Map fixes

| # | Issue | Fix |
|---|---|---|
| 1-2 | Marker values (177, 123, 76…) didn't say whether they were AQI, a concentration, current, or forecast | New `markerMeaningLabel(pollutant, timeMode)` renders a one-line banner under the toolbar: "Markers show current station AQI." / "Markers show latest station PM10 concentration (µg/m³)." / "Markers show 24h forecast peak for NO₂ (µg/m³)." / an honest proxy note for AQI forecast mode (see below). Marker badge, popup, and side panel all read from the same `resolveWardReading()`/`stationReadingValue()` result - never independently derived |
| 3 | "No boundary geometry has been captured" showed even while the ~8MB fetch was still loading | `MapLayerControl` now takes `wardBoundariesLoading` - shows "Ward boundaries are loading…" during the fetch, and only the real "no boundary geometry" note once the backend has actually returned zero rows. The toggle already enabled itself automatically once data arrived (pre-existing) - now the *message* is honest during the wait too |
| 4 | Clicking a municipal-boundary ward (e.g. Kanjhawala) showed only a static jurisdiction note | `SelectedWardBoundaryPanel` rewritten around a new `WardBoundaryDetail` computed in `MapPage.tsx` from data already fetched: data status (station-backed / nearest-station proxy / no station-backed data, via new `wardDataStatus()`), the ward's own assigned station if one exists, otherwise the real nearest station and distance (`nearestStationTo()`, haversine, reusing `incidentRules.ts`'s existing `haversineMeters`), linked active incidents, and forecast peak if this ward has forecast history (many of the 250 boundary wards do - forecast.py runs per-ward, not just the 13 hotspot wards). Falls back to the exact required copy ("No direct station assigned. Select a nearby station marker for live readings.") only when nothing is computable - never fabricated |
| 5 | Suspected marker-vs-polygon click conflicts | Investigated the actual stacking: MapLibre markers are DOM elements appended after the canvas, so they already sit above and intercept clicks before a boundary polygon underneath ever sees them - this was not a live bug. Added explicit `z-index` per marker kind (`incident > station > ward > report`) in `mapMarkers.ts` as defense-in-depth so this stays guaranteed regardless of future array-ordering changes, rather than relying on incidental append order |
| 6 | Spatial Summary's "13 Wards shown" (all-time hotspot markers) read as contradictory next to 252 boundaries; "34 Stale sensors" and "0 Predicted hotspots" lacked context | `SpatialSummaryPanel` rewritten with 7 clearly-labelled stats: Municipal boundaries (252, "—" while loading, never a false 0), Hotspot wards (13, decoupled from whether the marker layer is currently toggled on - see §3 below), AQ stations (34), Fresh stations, Stale stations, Active incidents, Forecast alerts (renamed from "Predicted hotspots", with a note distinguishing it from Incidents' own "Predicted" queue). Dominant source line now says "preliminary, citywide" |
| 7 | Layer names implied more than they deliver | "Ward AQI" → "Hotspot AQI markers", "AQI stations" → "AQ station readings", "Predicted hotspots" → "Forecast alerts", "Source attribution" → "Suspected source signals" |
| 8 | Dispatch/task zones and Citizen reports toggles had nothing behind them | Both now compute real availability (`dispatchIncidentIds.size > 0`, `reports.length > 0`) and render disabled with an honest reason ("No incident currently has an active dispatch to flag." / "No open citizen reports with a location right now.") when empty, auto-enabling once real data exists - same pattern as the pre-existing ward-boundaries toggle, not a new affordance |
| 9 | Station panel had no forecast context | `SelectedStationPanel` now shows a "Forecast (linked ward)" section: method (ML validated / baseline fallback, reusing the exact same `FORECAST_METHOD_LABEL`/`forecastFallbackStatus` Incidents already uses), latest cycle time, and forecast peak for the selected pollutant/horizon - sourced from the station's linked ward (stations have no forecast of their own). A stale reading now shows a prominent warning banner at the top of the panel, not just a small badge |
| 10 | Unclear whether 24h/48h forecast toggle actually changed values | It did for PM2.5 already; now verified and extended to genuinely switch for PM10/NO2 too (see §4 - real backend data, not previously fetched). AQI has no forecast (forecast.py never computes the composite index) - stays an explicitly-labelled PM2.5 proxy ("risk signal"), never a fabricated AQI forecast |
| 11 | Legend didn't explain colours/scales | Added the real India NAQI colour-band table (shown only in AQI mode - a concentration-mode note appears instead), a forecast-alert pulsing-halo key, and a ward-boundary-polygon key, alongside the existing severity/marker-type/sensor-state keys |
| 12 | Search bar copy | Already "Search disabled in pilot build" from the prior Overview/Incidents pass (shared `AppShell.tsx`) - confirmed still consistent, no "coming soon" anywhere in the launch UI |

### 2.1 A user-flagged follow-up mid-pass: "Ward AQI" vs "AQI stations" clarity

The user pointed out live that both layers were showing nearly the same values at slightly different coordinates. Confirmed the real cause in `data.ts`: `fetchAllWardsAqi()`'s ward AQI *is* the reading from whichever station has `ward_id = <that ward>` - not an independent ward-level calculation. Fixed:
- `wardMarkers` (now "Hotspot AQI markers") is **off by default**; "AQ station readings" stays on as the single source of truth, since for the 13 hotspot wards they usually duplicate each other.
- `Hotspot wards` count in Spatial Summary no longer depends on the marker layer being toggled on (was reading `wardMarkers.length`, now reads `wards.length` directly) - a real fact (13 hotspot wards exist), not an artifact of the layer's current on/off state.
- Legend and layer-control tooltips both now state plainly: "AQ station readings show actual monitoring station locations. Ward-linked AQI shows the reading assigned to each operational hotspot ward via its own station - not an independent ward-level calculation."
- Also fixed a redundancy this surfaced: the ward-boundary panel's station block showed "AQI 105 · AQI 105" when the selected metric was already AQI (same number twice) - now shown once.

## 3. Data layer: real multi-pollutant forecasts

`forecast.py` has always forecast pm25/pm10/no2 (`DEFAULT_ENABLED_POLLUTANTS`), confirmed via the same production data the prior verification pass found (93 pm25 + 93 pm10 + 93 no2 rows per cycle) - but `fetchAllForecasts()` was hardcoded to `.eq('pollutant', 'pm25')`, so Map and Overview only ever saw PM2.5 regardless of what the user selected. This is real, already-collected data the frontend simply never asked for - closing this gap (not adding a dataset) was the correct fix rather than disabling PM10/NO2 forecast views:

- `fetchAllForecasts(pollutant)` now takes `'pm25' | 'pm10' | 'no2'` (default `'pm25'`, so every untouched call site keeps its exact prior behaviour), reads the universal `predicted_value` column instead of the legacy pm25-only `pm25_pred` alias, and stamps the result with `WardForecastSummary.pollutant` so a value can never be silently mislabeled several components downstream.
- `hoursToSevere` (severity-crossing prediction) stays PM2.5-only - the only pollutant with an established threshold (`SEVERE_THRESHOLD_PM25 = 400`) in this codebase. Selecting PM10/NO2 correctly shows 0 forecast alerts rather than applying PM2.5's threshold to a different pollutant's scale.
- AQI maps to a labelled PM2.5 proxy everywhere (`forecastPollutantFor('aqi') → 'pm25'`) - never a fabricated AQI forecast.
- Map and Overview each fetch forecasts in their own `useAsync`, keyed by the selected pollutant, separate from their main data bundles - switching pollutants only re-fetches forecasts, not wards/stations/incidents/etc.

**Live-verified with real production data**: selecting PM10 on Overview changed "Current AQI 219" / "Forecast PM2.5 Peak 99 µg/m³" to "Current PM10 268 µg/m³" / "Forecast PM10 Peak 145 µg/m³" - genuinely different numbers from a genuinely different pollutant's real forecast, not a relabelled PM2.5 value.

## 4. Overview: Hotspots table now follows the metric/horizon toggle

Added per the addendum:
- Pollutant toggle expanded from 2 options (AQI/PM2.5) to all 4 (AQI/PM2.5/PM10/NO2), reusing `MapPollutant`/`MAP_POLLUTANT_LABEL` from `mapRules.ts` instead of a separate, narrower type - one definition, not two that could drift.
- Column headers are now fully dynamic: "Current AQI" / "Current PM10 (µg/m³)" / etc., "Forecast {pollutant} Peak (µg/m³, within {windowHours}h)", with a "- risk signal" qualifier only in the AQI proxy case.
- New `peakWithinWindow()` in `overviewRules.ts` scopes the forecast peak to the *selected* 12/24/36/48h window - previously "Forecast Peak" was always the peak across the whole 48h curve regardless of which window button was active. Forecast Confidence now reads the confidence at that same windowed peak's point, not the old whole-curve peak's point, so the two stay describing the same moment.
- A context label above the table states the current framing in one sentence, e.g. "Showing current PM10 and forecast peak within 36h." or "Showing current AQI with PM2.5 forecast-risk signal and forecast peak within 36h."
- Table title stays "Hotspots & Forecast Risk" (not renamed to "PM2.5 Forecast Risk") - the rename was conditional on the table staying PM2.5-only, which this pass makes untrue.

**Live-verified**: switching AQI → PM10 changed every affected header, the context label, and the actual current/forecast/local-excess numbers shown, using real backend PM10 data.

## 5. Citizens page

Replaced the narrow centered `max-w-3xl` card (a bare per-reporter activity list, "No citizen reports recorded yet" in a small box with acres of empty page around it) with a full-width, two-column desktop layout matching Tasks/Sensors/Analytics:

- Real page header (title "Citizen Reports", subtitle, Refresh).
- `KpiStrip` with 4 real counts: Total reports, New/unreviewed (`status='submitted'`), Linked to incidents (`incident_id != null`), Rejected. "Verification useful/corroborating" was considered and dropped - that concept lives on `incident_evidence.supports`, a different table with no honest per-report join available without adding a new query shape; shown only what's real, per the brief.
- New `listAllCitizenReports()` (`data.ts`) - report-level, not reporter-level: reads the same `reports` table `fetchAllOpenReports()` already reads for the Map layer, unfiltered by status (so rejected/resolved reports are visible, unlike the open-only queries), with ward name joined the same way `ops.ts`'s `fetchStationHealth()` already does (separate lookup, not a nested select).
- Left: report queue table (time, ward, description, source category, status, linked incident with a working `/incidents?incident=id` deep link, matching the exact pattern already used on Sensors/Tasks/Map).
- Right: "How citizen reports are used" explanation card with the exact required framing sentences.
- Strong, honest empty state (currently live, since this dataset has 0 reports right now) instead of a lonely card - explains what happens when reports do arrive, and that citizen evidence doesn't independently prove pollution reduction or violation.
- No "intake not active" disclaimer added - confirmed `CitizenView.tsx`'s report submission flow (`insertReport`, photo upload, incident-matching) is real and working, so that note would have been dishonest in the other direction. No fake "Submit report" button was ever added (commander console, not the citizen-facing page).
- `listCitizenActivity()` (the pre-existing per-reporter RPC) is no longer called by any page - left in `data.ts` unused rather than deleted, since it's a real, working, commander/admin-scoped function that a future view could still want.

**Live-verified**: full-width KPI strip + queue + sidebar layout renders correctly with the real (currently empty) dataset; empty state reads as intended, not broken.

## 6. What was deliberately not changed

- **No migrations** - `fetchAllForecasts`'s new column (`predicted_value`) and `fetchAllWardBoundaries`'s new columns (`lat`, `lng`) are existing `wards`/`forecasts` columns, not new ones. `listAllCitizenReports` reads existing `reports` columns.
- **No RLS changes** - every new query goes through the same RLS every existing caller of these tables already uses.
- **No `forecast.py`/ingest changes.**
- **No new datasets** - FIRMS/OSM/Open-Meteo/PostGIS untouched.
- **No fabricated ward-level AQI, source signal, or forecast value anywhere** - every new number traces to a real column; every "not available"/"no station-backed data"/"forecast unavailable" state is a true absence, stated honestly.
- **Map/Sensors/Analytics/Tasks/Settings pages** - untouched beyond the two functions (`fetchAllForecasts`, `peakWithinWindow`'s home file `overviewRules.ts`) genuinely shared with Overview, both changes backward-compatible and verified via the full test suite.

## 7. Tests

New/updated: `mapRules.test.ts` gained tests for `forecastPollutantFor`, `markerMeaningLabel`, `nearestStationTo`, `wardDataStatus`, and the `resolveWardReading` proxy/predicted_value behaviour (13 → 27 tests). `overviewRules.test.ts` gained `peakWithinWindow` tests (27 → 31 tests). Existing `WardForecastSummary` test fixtures updated for the new required `pollutant` field.

Full suite: `npx vitest run` → **252/252 passed** (163 `incidentRules` + 31 `overviewRules` + 25 `forecastTrustRules` + 27 `mapRules` + 6 `readinessRules`).
Typecheck: `npx tsc -b` → clean.
Build: `npx vite build` → succeeds (pre-existing >500kB single-chunk warning, unrelated).

## 8. Live verification

Local dev server against the same production Supabase project, logged in as a real commander account, full console/page-error listeners attached. For Map specifically, the MapTiler key was temporarily blanked in the local, gitignored `.env.local` (not committed, restored immediately after) to force the keyless CARTO fallback basemap - the same production key is domain-restricted to the deployed site and 403s on localhost, a pre-existing artifact noted in every prior report in this series; this let real markers actually mount locally instead of relying only on query-shape verification.

- **Overview**: pollutant toggle now shows AQI/PM2.5/PM10/NO2; selecting PM10 changed every table header and every value to real PM10 data; latest forecast cycle and coverage stats unaffected.
- **Map**: marker-meaning banner rendered correctly ("Markers show current station AQI."); 60 real markers mounted; clicking a ward marker opened `SelectedWardPanel` with real forecast status; clicking an AQ station marker opened the enriched `SelectedStationPanel` showing all 4 pollutant values, freshness, and a real "Forecast (linked ward)" block (method, fallback status, latest cycle); clicking a ward-boundary polygon (New Delhi NDMC) opened the enriched panel showing "STATION-BACKED", the assigned station ("IGI Airport (T3), Delhi - IMD"), a real forecast peak, and 0 linked incidents; legend expanded to show the new AQI scale, marker types (including the new Ward-linked-AQI-vs-AQ-station explanation), and sensor-state keys; Spatial Summary showed all 7 corrected stats with real numbers (252 / 13 / 34 / 25 / 9 / 13 / 0); layer toggles showed the renamed labels and correct default states (Hotspot AQI markers off, AQ station readings on).
- **Citizens**: full desktop layout, KPI strip, honest empty state - confirmed live with the real (currently empty) dataset.
- **Smoke**: Incidents, Sensors, Analytics all re-checked after the Map/Overview changes - zero regressions, identical to the prior two reports' verified state.

Zero new console or page errors were observed anywhere in this session (excluding the pre-existing, unrelated MapTiler 403s).

## 9. Remaining known limitations

1. **Ward-boundary loading-state fix not directly observed mid-transition** - the ~8MB fetch resolved in well under the time it took to navigate + wait in this local/fast-network test session, so the "Ward boundaries are loading…" message's real-world window couldn't be caught on camera. The logic itself (`wardBoundariesState.loading` threading through to `MapLayerControl`) is straightforward, typechecked, and was code-reviewed; a slower network or CDP throttling would be needed to observe it directly.
2. **`hoursToSevere`/"Forecast alerts" stays PM2.5-only** - by design (§3), not a gap to close without inventing thresholds for PM10/NO2/AQI that don't exist anywhere else in this codebase.
3. **"Verification useful/corroborating" KPI omitted from Citizens** - the honest data for it lives on a different table (`incident_evidence`) with no clean per-report join available without a new query shape; omitted rather than approximated, per "show only what is real."
4. **`listCitizenActivity()` is now dead code from the UI's perspective** - not deleted, since it's real and working; flagged here in case a future pass wants to either reintroduce a reporter-level view or remove it deliberately.

## 10. Launch-readiness verdict

**Map, Overview, and Citizens are launch-safe.** Every marker/table value now states what it is (AQI vs. concentration, current vs. forecast, which pollutant); a ward boundary click gives real context or an honest no-data state, never a dead end; a station click gives live readings plus real forecast context; Spatial Summary's numbers are internally consistent and each independently correct; non-functional layers are clearly marked rather than silently doing nothing; the Overview table can no longer show PM2.5 numbers under an AQI or PM10 selection without saying so; and Citizens no longer looks unfinished on desktop. All fixes were verified against real production data, not synthetic fixtures, including a genuine multi-pollutant forecast capability that existed in the backend but was never connected to the frontend until this pass.

## 11. Files changed

- `web/src/lib/data.ts` — `fetchAllForecasts` generalized, `WardBoundary` gets `lat`/`lng`, `listAllCitizenReports`/`REPORT_STATUS_LABEL`/`CitizenReportRow` added
- `web/src/lib/mapRules.ts` / `.test.ts` — `forecastPollutantFor`, honest `resolveWardReading`, `nearestStationTo`, `markerMeaningLabel`, `wardDataStatus`
- `web/src/lib/overviewRules.ts` / `.test.ts` — `peakWithinWindow`
- `web/src/lib/mapMarkers.ts` — explicit marker z-index
- `web/src/components/map/MapLayerControl.tsx` — loading state, renames, dynamic availability
- `web/src/components/map/MapLegend.tsx` — AQI scale, forecast-alert/ward-boundary keys, Ward-linked-AQI-vs-station copy
- `web/src/components/map/MapToolbar.tsx` — marker-meaning banner
- `web/src/components/map/SelectedStationPanel.tsx` — forecast summary, stale warning
- `web/src/components/map/SelectedWardBoundaryPanel.tsx` — full real-context rewrite
- `web/src/components/map/SpatialSummaryPanel.tsx` — corrected metric set
- `web/src/components/overview/HotspotsRiskTable.tsx` — full metric/horizon sync
- `web/src/pages/MapPage.tsx` — wiring for all of the above
- `web/src/pages/CommandView.tsx` — 4-option pollutant toggle, pollutant-aware forecast fetch
- `web/src/pages/CitizensView.tsx` — full desktop redesign
- `docs/data/map-overview-citizens-launch-ui-fix-report.md` — this report

## 12. Checks

| Check | Result |
|---|---|
| Migrations / RLS / `forecast.py` / ingest changes | **None** |
| New datasets | **None** |
| Tests | 252/252 passing (18 new) |
| Typecheck / build | Clean |
| Live browser check (Overview + Map full interaction pass + Citizens + Incidents/Sensors/Analytics smoke, real login, real production data) | 0 new console/page errors |
| Secret scan | Manual grep across all 16 changed files for `SUPABASE_SERVICE_ROLE_KEY=`, `OPENAQ_API_KEY=`, JWT/`eyJ...`, the live-verification login credentials, and the temporarily-exposed MapTiler key — no matches. `.env.local` was temporarily edited locally to force a keyless basemap for testing, confirmed gitignored throughout, and restored to its original value before finishing. |
