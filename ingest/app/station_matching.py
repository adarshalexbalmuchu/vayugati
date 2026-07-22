"""Station-name matching between the live data.gov.in CPCB feed and our own
`stations` table - exact-match-after-normalization only, never a fuzzy/
distance-based guess (explicit product requirement: unsafe matches must
never be guessed at). Pure functions, unit-tested directly
(test_station_matching.py).
"""

from __future__ import annotations

import re

# Documented CPCB source-document naming artifacts - see
# docs/data/delhi-station-reconciliation.md's own "Naming mismatches" note.
# Each key is the concatenated (no-space, lowercase, noise-stripped) form;
# each value is the correct name's own words. The concatenated key form
# means a correctly-SPACED input (e.g. "Vivek Vihar") produces the exact
# same lookup key as its camelCase/misspelled artifact ("VivekVihar") -
# both need an entry here regardless, since word-splitting itself only
# happens on whichever spaced/separated form the alias VALUE provides; a
# camelCase input like "VivekVihar" is one single unsplittable token before
# this substitution runs.
KNOWN_ALIASES: dict[str, str] = {
    "mundaka": "mundka",
    "sirifort": "siri fort",
    "vivekvihar": "vivek vihar",
    "mandirmarg": "mandir marg",
    "sriaurobindomarg": "sri aurobindo marg",
}

# Authority/city labels that appear inconsistently between the two sources
# (e.g. our own "Lodhi Road, New Delhi - IMD" vs. CPCB's live "IMD Lodhi
# Road, Delhi - IITM" for the same physical station) - dropped entirely for
# matching purposes, never treated as part of a station's identity.
_NOISE_TOKENS = {"delhi", "new", "ncr", "dpcc", "cpcb", "imd", "iitm"}


def normalize_station_name(name: str | None) -> str:
    """Lowercase, strip punctuation, drop known authority/city noise
    tokens, apply the documented alias table, then sort the remaining
    tokens - so word order and city/authority-label differences never
    block an otherwise-real match, but nothing is guessed beyond that."""
    if not name:
        return ""
    words = re.findall(r"[a-z0-9]+", name.lower())
    significant = [w for w in words if w not in _NOISE_TOKENS]
    if not significant:
        return ""
    joined = "".join(significant)
    if joined in KNOWN_ALIASES:
        significant = KNOWN_ALIASES[joined].split()
    return " ".join(sorted(significant))


def build_match_index(our_stations: list[dict]) -> dict[str, int]:
    """our_stations: [{id, name}, ...] -> {normalized_name: station_id}.
    Two of our own stations normalizing to the same key (shouldn't happen,
    but station names are free text) drop OUT of the index entirely -
    safer to leave both unmatched than guess which one a CPCB row means.
    An empty normalized name (nothing left after stripping noise) is never
    indexed, for the same reason."""
    index: dict[str, list[int]] = {}
    for s in our_stations:
        key = normalize_station_name(s["name"])
        if not key:
            continue
        index.setdefault(key, []).append(s["id"])
    return {k: v[0] for k, v in index.items() if len(v) == 1}


def match_station(cpcb_name: str, match_index: dict[str, int]) -> int | None:
    key = normalize_station_name(cpcb_name)
    if not key:
        return None
    return match_index.get(key)
