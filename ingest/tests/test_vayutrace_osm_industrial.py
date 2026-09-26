"""Tests for the OSM industrial-zone source loader (Sept 2026).

_shoelace_centroid() is pure and takes plain coordinate lists, so it's
tested directly here. load_delhi_industrial_zones() itself (the .pbf-
parsing entry point) is not unit-tested — it needs a real .pbf file and
osmium, same as vayutrace_osm_roads.load_delhi_roads(); its contract
(returns [] when the file/library is absent, never crashes) is exercised
live via the module's own docstring guarantees, matching this repo's
existing convention for the road loader.

See vayutrace_osm_industrial.py's own module docstring for the full
rationale (why real OSM polygons replaced the old 60 hardcoded zones, what
non-emission-source tags were excluded, why area-based weighting).

Run: pytest ingest/tests/test_vayutrace_osm_industrial.py -v
"""

import pytest

from app.vayutrace_osm_industrial import (
    _EXCLUDE_TAGS,
    _SUBTYPE_MULTIPLIER,
    _shoelace_centroid,
)


class TestShoelaceCentroid:
    def test_returns_none_for_fewer_than_three_points(self):
        assert _shoelace_centroid([(0.0, 0.0), (1.0, 1.0)]) is None

    def test_returns_none_for_empty_ring(self):
        assert _shoelace_centroid([]) is None

    def test_square_centroid_at_geometric_center(self):
        # Square: (0,0)-(0,2)-(2,2)-(2,0) in (lng, lat) pairs.
        ring = [(0, 0), (0, 2), (2, 2), (2, 0), (0, 0)]
        c = _shoelace_centroid(ring)
        assert c is not None
        lng, lat, area = c
        assert lng == pytest.approx(1.0)
        assert lat == pytest.approx(1.0)
        assert area == pytest.approx(4.0)  # 2x2 square

    def test_area_is_always_non_negative(self):
        # Same square, opposite winding order — signed area flips sign,
        # but the returned area must be the absolute value.
        ring_cw = [(0, 0), (2, 0), (2, 2), (0, 2), (0, 0)]
        ring_ccw = [(0, 0), (0, 2), (2, 2), (2, 0), (0, 0)]
        area_cw = _shoelace_centroid(ring_cw)[2]
        area_ccw = _shoelace_centroid(ring_ccw)[2]
        assert area_cw == pytest.approx(area_ccw)
        assert area_cw > 0

    def test_larger_polygon_has_larger_area(self):
        small = _shoelace_centroid([(0, 0), (0, 1), (1, 1), (1, 0), (0, 0)])
        large = _shoelace_centroid([(0, 0), (0, 10), (10, 10), (10, 0), (0, 0)])
        assert large[2] > small[2]

    def test_degenerate_zero_area_ring_returns_none(self):
        # All points collinear — encloses no area.
        ring = [(0, 0), (1, 0), (2, 0), (0, 0)]
        assert _shoelace_centroid(ring) is None


class TestExclusionAndWeighting:
    """These are data assertions, not behaviour — locking in the exact
    exclude-tag set and subtype multipliers documented in the module
    docstring, so a future edit can't silently drop one without a test
    catching it (e.g. accidentally starting to count a power substation as
    an emission source again)."""

    def test_power_and_water_infrastructure_excluded(self):
        assert ("power", "plant") in _EXCLUDE_TAGS
        assert ("power", "substation") in _EXCLUDE_TAGS
        assert ("man_made", "wastewater_treatment") in _EXCLUDE_TAGS

    def test_depots_excluded_not_manufacturing(self):
        assert ("industrial", "depot") in _EXCLUDE_TAGS
        assert ("industrial", "bus_depot") in _EXCLUDE_TAGS

    def test_actual_manufacturing_subtypes_not_excluded(self):
        manufacturing_tags = {("industrial", "factory"), ("industrial", "steel_mill")}
        assert manufacturing_tags.isdisjoint(_EXCLUDE_TAGS)

    def test_heavy_industry_subtypes_weighted_above_neutral(self):
        assert _SUBTYPE_MULTIPLIER["steel_mill"] > 1.0
        assert _SUBTYPE_MULTIPLIER["factory"] > 1.0

    def test_warehouse_weighted_below_neutral(self):
        assert _SUBTYPE_MULTIPLIER["warehouse"] < 1.0
