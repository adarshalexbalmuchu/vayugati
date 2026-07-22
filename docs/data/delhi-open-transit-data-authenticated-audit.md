# Delhi Open Transit Data (OTD) — Authenticated Audit

Run: 2026-07-22 11:02 UTC
Real-time endpoint: `https://otd.delhi.gov.in/api/realtime/VehiclePositions.pb`

This is a one-shot, read-only field-shape probe. **Not** wired into
production ingest — no Supabase writes, no OpenAQ changes, no
forecast.py changes. This is a transit feed, evaluated purely as a
possible future context layer, not an air-quality data source.

## Real-time GTFS-realtime feed

- **HTTP status:** 200
- **Content-Type:** application/octet-stream
- **Response size:** 474725 bytes
- **Looks like a protobuf payload:** yes — sniffed `gtfs_realtime_version = "2.0"` from the outer FeedMessage/FeedHeader envelope (minimal wire-format read, not a full decode)
- **GTFS-realtime decoding possible with current dependencies:** no — `gtfs-realtime-bindings`/`protobuf` is not installed in ingest/requirements.txt; not added by this audit (read-only scope)

- **Vehicle count / sample IDs / timestamps:** not available — blocked on the
  missing decode dependency above, not on data availability (the sniffed
  envelope above confirms real, well-formed GTFS-realtime bytes were received).

Raw payload was **not** written to disk anywhere (kept in memory for this
run only), per the "do not store raw protobuf payload in git" requirement.

## Static GTFS reachability (no key required)

Exact static GTFS filename is not publicly documented, so this audit tried
the homepage plus a set of common candidate paths/filenames (HEAD requests
only — no file bodies were downloaded):

| URL | Status | Content-Type | Content-Length |
|---|---|---|---|
| `https://otd.delhi.gov.in/` | 200 | text/html; charset=utf-8 | — |
| `https://otd.delhi.gov.in/static` | 403 | text/html | — |
| `https://otd.delhi.gov.in/static/` | 403 | text/html | — |
| `https://otd.delhi.gov.in/static/GTFS.zip` | 404 | text/html | — |
| `https://otd.delhi.gov.in/static/gtfs.zip` | 404 | text/html | — |
| `https://otd.delhi.gov.in/static/Delhi_GTFS.zip` | 404 | text/html | — |
| `https://otd.delhi.gov.in/static/delhi_gtfs.zip` | 404 | text/html | — |
| `https://otd.delhi.gov.in/api/static/GTFS.zip` | 404 | text/html | — |

The `/static/` path itself exists (redirects, then returns 403 — directory listing is disabled), but none of the guessed filenames resolved (all 404).
No official static-GTFS URL could be confirmed from this audit alone — it
would need to come from OTD's own API documentation/registration materials,
not further guessing.

## Recommendation

**C. Not usable yet — but the connection itself is proven.** The
authenticated call succeeds and returns a genuine, well-formed
GTFS-realtime protobuf envelope (confirmed by name, not assumed). Two
concrete, independent blockers remain before this could become a real
layer (B: a future corridor/exposure layer, not an A: usable-now context
layer, even once unblocked — vehicle positions alone don't carry route
names without the static schedule):

1. **Decode dependency.** `gtfs-realtime-bindings` (or bare `protobuf` +
   a compiled `gtfs-realtime.proto`) is not in `ingest/requirements.txt`.
   Without it, vehicle count, route/trip/vehicle IDs, and timestamps
   can't be verified — only the envelope shape could be confirmed here.
2. **Static GTFS reference.** Vehicle positions are just moving points
   without the static route/stop/trip data to give them a corridor
   identity. This audit could not discover a working static GTFS URL by
   guessing common paths (table above) — it needs an authoritative link
   from OTD's own docs or registration email.

Once both are resolved, re-run this audit (or a successor) to confirm
actual vehicle coverage and freshness before promoting this past B.
