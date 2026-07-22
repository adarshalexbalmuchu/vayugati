"""Known inputs, checked outputs - transit_activity.py's derived summary."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.transit_activity import haversine_km, summarize_activity, unavailable_summary  # noqa: E402

# Narela ward centroid (real coordinate, matches stations.yaml's Narela station)
NARELA = {"id": 1, "name": "Narela", "lat": 28.8524, "lng": 77.0925}
# ~far away, well outside any 3km buffer
FAR_AWAY = {"id": 2, "name": "Elsewhere", "lat": 12.9716, "lng": 77.5946}


def vehicle(lat, lng, route_id="R1", vehicle_id="V1", trip_id="T1"):
    return {"vehicle_id": vehicle_id, "trip_id": trip_id, "route_id": route_id, "lat": lat, "lng": lng, "timestamp": 1_700_000_000}


class TestHaversine:
    def test_zero_distance_for_identical_points(self):
        assert haversine_km(28.85, 77.09, 28.85, 77.09) == 0

    def test_known_distance_is_reasonable(self):
        # Narela to a point ~0.01 degrees away is roughly ~1km, not ~100km or ~0km
        d = haversine_km(28.8524, 77.0925, 28.8624, 77.0925)
        assert 0.5 < d < 2.0


class TestSummarizeActivity:
    def test_counts_live_buses_and_distinct_routes(self):
        vehicles = [vehicle(28.8524, 77.0925, route_id="R1"), vehicle(28.8524, 77.0925, route_id="R2"), vehicle(28.8524, 77.0925, route_id="R1")]
        summary = summarize_activity(vehicles, [NARELA])
        assert summary["live_buses_tracked"] == 3
        assert summary["active_routes"] == 2

    def test_vehicles_beyond_buffer_are_not_counted_for_a_ward(self):
        vehicles = [vehicle(28.8524, 77.0925)]  # right at Narela's centroid
        summary = summarize_activity(vehicles, [FAR_AWAY])
        assert summary["per_ward"][0]["vehicle_count"] == 0
        assert summary["per_ward"][0]["activity_level"] == "none"

    def test_vehicles_within_buffer_are_counted_for_the_right_ward(self):
        vehicles = [vehicle(28.8524, 77.0925), vehicle(28.8524, 77.0925)]
        summary = summarize_activity(vehicles, [NARELA, FAR_AWAY])
        by_id = {w["ward_id"]: w for w in summary["per_ward"]}
        assert by_id[1]["vehicle_count"] == 2
        assert by_id[2]["vehicle_count"] == 0

    def test_wards_without_lat_lng_are_skipped_not_fabricated(self):
        ward_no_coords = {"id": 3, "name": "No Coords", "lat": None, "lng": None}
        summary = summarize_activity([vehicle(28.8524, 77.0925)], [ward_no_coords])
        assert summary["per_ward"] == []

    def test_activity_level_buckets(self):
        # 0 -> none, 1..5 -> low, 6..15 -> medium, 16+ -> high
        for count, expected in [(0, "none"), (5, "low"), (6, "medium"), (15, "medium"), (16, "high")]:
            vehicles = [vehicle(28.8524, 77.0925, vehicle_id=f"V{i}") for i in range(count)]
            summary = summarize_activity(vehicles, [NARELA])
            assert summary["per_ward"][0]["activity_level"] == expected, f"count={count}"

    def test_always_carries_the_required_disclaimer_labels(self):
        summary = summarize_activity([], [NARELA])
        assert summary["label"] == "Public transport activity via Delhi Open Transit Data."
        assert summary["disclaimer"] == "Context layer only — not proof of emissions or congestion."


class TestUnavailableSummary:
    def test_flags_unavailable_with_none_counts_not_zero(self):
        summary = unavailable_summary("key not configured")
        assert summary["live_buses_tracked"] is None
        assert summary["active_routes"] is None
        assert summary["per_ward"] == []
        assert summary["unavailable_reason"] == "key not configured"

    def test_still_carries_the_required_disclaimer_labels(self):
        summary = unavailable_summary("some failure")
        assert summary["label"] == "Public transport activity via Delhi Open Transit Data."
        assert summary["disclaimer"] == "Context layer only — not proof of emissions or congestion."
