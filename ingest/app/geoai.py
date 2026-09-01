"""Claude-based natural-language -> structured map action parsing (GeoAI agent).

Language-only: Claude turns a free-text question into a small, bounded set of
typed actions (schema below). It never computes geography, thresholds, or
distances itself - the frontend executes every action deterministically
against the same spatial engine the manual measure/buffer tools use
(web/src/lib/spatialQuery.ts). validate_actions() below is a second,
independent gate: structured outputs guarantee the *shape* of the response,
not that it makes sense (e.g. a PM2.5 threshold on incidents, which carry no
pollutant readings) - anything that fails validation is downgraded to
"unsupported" before it ever reaches the frontend.
"""

import logging
import os
from typing import Literal

import anthropic
from pydantic import BaseModel, Field

from . import config

log = logging.getLogger("ingest.geoai")

# Configurable rather than hardcoded so a future model swap is an env change,
# not a code change. Defaults to the same model classify.py already uses.
GEOAI_MODEL = os.getenv("GEOAI_MODEL", "claude-haiku-4-5-20251001")

MAX_ACTIONS = 3
DEFAULT_RADIUS_KM = 3.0
MIN_RADIUS_KM = 0.5
MAX_RADIUS_KM = 20.0

POLLUTANTS = ("aqi", "pm25", "pm10", "no2")
SEVERITIES = ("severe", "high", "moderate", "low")
SOURCE_CATEGORIES = (
    "road_dust",
    "construction_dust",
    "vehicular",
    "open_burning",
    "industrial",
    "waste",
    "other",
    "regional_transport",
    "mixed",
    "unresolved",
)


class EntityRef(BaseModel):
    type: Literal["ward", "station"]
    id: str


class SetTimeAction(BaseModel):
    type: Literal["set_time"]
    time_mode: Literal["now", "24h", "48h"] | None = None
    obs_slot: Literal["now", "-3h", "-6h", "-12h", "-24h"] | None = None


class SetFiltersAction(BaseModel):
    type: Literal["set_filters"]
    pollutant: Literal["aqi", "pm25", "pm10", "no2"] | None = None
    source_filter: str | None = None
    severity_filter: Literal["severe", "high", "moderate", "low"] | None = None
    view_mode: Literal["pollution", "data_quality"] | None = None


class FocusAction(BaseModel):
    type: Literal["focus"]
    target_ref: EntityRef | None = None


class QueryAction(BaseModel):
    type: Literal["query"]
    target: Literal["wards", "stations", "incidents"]
    near_ref: EntityRef | None = None
    radius_km: float | None = None
    pollutant: Literal["aqi", "pm25", "pm10", "no2"] | None = None
    op: Literal[">", ">=", "<", "<="] | None = None
    threshold: float | None = None
    source_category: str | None = None
    severity: Literal["severe", "high", "moderate", "low"] | None = None


class UnsupportedAction(BaseModel):
    type: Literal["unsupported"]
    reason: str


Action = SetTimeAction | SetFiltersAction | FocusAction | QueryAction | UnsupportedAction


class GeoAiResponse(BaseModel):
    explanation: str
    actions: list[Action] = Field(max_length=MAX_ACTIONS)


_SYSTEM = f"""\
You are a GIS query assistant for a Delhi air-quality operations dashboard.

Turn the user's question into up to {MAX_ACTIONS} structured actions from this \
fixed set: set_time, set_filters, focus, query, unsupported. Never invent a \
different action type. A single question may need several actions - e.g. \
"wards near Anand Vihar with PM2.5 above 200 yesterday" needs a set_time \
action (yesterday -> obs_slot), then a query action (wards, near Anand \
Vihar's ref, pollutant pm25, op >, threshold 200).

You will be given a list of known wards and stations, each with an exact \
{{type, id, name}}. When the question refers to a place, resolve it to the \
EXACT id from that list - never invent an id. If no confident match exists, \
omit the ref (near_ref/target_ref: null) rather than guessing.

query.target must match what you're filtering: "wards" or "stations" for \
pollutant thresholds (aqi/pm25/pm10/no2), "incidents" for severity/source \
category filters. Incidents do not carry pollutant readings - do not put a \
pollutant threshold on target "incidents".

If the question can't be mapped to this action set, return a single \
unsupported action with a short, honest reason.

Always include a one-sentence explanation restating what you're about to do, \
in plain language, using entity names (not ids).
"""


def _stub_response(reason: str) -> GeoAiResponse:
    return GeoAiResponse(
        explanation=reason,
        actions=[UnsupportedAction(type="unsupported", reason=reason)],
    )


def parse_geo_query(question: str, entities: list[dict]) -> GeoAiResponse:
    """Call Claude with structured outputs to turn a question into actions.

    `entities` is the compact catalog the frontend already has in memory
    ([{type, id, name}, ...] for wards + stations) - used only for entity
    resolution, never fetched or stored server-side.
    """
    api_key = config.ANTHROPIC_API_KEY
    if not api_key:
        log.warning("No ANTHROPIC_API_KEY set - GeoAI unavailable")
        return _stub_response("GeoAI is not configured on this deployment.")

    client = anthropic.Anthropic(api_key=api_key)

    entity_lines = "\n".join(f"- {{type: {e['type']}, id: {e['id']}, name: {e['name']}}}" for e in entities)
    user_content = f"Known wards and stations:\n{entity_lines}\n\nQuestion: {question}"

    try:
        response = client.messages.create(
            model=GEOAI_MODEL,
            max_tokens=800,
            system=_SYSTEM,
            output_config={"format": {"type": "json_schema", "schema": GeoAiResponse.model_json_schema()}},
            messages=[{"role": "user", "content": user_content}],
        )
    except anthropic.APIError as e:
        log.warning("GeoAI request failed: %s", e)
        return _stub_response("GeoAI couldn't process that question right now.")

    if response.stop_reason == "refusal":
        return _stub_response("GeoAI declined to answer that question.")

    text_block = next((b for b in response.content if b.type == "text"), None)
    if text_block is None:
        return _stub_response("GeoAI returned an unexpected response.")

    try:
        parsed = GeoAiResponse.model_validate_json(text_block.text)
    except Exception:
        log.warning("GeoAI structured output failed validation: %s", text_block.text[:200])
        return _stub_response("GeoAI returned a response that couldn't be parsed.")

    entity_ids = {(e["type"], e["id"]) for e in entities}
    return validate_actions(parsed, entity_ids)


def validate_actions(parsed: GeoAiResponse, entity_ids: set[tuple[str, str]]) -> GeoAiResponse:
    """Deterministic semantic gate run after every parse, before the response
    leaves this module. Structured outputs guarantee shape; this guarantees
    the actions actually make sense against real allowed combinations - the
    'validator authorizes' step between LLM interpretation and execution."""
    validated: list[Action] = []
    for action in parsed.actions:
        reason = _invalid_reason(action, entity_ids)
        if reason is not None:
            validated.append(UnsupportedAction(type="unsupported", reason=reason))
            continue
        if isinstance(action, QueryAction) and action.radius_km is not None:
            action = action.model_copy(
                update={"radius_km": max(MIN_RADIUS_KM, min(MAX_RADIUS_KM, action.radius_km))}
            )
        validated.append(action)
    return GeoAiResponse(explanation=parsed.explanation, actions=validated)


def _invalid_reason(action: Action, entity_ids: set[tuple[str, str]]) -> str | None:
    if isinstance(action, FocusAction):
        if action.target_ref is not None and (action.target_ref.type, action.target_ref.id) not in entity_ids:
            return "Couldn't resolve that location to a known ward or station."
        return None

    if isinstance(action, QueryAction):
        if action.near_ref is not None and (action.near_ref.type, action.near_ref.id) not in entity_ids:
            return "Couldn't resolve that location to a known ward or station."
        if action.target == "incidents":
            if action.pollutant is not None or action.op is not None or action.threshold is not None:
                return "Pollutant thresholds can be applied to wards or stations, not incidents."
            if action.source_category is not None and action.source_category not in SOURCE_CATEGORIES:
                return f"Unrecognized source category: {action.source_category}."
        else:
            if action.severity is not None or action.source_category is not None:
                return "Severity and source-category filters apply to incidents, not wards or stations."
            if (action.op is None) != (action.threshold is None):
                return "A pollutant threshold needs both a comparison and a value."
        return None

    if isinstance(action, SetFiltersAction):
        if action.source_filter is not None and action.source_filter not in SOURCE_CATEGORIES:
            return f"Unrecognized source category: {action.source_filter}."
        return None

    return None
