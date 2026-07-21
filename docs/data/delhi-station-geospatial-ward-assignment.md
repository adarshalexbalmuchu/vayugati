# Delhi Station Geospatial Ward-Assignment Audit

**Type:** Read-only audit / dry-run. No migrations created, no RLS touched, no UI changed, no Supabase rows written, no station fabricated, no `OPENAQ_API_KEY` printed or logged. `shapely` was installed into `ingest/.venv` (git-ignored, not added to `requirements.txt`) purely to run this one-off analysis — no project dependency changed.
**Date:** 2026-07-21
**Follows on from:** [`delhi-station-expansion-report.md`](delhi-station-expansion-report.md) §5 (the 18-station "needs manual review" backlog)

---

## 1. Summary

All **18** backlog stations were evaluated: live coordinates re-fetched from OpenAQ (read-only, re-verified rather than trusted from the older report), validated against the app's own `DELHI_BOUNDS` box, and tested with real point-in-polygon geometry against all **252** imported Delhi ward boundary polygons (`shapely`, not hand-rolled ray-casting).

- **15 of 18 are safe to import** — each station's coordinate falls inside exactly one ward polygon, well clear (≥71m) of any boundary edge.
- **3 of 18 need manual review** — not guessed either way:
  - **ITO** sits ~30m from the `DELHI GATE`/`DARYAGANJ` shared boundary — inside `DELHI GATE` today, but close enough that import-precision could put it on either side.
  - **Pusa (DPCC)** and **Pusa (IMD)** — two distinct OpenAQ stations at (confirmed) nearly identical real-world coordinates — both land inside **two overlapping ward polygons simultaneously** (`New Delhi (NDMC)` and `INDER PURI` genuinely overlap by ~3.26 km² in the imported boundary data itself — a real data-quality finding, not a bug in this analysis; see §6).
- **0 of 18 are unresolved** — every station fell within Delhi's bounds and inside at least one ward polygon.

**A real, unrequested finding surfaced by doing this geometrically rather than by name:** the ward row named `New Delhi (NDMC)` is not actually the small (~43 km²) NDMC municipal jurisdiction its name implies — its `metadata.osm_official_name` is `"New Delhi District"`, an OSM admin_level-5 **revenue district**, ~162 km². Four of the 15 "safe" stations (Major Dhyan Chand National Stadium, MandirMarg, IGI Airport Terminal-3, Lodhi Road) land inside this one oversized polygon, spread across a real ~11km span (Lodhi Road to the airport) that would all be attributed to a single "ward" for forecasting purposes. Geometrically correct, still worth a product decision — see §6.

---

## 2. Backlog extracted (18 stations)

Pulled verbatim from `delhi-station-expansion-report.md` §5 — the same 18 official Delhi CAAQMS stations verified live on OpenAQ but left unimported because no safe ward-name match existed. **Pitampura excluded** (no OpenAQ match at all, unrelated to ward assignment). **Mayapuri excluded** (not an official CPCB/DPCC/IMD station, no OpenAQ match — nothing to geo-assign).

Re-verified live in this audit (`openaq.get_location`/`get_latest`, read-only): all 18 still resolve, all still report 2026-07 data. No change to any id.

## 3. Coordinate validation

All 18 coordinates fall inside the app's own `DELHI_BOUNDS` (`web/src/lib/mapRules.ts`: `minLng 76.7 / maxLng 77.7 / minLat 28.2 / maxLat 29.0`) — reused rather than inventing a new bounding box, so this audit's notion of "inside Delhi" matches what the app itself already enforces for every marker it renders. 0 of 18 failed this check.

## 4. Dry-run table (point-in-polygon results)

| Official station name | OpenAQ id | Latitude | Longitude | Matched ward_number | Matched ward_name | Match method | Confidence | Reason |
|---|---|---|---|---|---|---|---|---|
| DTU, New Delhi | 5626 | 28.7500499 | 77.1112615 | 29 | POOTH KHURD | point_in_polygon | **safe** | Uniquely contained in 'POOTH KHURD' (ward_number=29), ~799m from the nearest edge. |
| ITO, New Delhi | 5613 | 28.628624 | 77.24106 | 77 | DELHI GATE | point_in_polygon | **needs manual review** | Point is only ~30m from the 'DELHI GATE' ward boundary — within the caution threshold (60m); coordinate/import precision could place it in a neighboring ward (`DARYAGANJ`, equidistant). |
| NSIT Dwarka, New Delhi | 5622 | 28.60909 | 77.0325413 | 123 | KAKROLA | point_in_polygon | **safe** | Uniquely contained in 'KAKROLA' (ward_number=123), ~223m from the nearest edge. |
| Shadipur, New Delhi | 5630 | 28.6514781 | 77.1473105 | 90 | MOTI NAGAR | point_in_polygon | **safe** | Uniquely contained in 'MOTI NAGAR' (ward_number=90), ~162m from the nearest edge. |
| Siri Fort, New Delhi | 5586 | 28.5504249 | 77.2159377 | 172 | CHIRAG DELHI | point_in_polygon | **safe** | Uniquely contained in 'CHIRAG DELHI' (ward_number=172), ~325m from the nearest edge. |
| Dr. Karni Singh Shooting Range, Delhi | 6934 | 28.498571 | 77.26484 | 169 | SANGAM VIHAR-B | point_in_polygon | **safe** | Uniquely contained in 'SANGAM VIHAR-B' (ward_number=169), ~587m from the nearest edge. |
| Jawaharlal Nehru Stadium, Delhi | 6957 | 28.58028 | 77.233829 | 145 | ANDREWS GANJ | point_in_polygon | **safe** | Uniquely contained in 'ANDREWS GANJ' (ward_number=145), ~524m from the nearest edge. |
| Major Dhyan Chand National Stadium, Delhi | 6929 | 28.611281 | 77.237738 | — | New Delhi (NDMC)* | point_in_polygon | **safe**\* | Uniquely contained in 'New Delhi (NDMC)' (ward_number=null), ~311m from the nearest edge. *See §6 — this polygon is OSM's "New Delhi District," not true NDMC. |
| MandirMarg, New Delhi | 6358 | 28.636429 | 77.201067 | — | New Delhi (NDMC)* | point_in_polygon | **safe**\* | Uniquely contained in 'New Delhi (NDMC)' (ward_number=null), ~709m from the nearest edge. *See §6. |
| Nehru Nagar, Delhi | 8365 | 28.56789 | 77.250515 | 144 | LAJPAT NAGAR | point_in_polygon | **safe** | Uniquely contained in 'LAJPAT NAGAR' (ward_number=144), ~185m from the nearest edge. |
| Pusa, DPCC Delhi | 6356 | 28.639645 | 77.146262 | 140 | INDER PURI (ambiguous) | point_in_polygon | **needs manual review** | Point falls inside 2 ward polygons simultaneously: `New Delhi (NDMC)` and `INDER PURI` (confirmed real overlap in the imported boundary data — see §6). |
| Sri AurobindoMarg | 10484 | 28.531346 | 77.190156 | 148 | HAUZ KHAS | point_in_polygon | **safe** | Uniquely contained in 'HAUZ KHAS' (ward_number=148), ~255m from the nearest edge. |
| Burari Crossing, New Delhi | 5541 | 28.7256504 | 77.2011573 | 14 | DHIRPUR | point_in_polygon | **safe** | Uniquely contained in 'DHIRPUR' (ward_number=14), ~224m from the nearest edge. Resolves the expansion report's open question — geometry places it in `DHIRPUR`, not `BURARI` as the landmark name would suggest. |
| CRRI Mathura Road, New Delhi | 5627 | 28.5512005 | 77.2735737 | 174 | SRI NIWAS PURI | point_in_polygon | **safe** | Uniquely contained in 'SRI NIWAS PURI' (ward_number=174), ~181m from the nearest edge. |
| IGI Airport Terminal - 3, New Delhi | 5650 | 28.5627763 | 77.1180053 | — | New Delhi (NDMC)* | point_in_polygon | **safe**\* | Uniquely contained in 'New Delhi (NDMC)' (ward_number=null), ~3,800m from the nearest edge. *See §6 — this is the clearest case of the district-vs-NDMC mislabel. |
| Lodhi Road, New Delhi | 5634 | 28.5918245 | 77.2273074 | — | New Delhi (NDMC)* | point_in_polygon | **safe**\* | Uniquely contained in 'New Delhi (NDMC)' (ward_number=null), ~71m from the nearest edge. *See §6. |
| North Campus, DU, New Delhi | 5610 | 28.6573814 | 77.1585447 | 88 | BALJEET NAGAR | point_in_polygon | **safe** | Uniquely contained in 'BALJEET NAGAR' (ward_number=88), ~219m from the nearest edge. |
| Pusa, New Delhi | 5404 | 28.639645 | 77.146263 | 140 | INDER PURI (ambiguous) | point_in_polygon | **needs manual review** | Point falls inside 2 ward polygons simultaneously: `New Delhi (NDMC)` and `INDER PURI` — same overlap as the DPCC Pusa row above (confirms these are the same physical location, different operating agency, exactly as the expansion report already suspected). |

*"Near-boundary" caution threshold: 60 meters from the matched polygon's nearest edge — chosen as a conservative multiple of typical consumer-GPS/OSM-import coordinate error, not a project-wide standard (none existed to reuse).*

---

## 5. Counts

| | Count |
|---|---|
| Backlog stations evaluated | 18 |
| Coordinates outside Delhi bounds | 0 |
| **Safe to import (unique, non-boundary match)** | **15** |
| **Needs manual review** | **3** (ITO; Pusa DPCC; Pusa IMD) |
| **Unresolved (no containing ward)** | **0** |

---

## 6. Risks / limitations found

1. **`New Delhi (NDMC)` is mislabeled** — its real content (per its own `metadata.osm_official_name`) is OSM's "New Delhi District" (admin_level 5, ~162 km²), not the true NDMC municipal jurisdiction (~43 km²). This was imported in an earlier phase (`data/delhi/processed/delhi_non_mcd_jurisdictions.geojson`, OSM relation `2763541`) under a name that doesn't match what it actually contains. Not something this audit can safely fix (renaming or re-importing this ward is outside scope — flagging, not touching it), but it directly affects 4 of the 15 "safe" matches: geometrically correct, but grouping IGI Airport T3, Lodhi Road, MandirMarg, and Major Dhyan Chand Stadium (spread across ~11km) into one "ward" dilutes what "ward-level" means for those four if imported as-is.
2. **Real polygon overlap**: `New Delhi (NDMC)` and `INDER PURI` genuinely overlap by ~3.26 km² in the imported data (confirmed via direct `shapely.intersection`) — both Pusa stations' points fall inside both. This is a pre-existing topology issue in the ward boundary import, not something introduced or fixable by this audit.
3. **Near-boundary precision**: ITO's ~30m margin is well within plausible OSM/GPS coordinate error for either the station's own reported location or the ward polygon's traced edge — a wrong call here would misattribute one station's readings to the wrong ward, which matters for ward-level forecast attribution. Flagged rather than resolved either way.
4. **Threshold choice**: the 60m "near boundary" caution distance is this audit's own judgment call, not a pre-existing project standard — reasonable for administrative ward boundaries at this scale, but arbitrary in the sense that no prior document specified it.
5. **`ward_number` is `null`** for `New Delhi (NDMC)`, `Delhi Cantonment`, and other non-MCD jurisdictions (they're not MCD wards, so they were never assigned an MCD ward number) — the dry-run table reflects that honestly (`—`) rather than inventing one.

---

## 7. Recommendation: exact stations to import vs. skip (not executed)

**Recommended for import** (15, geometrically safe) — same pattern as the previous expansion (`stations.yaml` entry with `ward:` set to the matched ward's exact `wards.name`, `openaq_location_id` as verified above):

| Station | Ward to assign |
|---|---|
| DTU, New Delhi | `POOTH KHURD` |
| NSIT Dwarka, New Delhi | `KAKROLA` |
| Shadipur, New Delhi | `MOTI NAGAR` |
| Siri Fort, New Delhi | `CHIRAG DELHI` |
| Dr. Karni Singh Shooting Range, Delhi | `SANGAM VIHAR-B` |
| Jawaharlal Nehru Stadium, Delhi | `ANDREWS GANJ` |
| Major Dhyan Chand National Stadium, Delhi | `New Delhi (NDMC)` — see limitation §6.1 |
| MandirMarg, New Delhi | `New Delhi (NDMC)` — see limitation §6.1 |
| Nehru Nagar, Delhi | `LAJPAT NAGAR` |
| Sri AurobindoMarg | `HAUZ KHAS` |
| Burari Crossing, New Delhi | `DHIRPUR` |
| CRRI Mathura Road, New Delhi | `SRI NIWAS PURI` |
| IGI Airport Terminal - 3, New Delhi | `New Delhi (NDMC)` — see limitation §6.1 |
| Lodhi Road, New Delhi | `New Delhi (NDMC)` — see limitation §6.1 |
| North Campus, DU, New Delhi | `BALJEET NAGAR` |

**Recommended to skip for now** (3, needs manual review — a human call, not this audit's to make):

| Station | Why | What a human needs to decide |
|---|---|---|
| ITO, New Delhi | ~30m from a ward boundary | Confirm against a higher-precision source whether ITO belongs in `DELHI GATE` or `DARYAGANJ` |
| Pusa, DPCC Delhi | Inside 2 overlapping polygons | Decide `New Delhi (NDMC)` vs. `INDER PURI` for this specific point, independent of the polygon-overlap bug |
| Pusa, New Delhi (IMD) | Same overlap, same location as above | Same decision as the DPCC Pusa row — will very likely get the same answer since they're ~0.1m apart |

**If a future pass proceeds with the 15**, the same idempotent pattern already used twice in this project applies directly: repoint `ingest/stations.yaml` (new entries only, `ward:` = the exact matched `wards.name` above), then `python scripts/backfill_history.py --days 60 --only "<ward name>" ...` for each — no schema change, no migration, each new ward gets exactly one new station row via the existing `_ensure_station` find-or-create path (verified in the prior two passes to never duplicate). **Not executed in this audit**, per the task's explicit "audit/dry-run only" scope.

## 8. Success criteria check

- ✅ We know which of the 18 can be safely loaded by geometry: **15**.
- ✅ Ward assignment is based on coordinates + real polygons (`shapely` point-in-polygon against the actual imported `wards.boundary` data), not name guessing — in fact this method directly *overrode* one name-based intuition (`Burari Crossing` geometrically lands in `DHIRPUR`, not `BURARI`).
- ✅ No fake stations or fake wards created — audit-only, zero Supabase writes.
- ✅ Prediction work can proceed knowing exactly which 15 of the remaining 18 are import-ready and which 3 need a human call first.
