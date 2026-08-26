"""Sector-wise PM2.5/PM10 contribution priors — calibration starting point.

These are NOT derived from ISRM_PAVITRA. They come from published,
peer-reviewed / government-commissioned Delhi source-apportionment
studies, independent of and predating PAVITRA:

  - Sharma, M. & Dikshit, O. (2016). "Comprehensive Study on Air Pollution
    and Green House Gases (GHGs) in Delhi." IIT Kanpur, commissioned by
    DPCC. Hosted publicly at cerca.iitd.ac.in and airqualityasia.org, and
    listed on DPCC's own Technical Reports page.
  - TERI & ARAI (2018). "Source Apportionment of PM2.5 & PM10 of Delhi NCR
    for Identification of Major Sources."

These numbers are seasonal, city-wide AVERAGES from bulk chemical/receptor
analysis of real air samples — they are genuine measured source-
apportionment results, not a model's predictions. That makes them good
calibration PRIORS (a sanity check on what fraction each category should
roughly contribute, city-wide) but they are NOT ward-level and NOT
something this project's own forward model can be graded against
directly — see the honesty note in the harness's calibration step.

Percentages are approximate ranges from the IIT Kanpur study as reported;
treat the midpoint as the prior, the range as the uncertainty band.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SectorContributionPrior:
    category: str
    season: str  # "winter" | "summer"
    pm_type: str  # "PM2.5" | "PM10" | "both"
    pct_low: float
    pct_high: float
    source: str


SECTOR_PRIORS: list[SectorContributionPrior] = [
    # Winter, per IIT Kanpur (2016) - Sharma & Dikshit
    SectorContributionPrior("secondary_particles", "winter", "both", 25, 30,
                             "IIT Kanpur 2016, Ch.4 (Sharma & Dikshit)"),
    SectorContributionPrior("vehicles", "winter", "both", 20, 25,
                             "IIT Kanpur 2016, Ch.4 (Sharma & Dikshit)"),
    SectorContributionPrior("biomass_burning", "winter", "both", 17, 26,
                             "IIT Kanpur 2016, Ch.4 (Sharma & Dikshit)"),
    SectorContributionPrior("waste_burning_msw", "winter", "both", 8, 9,
                             "IIT Kanpur 2016, Ch.4 (Sharma & Dikshit)"),
    # Winter vehicular contribution can exceed the city-wide average at
    # specific high-traffic locations, per the same study - worth encoding
    # as a separate, wider-uncertainty entry rather than silently averaging
    # it into the city-wide figure above.
    SectorContributionPrior("vehicles_hotspot_locations", "winter", "PM2.5", 25, 35,
                             "IIT Kanpur 2016 - 'at certain locations this contribution could be above 35%'"),
    # Summer: crustal/dust dominated, per the same study.
    SectorContributionPrior("soil_road_dust_flyash", "summer", "PM10", 40, 44,
                             "IIT Kanpur 2016 - crustal fraction, highest at DSG/OKH monitoring sites"),
]

# Explicit, honest gap: TERI-ARAI (2018) numbers were confirmed to exist
# (real study, real citation trail) but this build did not fetch and
# transcribe its specific tables yet - only IIT Kanpur's numbers, which
# were directly visible in search results with real figures attached, are
# encoded above. Adding TERI-ARAI's numbers as a second, independent
# cross-check is a clear next step, not done yet - don't treat the list
# above as final or as having been cross-validated against a second source.
KNOWN_GAPS = [
    "TERI-ARAI (2018) sector contribution tables not yet transcribed into this file.",
    "SAFAR (2018) high-resolution emission inventory not yet reviewed for this project.",
    "No ward-level breakdown exists in either source above - these are city-wide averages, "
    "used here only as a sanity-check prior, not as ward-level ground truth.",
]
