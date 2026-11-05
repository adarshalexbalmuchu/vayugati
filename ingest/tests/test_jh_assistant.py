"""Validation tests for the Jharkhand map assistant (app/jh_assistant.py): the server-side gate that sits
between Claude's structured output and the browser. No network: the model call itself is not exercised."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import jh_assistant as ja  # noqa: E402

LAYERS = {"mines", "water", "forest", "fires", "places"}


def resp(reply, *actions):
    return ja.AssistantResponse(reply=reply, actions=list(actions))


def test_pack_data_is_found():
    assert len(ja.district_names()) == 24
    assert len(ja.places()) > 800


def test_unknown_layer_keys_are_dropped():
    r = ja.validate(resp("Showing mines.", ja.SetLayersAction(type="set_layers", on=["mines", "bogus"], off=["nope"])), LAYERS)
    a = r.actions[0]
    assert a.type == "set_layers" and a.on == ["mines"] and a.off == []


def test_all_unknown_layers_become_unsupported():
    r = ja.validate(resp("x", ja.SetLayersAction(type="set_layers", on=["bogus"])), LAYERS)
    assert r.actions[0].type == "unsupported"


def test_layer_not_both_on_and_off():
    r = ja.validate(resp("ok", ja.SetLayersAction(type="set_layers", on=["mines"], off=["mines", "water"])), LAYERS)
    assert r.actions[0].on == ["mines"] and r.actions[0].off == ["water"]


def test_district_aliases_resolve_to_census_spelling():
    assert ja.resolve_district("Koderma") == "Kodarma"
    assert ja.resolve_district("hazaribag") == "Hazaribagh"
    assert ja.resolve_district("East Singhbhum") == "Purbi Singhbhum"
    assert ja.resolve_district("Seraikela Kharsawan") == "Saraikela-Kharsawan"
    assert ja.resolve_district("Atlantis") is None


def test_go_to_district_must_be_real():
    ok = ja.validate(resp("Going.", ja.GoToAction(type="go_to", kind="district", name="Ranchi")), LAYERS)
    assert ok.actions[0].name == "Ranchi"
    bad = ja.validate(resp("Going.", ja.GoToAction(type="go_to", kind="district", name="Gotham")), LAYERS)
    assert bad.actions[0].type == "unsupported"


def test_place_resolves_with_server_coordinates_and_ignores_model_coordinates():
    r = ja.validate(resp("Going.", ja.GoToAction(type="go_to", kind="place", name="jhumri tilaiya", lng=0.0, lat=0.0)), LAYERS)
    a = r.actions[0]
    assert a.type == "go_to" and a.name.lower().startswith("jhumri")
    assert 85 < a.lng < 86 and 24 < a.lat < 25  # not the model's 0, 0


def test_unknown_place_is_unsupported():
    r = ja.validate(resp("Going.", ja.GoToAction(type="go_to", kind="place", name="Xyzzyville")), LAYERS)
    assert r.actions[0].type == "unsupported"


def test_reply_with_digits_is_replaced():
    r = ja.validate(resp("Ranchi has 2.9 million people.", ja.FactsAction(type="facts", district="Ranchi", fields=["population"])), LAYERS)
    assert r.reply == "Showing facts for Ranchi from the checked data."
    assert not any(ch.isdigit() for ch in r.reply)


def test_reply_without_digits_is_kept():
    r = ja.validate(resp("Showing Ranchi's profile.", ja.FactsAction(type="facts", district="Ranchi", fields=["population"])), LAYERS)
    assert r.reply == "Showing Ranchi's profile."


def test_overlong_reply_is_replaced():
    r = ja.validate(resp("a" * 400, ja.FactsAction(type="facts", district="Ranchi", fields=["area"])), LAYERS)
    assert r.reply == "Showing facts for Ranchi from the checked data."


def test_facts_district_is_validated_and_fields_deduped():
    r = ja.validate(resp("ok", ja.FactsAction(type="facts", district="Koderma", fields=["area", "area", "population"])), LAYERS)
    a = r.actions[0]
    assert a.district == "Kodarma" and a.fields == ["area", "population"]


def test_unsupported_reply_is_its_reason():
    r = ja.validate(resp("whatever", ja.UnsupportedAction(type="unsupported", reason="No air-quality readings on this map.")), LAYERS)
    assert r.reply == "No air-quality readings on this map."


def test_rank_limit_is_bounded_by_the_schema():
    import pytest
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        ja.RankAction(type="rank", field="area", limit=50)


def test_no_api_key_gives_an_honest_unsupported(monkeypatch):
    monkeypatch.setattr(ja.config, "ANTHROPIC_API_KEY", "")
    r = ja.ask("hello", [], [ja.LayerRef(key="mines", label="Mines")])
    assert r.actions[0].type == "unsupported"


def test_near_resolves_place_and_clamps_radius():
    r = ja.validate(resp("Looking.", ja.NearAction(type="near", place="bokaro", radius_km=100, what="schools")), LAYERS)
    a = r.actions[0]
    assert a.type == "near" and a.radius_km == ja.MAX_NEAR_KM and a.what == "schools"
    assert a.place_name and 85 < a.lng < 87 and 23 < a.lat < 24.5


def test_near_with_unknown_place_is_unsupported():
    r = ja.validate(resp("Looking.", ja.NearAction(type="near", place="Xyzzyville", radius_km=10, what="mines")), LAYERS)
    assert r.actions[0].type == "unsupported"


def test_near_rejects_unknown_feature_type():
    import pytest
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        ja.NearAction(type="near", place="Ranchi", radius_km=5, what="banks")


def test_rank_can_open_the_winner():
    r = ja.validate(resp("Ranking.", ja.RankAction(type="rank", field="n_schools", order="desc", limit=3, open_top=True)), LAYERS)
    assert r.actions[0].open_top is True
