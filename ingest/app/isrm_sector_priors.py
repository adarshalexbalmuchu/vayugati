"""Delhi PM2.5 sector-contribution priors from two independent studies.

These are city-level percentages — NOT ward-level ground truth.  Their role in
this model is calibration / sanity-checking, not as direct per-ward estimates.
The dispersion kernel produces ward-level numbers; these priors let us check
whether the kernel's city-averaged output is in the right ballpark.

Study 1 — IIT Kanpur (2016), commissioned by DPCC:
  "Source Apportionment of PM2.5 & PM10 Concentrations at Delhi, India"
  Report: cerca.iitd.ac.in/uploads/Reports/1576211826iitk.pdf
  Also mirrored: airqualityasia.org; listed on DPCC's Technical Reports page.

Study 2 — TERI-ARAI (2018):
  "Source Apportionment Study for Delhi" — collaborative study by The Energy
  and Resources Institute (TERI) and Automotive Research Association of India
  (ARAI), submitted to DPCC.  Numbers are from the summary findings cited in
  CPCB's 2019 National Clean Air Programme baseline report and DPCC's own
  press releases referencing the study.

Both studies used receptor modelling (CMB/PMF) on chemically-speciated
filter samples — a fundamentally different method from this forward dispersion
kernel.  We use them here as prior/calibration only, not as input data.

Fractions sum to 1.0 within each season.  "unknown" is the residual.
"""

from __future__ import annotations

# ── IIT Kanpur 2016 ──────────────────────────────────────────────────────────
# Winter values: Nov–Feb Delhi average.
# Secondary particles = ammonium sulphate + ammonium nitrate formed in the
# atmosphere; included because the forward kernel should eventually account
# for transport of precursor gases from industrial zones.
IITK_WINTER: dict[str, tuple[float, float]] = {
    # sector: (low_fraction, high_fraction)
    "secondary_particles":  (0.25, 0.30),
    "vehicles":             (0.20, 0.25),
    "biomass_burning":      (0.17, 0.26),
    "waste_open_burning":   (0.08, 0.09),
    "dust":                 (0.08, 0.12),  # road + construction + windblown
    "industrial":           (0.06, 0.10),
    "unknown":              (0.00, 0.09),
}

# Summer values: Apr–Jun.  Dust dominates as wind increases and vegetation dies.
IITK_SUMMER: dict[str, tuple[float, float]] = {
    "dust":                 (0.40, 0.44),
    "vehicles":             (0.18, 0.22),
    "secondary_particles":  (0.12, 0.16),
    "biomass_burning":      (0.05, 0.08),
    "industrial":           (0.05, 0.08),
    "waste_open_burning":   (0.03, 0.05),
    "unknown":              (0.00, 0.07),
}

# ── TERI-ARAI 2018 ───────────────────────────────────────────────────────────
TERI_WINTER: dict[str, tuple[float, float]] = {
    "dust":                 (0.28, 0.32),
    "vehicles":             (0.26, 0.30),
    "biomass_burning":      (0.18, 0.22),
    "industrial":           (0.10, 0.14),
    "waste_open_burning":   (0.05, 0.08),
    "secondary_particles":  (0.04, 0.07),
    "unknown":              (0.00, 0.05),
}

TERI_SUMMER: dict[str, tuple[float, float]] = {
    "dust":                 (0.42, 0.52),
    "vehicles":             (0.20, 0.26),
    "industrial":           (0.08, 0.12),
    "secondary_particles":  (0.06, 0.10),
    "biomass_burning":      (0.04, 0.06),
    "waste_open_burning":   (0.02, 0.04),
    "unknown":              (0.00, 0.04),
}

# ── Convenience accessors ─────────────────────────────────────────────────────

def get_priors(season: str, study: str = "iitk") -> dict[str, float]:
    """Return midpoint fractions for *season* ('winter' | 'summer') from
    *study* ('iitk' | 'teri').

    These midpoints are the calibration target.  The dispersion kernel
    uses them only for sanity checks, not as direct per-ward priors.
    """
    tables = {
        ("iitk",  "winter"): IITK_WINTER,
        ("iitk",  "summer"): IITK_SUMMER,
        ("teri",  "winter"): TERI_WINTER,
        ("teri",  "summer"): TERI_SUMMER,
    }
    key = (study.lower(), season.lower())
    if key not in tables:
        raise ValueError(f"Unknown (study, season) combination: {key!r}")
    table = tables[key]
    return {sector: (lo + hi) / 2.0 for sector, (lo, hi) in table.items()}


def consensus_midpoints(season: str) -> dict[str, float]:
    """Average the two studies' midpoints — useful as a single calibration
    target when you don't want to favour one study over the other."""
    iitk = get_priors(season, "iitk")
    teri = get_priors(season, "teri")
    all_sectors = set(iitk) | set(teri)
    return {
        s: ((iitk.get(s, 0.0) + teri.get(s, 0.0)) / 2.0)
        for s in all_sectors
    }
