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
# Zone names and coordinates match the verified list in vayu_isrm/sources/industrial_zones.py
# (built against the actual MSME/DSIIDC source documents during the Phase 1 sandbox build).
#
# Emission weight 3 = large/heavy industry (metal, chemicals, auto parts);
# 2 = mixed light/medium (plastics, garments, printing, packaging);
# 1 = small-scale/light (furniture, food processing, warehousing).
INDUSTRIAL_ZONES: list[IndustrialZone] = [
    IndustrialZone("Wazirpur Industrial Area",              28.6975, 77.1645, emission_weight=3),
    IndustrialZone("Mangolpuri Industrial Area",            28.6890, 77.0790, emission_weight=2),
    IndustrialZone("Narela Industrial Area",                28.8540, 77.0910, emission_weight=2),
    IndustrialZone("Bawana Industrial Area",                28.7995, 77.0335, emission_weight=3),
    IndustrialZone("Okhla Industrial Area (Phase I-III)",  28.5355, 77.2755, emission_weight=2),
    IndustrialZone("Mohan Cooperative Industrial Estate",  28.5285, 77.2865, emission_weight=2),
    IndustrialZone("Patparganj Industrial Area",            28.6230, 77.2905, emission_weight=2),
    IndustrialZone("Jhilmil Industrial Area",               28.6720, 77.3175, emission_weight=2),
    IndustrialZone("Shahdara Industrial Area",              28.6710, 77.2890, emission_weight=2),
    IndustrialZone("Naraina Industrial Area (Phase I-II)", 28.6335, 77.1385, emission_weight=2),
    IndustrialZone("Mayapuri Industrial Area (Phase I-II)",28.6320, 77.1215, emission_weight=3),
    IndustrialZone("Kirti Nagar Industrial Area",           28.6520, 77.1450, emission_weight=1),
    IndustrialZone("Lawrence Road Industrial Area",         28.6870, 77.1520, emission_weight=1),
    IndustrialZone("Anand Parbat Industrial Area",          28.6555, 77.1795, emission_weight=2),
    IndustrialZone("Mundka Industrial Area",                28.6815, 77.0335, emission_weight=1),
    IndustrialZone("Badli Industrial Area",                 28.7365, 77.1305, emission_weight=2),
]


def all_zones() -> list[IndustrialZone]:
    """Return the full list (immutable copies via frozen dataclass)."""
    return list(INDUSTRIAL_ZONES)


def zones_as_dicts() -> list[dict]:
    """Serialisable form for JSON/DB storage."""
    return [z.as_dict() for z in INDUSTRIAL_ZONES]
