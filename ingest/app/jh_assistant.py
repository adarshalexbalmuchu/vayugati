"""Jharkhand map assistant: a grounded natural-language control for the geospatial map.

Claude only turns a question (and the last few turns) into at most three typed actions. It never states a
figure: every number the user sees is read by the app from the checked district profiles, with its source.
Server-side validation is a second, independent gate:

  * layer keys must be ones the client sent;
  * district names must be one of the 24 districts; place names must resolve to a real place in the map data
    (the server returns its coordinates, so the model never supplies one);
  * the model's own wording must contain no digits (a figure in prose could be wrong and would carry no
    source), otherwise it is replaced by a neutral sentence;
  * anything else becomes an "unsupported" action with an honest reason.

Same pattern as geoai.py (Delhi's query agent): language only, deterministic execution in the browser.
"""

import json
import logging
import os
import re
import unicodedata
from pathlib import Path
from typing import Literal

import anthropic
from pydantic import BaseModel, Field, ValidationError

from . import config

log = logging.getLogger("ingest.jh_assistant")

JH_ASSISTANT_MODEL = os.getenv("JH_ASSISTANT_MODEL", "claude-haiku-5-5")
MAX_ACTIONS = 3
MAX_HISTORY = 6
MAX_REPLY_CHARS = 280

PACK_DIR = Path(os.getenv("JH_PACK_DIR", str(Path(__file__).resolve().parents[2] / "web" / "public" / "city-packs" / "jharkhand")))

FIELDS = (
    "area", "population", "forest_pct", "forest_km2", "highest_point", "typical_height", "heat_detections",
    "tree_cover_pct", "cropland_pct", "builtup_pct", "water_pct", "monitors_continuous", "monitors_manual",
    "monitors_planned", "n_mining_areas", "n_industrial_areas", "n_brick_kilns", "n_schools", "n_hospitals",
    "n_rail_stations", "n_peaks", "n_substations", "n_towns", "n_villages", "annual_rainfall", "monsoon_rain_pct",
    "winter_wind_speed", "winter_wind_from", "monsoon_wind_from", "near_mines_2km_pct", "near_mines_5km_pct",
    "near_kilns_2km_pct", "near_plants_5km_pct",
)
FieldName = Literal[
    "area", "population", "forest_pct", "forest_km2", "highest_point", "typical_height", "heat_detections",
    "tree_cover_pct", "cropland_pct", "builtup_pct", "water_pct", "monitors_continuous", "monitors_manual",
    "monitors_planned", "n_mining_areas", "n_industrial_areas", "n_brick_kilns", "n_schools", "n_hospitals",
    "n_rail_stations", "n_peaks", "n_substations", "n_towns", "n_villages", "annual_rainfall", "monsoon_rain_pct",
    "winter_wind_speed", "winter_wind_from", "monsoon_wind_from", "near_mines_2km_pct", "near_mines_5km_pct",
    "near_kilns_2km_pct", "near_plants_5km_pct",
]
NEAR_WHAT = ("mines", "industrial", "plants", "kilns", "schools", "hospitals", "towns", "villages", "heat",
             "peaks", "rail_stations", "substations")
NearWhat = Literal["mines", "industrial", "plants", "kilns", "schools", "hospitals", "towns", "villages", "heat",
                   "peaks", "rail_stations", "substations"]
MIN_NEAR_KM, MAX_NEAR_KM = 1.0, 50.0


class SetLayersAction(BaseModel):
    type: Literal["set_layers"]
    on: list[str] = Field(default_factory=list, max_length=20)
    off: list[str] = Field(default_factory=list, max_length=20)
    only: bool = False  # true: switch everything else off


class GoToAction(BaseModel):
    type: Literal["go_to"]
    kind: Literal["state", "district", "place"]
    name: str | None = None
    # filled by validate(): coordinates of a resolved place
    lng: float | None = None
    lat: float | None = None


class RankAction(BaseModel):
    type: Literal["rank"]
    field: FieldName
    order: Literal["desc", "asc"] = "desc"
    limit: int = Field(default=5, ge=1, le=10)
    # also fly to the top-ranked district and open it ("which district has the most forest, show it")
    open_top: bool = False


class NearAction(BaseModel):
    type: Literal["near"]
    place: str  # a named place; resolved by the server
    radius_km: float = Field(default=10.0, ge=0.1, le=100.0)
    what: NearWhat
    # filled by validate(): the resolved place
    place_name: str | None = None
    lng: float | None = None
    lat: float | None = None


class FactsAction(BaseModel):
    type: Literal["facts"]
    district: str
    fields: list[FieldName] = Field(min_length=1, max_length=8)


class ZoomAction(BaseModel):
    type: Literal["zoom"]
    direction: Literal["in", "out"]


class OverviewAction(BaseModel):
    """A summary of the whole state from the checked district data (the app computes every figure)."""
    type: Literal["overview"]


class UnsupportedAction(BaseModel):
    type: Literal["unsupported"]
    reason: str


Action = SetLayersAction | GoToAction | RankAction | NearAction | FactsAction | ZoomAction | OverviewAction | UnsupportedAction


class AssistantResponse(BaseModel):
    reply: str
    actions: list[Action] = Field(min_length=1, max_length=MAX_ACTIONS)


class LayerRef(BaseModel):
    key: str = Field(max_length=40)
    label: str = Field(max_length=120)
    note: str = Field(default="", max_length=500)  # what the layer shows and where it comes from


class MapState(BaseModel):
    """What the viewer is looking at right now (sent by the browser with each message)."""
    layers_on: list[str] = Field(default_factory=list, max_length=40)
    district: str | None = Field(default=None, max_length=60)
    zoom: float | None = None
    view3d: bool = False


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    text: str = Field(max_length=600)


# ── data the server resolves names against ───────────────────────────────────────────────────────────


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


_districts_cache: list[str] | None = None
_places_cache: list[dict] | None = None


def district_names() -> list[str]:
    global _districts_cache
    if _districts_cache is None:
        try:
            doc = json.load(open(PACK_DIR / "district_profiles.json"))
            _districts_cache = sorted(doc["districts"])
        except (OSError, ValueError, KeyError):
            _districts_cache = []
    return _districts_cache


def places() -> list[dict]:
    global _places_cache
    if _places_cache is None:
        try:
            fc = json.load(open(PACK_DIR / "places.geojson"))
            _places_cache = [
                {"name": f["properties"]["name"], "kind": f["properties"]["kind"], "norm": _norm(f["properties"]["name"]),
                 "lng": f["geometry"]["coordinates"][0], "lat": f["geometry"]["coordinates"][1]}
                for f in fc["features"] if f["properties"].get("name")
            ]
        except (OSError, ValueError, KeyError):
            _places_cache = []
    return _places_cache


def resolve_district(name: str | None) -> str | None:
    if not name:
        return None
    n = _norm(name)
    names = district_names()
    exact = [d for d in names if _norm(d) == n]
    if exact:
        return exact[0]
    aliases = {"east singhbhum": "Purbi Singhbhum", "west singhbhum": "Pashchimi Singhbhum", "singhbhum east": "Purbi Singhbhum",
               "singhbhum west": "Pashchimi Singhbhum", "seraikela": "Saraikela-Kharsawan", "saraikela": "Saraikela-Kharsawan",
               "seraikela kharsawan": "Saraikela-Kharsawan", "koderma": "Kodarma", "hazaribag": "Hazaribagh", "sahebganj": "Sahibganj",
               "pakaur": "Pakur"}
    a = aliases.get(n)
    return a if a in names else None


_KIND_RANK = {"city": 0, "town": 1, "village": 2}


def resolve_place(name: str | None) -> dict | None:
    """Exact (accent- and case-insensitive) name, preferring the larger settlement; else a unique prefix match."""
    if not name:
        return None
    n = _norm(name)
    if not n:
        return None
    ps = places()
    exact = sorted((p for p in ps if p["norm"] == n), key=lambda p: _KIND_RANK.get(p["kind"], 3))
    if exact:
        return exact[0]
    pref = [p for p in ps if p["norm"].startswith(n)]
    if len({p["norm"] for p in pref}) == 1:
        return sorted(pref, key=lambda p: _KIND_RANK.get(p["kind"], 3))[0]
    return None


# ── validation ───────────────────────────────────────────────────────────────────────────────────────

_NEUTRAL_REPLY = "Here is what I found."


def _default_reply(actions: list) -> str:
    """A digit-free sentence built from the actions themselves, used when the model's own wording is unusable."""
    for a in actions:
        if isinstance(a, NearAction) and a.place_name:
            return f"Searching around {a.place_name} for mapped {a.what.replace('_', ' ')}."
        if isinstance(a, RankAction):
            return "Ranking the districts on the checked data."
        if isinstance(a, FactsAction):
            return f"Showing facts for {a.district} from the checked data."
        if isinstance(a, OverviewAction):
            return "Here is an overview of Jharkhand from the checked data."
        if isinstance(a, ZoomAction):
            return f"Zooming {a.direction}."
        if isinstance(a, GoToAction) and a.name:
            return f"Showing {a.name}."
    return _NEUTRAL_REPLY


def _unsupported(reason: str) -> AssistantResponse:
    return AssistantResponse(reply=reason, actions=[UnsupportedAction(type="unsupported", reason=reason)])


def validate(parsed: AssistantResponse, layer_keys: set[str]) -> AssistantResponse:
    out: list[Action] = []
    for a in parsed.actions:
        if isinstance(a, SetLayersAction):
            on = [k for k in dict.fromkeys(a.on) if k in layer_keys]
            off = [k for k in dict.fromkeys(a.off) if k in layer_keys and k not in on]
            if not on and not off and not a.only:
                out.append(UnsupportedAction(type="unsupported", reason="I couldn't match that to any map layer."))
            else:
                out.append(SetLayersAction(type="set_layers", on=on, off=off, only=a.only and bool(on)))
        elif isinstance(a, GoToAction):
            if a.kind == "state":
                out.append(GoToAction(type="go_to", kind="state"))
            elif a.kind == "district":
                d = resolve_district(a.name)
                out.append(GoToAction(type="go_to", kind="district", name=d) if d else
                           UnsupportedAction(type="unsupported", reason="I don't know that district."))
            else:
                p = resolve_place(a.name)
                out.append(GoToAction(type="go_to", kind="place", name=p["name"], lng=p["lng"], lat=p["lat"]) if p else
                           UnsupportedAction(type="unsupported",
                                             reason="I couldn't find that place on the map. Try a nearby town or the district."))
        elif isinstance(a, FactsAction):
            d = resolve_district(a.district)
            out.append(FactsAction(type="facts", district=d, fields=list(dict.fromkeys(a.fields))) if d else
                       UnsupportedAction(type="unsupported", reason="I don't know that district."))
        elif isinstance(a, NearAction):
            p = resolve_place(a.place)
            if not p:
                out.append(UnsupportedAction(type="unsupported", reason="I couldn't find that place on the map. Try a nearby town."))
            else:
                r = min(max(a.radius_km, MIN_NEAR_KM), MAX_NEAR_KM)
                out.append(NearAction(type="near", place=a.place, radius_km=r, what=a.what, place_name=p["name"], lng=p["lng"], lat=p["lat"]))
        elif isinstance(a, (RankAction, ZoomAction, OverviewAction)):
            out.append(a)
        else:
            out.append(a)
    if all(isinstance(a, UnsupportedAction) for a in out) and out:
        reply = out[0].reason  # type: ignore[union-attr]
    else:
        reply = (parsed.reply or "").strip()
        if not reply or re.search(r"\d", reply) or len(reply) > MAX_REPLY_CHARS:
            if re.search(r"\d", reply or ""):
                log.info("assistant reply contained digits; replaced")
            reply = _default_reply(out)
    return AssistantResponse(reply=reply, actions=out[:MAX_ACTIONS])


# open_top moves the map and opens a profile, so it needs the user to have asked to see something.
_WANTS_TO_SEE = re.compile(r"\b(show|open|take|go|fly|see|display|zoom|navigate|view|visit|there)\b", re.I)


def enforce_open_top(resp: AssistantResponse, question: str) -> AssistantResponse:
    """Strip open_top unless the question asks to see/go somewhere (the model overused it)."""
    if _WANTS_TO_SEE.search(question):
        return resp
    for a in resp.actions:
        if isinstance(a, RankAction) and a.open_top:
            a.open_top = False
    return resp


# ── the model call ───────────────────────────────────────────────────────────────────────────────────

_SYSTEM = f"""\
You are the assistant for the Vayu Gati Jharkhand geospatial map: a public map of Jharkhand's 24 districts \
with layers for boundaries, imagery, land cover, forests, water, towns, transport, power, mines, industry and \
satellite heat detections, and a profile for every district.

Turn the user's message (and the short conversation so far) into up to {MAX_ACTIONS} actions from this fixed set:
- set_layers: turn map layers on or off by key (from the list you are given). Use only=true to show just those layers.
- go_to: fly to the whole state, a district (kind "district", name one of the 24), or a named place \
(kind "place", the name as people write it, e.g. "Jhumri Tilaiya").
- facts: show chosen facts about one district. Fields: {", ".join(FIELDS)}. The n_* fields are \
counts of features volunteers have mapped in OpenStreetMap (incomplete); they are not official totals. The near_* \\
fields are the share of a district's WorldPop-estimated people living within 2 or 5 km of a mapped site: a \\
proximity estimate, never a measure of exposure or health risk. annual_rainfall, monsoon_rain_pct and \\
winter_wind_speed, winter_wind_from and monsoon_wind_from (a compass direction the wind blows FROM) are ERA5 area \\
climate (not a town's weather). Rank only on numeric fields; the wind-direction fields are for facts.
- rank: rank all districts by one field (desc/asc, limit up to 10). open_top defaults to FALSE: a plain question \
("which district has the most forest?") only ranks and must not move the map. Set open_top=true only when the \
user explicitly asks to see or go to the winner ("show it", "take me there", "open it").
- near: count and list mapped features within a radius of a named place. what is one of: {", ".join(NEAR_WHAT)}. \
Radius 1 to 50 km (default 10).
- zoom: zoom the map in or out one step (direction in/out).
- overview: a summary of the whole state from the checked data (the app computes the figures).
- unsupported: when the request can't be done, with a short honest reason.

Rules, all of them important:
1. NEVER write a number, count, area, population or percentage in "reply". The app reads every figure from \
checked data and shows it with its source. Your reply is one short plain sentence about what you are doing, \
with no digits at all.
2. There are no air-quality readings on this map (only two government stations exist in the state, and no AQI \
is shown). If asked about air quality, pollution levels or forecasts, use unsupported and say the map holds \
geographic data, not readings. You may still offer to show likely sources of pollution as layers (mines, \
industry, power plants, brick kilns, heat detections, roads, railways).
3. Do not claim causes or health effects. Do not guess. If a request is ambiguous, pick the most reasonable \
reading and say what you chose.
4. District names: use the Census spelling (Purbi Singhbhum, Pashchimi Singhbhum, Saraikela-Kharsawan, \
Kodarma, Hazaribagh, Sahibganj ...).
5. Combine actions when natural: e.g. "show mines and rivers in Hazaribagh" is go_to(district Hazaribagh) then \
set_layers(on mines, water). "Which district has the most forest?" is rank(forest_km2 desc). "Tell me about \
Ranchi" is go_to(district) plus facts(area, population, forest_pct, highest_point, heat_detections).
6. "Mines" and "industrial" are mapped areas, "plants" are the checked power plants and large works. Questions \
like "how many schools are within 10 km of Ranchi" are near actions; "which district has the most schools" is a \
rank on n_schools. Never present mapped counts as complete.
7. You are told what is on the screen right now (layers on, open district, zoom). Use it. "I can't see it" or \
"where is it" usually means the layer is off, or it is too small at this zoom: switch it on and, for small things \
(peaks, kilns, schools, villages, substations, heat detections), also use zoom in; mention in the reply what the \
layer looks like (small dots, areas, lines). "Do it again", "that", "this" and "here" refer to the previous turn or \
the open district. "Tell me about this" with a district open is facts for that district; with none open it is an \
overview of the state. "Give me some info", "what is this map", "what can you do" is an overview action plus a \
short plain description of what the map holds and how to use it.
8. Explain layers from the layer notes you are given (what it shows, source, caveats) in plain words, without \
digits. The notes are the only truth about a layer: do not add facts beyond them.
9. Layer guidance: coal and quarries are "mines"; likely pollution sources are mines, industry, kilns, power, \
railways, roads and fires; greenery is forest, protected, landcover; people are places, builtup, facilities.
"""


def _client() -> anthropic.Anthropic | None:
    return anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY) if config.ANTHROPIC_API_KEY else None


def _state_block(state: MapState | None, layers: list[LayerRef]) -> str:
    if state is None:
        return ""
    labels = {l.key: l.label for l in layers}
    on = ", ".join(labels.get(k, k) for k in state.layers_on) or "none"
    zoom = "unknown" if state.zoom is None else ("the whole state" if state.zoom < 8 else "a district" if state.zoom < 10.5 else "close up")
    return (f"\nOn screen now: layers on: {on}. Open district: {state.district or 'none (state view)'}. "
            f"View: {zoom}{', tilted 3D' if state.view3d else ''}.\n")


def ask(question: str, history: list[Turn], layers: list[LayerRef], state: MapState | None = None) -> AssistantResponse:
    client = _client()
    if client is None:
        log.warning("No ANTHROPIC_API_KEY set - assistant unavailable")
        return _unsupported("The assistant is not configured on this deployment.")
    layer_keys = {l.key for l in layers}
    layer_lines = "\n".join(f"- {l.key}: {l.label}" + (f" ({l.note})" if l.note else "") for l in layers)
    messages = [{"role": t.role, "content": t.text} for t in history[-MAX_HISTORY:]]
    messages.append({"role": "user", "content": f"Layers (key: label (note)):\n{layer_lines}\n{_state_block(state, layers)}\nMessage: {question}"})
    # the API needs the first message to be from the user
    while messages and messages[0]["role"] != "user":
        messages.pop(0)
    try:
        response = client.messages.parse(
            model=JH_ASSISTANT_MODEL,
            max_tokens=700,
            system=_SYSTEM,
            output_format=AssistantResponse,
            messages=messages,
        )
    except (anthropic.APIError, ValidationError) as e:
        log.warning("Jharkhand assistant request failed: %s", e)
        return _unsupported("I couldn't process that right now. Please try again.")
    if response.stop_reason == "refusal":
        return _unsupported("I can't help with that request.")
    if response.parsed_output is None:
        return _unsupported("I couldn't understand that. Try rephrasing.")
    return enforce_open_top(validate(response.parsed_output, layer_keys), question)
