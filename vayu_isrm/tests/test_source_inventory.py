"""Sanity tests for Phase 1 source inventory data. These check the static
data loads and is internally consistent - they don't (yet) test anything
live, since FIRMS/OSM live access isn't wired up yet by design (see the
NotImplementedError docstrings in sources/firms_fire.py and
sources/osm_roads.py)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from sources.industrial_zones import INDUSTRIAL_ZONES
from sources.sector_priors import SECTOR_PRIORS, KNOWN_GAPS


def test_industrial_zones_load_and_are_within_delhi_bbox():
    # Loose Delhi NCT bounding box - same one used across the other source modules.
    w, s, e, n = 76.8, 28.4, 77.4, 28.9
    assert len(INDUSTRIAL_ZONES) >= 10, "expected a real starter list, not a placeholder"
    for zone in INDUSTRIAL_ZONES:
        assert w <= zone.lng <= e, f"{zone.name} longitude {zone.lng} outside Delhi bbox"
        assert s <= zone.lat <= n, f"{zone.name} latitude {zone.lat} outside Delhi bbox"
        assert zone.coordinate_confidence == "approximate_centroid", (
            f"{zone.name} claims a confidence level other than approximate_centroid - "
            f"only mark this higher once real polygon data backs it"
        )


def test_industrial_zone_names_are_unique():
    names = [z.name for z in INDUSTRIAL_ZONES]
    assert len(names) == len(set(names)), "duplicate zone name found"


def test_sector_priors_percentages_are_sane():
    for prior in SECTOR_PRIORS:
        assert 0 <= prior.pct_low <= prior.pct_high <= 100, f"{prior.category}: nonsensical range"
        assert prior.source, f"{prior.category} has no source citation"


def test_known_gaps_are_documented_not_hidden():
    # This is a slightly unusual test: it asserts the gap-tracking list
    # itself isn't empty, i.e. this module is still honestly admitting
    # what it hasn't done yet rather than silently going quiet about it.
    assert len(KNOWN_GAPS) > 0


if __name__ == "__main__":
    import inspect
    mod = sys.modules[__name__]
    fns = [f for name, f in inspect.getmembers(mod, inspect.isfunction) if name.startswith("test_")]
    passed, failed = 0, 0
    for fn in fns:
        try:
            fn()
            passed += 1
        except AssertionError as e:
            failed += 1
            print(f"FAIL: {fn.__name__}: {e}")
    print(f"\n{passed} passed, {failed} failed (out of {len(fns)})")
    sys.exit(1 if failed else 0)
