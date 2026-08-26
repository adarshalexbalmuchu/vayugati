# Handoff: Vayu Gati source-attribution model (ISRM-style)

Context for whoever/whatever picks this up next (written for Claude Code
to read cold, with no memory of the conversation that produced it).

## The one non-negotiable framing

This model must be independently built — no code, data, or structural
inspiration taken from IIT Bombay's ISRM_PAVITRA workshop notebook. That
constraint shaped every source choice below; don't relax it for
convenience. If you (Claude Code) ever have PAVITRA's notebook open in the
same context while writing this code, stop and flag it — that undermines
the whole point even without copying a line.

Also non-negotiable: **this model produces estimated/modeled source
contributions, not measured/detected ones.** It's a forward model
(emissions → predicted concentration), not receptor modeling (observed
air sample → decoded source mix) — the latter would need chemically
speciated samples CPCB's stations don't provide. Every place this shows
up in code comments, docs, UI copy, or the grant application, use
"estimated"/"modeled," never "detected"/"measured." This came up
repeatedly in the design conversation and is worth holding the line on.

## What's already built and verified (attached: `vayu-isrm-phase1.zip`)

Treat this zip as a verified starting point to adapt into the real repo's
conventions, not a finished module to drop in unchanged — it was built in
an isolated sandbox with no access to the actual vayugati codebase style.

- `sources/industrial_zones.py` — 16 of Delhi's designated industrial
  areas. Sourced from Ministry of MSME's official "Brief Industrial
  Profile of Delhi" (dcmsme.gov.in), cross-checked against DSIIDC's own
  area list and CPCB's public GPI_DL registered-industry list. Real
  government sources. Coordinates are **approximate locality centroids**,
  explicitly flagged as such in the code and a test — refine with OSM
  `landuse=industrial` polygons or a DDA Master Plan shapefile once
  available.
- `sources/sector_priors.py` — real, cited sector-contribution
  percentages from IIT Kanpur's 2016 DPCC-commissioned study (winter:
  secondary particles 25–30%, vehicles 20–25%, biomass 17–26%, waste
  burning 8–9%; summer dust 40–44%). Useful as a calibration sanity-check,
  explicitly NOT ward-level ground truth.
- `sources/firms_fire.py` — NASA FIRMS client. API shape verified live
  (got a real "Invalid MAP_KEY" error back, confirming the URL structure
  is correct). **Needs a real MAP_KEY** — free, instant, register at
  firms.modaps.eosdis.nasa.gov/api/area/. Nothing else in this file needs
  to change once you have one.
- `sources/osm_roads.py` — deliberately built around Geofabrik's static
  `.osm.pbf` extracts (`download.geofabrik.de/asia/india/northern-zone-latest.osm.pbf`,
  confirmed reachable), NOT live Overpass API. Live Overpass failed across
  three independent mirrors during the build (genuine service outage,
  confirmed via unrelated domains working fine in parallel) — but static
  extracts are the right production design regardless of that outage, so
  don't revert to live Overpass queries even once it's back up.
- `tests/test_source_inventory.py` — 4 passing sanity tests on the static
  data above.
- `PHASE1_STATUS.md` — the full verified/stubbed breakdown, more detail
  than this summary.

## Explicitly not done — pick up here

1. Get a real FIRMS `MAP_KEY` and wire up `fetch_delhi_fires()` for real.
2. Download the Geofabrik extract and implement the actual `.pbf` parsing
   in `osm_roads.py` (needs `osmium-tool` or `pyrosm` — check what's
   available in the deployment environment before picking one).
3. TERI-ARAI (2018) sector-apportionment numbers — confirmed to be a real
   study, not yet transcribed as a second independent cross-check
   alongside IIT Kanpur's.
4. The dispersion/attribution kernel itself — not started. Design
   discussion landed on a distance-and-wind-weighted decay kernel (own
   derivation, not InMAP's/PAVITRA's specific formulation), calibrated by
   regressing against Vayu Gati's own ingested CPCB station history. The
   existing `web/src` weather integration (met.no) is a real asset here —
   real-time wind should feed the kernel, not a static climatological
   average.
5. A confidence signal per ward (higher near a real CPCB station, lower
   far from one) — agreed as worth building in from the start, not
   started.

## Where this probably belongs in the repo

Given the existing `ingest/app/` module pattern (`data_gov_cpcb.py`,
`aqi.py`, `station_matching.py`, etc.), a new `ingest/app/attribution/`
package matching that convention is the likely fit — but this wasn't
decided against the real repo's actual current structure, only reasoned
about in the abstract. Worth checking against however `ingest/app/` looks
today before committing to a layout, since this note may already be
stale by the time it's read.

## Sources worth re-verifying independently, not just trusting this doc

- Ministry of MSME industrial profile: dcmsme.gov.in/dips/Brief%20industrial%20profile%20of%20Delhi.pdf
- IIT Kanpur 2016 study: cerca.iitd.ac.in/uploads/Reports/1576211826iitk.pdf (also mirrored on airqualityasia.org and listed on DPCC's own Technical Reports page)
- NASA FIRMS API docs: firms.modaps.eosdis.nasa.gov/api/area/
- Geofabrik India extracts: download.geofabrik.de/asia/india.html
