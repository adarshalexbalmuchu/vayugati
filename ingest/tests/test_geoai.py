"""GeoAI structured-output parsing + semantic validation - no live Anthropic
calls. Anthropic client is fully mocked; the no-API-key stub path and the
validate_actions() semantic gate are exercised directly."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import geoai  # noqa: E402


class _FakeTextBlock:
    def __init__(self, text):
        self.type = "text"
        self.text = text


class _FakeResponse:
    def __init__(self, text, stop_reason="end_turn"):
        self.stop_reason = stop_reason
        self.content = [_FakeTextBlock(text)]


class _FakeMessages:
    def __init__(self, text, stop_reason):
        self._text = text
        self._stop_reason = stop_reason

    def create(self, **kwargs):
        return _FakeResponse(self._text, self._stop_reason)


class _FakeAnthropicClient:
    def __init__(self, api_key=None, text="", stop_reason="end_turn"):
        self.messages = _FakeMessages(text, stop_reason)


def _patch_anthropic(monkeypatch, text, stop_reason="end_turn"):
    monkeypatch.setattr(geoai.config, "ANTHROPIC_API_KEY", "fake-key-for-tests")
    monkeypatch.setattr(
        geoai.anthropic,
        "Anthropic",
        lambda api_key=None: _FakeAnthropicClient(api_key, text, stop_reason),
    )


def test_no_api_key_returns_unsupported_stub(monkeypatch):
    monkeypatch.setattr(geoai.config, "ANTHROPIC_API_KEY", "")
    result = geoai.parse_geo_query("show wards near Anand Vihar", [])
    assert len(result.actions) == 1
    assert result.actions[0].type == "unsupported"
    assert "not configured" in result.actions[0].reason


def test_refusal_stop_reason_returns_unsupported_stub(monkeypatch):
    _patch_anthropic(monkeypatch, text="", stop_reason="refusal")
    result = geoai.parse_geo_query("anything", [])
    assert result.actions[0].type == "unsupported"


def test_parses_valid_focus_action(monkeypatch):
    payload = {
        "explanation": "Taking you to Anand Vihar.",
        "actions": [{"type": "focus", "target_ref": {"type": "ward", "id": "ward_1"}}],
    }
    _patch_anthropic(monkeypatch, text=json.dumps(payload))
    entities = [{"type": "ward", "id": "ward_1", "name": "Anand Vihar"}]
    result = geoai.parse_geo_query("take me to Anand Vihar", entities)
    assert len(result.actions) == 1
    action = result.actions[0]
    assert action.type == "focus"
    assert action.target_ref.type == "ward"
    assert action.target_ref.id == "ward_1"


def test_parses_bounded_multi_action_query(monkeypatch):
    payload = {
        "explanation": "Showing wards near Anand Vihar with PM2.5 above 200 yesterday.",
        "actions": [
            {"type": "set_time", "obs_slot": "-24h"},
            {
                "type": "query",
                "target": "wards",
                "near_ref": {"type": "ward", "id": "ward_1"},
                "radius_km": 3,
                "pollutant": "pm25",
                "op": ">",
                "threshold": 200,
            },
        ],
    }
    _patch_anthropic(monkeypatch, text=json.dumps(payload))
    entities = [{"type": "ward", "id": "ward_1", "name": "Anand Vihar"}]
    result = geoai.parse_geo_query("wards near Anand Vihar with PM2.5 above 200 yesterday", entities)
    assert [a.type for a in result.actions] == ["set_time", "query"]
    query = result.actions[1]
    assert query.near_ref.id == "ward_1"
    assert query.threshold == 200


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


def test_validate_actions_allows_severity_on_incidents():
    action = geoai.QueryAction(type="query", target="incidents", severity="severe")
    parsed = geoai.GeoAiResponse(explanation="test", actions=[action])
    result = geoai.validate_actions(parsed, entity_ids=set())
    assert result.actions[0].type == "query"
    assert result.actions[0].severity == "severe"
