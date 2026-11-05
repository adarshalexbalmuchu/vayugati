# Jharkhand / Dhanbad–Jharia city pack

Status, 5 November 2026: the map layers are built and committed. Nothing is in the database yet, and
the app is still Delhi-only. This note is the handover for anyone, including a Claude Code cloud
session, picking up the work.

## Why

Vayu Gati's pilot moves from Delhi to the Dhanbad–Jharia coalfield in Jharkhand (see the concept note,
"Seeing Jharkhand's Air"). Phase 1 puts 2 prototype nodes beside reference stations, then 12 nodes at
paired sites (mine edges, coal-haul roads, fire zones, schools, town centre). The platform has to show
Jharkhand before those nodes exist, using the official stations and open source layers.

## The layers (`data/jharkhand/processed/`)

| File | What it is | Source |
|---|---|---|
| `state.geojson` | Jharkhand outline (union of the districts) | geoBoundaries IND ADM2 (ODbL) |
| `districts.geojson` | 24 districts, with `continuous_in_feed`, `manual_namp`, `planned_caaqms` station counts | geoBoundaries; CPCB NAMP list 19.11.2024; JSPCB tender JSPCB/CAAQMS/2025-26 |
| `dhanbad_blocks.geojson` | Dhanbad's 11 blocks | geoBoundaries IND ADM3 (2018 names) |
| `dhanbad_grid_3km.geojson` | 265 grid cells over Dhanbad district, the working map units; ids `DH-row-col`, with a centre point | built from the district outline |
| `stations.geojson` | 10 continuous stations: 2 in Jharkhand (Jorapokhar, Sardar Patel Nagar), 8 reference candidates in Asansol and Durgapur | CPCB data.gov.in feed + OpenAQ, 5 Nov 2026 |
| `sources_osm.geojson` | Mines and quarries, industrial land, power plants, large works around Dhanbad | OpenStreetMap, Geofabrik eastern-zone extract |
| `roads_major.geojson` | Motorway, trunk, primary and secondary roads around Dhanbad | OpenStreetMap |
| `fires_firms_5d.geojson` | VIIRS fire detections over Jharkhand, last 5 days (a snapshot, not live) | NASA FIRMS |
| `openaq_locations.json` | Every OpenAQ location in the Jharkhand box, for station matching | OpenAQ v3 |
| `preview.html` | A standalone map of the layers (`#state` and `#dhanbad` views) | — |

Preview: from `data/jharkhand/processed/`, run `python3 -m http.server 8765` and open
`http://127.0.0.1:8765/preview.html#state` or `#dhanbad`.

Rebuild: from `ingest/`, `.venv/bin/python scripts/jharkhand/build_layers.py all` (needs
`DATA_GOV_API_KEY`, `OPENAQ_API_KEY`, `FIRMS_MAP_KEY` in `ingest/.env`, and for the `osm` step the
Geofabrik file at `ingest/data/osm/eastern-zone-latest.osm.pbf`, about 250 MB). Downloads go to the
gitignored `ingest/data/`.

## Facts the layers rest on

- Only **2 Jharkhand stations** are on CPCB's real-time feed (data.gov.in and OpenAQ agree, 5 Nov 2026):
  Tata Stadium, Jorapokhar and Sardar Patel Nagar, Dhanbad. Pathardih, listed in CPCB bulletins, is in
  neither feed.
- Jharkhand also has **10 manual (NAMP) stations**: Dhanbad 3, Jharia 1, Sindri 1, Jamshedpur 2,
  Ranchi 1, Saraikela 1, Barajamda 1. They publish no daily data and have no coordinates in the list.
- JSPCB tendered **15 continuous stations** (Dec 2025), none in Dhanbad district. Counts are by district;
  no site coordinates exist yet.
- Asansol (4) and Durgapur (4) stations report reliably and are the calibration-reference candidates.
- Of 190 fire detections inside Jharkhand in the 5 days to 5 Nov 2026, 121 were in Dhanbad district.

## Decisions already made

- **Map unit: a 3 km grid** over Dhanbad district, not wards. Open ward boundaries for Dhanbad Municipal
  Corporation were not found. 3 km gives 265 cells, the same as Delhi's 265 wards; the ingest service
  fetches weather per unit, so a 2 km grid (571 cells) would double that load. Swap to wards if the
  municipal corporation shares its ward map.
- **Reference stations** for calibration are Asansol's, not Jorapokhar, whose NO₂ fails our checks.
- **Public data only.** No secrets in the repo; keys live in `ingest/.env` and `web/.env.local`.

## Known limits

- OpenStreetMap coverage is incomplete: 196 mine areas and 17 power plants were found, but some plants are
  unnamed (possibly solar) and coal-haul roads are not tagged as such.
- FIRMS detections in the coalfield include underground coal fires and industrial heat sources such as
  coke ovens; they are not all open burning.
- geoBoundaries ADM3 uses 2018 block names (EGARKUND, KARIASOL are newer blocks).

## Next steps

1. **Make the web app city-aware** (safe for a cloud session; no database changes). Remove the hard-coded
   Delhi centre and bounds (`DELHI_CENTER`, `DELHI_BOUNDS`, `DELHI_DEFAULT_ZOOM` in `web/src/lib/mapRules.ts`,
   and their uses in `MapView.tsx`, `OverviewChoroplethMap.tsx`, `LocationPickerMap.tsx`, `MapPage.tsx`)
   and read them from the active city (`city_config`), with Delhi as the default.
   *Done in the web app:* the registry is `web/src/lib/cities.ts` (a `dhanbad` entry is already there,
   derived from the grid's extent), the active city comes from `web/src/lib/city.tsx`, and ward/station
   queries filter by city. Map settings can move to the database later as `city_config.config.map`
   (`{ label, center: [lng, lat], default_zoom, bounds: { minLng, maxLng, minLat, maxLat }, wider_area }`),
   which overrides the registry field by field. A city switcher appears once a second active city exists.
2. **Import the city pack into the database** (on the Mac, with the service key, after review): a
   `city_config` row (`city_code = 'dhanbad'`), the 265 grid cells as `wards` rows, and the stations.
   Write it as a migration or seed script first; apply only once the city-aware app is merged.
3. **Ingest Jharkhand and reference stations.** `ingest/app/data_gov_cpcb.py` fetches with
   `filters[state]=Delhi` only; it needs to fetch per active city.
4. **Coalfield source inventory** for attribution: mines, roads, power plants and fires from these layers,
   in place of the Delhi industrial-estate list.
5. Later: a data source for Vayu Gati's own nodes.

## Rules for cloud sessions

- Do not write to the production database, and never use the Supabase service key.
- Keep Delhi working; it is live data.
- Work on a branch and open a pull request.
