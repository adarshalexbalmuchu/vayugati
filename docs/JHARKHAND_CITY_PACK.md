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
| `dhanbad_grid_3km.geojson` | 265 grid cells over Dhanbad district, the working map units; ids `DH-row-col`, with a centre point; named "Dhanbad grid DH-row-col" in the database | built from the geoBoundaries district outline (approximate, not Survey of India) |
| `stations.geojson` | 10 continuous stations: 2 in Jharkhand (Jorapokhar, Sardar Patel Nagar), 8 reference candidates in Asansol and Durgapur | CPCB data.gov.in feed + OpenAQ, 5 Nov 2026 |
| `sources_osm.geojson` | Mining and quarry areas, industrial land, and 6 power plants and 2 large works whose names and operators were checked (`CHECKED_SITES` in `build_layers.py`) | OpenStreetMap, Geofabrik eastern-zone extract, data as of 3 Nov 2026 |
| `roads_major.geojson` | Motorway, trunk, primary and secondary roads around Dhanbad | OpenStreetMap |
| `fires_firms_5d.geojson` | VIIRS heat detections over Jharkhand, 1–4 Nov 2026 (a snapshot, not live) | NASA FIRMS |
| `state_sources_osm.geojson`, `state_roads.geojson` | The same layers for all of Jharkhand, clipped to the state outline (1,373 mining and quarry areas, 712 industrial areas, 8 checked power plants; roads trunk to secondary) | OpenStreetMap, data as of 3 Nov 2026 |
| `district_profiles.json` | One profile per district for the map's district panel: area and forest (FSI ISFR 2023, area by Survey of India), population (Census 2011 A-02), highest point and median height (Copernicus DEM GLO-90, computed), heat detections (FIRMS), checked plants, public monitors; `null` (shown as NA) where no verified figure exists, e.g. mining area. Built by `scripts/jharkhand/district_profiles.py` from the tables in `data/jharkhand/sources/` | see `data/jharkhand/sources/README.md` |
| `state_{railways,rivers,water,forest,protected,places,builtup,facilities,transport,power,kilns,landmarks}.geojson` | Statewide base layers for every district (`osm_base` step): railways and sidings, stations and airports, rivers and canals, lakes and reservoirs, forest areas, the 12 protected areas (Betla NP + 11 WLS, matching the official list), towns and villages, built-up areas, schools and hospitals, power lines and substations, brick kilns, peaks, waterfalls and dams | OpenStreetMap, 3 Nov 2026 |
| `landcover_districts.json` + web `landcover_2021.png` | ESA WorldCover 2021 land cover, cut to the state (`landcover` step), and each district's class shares | ESA WorldCover 10 m v200 (CC BY 4.0) |
| `openaq_locations.json` | Every OpenAQ location in the Jharkhand box, for station matching | OpenAQ v3 |
| `preview.html` | A standalone map of the layers (`#state` and `#dhanbad` views) | — |

The web app serves a state pack from `web/public/city-packs/jharkhand/`, built by the `pack` step:
the state layers plus the Dhanbad-area features just across the West Bengal border (Santaldih,
Raghunathpur, Panchet and Maithon). On `/map` with Dhanbad–Jharia selected, the "Jharkhand" and
"Dhanbad–Jharia" buttons switch between the state view and the coalfield.

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

- **City wards: none available.** No Jharkhand municipal ward boundaries are published as GIS (checked Nov 2026:
  no official download, none in Datameet's Municipal_Spatial_Data, no admin_level 10 boundaries in OpenStreetMap).
  OSM has 1,926 village boundaries (admin_level 9), almost all in Sahibganj (1,685), so they are not shown.
  Ward maps would have to come from the Urban Development & Housing Department or each urban local body.
- Night lights are NASA's 2016 Black Marble, the latest global composite served as map tiles.

- OpenStreetMap is volunteer-mapped and incomplete. The 196 mining and quarry shapes are mapped areas, not
  a count of mines, and not BCCL/CMPDI lease boundaries. Never quote these counts as official figures.
- Statewide, Mahadev Prasad STPP is left off because its current owner could not be confirmed, and so
  are dams, solar mini-grids and small works.
- Power plants and works: only those on `CHECKED_SITES` are kept. Dropped on 5 Nov 2026: 10 unnamed
  power-plant features, "BCCL Powerhouse" and "Bokaro Works Power Plant" (identity or status not
  confirmed), PDIL (not confirmed) and a small engineering workshop. Add a site only after checking it
  against the operator or the Central Electricity Authority.
- FIRMS points are heat detections (375 m pixels), not fire areas. In the coalfield they can be surface
  coal fires, industrial heat (coke ovens, steel) or open burning. The official Jharia coal-fire maps are
  NRSC/ISRO's, made quarterly for BCCL and CMPDI under the October 2025 MoU; quote fire areas only from those.
- No block layer. geoBoundaries ADM3 has 11 Census-era blocks for Dhanbad (e.g. Jharia-Cum-Jorapokhar-Cum-
  Sindri); the district now has 10 (Dhanbad, Baghmara, Nirsa, Topchanchi, Tundi, Purbi Tundi, Gobindpur,
  Baliapur, Egarkund, Kaliasole; dhanbad.nic.in). No official block boundaries are published for
  download. Add blocks only from Survey of India or JSAC.
- District and state outlines are geoBoundaries (approximate). Use Survey of India outlines before any
  official or printed map.

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
