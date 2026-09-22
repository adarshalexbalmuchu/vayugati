"""VayuTrace validation harness — measure whether kernel changes actually improve it.

WHY THIS EXISTS
===============
Every physics change to vayutrace_kernel.py (sigma values, wind factor,
emission weights, calibration) was, before this script, unfalsifiable: we
could confirm the numbers CHANGED but never that they got BETTER. That makes
the whole model unimprovable in any rigorous sense, and makes any accuracy
claim in a funding application unsupportable.

WHAT CAN AND CANNOT BE VALIDATED
================================
CANNOT: the breakdown fractions themselves (industrial 30% / road 65% / ...).
CPCB stations measure total PM2.5 mass, not per-source splits. Checking a
source split requires chemical speciation (the CMB/receptor-modelling
approach VayuTrace deliberately does not use). Nothing in this repo — and
nothing obtainable without a speciation lab — can validate those fractions.
Any claim that this harness validates the source split would be false.

CAN: the kernel's underlying dispersion physics, via its raw `local_score`
(the un-normalised sum of emission_weight x wind_factor x distance_decay
over all sources, exposed by run_kernel for exactly this purpose).

The falsifiable claim is:

    A ward-hour that the kernel scores HIGHER should actually have a
    HIGHER observed PM2.5 local excess than a ward-hour it scores lower.

"Local excess" (ward PM2.5 minus the city-wide median PM2.5 at that same
hour) is the correct comparison target, not raw PM2.5 — the kernel models
only LOCAL sources, and deliberately excludes regional transport
(regional_fraction_prior is tracked separately). Comparing against raw
PM2.5 would mostly measure citywide meteorology the kernel never claims to
predict, and would produce a flatteringly high correlation for the wrong
reason.

METRIC
======
Spearman rank correlation (rho) between local_score and observed local
excess, computed per ward-hour across the whole matched dataset.

Spearman, not Pearson: local_score is in arbitrary units (see its own
comment in vayutrace_kernel.py), so only its ORDERING is meaningful. A
Pearson r would imply a linear-in-magnitude relationship the units do not
support.

Interpretation, calibrated to what this class of model can achieve — a
reduced-complexity dispersion kernel with no chemistry, no dust module and
proxy emission inventories will NOT reach the correlations a full CTM does:
    rho <= 0.0   model is no better than random (or inverted) — broken
    0.0-0.10     essentially no skill
    0.10-0.20    weak but real signal (the Sept 2026 sigma calibration
                 reported rho=0.20 on a 30-day wind-stratified subset)
    0.20-0.35    solid for this model class
    > 0.35       strong; verify it isn't leakage before believing it

HONEST LIMITATIONS OF THIS HARNESS ITSELF
=========================================
1. Only ~39 of 265 wards have a CPCB station, so validation can only ever
   cover those. The other ~226 wards' outputs remain entirely unvalidated —
   the kernel produces numbers for them that nothing here checks. State
   this plainly rather than implying whole-city validation.

2. In practice the usable set is smaller still — ~12 wards as of Sept 2026,
   i.e. ~4.5% of the wards the kernel actually scores. The binding
   constraint is WEATHER history, not readings:
       - all 44 stations report healthily (~950 pm25 rows each / 60 days)
       - but per-ward weather was only extended from the original 13
         "hotspot" wards to all 265 in Sept 2026 (see ingest.py's
         boundary-centroid weather fetch), so a 60-day window is dominated
         by the era when only 13 wards had any weather at all
       - VC/PBLH specifically postdate an even later migration
   This is a DATA-HISTORY limitation that resolves itself as the extended
   ingestion accumulates — not a model limitation. Re-run with a longer
   window every few weeks; `wards_with_own_rho` in the output is the number
   to watch. Once it approaches 39, per-ward statistics become meaningful.

3. With ~12 wards the per-ward statistics are UNDERPOWERED. Measured
   Sept 2026 for the dilution/wind-blend change: median improvement
   +0.039, 9 of 12 wards improved, but the 95% bootstrap CI was
   [-0.022, +0.131] — i.e. it crosses zero, so the improvement is
   directionally consistent and physically motivated but NOT statistically
   significant at n=12. Do not describe such a result as "proven"; describe
   it as measured-and-underpowered until the ward count grows.
4. Source inventories (OSM roads/industrial) are CURRENT, not historical —
   we assume the road network and industrial zones did not change over the
   validation window. Over a few months that is reasonable; over years it
   would not be.
5. FIRMS fire data is not replayed historically here (fetch_igp_fires is a
   live API scoped to recent days), so the fire source type is effectively
   absent from validation. Fire-season performance is therefore NOT
   measured by this harness.
6. A positive rho confirms the dispersion geometry has real skill. It does
   NOT confirm the source-split fractions, which remain unvalidatable (see
   above).

USAGE
=====
    python ingest/scripts/validate_vayutrace.py
    python ingest/scripts/validate_vayutrace.py --hours 720 --json out.json

Run it BEFORE and AFTER a kernel change and compare rho. That difference is
the only evidence that a change was an improvement rather than just a
change.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import db  # noqa: E402
from app.vayutrace_kernel import run_kernel  # noqa: E402


def _spearman(xs: list[float], ys: list[float]) -> float:
    """Spearman rank correlation. Implemented directly (no scipy dependency —
    the ingest service deliberately keeps its dependency list minimal), with
    average ranks for ties, which matters here because many ward-hours share
    identical scores when a ward has no nearby sources."""
    n = len(xs)
    if n < 3:
        return float("nan")

    def _ranks(vals: list[float]) -> list[float]:
        order = sorted(range(len(vals)), key=lambda i: vals[i])
        ranks = [0.0] * len(vals)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and vals[order[j + 1]] == vals[order[i]]:
                j += 1
            avg = (i + j) / 2.0 + 1.0
            for k in range(i, j + 1):
                ranks[order[k]] = avg
            i = j + 1
        return ranks

    rx, ry = _ranks(xs), _ranks(ys)
    mx, my = statistics.fmean(rx), statistics.fmean(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    dx = sum((a - mx) ** 2 for a in rx)
    dy = sum((b - my) ** 2 for b in ry)
    if dx <= 0 or dy <= 0:
        return float("nan")
    return num / (dx * dy) ** 0.5


def _hour_key(ts: str) -> str:
    return ts[:13]  # 'YYYY-MM-DDTHH'


def build_observations(hours: int) -> tuple[dict, dict]:
    """Returns (observed_local_excess, weather_by_hour).

    observed_local_excess: {(ward_id, hour_key): pm25 - city_median_that_hour}
    weather_by_hour:       {hour_key: {ward_id: {wind_dir, wind_speed}}}

    Local excess is computed against the MEDIAN (not mean) of all wards
    reporting in that same hour — median is robust to the one or two
    extreme-outlier stations Delhi routinely produces, which would drag a
    mean and make every other ward look artificially clean.
    """
    readings = db.get_readings_history(hours=hours)
    weather = db.get_weather_history(hours=hours)

    # ward-hour -> mean pm25 (a ward can have multiple stations/readings per hour)
    by_ward_hour: dict[tuple[int, str], list[float]] = defaultdict(list)
    for r in readings:
        if r.get("pm25") is None or r.get("ward_id") is None:
            continue
        by_ward_hour[(r["ward_id"], _hour_key(r["ts"]))].append(float(r["pm25"]))
    ward_hour_pm25 = {k: statistics.fmean(v) for k, v in by_ward_hour.items()}

    # city median per hour
    per_hour: dict[str, list[float]] = defaultdict(list)
    for (_wid, hk), v in ward_hour_pm25.items():
        per_hour[hk].append(v)
    city_median = {hk: statistics.median(v) for hk, v in per_hour.items() if len(v) >= 3}

    observed = {
        (wid, hk): v - city_median[hk]
        for (wid, hk), v in ward_hour_pm25.items()
        if hk in city_median
    }

    wx: dict[str, dict[int, dict]] = defaultdict(dict)
    for w in weather:
        if w.get("ward_id") is None or w.get("wind_speed") is None:
            continue
        hk = _hour_key(w["ts"])
        wid = w["ward_id"]
        cand = {
            "wind_dir": w.get("wind_dir"),
            "wind_speed": w.get("wind_speed"),
            # PBLH/VC drive the kernel's dilution term — without forwarding
            # these the harness would silently validate a no-dilution model
            # and report the OLD behaviour's score.
            "boundary_layer_height": w.get("boundary_layer_height"),
            "ventilation_coefficient": w.get("ventilation_coefficient"),
        }
        prev = wx[hk].get(wid)
        # A ward-hour can have several weather rows (the 15-min ingest cycle
        # writes more than one row per hour). Older rows predate the
        # PBLH/VC migration and carry nulls for both. Taking "whichever row
        # came last" silently discarded ALL dilution data — confirmed live
        # Sept 2026: 0 of 2,581 sampled ward-hours had VC despite 6,496
        # non-null VC rows existing in the same query result. Prefer a row
        # that actually has the dilution fields.
        if prev is not None and prev.get("ventilation_coefficient") is not None \
                and cand.get("ventilation_coefficient") is None:
            continue
        wx[hk][wid] = cand
    return observed, wx


def run_validation(hours: int, max_hours_sampled: int,
                   require_dilution: bool = False) -> dict:
    wards = db.get_wards_with_city()
    stations = db.get_stations_with_coords()

    from app.vayutrace_osm_industrial import load_delhi_industrial_zones
    from app.vayutrace_osm_roads import load_delhi_roads

    industrial = load_delhi_industrial_zones()
    roads = load_delhi_roads()
    if not industrial and not roads:
        raise SystemExit(
            "No emission sources loaded — is OSM_PBF_PATH set and the .pbf present?\n"
            "Validation cannot run without a source inventory."
        )

    observed, wx_by_hour = build_observations(hours)
    # Only hours where we have BOTH weather and observed local excess.
    usable_hours = sorted({hk for (_w, hk) in observed} & set(wx_by_hour))
    if max_hours_sampled and len(usable_hours) > max_hours_sampled:
        # Even stride across the window rather than the first N — avoids
        # validating only against one contiguous (possibly unrepresentative)
        # stretch of days.
        stride = len(usable_hours) / max_hours_sampled
        usable_hours = [usable_hours[int(i * stride)] for i in range(max_hours_sampled)]

    paired_score: list[float] = []
    paired_obs: list[float] = []
    per_ward: dict[int, list[tuple[float, float]]] = defaultdict(list)

    for hk in usable_hours:
        weather_this_hour = wx_by_hour[hk]
        if require_dilution:
            weather_this_hour = {
                wid: m for wid, m in weather_this_hour.items()
                if m.get("ventilation_coefficient") is not None
                or m.get("boundary_layer_height") is not None
            }
        if not weather_this_hour:
            continue
        month = int(hk[5:7])
        results = run_kernel(
            wards=wards,
            weather=weather_this_hour,
            industrial_sources=industrial,
            fire_sources=[],           # see limitation 4 in module docstring
            road_sources=roads,
            cpcb_stations=stations,
            month=month,
            regional_fire_sources=[],
        )
        for r in results:
            key = (r["ward_id"], hk)
            if key not in observed:
                continue
            score = r.get("local_score")
            if score is None:
                continue
            paired_score.append(float(score))
            paired_obs.append(float(observed[key]))
            per_ward[r["ward_id"]].append((float(score), float(observed[key])))

    rho = _spearman(paired_score, paired_obs)

    ward_rhos = {}
    for wid, pairs in per_ward.items():
        if len(pairs) >= 20:
            ward_rhos[wid] = _spearman([p[0] for p in pairs], [p[1] for p in pairs])

    finite = [v for v in ward_rhos.values() if v == v]

    # BETWEEN-ward skill: does the kernel rank WARDS correctly, using each
    # ward's time-averaged score vs. its time-averaged local excess?
    #
    # This decomposition exists because the pooled rho above is genuinely
    # misleading on its own (confirmed live Sept 2026: pooled rho=+0.32
    # while the per-ward median was -0.05). Pooling mixes two very different
    # claims:
    #   between-ward — "wards near more sources are dirtier on average"
    #                  (a static geography claim; easy, and largely a
    #                  restatement of the emission inventory)
    #   within-ward  — "THIS ward gets worse when wind/dispersion conditions
    #                  turn against it" (the dynamic claim that actually
    #                  requires the wind/sigma physics to be right)
    # Only the second tests the kernel's meteorology. Reporting the pooled
    # number alone would credit the model for skill it has not demonstrated.
    ward_means = [
        (statistics.fmean([p[0] for p in pairs]), statistics.fmean([p[1] for p in pairs]))
        for pairs in per_ward.values()
        if len(pairs) >= 5
    ]
    between_rho = (
        _spearman([m[0] for m in ward_means], [m[1] for m in ward_means])
        if len(ward_means) >= 3 else float("nan")
    )
    return {
        "window_hours": hours,
        "hours_evaluated": len(usable_hours),
        "paired_observations": len(paired_score),
        "wards_covered": len(per_ward),
        # The kernel scores every ward; validation only covers those with a
        # station AND enough matched weather. Reported so the coverage gap is
        # impossible to overlook when quoting a rho. See limitations 1-2.
        "wards_scored_by_kernel": len(wards),
        "spearman_rho_overall": rho,
        "spearman_rho_between_wards": between_rho,
        "wards_with_own_rho": len(finite),
        "per_ward_rho_median": statistics.median(finite) if finite else float("nan"),
        "per_ward_rho_positive_fraction": (
            sum(1 for v in finite if v > 0) / len(finite) if finite else float("nan")
        ),
        "per_ward_rho": {str(k): v for k, v in sorted(ward_rhos.items())},
        "source_counts": {"industrial": len(industrial), "road": len(roads)},
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--hours", type=int, default=24 * 60,
                    help="History window to validate over (default: 60 days)")
    ap.add_argument("--max-hours", type=int, default=120,
                    help="Max distinct hours to evaluate; each runs the full kernel "
                         "over all wards, so this bounds runtime (default: 120)")
    ap.add_argument("--json", type=str, default=None,
                    help="Write the full result dict to this path as JSON")
    ap.add_argument("--require-dilution", action="store_true",
                    help="Only evaluate ward-hours that actually have "
                         "ventilation_coefficient/PBLH. Roughly half of "
                         "historical ward-hours predate those fields; "
                         "including them silently applies a no-op dilution "
                         "factor of 1.0 and dampens any measured effect of "
                         "the dilution term, in EITHER direction.")
    args = ap.parse_args()

    res = run_validation(args.hours, args.max_hours,
                         require_dilution=args.require_dilution)

    print("=" * 66)
    print("VayuTrace validation — dispersion skill vs. observed local excess")
    print("=" * 66)
    print(f"  window:                {res['window_hours']}h")
    print(f"  hours evaluated:       {res['hours_evaluated']}")
    print(f"  paired observations:   {res['paired_observations']}")
    print(f"  wards covered:         {res['wards_covered']} of "
          f"{res['wards_scored_by_kernel']} scored by the kernel "
          f"({res['wards_covered'] / max(res['wards_scored_by_kernel'], 1):.1%})")
    print(f"  wards w/ own rho:      {res['wards_with_own_rho']} "
          f"(these drive the verdict; see limitations 1-3)")
    print(f"  sources: {res['source_counts']['industrial']} industrial, "
          f"{res['source_counts']['road']} road cells")
    print("-" * 66)
    print(f"  pooled rho (MISLEADING alone):   {res['spearman_rho_overall']:+.4f}")
    print(f"    ^ mixes the two claims below; do not quote on its own")
    print()
    print(f"  BETWEEN-ward rho:                {res['spearman_rho_between_wards']:+.4f}")
    print( "    'wards near more sources are dirtier on average'")
    print( "    (static geography — largely restates the emission inventory)")
    print()
    print(f"  WITHIN-ward rho (median):        {res['per_ward_rho_median']:+.4f}")
    print(f"    'this ward worsens when conditions turn against it'")
    print(f"    (the real test of the wind/sigma physics)")
    print(f"    wards with enough data: {res['wards_with_own_rho']}, "
          f"{res['per_ward_rho_positive_fraction']:.0%} positive")
    print("-" * 66)
    # The verdict is driven by WITHIN-ward skill, deliberately. That is the
    # claim the kernel's meteorology actually makes, and the one a change to
    # sigma/wind/stability should move. Judging by the pooled number would
    # let a purely geographic signal mask having no dynamic skill at all.
    rho = res["per_ward_rho_median"]
    if rho != rho:
        verdict = "INSUFFICIENT DATA"
    elif rho <= 0:
        verdict = "NO DYNAMIC SKILL — cannot predict when a ward worsens"
    elif rho < 0.10:
        verdict = "ESSENTIALLY NO DYNAMIC SKILL"
    elif rho < 0.20:
        verdict = "WEAK BUT REAL DYNAMIC SIGNAL"
    elif rho < 0.35:
        verdict = "SOLID DYNAMIC SKILL for this model class"
    else:
        verdict = "STRONG — check for leakage before believing it"
    print(f"  VERDICT (within-ward): {verdict}")
    print("=" * 66)
    print("  NOTE: this validates dispersion GEOMETRY only. The source-split")
    print("  fractions (industrial/road/fire %) are NOT validated here and")
    print("  cannot be without chemical speciation. See module docstring.")

    if args.json:
        Path(args.json).write_text(json.dumps(res, indent=2))
        print(f"\n  wrote {args.json}")


if __name__ == "__main__":
    main()
