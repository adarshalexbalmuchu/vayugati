"""Delhi's designated industrial areas — source inventory, point-source layer.

SOURCE: Ministry of MSME (Government of India), "Brief Industrial Profile
of Delhi", dcmsme.gov.in/dips/Brief%20industrial%20profile%20of%20Delhi.pdf
— an official government document, cross-checked against DSIIDC's own
published area list (delhionline.in/guide/delhi-industrial-area, mirroring
DSIIDC's official New Industrial Policy document) and the CPCB "GPI_DL"
public industry list (cpcb.nic.in/ngrba/GPI_DL.pdf), which independently
confirms several of these zone names by listing individual registered
units located within them.

NOT sourced from PAVITRA, IIT Bombay, or any ISRM_PAVITRA material.

HONESTY NOTE: coordinates below are approximate locality centroids from
general geographic knowledge of these well-known Delhi neighborhoods, NOT
precise polygon boundaries from an official GIS shapefile. This is a
starter fixture, not a finished one. Two concrete ways to sharpen this:
  1. OSM's landuse=industrial polygons for Delhi, once Overpass API access
     is available again (it returned a genuine service outage — HTTP 503
     across three independent mirrors — during this build, not a data
     problem; see sources/osm_roads.py for the production-appropriate
     static-extract approach that avoids depending on live Overpass at
     request time anyway).
  2. A DDA (Delhi Development Authority) Master Plan zoning shapefile, if
     one can be sourced publicly.
Until then, treat every centroid here as "approximately here," not exact.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class IndustrialZone:
    name: str
    lat: float
    lng: float
    coordinate_confidence: str  # "approximate_centroid" until refined per the note above
    notes: str = ""


# Approximate centroids, Delhi (NCT). Refine per the honesty note above.
INDUSTRIAL_ZONES: list[IndustrialZone] = [
    IndustrialZone("Wazirpur Industrial Area", 28.6975, 77.1645, "approximate_centroid",
                   "Metal fabrication, steel utensils — Delhi's oldest industrial estate."),
    IndustrialZone("Mangolpuri Industrial Area", 28.6890, 77.0790, "approximate_centroid",
                   "Textiles, garments, plastics — split DDA/DSIIDC."),
    IndustrialZone("Narela Industrial Area", 28.8540, 77.0910, "approximate_centroid",
                   "North Delhi, light manufacturing/packaging."),
    IndustrialZone("Bawana Industrial Area", 28.7995, 77.0335, "approximate_centroid",
                   "Delhi's largest industrial estate, 1900+ acres, thousands of units."),
    IndustrialZone("Okhla Industrial Area (Phase I-III)", 28.5355, 77.2755, "approximate_centroid",
                   "Garments, electronics, export-oriented — three phases."),
    IndustrialZone("Mohan Cooperative Industrial Estate", 28.5285, 77.2865, "approximate_centroid"),
    IndustrialZone("Patparganj Industrial Area", 28.6230, 77.2905, "approximate_centroid",
                   "Printing, packaging, FMCG."),
    IndustrialZone("Jhilmil Industrial Area", 28.6720, 77.3175, "approximate_centroid"),
    IndustrialZone("Shahdara Industrial Area", 28.6710, 77.2890, "approximate_centroid"),
    IndustrialZone("Naraina Industrial Area (Phase I-II)", 28.6335, 77.1385, "approximate_centroid"),
    IndustrialZone("Mayapuri Industrial Area (Phase I-II)", 28.6320, 77.1215, "approximate_centroid",
                   "Auto parts, recycling, metal works."),
    IndustrialZone("Kirti Nagar Industrial Area", 28.6520, 77.1450, "approximate_centroid",
                   "Furniture hub."),
    IndustrialZone("Lawrence Road Industrial Area", 28.6870, 77.1520, "approximate_centroid",
                   "Food processing."),
    IndustrialZone("Anand Parbat Industrial Area", 28.6555, 77.1795, "approximate_centroid"),
    IndustrialZone("Mundka Industrial Area", 28.6815, 77.0335, "approximate_centroid",
                   "Warehousing and small-scale factories."),
    IndustrialZone("Badli Industrial Area", 28.7365, 77.1305, "approximate_centroid"),
]
