# Phase 1 status — source inventory

Started this session. Everything below is either genuinely verified against
a live source this session, or explicitly marked as not yet done — nothing
in between.

## Verified and working

- **Industrial zones** (`sources/industrial_zones.py`): 16 of Delhi's
  designated industrial areas, sourced from Ministry of MSME's official
  "Brief Industrial Profile of Delhi" (dcmsme.gov.in), cross-checked
  against DSIIDC's own published area list and CPCB's public GPI_DL
  registered-industry list. Real government sources, not PAVITRA, not a
  blog. Coordinates are approximate locality centroids — flagged
  explicitly in the code and in a passing test — not precise polygons yet.
- **Sector contribution priors** (`sources/sector_priors.py`): real,
  cited percentages from IIT Kanpur's 2016 DPCC-commissioned source-
  apportionment study (winter: secondary particles 25–30%, vehicles
  20–25%, biomass burning 17–26%, waste burning 8–9%; summer: crustal/dust
  40–44%). These are measured, published numbers, useful as a calibration
  sanity-check — explicitly documented as city-wide averages, not ward-
  level truth.
- **NASA FIRMS API shape**: confirmed real via a live request — the
  documented URL pattern returned a specific "Invalid MAP_KEY" error
  (HTTP 400), not a 404 or connection failure, meaning the endpoint and
  parameter structure are correct. Client code in `sources/firms_fire.py`
  is ready to run the moment a real key exists.
- **Geofabrik OSM extract path**: confirmed reachable (HTTP 200), and
  confirmed to include a `northern-zone-latest.osm.pbf` covering Delhi.
  This replaces the original live-Overpass-API plan with the more
  production-appropriate periodic-static-extract approach.
- **EDGAR portal**: confirmed reachable, not explored further this
  session.

## Real finding, not a mistake to fix

Live Overpass API (the original plan for OSM road data) failed across
three independent public mirrors during this session — a genuine service
outage (confirmed: unrelated domains worked fine in the same environment
at the same time), not something wrong with the query or this project. It
also would have been the wrong long-term design regardless — Overpass
isn't meant for per-request production queries. `sources/osm_roads.py` is
built around the Geofabrik static-extract approach instead.

## Explicitly not done yet — stubs, not silent gaps

- FIRMS: no real `MAP_KEY` in hand. Free, instant registration at
  firms.modaps.eosdis.nasa.gov/api/area/ — nothing else in that file needs
  to change once you have one.
- OSM roads: the actual `.pbf` download + parsing (needs osmium-tool or
  pyrosm, not yet confirmed available in the deployment environment).
- TERI-ARAI's 2018 sector-apportionment numbers — confirmed to be a real,
  citable study, but not yet transcribed as a second independent
  cross-check alongside IIT Kanpur's numbers.
- EDGAR's actual gridded data format/download, beyond confirming the
  portal is reachable.
- Precise industrial-zone polygon boundaries (pending OSM access or a DDA
  shapefile).

## Correction (Sept 2026) — a real, more advanced kernel already exists

A `kernel/` module was added here briefly this session (a Gaussian-plume
prototype) before discovering that `ingest/app/vayutrace_kernel.py` — a
separate, already-shipped, already-scheduled production system — already
does this and does it better: season-aware Pasquill-Gifford sigma
calibrated against 4,340 real reading+weather pairs, a calm-wind
isotropic fallback, a literature-grounded dynamic regional-fire-transport
index, and real industrial/road/fire inventories
(`vayutrace_industrial_zones.py`, `vayutrace_osm_roads.py`,
`vayutrace_firms.py`), wired into the live scheduled pipeline via
`vayutrace_attribution.py`. That prototype was deleted rather than kept
as a redundant, less-rigorous duplicate. This `vayu_isrm/` directory's
own `sources/` inventory (industrial zones, sector priors) remains a
smaller, independent, standalone reference — not currently imported by
the production `vayutrace_*` system.

## Next concrete step

FIRMS_MAP_KEY has been added to the environment and verified live (HTTP
200, real CSV header returned) — the production `vayutrace_firms.py`
should now receive real fire data on its next scheduled run, no code
change needed there. Next real step is auditing whether the production
kernel's OUTPUT is actually surfaced anywhere in the frontend (checked
separately, see main project session notes).
