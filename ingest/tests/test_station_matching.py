"""Known inputs, checked outputs - station_matching.py. Cases below are the
real documented mismatches (docs/data/delhi-station-reconciliation.md) plus
the real authority-label mismatches observed live from data.gov.in during
this integration's own audit (docs/data/data-gov-cpcb-authenticated-audit.md)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.station_matching import build_match_index, match_station, normalize_station_name  # noqa: E402


class TestNormalizeStationName:
    def test_strips_authority_and_city_noise_tokens(self):
        assert normalize_station_name("Narela, Delhi - DPCC") == "narela"

    def test_none_and_empty_are_safe(self):
        assert normalize_station_name(None) == ""
        assert normalize_station_name("") == ""

    def test_noise_only_name_normalizes_to_empty_not_a_fabricated_match(self):
        assert normalize_station_name("Delhi - DPCC") == ""

    def test_word_order_does_not_matter_once_noise_is_dropped(self):
        # Real live CPCB name vs. our own DB name for the same station -
        # authority label differs (IITM vs IMD) AND word order differs.
        cpcb = normalize_station_name("IMD Lodhi Road, Delhi - IITM")
        ours = normalize_station_name("Lodhi Road, New Delhi - IMD")
        assert cpcb == ours == "lodhi road"

    def test_authority_label_mismatch_alone_does_not_block_a_match(self):
        cpcb = normalize_station_name("North Campus, DU, Delhi - IITM")
        ours = normalize_station_name("North Campus, DU, Delhi - IMD")
        assert cpcb == ours

    def test_known_misspelling_mundaka_resolves_to_mundka(self):
        assert normalize_station_name("Mundaka, Delhi - DPCC") == normalize_station_name("Mundka, Delhi - DPCC")

    def test_camelcase_concatenation_artifact_still_matches_the_spaced_form(self):
        # "VivekVihar" (real documented CPCB PDF extraction artifact) vs.
        # our correctly-spaced "Vivek Vihar" - both reduce to the same
        # token set once noise is stripped, no alias table entry needed.
        assert normalize_station_name("VivekVihar, Delhi") == normalize_station_name("Vivek Vihar, Delhi - DPCC")

    def test_camelcase_mandirmarg_matches_spaced_form(self):
        assert normalize_station_name("MandirMarg, New Delhi") == normalize_station_name("Mandir Marg, New Delhi - DPCC")

    def test_unrelated_stations_do_not_collide(self):
        assert normalize_station_name("Wazirpur, Delhi - DPCC") != normalize_station_name("Rohini, Delhi - DPCC")


class TestBuildMatchIndexAndMatchStation:
    def test_matches_a_real_station_after_normalization(self):
        our_stations = [{"id": 1, "name": "Narela, Delhi - DPCC"}, {"id": 5, "name": "Rohini, Delhi - DPCC"}]
        index = build_match_index(our_stations)
        assert match_station("Narela, Delhi - DPCC", index) == 1

    def test_returns_none_for_a_station_with_no_match(self):
        our_stations = [{"id": 1, "name": "Narela, Delhi - DPCC"}]
        index = build_match_index(our_stations)
        assert match_station("Chandni Chowk, Delhi - IITM", index) is None

    def test_colliding_normalized_names_are_excluded_from_the_index_not_guessed(self):
        # Two distinct real station rows that would normalize identically -
        # neither should be matchable, rather than picking one arbitrarily.
        our_stations = [{"id": 1, "name": "Narela, Delhi - DPCC"}, {"id": 2, "name": "Narela, New Delhi - CPCB"}]
        index = build_match_index(our_stations)
        assert match_station("Narela, Delhi - DPCC", index) is None

    def test_empty_normalized_cpcb_name_never_matches_anything(self):
        our_stations = [{"id": 1, "name": "Narela, Delhi - DPCC"}]
        index = build_match_index(our_stations)
        assert match_station("Delhi - DPCC", index) is None
