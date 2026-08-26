"""Delhi industrial emission source inventory — three DSIIDC/DDA categories.

Sources:
  - DSIIDC "Industrial Estates in Delhi" official list (dsiidc.org)
  - Ministry of MSME "Brief Industrial Profile of Delhi"
    (dcmsme.gov.in/dips/Brief%20industrial%20profile%20of%20Delhi.pdf)
  - Delhi Master Plan 2021 (MPD-2021), Chapter 10 — Industry
    (dda.org.in/planning/master_plans/MPD2021.pdf)
  - CPCB "GPI_DL" registered-industry list (cpcb.nic.in/ngrba/GPI_DL.pdf)
  - Delhi Pollution Control Committee (DPCC) industrial zone notifications

NOT sourced from PAVITRA, IIT Bombay, or any ISRM_PAVITRA material.

Three zone categories:
  'planned'        — 29 DSIIDC-managed planned industrial estates
  'flatted_factory'— 4 Flatted Factory Complexes (multi-floor, mixed SMEs)
  'non_conforming' — 27 notified non-conforming clusters being redeveloped;
                     typically older/informal, often lacking modern emission
                     controls → higher emission weight per unit area

What NOT to add:
  Common Effluent Treatment Plants (CETPs) — these are pollution TREATMENT
  facilities co-located with industrial zones, not additional emission sources.
  Adding them would double-count the same physical location.

Coordinates are APPROXIMATE LOCALITY CENTROIDS — suitable for ward-level
dispersion modelling at 1–5 km resolution.  Refine with DDA Master Plan
zoning shapefile or OSM landuse=industrial polygons.  The test suite enforces
a Delhi bbox guard so any lat/lng swap stays caught.

Emission weights (relative, unitless):
  3 = heavy industry (metal, chemicals, rubber, auto parts, large-scale)
  2 = mixed light/medium (plastics, garments, printing, packaging, SMEs)
  1 = small-scale / flatted / light craft
"""

from __future__ import annotations

from dataclasses import dataclass

DELHI_BBOX = {
    "lat_min": 28.40,
    "lat_max": 28.90,
    "lng_min": 76.84,
    "lng_max": 77.35,
}


@dataclass(frozen=True)
class IndustrialZone:
    name: str
    lat: float
    lng: float
    emission_weight: int = 2   # 1–3, relative
    category: str = "planned"  # planned | flatted_factory | non_conforming

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "lat": self.lat,
            "lng": self.lng,
            "emission_weight": self.emission_weight,
            "category": self.category,
            "source_type": "industrial",
        }


# ── 1. Planned industrial estates (DSIIDC) ────────────────────────────────────
# 29 estates from DSIIDC's official list and MPD-2021.
_PLANNED: list[IndustrialZone] = [
    IndustrialZone("Wazirpur Industrial Area",              28.6975, 77.1645, 3, "planned"),
    IndustrialZone("Mangolpuri Industrial Area",            28.6890, 77.0790, 2, "planned"),
    IndustrialZone("Narela Industrial Area",                28.8540, 77.0910, 2, "planned"),
    IndustrialZone("Bawana Industrial Area",                28.7995, 77.0335, 3, "planned"),
    IndustrialZone("Okhla Industrial Area (Phase I-III)",  28.5355, 77.2755, 2, "planned"),
    IndustrialZone("Mohan Cooperative Industrial Estate",  28.5285, 77.2865, 2, "planned"),
    IndustrialZone("Patparganj Industrial Area",            28.6230, 77.2905, 2, "planned"),
    IndustrialZone("Jhilmil Industrial Area",               28.6720, 77.3175, 2, "planned"),
    IndustrialZone("Shahdara Industrial Area",              28.6710, 77.2890, 2, "planned"),
    IndustrialZone("Naraina Industrial Area (Phase I-II)", 28.6335, 77.1385, 2, "planned"),
    IndustrialZone("Mayapuri Industrial Area (Phase I-II)",28.6320, 77.1215, 3, "planned"),
    IndustrialZone("Kirti Nagar Industrial Area",           28.6520, 77.1450, 1, "planned"),
    IndustrialZone("Lawrence Road Industrial Area",         28.6870, 77.1520, 1, "planned"),
    IndustrialZone("Anand Parbat Industrial Area",          28.6555, 77.1795, 2, "planned"),
    IndustrialZone("Mundka Industrial Area",                28.6815, 77.0335, 1, "planned"),
    IndustrialZone("Badli Industrial Area",                 28.7365, 77.1305, 2, "planned"),
    # Additional planned estates from DSIIDC list / MPD-2021
    IndustrialZone("GT Karnal Road Industrial Area",        28.7280, 77.1580, 2, "planned"),
    IndustrialZone("Rohtak Road Industrial Area",           28.6740, 77.0680, 2, "planned"),
    IndustrialZone("Rani Khera Industrial Area",            28.7480, 76.9880, 2, "planned"),
    IndustrialZone("Nand Nagri Industrial Area",            28.6960, 77.3090, 2, "planned"),
    IndustrialZone("Sanjay Gandhi Transport Nagar",         28.7205, 77.1490, 2, "planned"),
    IndustrialZone("Sultanpur Majra Industrial Area",       28.6950, 77.0680, 1, "planned"),
    IndustrialZone("Samaypur Badli Industrial Area",        28.7480, 77.1380, 2, "planned"),
    IndustrialZone("Udyog Nagar Industrial Area",           28.6625, 77.0490, 2, "planned"),
    IndustrialZone("Peeragarhi Industrial Area",            28.6760, 77.0870, 2, "planned"),
    IndustrialZone("Hastsal Industrial Area",               28.6570, 77.0610, 1, "planned"),
    IndustrialZone("Nangloi Industrial Area",               28.6740, 77.0630, 2, "planned"),
    IndustrialZone("Kapashera Industrial Area",             28.5220, 77.0710, 2, "planned"),
    IndustrialZone("Bhorgarh Industrial Area",              28.8210, 77.0590, 2, "planned"),
]

# ── 2. Flatted Factory Complexes (FFCs) ───────────────────────────────────────
# 4 DSIIDC-built multi-storey factory blocks.  Mixed light-to-medium SMEs;
# lower emission weight than open industrial estates.
_FLATTED: list[IndustrialZone] = [
    IndustrialZone("FFC Jhandewalan",  28.6445, 77.1995, 1, "flatted_factory"),
    IndustrialZone("FFC Okhla",        28.5390, 77.2710, 1, "flatted_factory"),
    IndustrialZone("FFC Wazirpur",     28.7005, 77.1620, 1, "flatted_factory"),
    IndustrialZone("FFC Lawrence Road",28.6870, 77.1510, 1, "flatted_factory"),
]

# ── 3. Non-conforming industrial clusters (notified, under redevelopment) ─────
# 27 clusters notified by DPCC/DDA under MPD-2021's non-conforming use policy.
# These are legacy/informal zones being phased out or regularised; often lack
# modern emission controls → emission_weight 2–3 despite smaller physical size.
# Coordinates are approximate neighbourhood centroids.
_NON_CONFORMING: list[IndustrialZone] = [
    IndustrialZone("Lajpat Nagar Industrial Cluster",      28.5693, 77.2430, 2, "non_conforming"),
    IndustrialZone("Kiran Nagar Industrial Cluster",        28.6570, 77.0760, 2, "non_conforming"),
    IndustrialZone("Shakur Basti Industrial Cluster",       28.6860, 77.1200, 2, "non_conforming"),
    IndustrialZone("Motia Khan Industrial Cluster",         28.6530, 77.2110, 2, "non_conforming"),
    IndustrialZone("Sadar Bazar Industrial Cluster",        28.6600, 77.2130, 3, "non_conforming"),
    IndustrialZone("Azad Market Industrial Cluster",        28.6660, 77.2070, 2, "non_conforming"),
    IndustrialZone("Karol Bagh Industrial Cluster",         28.6530, 77.1890, 2, "non_conforming"),
    IndustrialZone("Tri Nagar Industrial Cluster",          28.6940, 77.1370, 2, "non_conforming"),
    IndustrialZone("Inderlok Industrial Cluster",           28.6870, 77.1620, 2, "non_conforming"),
    IndustrialZone("Rani Bagh Industrial Cluster",          28.7105, 77.1310, 2, "non_conforming"),
    IndustrialZone("Patel Nagar Industrial Cluster",        28.6565, 77.1700, 2, "non_conforming"),
    IndustrialZone("Punjabi Bagh Industrial Cluster",       28.6680, 77.1310, 2, "non_conforming"),
    IndustrialZone("Raja Garden Industrial Cluster",        28.6600, 77.1200, 2, "non_conforming"),
    IndustrialZone("Tilak Nagar Industrial Cluster",        28.6420, 77.0970, 2, "non_conforming"),
    IndustrialZone("Janakpuri Industrial Cluster",          28.6285, 77.0830, 2, "non_conforming"),
    IndustrialZone("Uttam Nagar Industrial Cluster",        28.6185, 77.0560, 2, "non_conforming"),
    IndustrialZone("Dwarka Sector 5 Industrial Cluster",   28.5830, 77.0670, 2, "non_conforming"),
    IndustrialZone("Badarpur Industrial Cluster",           28.5020, 77.2980, 3, "non_conforming"),
    IndustrialZone("Tughlakabad Industrial Cluster",        28.5150, 77.2760, 2, "non_conforming"),
    IndustrialZone("Sangam Vihar Industrial Cluster",       28.5190, 77.2560, 2, "non_conforming"),
    IndustrialZone("Govindpuri Industrial Cluster",         28.5350, 77.2560, 2, "non_conforming"),
    IndustrialZone("Kalkaji Industrial Cluster",            28.5490, 77.2570, 2, "non_conforming"),
    IndustrialZone("Shakarpur Industrial Cluster",          28.6390, 77.2890, 2, "non_conforming"),
    IndustrialZone("Seelampur Industrial Cluster",          28.6680, 77.2970, 3, "non_conforming"),
    IndustrialZone("Zaffrabad Industrial Cluster",          28.6820, 77.3020, 2, "non_conforming"),
    IndustrialZone("Khureji Khas Industrial Cluster",       28.6480, 77.3070, 2, "non_conforming"),
    IndustrialZone("Mandawali Industrial Cluster",          28.6260, 77.3020, 2, "non_conforming"),
]

# ── Combined list ─────────────────────────────────────────────────────────────

INDUSTRIAL_ZONES: list[IndustrialZone] = _PLANNED + _FLATTED + _NON_CONFORMING


def all_zones() -> list[IndustrialZone]:
    return list(INDUSTRIAL_ZONES)


def zones_by_category(category: str) -> list[IndustrialZone]:
    """Filter zones by category: 'planned' | 'flatted_factory' | 'non_conforming'."""
    return [z for z in INDUSTRIAL_ZONES if z.category == category]


def zones_as_dicts() -> list[dict]:
    return [z.as_dict() for z in INDUSTRIAL_ZONES]
