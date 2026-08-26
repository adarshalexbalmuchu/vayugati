"""Delhi designated industrial zones — static reference data.

Source: Ministry of MSME 'Brief Industrial Profile of Delhi'
(dcmsme.gov.in/dips/Brief%20industrial%20profile%20of%20Delhi.pdf),
cross-checked against DSIIDC's own area list and CPCB's GPI_DL
registered-industry list.

Coordinates are APPROXIMATE LOCALITY CENTROIDS — suitable for ward-level
dispersion modelling at the 1–5 km resolution this kernel targets.  Refine
with OSM landuse=industrial polygons or a DDA Master Plan shapefile once
available.  The test suite enforces a bbox-in-Delhi guard so any future
coordinate fix that accidentally flips lat/lng stays caught.

This module is intentionally free of I/O: no file reads, no network calls,
no database access.  Import it anywhere in the ingest package without side
effects.
"""

from __future__ import annotations

from dataclasses import dataclass

# Delhi approximate bounding box (used only in tests)
DELHI_BBOX = {
    "lat_min": 28.40,
    "lat_max": 28.90,
    "lng_min": 76.84,
    "lng_max": 77.35,
}


@dataclass(frozen=True)
class IndustrialZone:
    name: str
    lat: float   # WGS-84, approximate centroid
    lng: float
    # Qualitative scale: 1 = small-scale, 2 = medium, 3 = large/heavy
    # Used as a relative emission weight in the dispersion kernel.
    emission_weight: int = 2

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "lat": self.lat,
            "lng": self.lng,
            "emission_weight": self.emission_weight,
            "source_type": "industrial",
        }


# 16 designated industrial areas per MSME/DSIIDC records.
# Emission weight 3 = large/heavy industry (metal, chemicals, rubber);
# 2 = mixed light/medium (plastics, garments, electroplating);
# 1 = small-scale/craft.
INDUSTRIAL_ZONES: list[IndustrialZone] = [
    IndustrialZone("Okhla Phase I",          28.5412, 77.2610, emission_weight=3),
    IndustrialZone("Okhla Phase II",         28.5368, 77.2684, emission_weight=3),
    IndustrialZone("Okhla Phase III",        28.5326, 77.2760, emission_weight=2),
    IndustrialZone("Narela",                 28.8524, 77.0937, emission_weight=3),
    IndustrialZone("Bawana",                 28.7950, 77.0373, emission_weight=3),
    IndustrialZone("Mundka",                 28.6802, 76.9985, emission_weight=2),
    IndustrialZone("Mayapuri",               28.6353, 77.1101, emission_weight=2),
    IndustrialZone("Wazirpur",               28.6987, 77.1641, emission_weight=3),
    IndustrialZone("Lawrence Road (Keshav Puram)", 28.7014, 77.1522, emission_weight=2),
    IndustrialZone("Jhilmil",               28.6776, 77.3104, emission_weight=2),
    IndustrialZone("Patparganj",             28.6230, 77.2950, emission_weight=2),
    IndustrialZone("Shahdara",               28.6698, 77.2942, emission_weight=3),
    IndustrialZone("GT Karnal Road (Badli)", 28.7413, 77.1489, emission_weight=2),
    IndustrialZone("Badli",                  28.7356, 77.1644, emission_weight=2),
    IndustrialZone("Sultanpur Majra",        28.6943, 77.0683, emission_weight=1),
    IndustrialZone("Mangolpuri",             28.6956, 77.0855, emission_weight=2),
]


def all_zones() -> list[IndustrialZone]:
    """Return the full list (immutable copies via frozen dataclass)."""
    return list(INDUSTRIAL_ZONES)


def zones_as_dicts() -> list[dict]:
    """Serialisable form for JSON/DB storage."""
    return [z.as_dict() for z in INDUSTRIAL_ZONES]
