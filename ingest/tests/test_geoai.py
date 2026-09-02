"""GeoAI structured-output parsing + semantic validation - no live Anthropic
calls. Anthropic client is fully mocked; the no-API-key stub path and the
validate_actions() semantic gate are exercised directly.

The fake client mocks client.messages.parse() (not .create()) and returns
.parsed_output directly, matching what parse_geo_query() actually calls -
see geoai.py's comment on why .parse(output_format=...) is required instead
of a hand-built output_config schema."""

import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import geoai  # noqa: E402


class _FakeResponse:
    def __init__(self, parsed_output, stop_reason="end_turn"):
        self.stop_reason = stop_reason
        self.parsed_output = parsed_output


class _FakeMessages:
    def __init__(self, parsed_output, stop_reason):
        self._parsed_output = parsed_output
        self._stop_reason = stop_reason

    def parse(self, **kwargs):
        return _FakeResponse(self._parsed_output, self._stop_reason)


class _FakeAnthropicClient:
    def __init__(self, api_key=None, parsed_output=None, stop_reason="end_turn"):
        self.messages = _FakeMessages(parsed_output, stop_reason)


def _patch_anthropic(monkeypatch, parsed_output=None, stop_reason="end_turn"):
    monkeypatch.setattr(geoai.config, "ANTHROPIC_API_KEY", "fake-key-for-tests")
    monkeypatch.setattr(
        geoai.anthropic,
        "Anthropic",
        lambda api_key=None: _FakeAnthropicClient(api_key, parsed_output, stop_reason),
    )


def test_no_api_key_returns_unsupported_stub(monkeypatch):
    monkeypatch.setattr(geoai.config, "ANTHROPIC_API_KEY", "")
    result = geoai.parse_geo_query("show wards near Anand Vihar", [])
    assert len(result.actions) == 1
    assert result.actions[0].type == "unsupported"
    assert "not configured" in result.actions[0].reason


def test_refusal_stop_reason_returns_unsupported_stub(monkeypatch):
    _patch_anthropic(monkeypatch, parsed_output=None, stop_reason="refusal")
    result = geoai.parse_geo_query("anything", [])
    assert result.actions[0].type == "unsupported"


def test_parses_valid_focus_action(monkeypatch):
    parsed_output = geoai.GeoAiResponse(
        explanation="Taking you to Anand Vihar.",
        actions=[geoai.FocusAction(type="focus", target_ref=geoai.EntityRef(type="ward", id="ward_1"))],
    )
    _patch_anthropic(monkeypatch, parsed_output=parsed_output)
    entities = [{"type": "ward", "id": "ward_1", "name": "Anand Vihar"}]
    result = geoai.parse_geo_query("take me to Anand Vihar", entities)
    assert len(result.actions) == 1
    action = result.actions[0]
    assert action.type == "focus"
    assert action.target_ref.type == "ward"
    assert action.target_ref.id == "ward_1"


def test_parses_bounded_multi_action_query(monkeypatch):
    parsed_output = geoai.GeoAiResponse(
        explanation="Showing wards near Anand Vihar with PM2.5 above 200.",
        actions=[
            geoai.SetFiltersAction(type="set_filters", pollutant="pm25"),
            geoai.QueryAction(
                type="query",
                target="wards",
                near_ref=geoai.EntityRef(type="ward", id="ward_1"),
                radius_km=3,
                pollutant="pm25",
                op=">",
                threshold=200,
            ),
        ],
    )
    _patch_anthropic(monkeypatch, parsed_output=parsed_output)
    entities = [{"type": "ward", "id": "ward_1", "name": "Anand Vihar"}]
    result = geoai.parse_geo_query("wards near Anand Vihar with PM2.5 above 200", entities)
    assert [a.type for a in result.actions] == ["set_filters", "query"]
    query = result.actions[1]
    assert query.near_ref.id == "ward_1"
    assert query.threshold == 200


def test_historical_time_downgrades_threshold_query(monkeypatch):
    """A threshold query paired with a non-'now' time change is scientifically
    misleading (the frontend filters live data regardless of obs_slot), so
    the validator must downgrade the query rather than let it execute
    against the wrong dataset under an honest-sounding 'yesterday' explanation."""
    parsed_output = geoai.GeoAiResponse(
        explanation="Showing wards near Anand Vihar with PM2.5 above 200 yesterday.",
        actions=[
            geoai.SetTimeAction(type="set_time", obs_slot="-24h"),
            geoai.QueryAction(
                type="query",
                target="wards",
                near_ref=geoai.EntityRef(type="ward", id="ward_1"),
                radius_km=3,
                pollutant="pm25",
                op=">",
                threshold=200,
            ),
        ],
    )
    _patch_anthropic(monkeypatch, parsed_output=parsed_output)
    entities = [{"type": "ward", "id": "ward_1", "name": "Anand Vihar"}]
    result = geoai.parse_geo_query("wards near Anand Vihar with PM2.5 above 200 yesterday", entities)
    assert [a.type for a in result.actions] == ["set_time", "unsupported"]
    assert "historical" in result.actions[1].reason.lower() or "forecast" in result.actions[1].reason.lower()


def test_parses_next_hour_into_1h_time_mode(monkeypatch):
    """Ward-level nowcasting (+1h): 'in the next hour' must resolve to
    time_mode="1h", and — since this is a plain display query with no
    threshold — must NOT be downgraded (spatialQuery.ts's matchesThreshold()
    was never updated to use the nowcast value, so a THRESHOLD query here
    would have the same live-data mismatch problem as historical/24h/48h -
    see test_next_hour_threshold_query_is_still_downgraded below - but a
    bare display query carries no such risk)."""
    parsed_output = geoai.GeoAiResponse(
        explanation="Showing PM2.5 wards near Anand Vihar in the next hour.",
        actions=[
            geoai.SetTimeAction(type="set_time", time_mode="1h"),
            geoai.SetFiltersAction(type="set_filters", pollutant="pm25"),
            geoai.QueryAction(
                type="query", target="wards", near_ref=geoai.EntityRef(type="ward", id="ward_1"), radius_km=3
            ),
        ],
    )
    _patch_anthropic(monkeypatch, parsed_output=parsed_output)
    entities = [{"type": "ward", "id": "ward_1", "name": "Anand Vihar"}]
    result = geoai.parse_geo_query("Show PM2.5 wards near Anand Vihar in the next hour", entities)

    assert [a.type for a in result.actions] == ["set_time", "set_filters", "query"]
    assert result.actions[0].time_mode == "1h"


def test_next_hour_threshold_query_is_still_downgraded(monkeypatch):
    """A threshold query under time_mode="1h" hits the exact same live-data
    mismatch the historical/24h/48h downgrade already protects against —
    the frontend's spatial-query matcher filters live ward data regardless
    of time_mode, so this must be downgraded exactly like the existing
    obs_slot="-24h" case, not silently exempted just because "1h" sounds
    forward-looking rather than historical."""
    parsed_output = geoai.GeoAiResponse(
        explanation="Showing wards near Anand Vihar with PM2.5 above 200 in the next hour.",
        actions=[
            geoai.SetTimeAction(type="set_time", time_mode="1h"),
            geoai.QueryAction(
                type="query",
                target="wards",
                near_ref=geoai.EntityRef(type="ward", id="ward_1"),
                radius_km=3,
                pollutant="pm25",
                op=">",
                threshold=200,
            ),
        ],
    )
    _patch_anthropic(monkeypatch, parsed_output=parsed_output)
    entities = [{"type": "ward", "id": "ward_1", "name": "Anand Vihar"}]
    result = geoai.parse_geo_query("wards near Anand Vihar with PM2.5 above 200 in the next hour", entities)

    assert [a.type for a in result.actions] == ["set_time", "unsupported"]


def test_historical_time_allows_non_threshold_query():
    """A pure spatial query (no threshold) under a historical time context is
    still fine - it doesn't depend on any pollutant value, only location,
    which doesn't change."""
    action = geoai.QueryAction(
        type="query", target="wards", near_ref=geoai.EntityRef(type="ward", id="ward_1")
    )
    set_time = geoai.SetTimeAction(type="set_time", obs_slot="-24h")
    parsed = geoai.GeoAiResponse(explanation="test", actions=[set_time, action])
    result = geoai.validate_actions(parsed, entity_ids={("ward", "ward_1")})
    assert [a.type for a in result.actions] == ["set_time", "query"]
    assert result.actions[1].near_ref.id == "ward_1"


def test_validate_actions_rejects_pollutant_threshold_on_incidents():
    action = geoai.QueryAction(
        type="query", target="incidents", pollutant="pm25", op=">", threshold=200
    )
    parsed = geoai.GeoAiResponse(explanation="test", actions=[action])
    result = geoai.validate_actions(parsed, entity_ids=set())
    assert result.actions[0].type == "unsupported"
    assert "incidents" in result.actions[0].reason.lower()


def test_validate_actions_rejects_unknown_entity_ref():
    action = geoai.FocusAction(type="focus", target_ref=geoai.EntityRef(type="ward", id="ward_999"))
    parsed = geoai.GeoAiResponse(explanation="test", actions=[action])
    result = geoai.validate_actions(parsed, entity_ids={("ward", "ward_1")})
    assert result.actions[0].type == "unsupported"


def test_validate_actions_clamps_radius():
    action = geoai.QueryAction(type="query", target="wards", radius_km=999)
    parsed = geoai.GeoAiResponse(explanation="test", actions=[action])
    result = geoai.validate_actions(parsed, entity_ids=set())
    assert result.actions[0].type == "query"
    assert result.actions[0].radius_km == geoai.MAX_RADIUS_KM


def test_validate_actions_rejects_focus_with_null_target():
    action = geoai.FocusAction(type="focus", target_ref=None)
    parsed = geoai.GeoAiResponse(explanation="test", actions=[action])
    result = geoai.validate_actions(parsed, entity_ids=set())
    assert result.actions[0].type == "unsupported"


def test_validate_actions_rejects_noop_set_time():
    action = geoai.SetTimeAction(type="set_time")
    parsed = geoai.GeoAiResponse(explanation="test", actions=[action])
    result = geoai.validate_actions(parsed, entity_ids=set())
    assert result.actions[0].type == "unsupported"


def test_validate_actions_rejects_noop_set_filters():
    action = geoai.SetFiltersAction(type="set_filters")
    parsed = geoai.GeoAiResponse(explanation="test", actions=[action])
    result = geoai.validate_actions(parsed, entity_ids=set())
    assert result.actions[0].type == "unsupported"


def test_validate_actions_rejects_threshold_missing_pollutant():
    action = geoai.QueryAction(type="query", target="wards", op=">", threshold=200)
    parsed = geoai.GeoAiResponse(explanation="test", actions=[action])
    result = geoai.validate_actions(parsed, entity_ids=set())
    assert result.actions[0].type == "unsupported"


def test_validate_actions_collapses_unsupported_mixed_with_executable():
    """The model hedging - flagging part of a plan unsupported while also
    returning executable actions - should not partially execute; collapse
    to just the unsupported action rather than run an uncertain plan."""
    filters = geoai.SetFiltersAction(type="set_filters", pollutant="pm25")
    unsupported = geoai.UnsupportedAction(type="unsupported", reason="Not sure what you meant by the rest.")
    parsed = geoai.GeoAiResponse(explanation="test", actions=[filters, unsupported])
    result = geoai.validate_actions(parsed, entity_ids=set())
    assert len(result.actions) == 1
    assert result.actions[0].type == "unsupported"


def test_validate_actions_allows_only_one_query():
    q1 = geoai.QueryAction(type="query", target="wards")
    q2 = geoai.QueryAction(type="query", target="stations")
    parsed = geoai.GeoAiResponse(explanation="test", actions=[q1, q2])
    result = geoai.validate_actions(parsed, entity_ids=set())
    assert result.actions[0].type == "query"
    assert result.actions[1].type == "unsupported"


def test_geoai_response_rejects_empty_actions_list():
    with pytest.raises(ValidationError):
        geoai.GeoAiResponse(explanation="test", actions=[])


def test_validate_actions_allows_severity_on_incidents():
    action = geoai.QueryAction(type="query", target="incidents", severity="severe")
    parsed = geoai.GeoAiResponse(explanation="test", actions=[action])
    result = geoai.validate_actions(parsed, entity_ids=set())
    assert result.actions[0].type == "query"
    assert result.actions[0].severity == "severe"
