# Jharkhand 3D and sandbox plan (7 Nov 2026)

Goal: 3D that helps people **understand** Jharkhand (terrain, water, where things are), built so it can later become a
**simulation sandbox**, and later carry **air quality**. Everything below is free to use. Standards of the platform apply:
credible sources only, every source credited, simulations always labelled as what-if scenarios, never as forecasts.

## 1. What exists today

- MapLibre GL JS **4.7.1** (latest is 6.16, weekly releases). Terrain from MapTiler Terrain RGB v2 (30 m grid), hillshade,
  contours, sky, height exaggeration, elevation on click. 3D only inside a district; the state view is flat.
- All layers are draped flat on the terrain. About 16-20 MB of GeoJSON is loaded by the browser.
- Elevation is a **surface** model (it includes tree tops). District figures use Copernicus GLO-90.

## 2. What European urban-planning platforms do, and what we take from them

| Platform | Stack (as published) | What we borrow |
|---|---|---|
| Helsinki 3D+ | CityGML 2.0 models, served with CesiumJS | Open data in open standards; publish the data, not only the viewer |
| Hamburg (Connected Urban Twins, with Leipzig and Munich) | Masterportal (OpenLayers, Vue) hosting CesiumJS and the open xeokit viewer | One interface that switches between 2D and 3D |
| Virtual City Systems "VC Map" | Open-source viewer on CesiumJS, used in several European cities | Open source is a strength for public trust |
| Florence | MapStore + CesiumJS, open "Digital Twin Toolbox" to build 3D Tiles | A repeatable data-to-3D build pipeline |
| Chalmers Digital Twin Cities Centre | MIT-licensed platform, 3DCityDB, CityJSON | Keep the scene as plain, documented data |
| TerriaJS (CSIRO; Digital Earth Australia/Africa, NSW and Victoria twins) | CesiumJS + Leaflet fallback, static site | A data catalogue, shareable "stories", a compare slider, a 2D fallback |
| iTowns / Giro3D (IGN France) | Three.js, 3D Tiles, COG, MIT/Cecill-B | A lighter, Three.js-based alternative if we leave MapLibre |

Lessons: (1) the scene is data in open formats, (2) 2D and 3D live in one interface, with an easy way back, (3) scenarios
and views can be shared by link, (4) a catalogue lists every dataset with its source and licence, (5) the public sector
leans on open source. The city twins are building-centred at city scale. We are terrain-and-process-centred at state
scale, so we do not copy their stack, only their habits.

## 3. Decision: stay on MapLibre, add deck.gl only where needed, keep CesiumJS as the fallback

- **MapLibre 6.x** is the base. It is open, free, we already run on it, and v5+ adds the globe and many 3D fixes.
- **deck.gl 9.4** (`@deck.gl/maplibre`) supports MapLibre 4.5.1, 5 and 6 and has the layers a sandbox needs (columns,
  trips/particles, arcs). **Known gap:** deck.gl layers are not draped over MapLibre's own terrain; an
  [RFC](https://github.com/visgl/deck.gl/issues/10758) is open and `TerrainExtension` is experimental. So:
  - Columns for mines, plants and dams use MapLibre's **native `fill-extrusion`** (small circle polygons) if the spike shows
    it follows terrain; deck.gl is used for moving particles only after the spike.
- **CesiumJS** (Apache 2.0, free) is what Helsinki, Hamburg, Florence and Terria use. We move to it only if we need what
  MapLibre cannot do: underground views of mines, 3D Tiles buildings, or large true-3D volumes. Cesium ion's free tier is
  non-commercial only; we would host our own data. Moving means rebuilding every layer, so it is a last resort.

## 4. What to download (all free)

| Data | Use | Licence / note |
|---|---|---|
| Copernicus GLO-30 DEM (public COG tiles on AWS Open Data) for Jharkhand, about 20 tiles | Hydrology, slope, viewshed. Our own terrain tiles if we stop depending on MapTiler | Free with ESA/Copernicus attribution |
| [Mapterhorn](https://mapterhorn.com/) terrain (PMTiles, Terrarium WebP 512 px, global 30 m from GLO-30; area extracts) | Self-hosted terrain tiles, no API key | Code BSD-3; data from open sources, attribution list on its site |
| [FABDEM V1-2](https://gee-community-catalog.org/projects/fabdem/) (bare-earth 30 m), tiles N22-N24, E084-E086 | Analysis where tree tops would mislead (slope, viewshed) | **CC BY-NC-SA 4.0**: non-commercial, share-alike. Fine for the analysis layer today, blocks commercial use later. Download needs approval (blocked once in the session) |
| [Hydrography90m](https://www.igb-berlin.de/en/node/12260) (90 m streams, basins, flow direction) | Cross-check of our own flow network | **Licence not confirmed in my research: verify before use** |
| ESA WorldCover 2021, ERA5, IMERG rainfall | Runoff scenarios | Already used (WorldCover, ERA5) or free; credit each |
| Google Open Buildings 2.5D (heights) / Overture buildings | Optional later 3D buildings | **Licence and India height coverage not confirmed: verify, and apply the "no patchy data" rule first** |

Not needed: paid DEMs (Airbus 5 m), Cesium ion paid tiers, Google photorealistic 3D tiles.

## 5. What to install

Web (`npm`): `maplibre-gl@6`, `pmtiles` (4.5), `@deck.gl/core` `@deck.gl/layers` `@deck.gl/geo-layers` `@deck.gl/maplibre`
(9.4, only when needed), `geotiff` (read COGs in the browser), `comlink` (web-worker calls), `@turf/circle` (column
footprints). `three` (0.187) only if a custom effect needs it.

Pipeline (Python, offline): `rasterio`, `numpy`, **WhiteboxTools** (MIT) for flow direction, accumulation and stream
extraction; `pysheds` or TauDEM (GPL) only as offline cross-checks. System tools: GDAL (make COGs), `tippecanoe` and the
`pmtiles` CLI (turn the 16-20 MB of GeoJSON into one PMTiles file).

## 6. Phases (each ends with something usable)

**Phase 0: foundations (about 2 sessions).** Spikes first, each a short throwaway test with a pass/fail:
(a) MapLibre 4.7.1 to 6.x upgrade; run the layer probe and visual checks; (b) `fill-extrusion` on terrain: columns sit
on the ground at the right height; (c) deck.gl + terrain: particles over terrain, with and without TerrainExtension;
(d) PMTiles for the pack: load time and memory against today. Gate: if (b) and (c) both fail, plan Cesium for Phase 2 on.

**Phase 1: whole-state 3D (about 2 sessions).** A "3D" switch tilts the whole state with terrain; flat stays one click away.
Fewer labels while tilted, a light mode (lower terrain detail, no sky) for slow computers, camera presets, state-wide fog.
Success: opens in under 3 s on a mid laptop; frame rate stays smooth.

**Phase 2: data standing up (about 2 sessions).** Coal mines and plants (height from capacity), large dams (real height from
the register). A scale in the legend. Sizing rule written down: height is proportional to the figure; no exaggeration that
changes rankings. Popups and credits unchanged. District columns (population, forest) as an option.

**Phase 3: water you can follow (about 4 sessions).** Offline: GLO-30 to a conditioned DEM, D8 flow direction (a 90 m byte
grid, about 25 MB), accumulation, streams and sub-catchments with Whitebox. Check against India-WRIS rivers and basins
(report the agreement; India-WRIS stays the authority we show). In the browser: click a point and see the upstream
catchment and the downstream path on tilted terrain, with moving flow. Runs in a web worker.

**Phase 4: sandbox core (about 4 sessions).** A scenario engine in a worker, a scenario panel, results on a time slider,
shareable by link (a Terria-style "story"). First scenario: rainfall on a catchment becomes runoff along the routed network
(land cover from WorldCover; rain presets from ERA5/IMERG history). Every run is stamped "Simulation: what-if, not a
forecast", lists its inputs and sources, and states its limits.

**Phase 5: analysis (about 3 sessions).** Elevation profile along a drawn line, slope and aspect, viewshed, on FABDEM.

**Phase 6: air quality (when monitors exist).** Wind from ERA5, boundary-layer height from Open-Meteo, and the
[CAMS](https://glama.ai/mcp/connectors/io.github.whiteknightonhorse/apibase/tools/openmeteoaq.air.current)-based model
air-quality values (40 km global, not validated in India) as a clearly labelled reference. A plume simulation only as
"illustrative" until measured data can check it.

## 7. Risks

- Browser speed with a tilted whole state: mitigated by PMTiles, label thinning and a light mode.
- deck.gl and MapLibre terrain do not yet agree: Phase 0 decides, with Cesium as the fallback.
- A simulation can look more certain than it is: stamp, inputs, limits, and no air-quality plume without data to check it.
- Licences: FABDEM is non-commercial and share-alike; two datasets above are unverified. Each licence must be
  confirmed from the dataset's own page before that data ships.
- MapLibre jump from 4 to 6: possible breaking changes; the upgrade is a separate, tested step.

## 8. Decisions we still need from the owner

1. How 3D is switched on (toggle, always on, or district only).
2. Whether non-commercial licences (FABDEM) are acceptable for the analysis layer.
3. Approval to download FABDEM tiles (blocked once).
4. Whether the shareable scenario link may be public.
