"""Tests for the OSM road-source grid aggregation fix (Sept 2026).

These never touch a real .pbf file — aggregate_roads_to_grid() is pure and
takes plain dicts, so it's tested directly against synthetic way lists.
See vayutrace_osm_roads.py's own module docstring for the full rationale
(fragmentation over-counting bug, why grid aggregation is the literature-
backed fix, why length-weighting rather than count-weighting matters).

Run: pytest ingest/tests/test_vayutrace_osm_roads.py -v
"""

import pytest

from app.vayutrace_osm_roads import (
    _GRID_DEG,
    _grid_key,
    _haversine_km,
    aggregate_roads_to_grid,
)


class TestHaversine:
    def test_zero_distance(self):
        assert _haversine_km(28.6, 77.2, 28.6, 77.2) == 0.0

    def test_known_short_distance(self):
        # ~0.0045deg lat ~ one grid cell height (~500m) — sanity check the
        # formula against the same constant the grid itself uses.
        d = _haversine_km(28.60, 77.20, 28.60 + _GRID_DEG, 77.20)
        assert 0.45 < d < 0.55


class TestGridKey:
    def test_same_cell_for_nearby_points(self):
        # Two points ~50m apart should land in the same ~500m cell.
        assert _grid_key(28.6000, 77.2000) == _grid_key(28.6003, 77.2002)

    def test_different_cell_for_far_points(self):
        assert _grid_key(28.6000, 77.2000) != _grid_key(28.6100, 77.2100)


class TestAggregateRoadsToGrid:
    def test_empty_input_returns_empty(self):
        assert aggregate_roads_to_grid([]) == []

    def test_single_way_preserved(self):
        ways = [{"lat": 28.6, "lng": 77.2, "length_km": 1.0, "emission_weight": 3}]
        out = aggregate_roads_to_grid(ways)
        assert len(out) == 1
        assert out[0]["source_type"] == "road"
        assert out[0]["segment_count"] == 1
        assert out[0]["total_length_km"] == 1.0
        # weighted_len_sum = length * class_weight
        assert out[0]["emission_weight"] == 3.0

    def test_fragmentation_invariance(self):
        """The core property this fix exists for: splitting one real road
        into many short OSM ways must not change its total contribution.
        A single 2km way and four 0.5km ways covering (approximately) the
        same path/cell must produce ~equal total emission_weight, not a 4x
        inflation — this is exactly the bug that made every ward read
        ~95-98% road dominance before this fix."""
        single = [{"lat": 28.6000, "lng": 77.2000, "length_km": 2.0, "emission_weight": 3}]
        # Same class, same cell, total length matches the single way.
        fragmented = [
            {"lat": 28.6000, "lng": 77.2000, "length_km": 0.5, "emission_weight": 3}
            for _ in range(4)
        ]

        single_out = aggregate_roads_to_grid(single)
        fragmented_out = aggregate_roads_to_grid(fragmented)

        assert len(single_out) == 1
        assert len(fragmented_out) == 1  # all 4 fragments collapse into one cell
        assert single_out[0]["emission_weight"] == pytest.approx(fragmented_out[0]["emission_weight"])
        assert fragmented_out[0]["segment_count"] == 4  # diagnostic count still reflects fragmentation
        assert single_out[0]["total_length_km"] == pytest.approx(fragmented_out[0]["total_length_km"])

    def test_count_weighting_would_have_inflated_but_length_weighting_does_not(self):
        """Directly demonstrates the bug this replaces: 100 short (10m)
        service-road fragments must contribute much less than 1 real 2km
        arterial, even though the fragment COUNT is 100x higher — a
        count-weighted (pre-fix) scheme would have gotten this backwards."""
        arterial = [{"lat": 28.6000, "lng": 77.2000, "length_km": 2.0, "emission_weight": 3}]
        many_tiny_fragments = [
            {"lat": 28.6000, "lng": 77.2000, "length_km": 0.01, "emission_weight": 1}
            for _ in range(100)
        ]

        arterial_out = aggregate_roads_to_grid(arterial)
        tiny_out = aggregate_roads_to_grid(many_tiny_fragments)

        # arterial: 2.0 * 3 = 6.0 ; tiny fragments: 100 * 0.01 * 1 = 1.0
        assert arterial_out[0]["emission_weight"] > tiny_out[0]["emission_weight"]
        assert tiny_out[0]["segment_count"] == 100  # count alone would have suggested the opposite

    def test_far_apart_ways_land_in_different_cells(self):
        ways = [
            {"lat": 28.60, "lng": 77.20, "length_km": 1.0, "emission_weight": 2},
            {"lat": 28.70, "lng": 77.30, "length_km": 1.0, "emission_weight": 2},
        ]
        out = aggregate_roads_to_grid(ways)
        assert len(out) == 2

    def test_zero_length_way_still_gets_a_position_but_no_weight(self):
        ways = [{"lat": 28.6, "lng": 77.2, "length_km": 0.0, "emission_weight": 3}]
        out = aggregate_roads_to_grid(ways)
        assert len(out) == 1
        assert out[0]["emission_weight"] == 0.0
        assert out[0]["lat"] == pytest.approx(28.6, abs=1e-3)
        assert out[0]["lng"] == pytest.approx(77.2, abs=1e-3)

    def test_missing_length_km_key_defaults_to_zero_not_crash(self):
        ways = [{"lat": 28.6, "lng": 77.2, "emission_weight": 2}]
        out = aggregate_roads_to_grid(ways)
        assert len(out) == 1
        assert out[0]["emission_weight"] == 0.0
