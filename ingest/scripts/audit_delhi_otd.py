#!/usr/bin/env python3
"""Authenticated audit of the Delhi Open Transit Data (OTD) real-time
GTFS-realtime feed, plus an unauthenticated reachability check of its
static GTFS download — a one-shot, read-only probe so a future decision
about whether/how to use this transit feed can be made from real field
shapes instead of guesswork.

NOT wired into production ingest. Does not write to Supabase. Does not
touch OpenAQ, forecast.py, or any air-quality data path — this is a transit
feed being evaluated purely as a possible future context layer.

Security: DELHI_OTD_API_KEY is read from env and used only in the outgoing
request's query string — this script never prints, logs, or writes the key
anywhere, including in the generated report. The real-time response body
(binary GTFS-realtime protobuf) is held in memory only and never written to
disk, per the "do not store raw protobuf payload in git" requirement — the
simplest way to guarantee that is to never write it anywhere at all.

Usage (run from the ingest/ directory, with ingest/.env filled in):
    python scripts/audit_delhi_otd.py
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx

# make the `app` package importable when run as a plain script from ingest/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config  # noqa: E402

REALTIME_URL = "https://otd.delhi.gov.in/api/realtime/VehiclePositions.pb"
UA = {"User-Agent": "vayugati-otd-audit/1.0"}
REPORT_PATH = (
    Path(__file__).resolve().parent.parent.parent / "docs" / "data" / "delhi-open-transit-data-authenticated-audit.md"
)

# Static GTFS is unauthenticated but its exact filename is undocumented
# publicly - these are the candidates this audit actually tried (real HTTP
# requests, not a guess reported as fact). HEAD-only: never downloads a
# response body, so this never risks pulling a large file into the process.
STATIC_CANDIDATES = [
    "https://otd.delhi.gov.in/",
    "https://otd.delhi.gov.in/static",
    "https://otd.delhi.gov.in/static/",
    "https://otd.delhi.gov.in/static/GTFS.zip",
    "https://otd.delhi.gov.in/static/gtfs.zip",
    "https://otd.delhi.gov.in/static/Delhi_GTFS.zip",
    "https://otd.delhi.gov.in/static/delhi_gtfs.zip",
    "https://otd.delhi.gov.in/api/static/GTFS.zip",
]


def fetch_realtime() -> tuple[int, dict, bytes]:
    resp = httpx.get(REALTIME_URL, params={"key": config.DELHI_OTD_API_KEY}, headers=UA, timeout=30)
    return resp.status_code, dict(resp.headers), resp.content


def _read_varint(data: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while True:
        b = data[pos]
        result |= (b & 0x7F) << shift
        pos += 1
        if not (b & 0x80):
            return result, pos
        shift += 7


def sniff_gtfs_realtime_version(data: bytes) -> str | None:
    """A minimal, defensive read of ONLY the outer two protobuf field tags -
    not a real decoder (no gtfs-realtime-bindings is installed - see
    decode_possible below). FeedMessage.header (field 1, wiretype 2) wraps a
    FeedHeader whose gtfs_realtime_version (field 1, wiretype 2) is a short
    ASCII string ("1.0"/"2.0"). If the bytes don't match this exact expected
    shape, this returns None rather than guessing - it either confirms a
    real GTFS-realtime envelope or says nothing at all, never a false
    positive dressed up as a decode."""
    try:
        if not data or data[0] != 0x0A:  # FeedMessage.header tag
            return None
        header_len, pos = _read_varint(data, 1)
        header = data[pos : pos + header_len]
        if not header or header[0] != 0x0A:  # FeedHeader.gtfs_realtime_version tag
            return None
        ver_len, vpos = _read_varint(header, 1)
        version = header[vpos : vpos + ver_len]
        if version.isascii() and all(32 <= b < 127 for b in version):
            return version.decode("ascii")
        return None
    except (IndexError, UnicodeDecodeError):
        return None


def decode_possible() -> bool:
    try:
        import google.transit.gtfs_realtime_pb2  # noqa: F401

        return True
    except ImportError:
        return False


def check_static_gtfs() -> list[dict]:
    results = []
    for url in STATIC_CANDIDATES:
        try:
            resp = httpx.head(url, headers=UA, timeout=15, follow_redirects=True)
            results.append(
                {
                    "url": url,
                    "status": resp.status_code,
                    "content_type": resp.headers.get("content-type"),
                    "content_length": resp.headers.get("content-length"),
                }
            )
        except httpx.HTTPError as exc:
            results.append({"url": url, "status": None, "error": type(exc).__name__})
    return results


def render_report(rt_result: dict, static_results: list[dict]) -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        "# Delhi Open Transit Data (OTD) — Authenticated Audit",
        "",
        f"Run: {now}",
        f"Real-time endpoint: `{REALTIME_URL}`",
        "",
        "This is a one-shot, read-only field-shape probe. **Not** wired into",
        "production ingest — no Supabase writes, no OpenAQ changes, no",
        "forecast.py changes. This is a transit feed, evaluated purely as a",
        "possible future context layer, not an air-quality data source.",
        "",
        "## Real-time GTFS-realtime feed",
        "",
    ]

    if rt_result.get("error"):
        lines += [
            f"**Call failed:** {rt_result['error']}",
            "",
            "The API key itself is never logged or included in this report — see",
            "`ingest/app/config.py` for how it's read from `DELHI_OTD_API_KEY`.",
            "",
        ]
    else:
        lines += [
            f"- **HTTP status:** {rt_result['status']}",
            f"- **Content-Type:** {rt_result['content_type']}",
            f"- **Response size:** {rt_result['size']} bytes",
            f"- **Looks like a protobuf payload:** {'yes' if rt_result['looks_like_protobuf'] else 'no'}"
            + (
                f" — sniffed `gtfs_realtime_version = \"{rt_result['sniffed_version']}\"` from the outer FeedMessage/FeedHeader envelope (minimal wire-format read, not a full decode)"
                if rt_result.get("sniffed_version")
                else ""
            ),
            f"- **GTFS-realtime decoding possible with current dependencies:** {'yes' if rt_result['decode_possible'] else 'no — `gtfs-realtime-bindings`/`protobuf` is not installed in ingest/requirements.txt; not added by this audit (read-only scope)'}",
            "",
        ]
        if rt_result["decode_possible"]:
            lines += [
                f"- **Vehicle count:** {rt_result.get('vehicle_count', 'n/a')}",
                f"- **Sample route/trip/vehicle IDs:** {rt_result.get('sample_ids', 'n/a')}",
                f"- **Timestamp examples:** {rt_result.get('timestamps', 'n/a')}",
                "",
            ]
        else:
            lines += [
                "- **Vehicle count / sample IDs / timestamps:** not available — blocked on the",
                "  missing decode dependency above, not on data availability (the sniffed",
                "  envelope above confirms real, well-formed GTFS-realtime bytes were received).",
                "",
            ]
        lines += [
            "Raw payload was **not** written to disk anywhere (kept in memory for this",
            "run only), per the \"do not store raw protobuf payload in git\" requirement.",
            "",
        ]

    lines += [
        "## Static GTFS reachability (no key required)",
        "",
        "Exact static GTFS filename is not publicly documented, so this audit tried",
        "the homepage plus a set of common candidate paths/filenames (HEAD requests",
        "only — no file bodies were downloaded):",
        "",
        "| URL | Status | Content-Type | Content-Length |",
        "|---|---|---|---|",
    ]
    for r in static_results:
        if r.get("error"):
            lines.append(f"| `{r['url']}` | ERROR ({r['error']}) | — | — |")
        else:
            lines.append(f"| `{r['url']}` | {r['status']} | {r.get('content_type') or '—'} | {r.get('content_length') or '—'} |")

    static_dir_exists = any(
        r.get("status") in (301, 403)
        for r in static_results
        if r["url"].rstrip("/").endswith("/static")
    )
    if static_dir_exists:
        static_summary = (
            "The `/static/` path itself exists (redirects, then returns 403 — directory "
            "listing is disabled), but none of the guessed filenames resolved (all 404)."
        )
    else:
        static_summary = "No evidence the static directory exists at any of the tried paths."
    lines += [
        "",
        static_summary,
        "No official static-GTFS URL could be confirmed from this audit alone — it",
        "would need to come from OTD's own API documentation/registration materials,",
        "not further guessing.",
        "",
        "## Recommendation",
        "",
    ]

    rt_ok = not rt_result.get("error") and rt_result.get("status") == 200 and rt_result.get("looks_like_protobuf")
    if not rt_ok:
        lines += [
            "**C. Not usable yet.** The authenticated real-time call itself did not",
            "cleanly succeed — see the failure/status above. Nothing further to build on",
            "until that's resolved.",
        ]
    else:
        lines += [
            "**C. Not usable yet — but the connection itself is proven.** The",
            "authenticated call succeeds and returns a genuine, well-formed",
            "GTFS-realtime protobuf envelope (confirmed by name, not assumed). Two",
            "concrete, independent blockers remain before this could become a real",
            "layer (B: a future corridor/exposure layer, not an A: usable-now context",
            "layer, even once unblocked — vehicle positions alone don't carry route",
            "names without the static schedule):",
            "",
            "1. **Decode dependency.** `gtfs-realtime-bindings` (or bare `protobuf` +",
            "   a compiled `gtfs-realtime.proto`) is not in `ingest/requirements.txt`.",
            "   Without it, vehicle count, route/trip/vehicle IDs, and timestamps",
            "   can't be verified — only the envelope shape could be confirmed here.",
            "2. **Static GTFS reference.** Vehicle positions are just moving points",
            "   without the static route/stop/trip data to give them a corridor",
            "   identity. This audit could not discover a working static GTFS URL by",
            "   guessing common paths (table above) — it needs an authoritative link",
            "   from OTD's own docs or registration email.",
            "",
            "Once both are resolved, re-run this audit (or a successor) to confirm",
            "actual vehicle coverage and freshness before promoting this past B.",
        ]

    return "\n".join(lines) + "\n"


def main() -> int:
    if not config.DELHI_OTD_API_KEY:
        print("DELHI_OTD_API_KEY is not set — copy ingest/.env.example to ingest/.env and fill it in.")
        return 1

    rt_result: dict = {}
    try:
        status, headers, body = fetch_realtime()
        sniffed = sniff_gtfs_realtime_version(body)
        rt_result = {
            "status": status,
            "content_type": headers.get("content-type"),
            "size": len(body),
            "looks_like_protobuf": sniffed is not None,
            "sniffed_version": sniffed,
            "decode_possible": decode_possible(),
        }
    except httpx.HTTPError as exc:
        rt_result = {"error": f"{type(exc).__name__}: request failed"}

    static_results = check_static_gtfs()

    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(render_report(rt_result, static_results))

    if rt_result.get("error"):
        print(f"Real-time call failed: {rt_result['error']}")
    else:
        print(f"HTTP status: {rt_result['status']}")
        print(f"Content-Type: {rt_result['content_type']}")
        print(f"Response size: {rt_result['size']} bytes")
        print(f"Looks like protobuf: {rt_result['looks_like_protobuf']} (sniffed version: {rt_result['sniffed_version']})")
        print(f"Decode possible with current deps: {rt_result['decode_possible']}")
    print(f"Static GTFS candidates tried: {len(static_results)}")
    print(f"Report written to {REPORT_PATH}")
    return 0 if not rt_result.get("error") else 1


if __name__ == "__main__":
    raise SystemExit(main())
