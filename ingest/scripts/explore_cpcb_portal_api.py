#!/usr/bin/env python3
"""
CPCB Portal API — reverse-engineering probe.

Tries all known NAQDMS / CCR portal endpoints to discover:
  1. Whether station lists are accessible without auth
  2. Whether 15-minute historical data is accessible
  3. Whether station photo URLs are included in the response

Run from the repo root:
    python3 ingest/scripts/explore_cpcb_portal_api.py

No auth, no side-effects — read-only probes only.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone

import httpx

# ---------------------------------------------------------------------------
# Known CPCB Delhi station IDs (from the CCR portal — reverse-engineered
# by the AQI developer community via browser DevTools).
# These are the CPCB-internal siteIds, NOT our own station IDs.
# Add more as you discover them from the /getStationList endpoint.
# ---------------------------------------------------------------------------
KNOWN_DELHI_CPCB_SITES: dict[str, str] = {
    "Anand Vihar": "site_233",
    "Rohini": "site_228",
    "Punjabi Bagh": "site_270",
    "Jahangirpuri": "site_209",
    "Wazirpur": "site_272",
    "Bawana": "site_282",
    "R.K. Puram": "site_229",
    "Vivek Vihar": "site_271",
    "Okhla Phase-2": "site_268",
}

# ---------------------------------------------------------------------------
# Portal variants to try — old CCR (app.cpcbccr.com) is better documented;
# new NAQDMS (airquality.cpcb.gov.in) may have different paths.
# ---------------------------------------------------------------------------
PORTALS = {
    "CCR (old)":    "https://app.cpcbccr.com",
    "NAQDMS (new)": "https://airquality.cpcb.gov.in",
}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; vayugati-research/1.0)",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://airquality.cpcb.gov.in/",
}

TIMEOUT = 15


def pp(label: str, data: object, max_keys: int = 8) -> None:
    """Pretty-print a result truncated to max_keys top-level keys."""
    print(f"\n  ✓ {label}")
    if isinstance(data, list):
        print(f"    → list of {len(data)} items")
        if data:
            item = data[0]
            print(f"    → first item keys: {list(item.keys()) if isinstance(item, dict) else type(item).__name__}")
            print(f"    → first item:      {json.dumps(item, indent=6)[:400]}")
    elif isinstance(data, dict):
        shown = dict(list(data.items())[:max_keys])
        print(f"    → {json.dumps(shown, indent=6)[:400]}")
    else:
        print(f"    → {str(data)[:200]}")


def probe_get(client: httpx.Client, url: str, params: dict | None = None) -> object | None:
    try:
        r = client.get(url, params=params, timeout=TIMEOUT)
        print(f"  GET {url}  →  HTTP {r.status_code}")
        if r.status_code == 200:
            try:
                return r.json()
            except Exception:
                text = r.text[:300]
                print(f"    body (non-JSON): {text!r}")
                return None
        return None
    except httpx.HTTPError as exc:
        print(f"  GET {url}  →  {type(exc).__name__}")
        return None


def probe_post(client: httpx.Client, url: str, body: dict) -> object | None:
    try:
        r = client.post(url, json=body, timeout=TIMEOUT)
        print(f"  POST {url}  →  HTTP {r.status_code}")
        if r.status_code == 200:
            try:
                return r.json()
            except Exception:
                text = r.text[:300]
                print(f"    body (non-JSON): {text!r}")
                return None
        return None
    except httpx.HTTPError as exc:
        print(f"  POST {url}  →  {type(exc).__name__}")
        return None


# ---------------------------------------------------------------------------
# 1. Station list
# ---------------------------------------------------------------------------
def try_station_list(client: httpx.Client) -> list[dict]:
    print("\n── Station list ─────────────────────────────────────────────────────")
    candidates = [
        ("CCR",    "https://app.cpcbccr.com/caaqms/getStationList"),
        ("CCR",    "https://app.cpcbccr.com/caaqms/getStationList?cities=delhi"),
        ("NAQDMS", "https://airquality.cpcb.gov.in/caaqms/getStationList"),
        ("NAQDMS", "https://airquality.cpcb.gov.in/AQI_India/api/stations"),
        ("NAQDMS", "https://airquality.cpcb.gov.in/caaqms/getCityStationList?city=Delhi"),
    ]
    for label, url in candidates:
        data = probe_get(client, url)
        if data is not None:
            pp(f"station list ({label})", data)
            # Extract Delhi entries if it's a list of dicts
            if isinstance(data, list):
                delhi = [
                    s for s in data
                    if isinstance(s, dict)
                    and "delhi" in str(s.get("cityName", "") or s.get("city", "")).lower()
                ]
                if delhi:
                    print(f"\n  Delhi entries: {len(delhi)}")
                    for s in delhi[:5]:
                        print(f"    {s}")
                    # Look for photo URLs
                    for s in delhi:
                        for k, v in s.items():
                            if isinstance(v, str) and (
                                "image" in k.lower() or "photo" in k.lower() or "img" in k.lower()
                                or (v.startswith("http") and any(ext in v for ext in [".jpg", ".png", ".jpeg"]))
                            ):
                                print(f"  🖼  Photo URL found → key={k!r} val={v!r}")
                return delhi if isinstance(data, list) else []
    print("  ✗ No station list endpoint responded")
    return []


# ---------------------------------------------------------------------------
# 2. 15-minute historical data
# ---------------------------------------------------------------------------
def try_15min_data(client: httpx.Client) -> None:
    print("\n── 15-minute historical data ────────────────────────────────────────")

    # Build a 15-minute window ending ~2 hours ago (avoids live-data gating).
    ist_offset = timedelta(hours=5, minutes=30)
    now_ist = datetime.now(timezone.utc).astimezone(timezone(ist_offset))
    to_dt   = now_ist - timedelta(hours=2)
    from_dt = to_dt - timedelta(minutes=15)
    fmt = "%d-%m-%Y %H:%M:%S"
    from_str = from_dt.strftime(fmt)
    to_str   = to_dt.strftime(fmt)
    print(f"  Window: {from_str} → {to_str} IST")

    # Try one well-known site (Anand Vihar) with multiple endpoint patterns.
    for site_id in ["site_233", "ANAV", "1-CCR_ANAV", "AV"]:
        body = {
            "fromDate":     from_str,
            "toDate":       to_str,
            "stationId":    site_id,
            "parameterType": "All",
        }
        urls = [
            "https://app.cpcbccr.com/caaqms/caaqmsPageData",
            "https://app.cpcbccr.com/caaqms/getStationData",
            "https://airquality.cpcb.gov.in/caaqms/getStationData",
        ]
        for url in urls:
            data = probe_post(client, url, body)
            if data is not None:
                pp(f"15-min data (stationId={site_id!r})", data)
                return

    # Also try GET variants
    for site_id in ["site_233", "ANAV"]:
        url = f"https://app.cpcbccr.com/caaqms/getStationData?stationId={site_id}&duration=15M"
        data = probe_get(client, url)
        if data is not None:
            pp(f"15-min data GET (stationId={site_id!r})", data)
            return

    print("  ✗ No 15-min endpoint responded — may need session cookie")
    print("    → Try: open browser DevTools → Network tab → visit airquality.cpcb.gov.in")
    print("      → click a station → look for XHR requests to /caaqms/")
    print("      → copy the Cookie header from that request and paste into CPCB_SESSION_COOKIE")


# ---------------------------------------------------------------------------
# 3. Station detail / photo URL
# ---------------------------------------------------------------------------
def try_station_detail(client: httpx.Client) -> None:
    print("\n── Station detail (photo URL discovery) ─────────────────────────────")
    candidates = [
        "https://app.cpcbccr.com/caaqms/getStationDetail?stationId=site_233",
        "https://airquality.cpcb.gov.in/caaqms/getStationDetail?stationId=site_233",
        "https://app.cpcbccr.com/caaqms/getImage?stationId=site_233",
        "https://airquality.cpcb.gov.in/caaqms/getImage?stationId=site_233",
    ]
    for url in candidates:
        data = probe_get(client, url)
        if data is not None:
            pp("station detail", data)
            if isinstance(data, dict):
                for k, v in data.items():
                    if isinstance(v, str) and (
                        "http" in v or ".jpg" in v or ".png" in v or "image" in k.lower()
                    ):
                        print(f"  🖼  Image URL candidate → {k}={v!r}")


# ---------------------------------------------------------------------------
# 4. Latest reading probe (compare against our data.gov reading)
# ---------------------------------------------------------------------------
def try_latest(client: httpx.Client) -> None:
    print("\n── Latest station reading (for AQI comparison) ─────────────────────")
    urls = [
        "https://app.cpcbccr.com/caaqms/getStationCurrentData?stationId=site_233",
        "https://airquality.cpcb.gov.in/caaqms/getCurrentData?stationId=site_233",
        "https://app.cpcbccr.com/caaqms/getStationCurrentData?stationId=ANAV",
    ]
    for url in urls:
        data = probe_get(client, url)
        if data is not None:
            pp("latest reading", data)
            return
    print("  ✗ No live-reading endpoint responded")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    print("=" * 70)
    print("  CPCB Portal API Probe — vayugati")
    print("=" * 70)
    print("  This script makes read-only GET/POST requests to CPCB's portal.")
    print("  No auth tokens are sent; some endpoints may need a session cookie.")

    with httpx.Client(headers=HEADERS, follow_redirects=True) as client:
        stations = try_station_list(client)
        try_15min_data(client)
        try_station_detail(client)
        try_latest(client)

    print("\n" + "=" * 70)
    print("  Done. Known Delhi CPCB site IDs (for manual testing):")
    for name, sid in KNOWN_DELHI_CPCB_SITES.items():
        print(f"    {sid:12s}  {name}")
    print("""
  Next steps if endpoints require session:
    1. Open https://airquality.cpcb.gov.in in browser
    2. DevTools → Network → click a station → filter XHR
    3. Find POST to /caaqms/... — right-click → "Copy as cURL"
    4. Extract Cookie header and paste into this script's HEADERS dict
    5. Re-run to confirm authenticated access
  """)


if __name__ == "__main__":
    main()
