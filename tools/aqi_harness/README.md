# AQI comparison harness

Read-only. Makes zero production changes: no edits to `ingest/app/`, `web/`,
`supabase/`, or any API response — verified by `git status` showing nothing
outside `tools/aqi_harness/` after this was built. No network access at
runtime, no database access (the formula-extraction script downloads the
workbook once, offline from the harness itself — see below). The only
production code this package touches is a **read-only import** of
`ingest/app/aqi.py` (see `profiles/repo_current.py`) so the `repo_current`
profile can never silently drift from what production actually computes.

## What it compares

Two explicitly versioned calculation profiles, run on the same structured
input:

- **`repo_current`** — this repository's real, unmodified `compute_aqi()` /
  `_sub_index()` logic, called directly. Same breakpoints, same
  round-half-up rounding, same hard 500 cap.
- **`cpcb_workbook_formula_exact`** — the CPCB National AQI (2014) linear
  interpolation formula, **decoded directly from the workbook's own BIFF8
  formula records** (not copied from `ingest/app/aqi.py`, not curve-fit to
  any expected output). Confirmed **uncapped**: every pollutant's decoded
  formula ends in an unconditional `IF(C > tier5_ceiling, ...)` with no
  reference to 500 anywhere.

Every result keeps five concepts separate (see `models.ProfileResult`):
`raw_sub_index` (unrounded math), `rounded_sub_index` (after rounding),
`cap_applied` (bool), `display_value` (None whenever the rounded value
exceeds 500 — this harness never assumes CPCB's public-display policy up
there), and `category_label` (same >500 rule).

### A real correction happened here

The first pass at `cpcb_workbook_formula_exact` copied `ingest/app/aqi.py`'s
breakpoint tables directly, because the workbook's own pre-filled worked
example (station NSIT, Delhi) matched them exactly at every tier those
values touch — but that example never exercises the severe band. On
inspection with real severe-range values, four of seven pollutants turned
out to be **contaminated**: `ingest/app/aqi.py` has an extra "tier 6" for
PM10, SO2, NO2, and CO that the actual workbook formula does not contain —
the real formula just extends tier 5's own slope forever. See
`methodology_manifest.json` → `contamination_audit` for the full,
pollutant-by-pollutant comparison (exact fractions, not float
approximations), and `formula_extraction/` for how the formulas were
actually decoded (`xlrd.formula.decompile_formula` against the raw BIFF8
bytes, not a hand-rolled parser).

## Running it

```bash
# From the repo root
python3 -m pytest tools/aqi_harness/tests/ -v      # 39 deterministic tests

PYTHONPATH=tools python3 -m aqi_harness.run_comparison
# -> tools/aqi_harness/output/comparison.json
# -> tools/aqi_harness/output/comparison.csv

# To re-run the formula extraction against a fresh copy of the workbook:
pip install xlrd==1.2.0 olefile
curl -o AQI-Calculator.xls https://cpcb.gov.in/upload/national-air-quality-index/AQI-Calculator.xls
python3 tools/aqi_harness/formula_extraction/extract_formulas.py AQI-Calculator.xls
```

Example output for the 31 synthetic fixtures already ships in
`output/comparison.json` / `output/comparison.csv` — regenerate any time
with the command above; output is deterministic (same fixtures always
produce byte-identical files, see `tests/test_output_generation.py`).

## Layout

```
models.py                          ComparisonInput / ProfileResult / ComparisonResult
compare.py                         runs one input through both profiles
output.py                          JSON + CSV serialization
profiles/repo_current.py           imports ingest/app/aqi.py directly
profiles/cpcb_workbook_formula_exact.py    built from decoded BIFF8 formulas, uncapped
formula_extraction/extract_formulas.py    reproducible BIFF8 decoding script
formula_extraction/decoded_formulas.json  its output — the formula-extraction artifact
fixtures/severe_fixtures.py        the 31 synthetic severe-range fixtures
fixtures/future_cpcb_observations.py   empty schema for real station data (future)
future_adapter.py                  interface stub — NOT implemented, NOT called
methodology_manifest.json          workbook URL, sha256, contamination audit, caveats
run_comparison.py                  CLI entrypoint
tests/                             39 pytest tests
```

## Fixtures

**PM10** at the exact values requested — 430, 431, 510, 511, 600, 601, 756,
785, 1400 µg/m³ — organized into three `comparison_range` buckets
(`430-510`, `510-600`, `above_600`). Both profiles agree through 430 (tier
5's real ceiling); `cpcb_workbook_formula_exact` reaches exactly 500 at **510**
(not 600); `repo_current` doesn't hit 500 until its own (contaminated)
600 boundary, and only its cap genuinely engages at 601. Verified rounded
values: `510→500, 511→501, 600→613, 601→614, 756→808, 785→844, 1400→1613`
— all confirmed against the decoded formula with exact fraction
arithmetic, matching the harness brief's own expected values exactly.

**Severe-range fixtures for every other repo-supported pollutant** (PM2.5,
NO2, SO2, CO, O3, NH3), each with a fixture at its own **real** tier-5
ceiling (not `ingest/app/aqi.py`'s assumed one, except where they're the
same — see below) and points straddling the real 500-crossing. **Pb has no
fixtures**: neither `ingest/app/aqi.py` nor the workbook's formulas
implement it.

- **PM2.5 and NH3 were NOT contaminated** — `ingest/app/aqi.py`'s assumed
  top-tier slope happens to equal the decoded formula's real tail slope
  exactly, so both profiles agree all the way to exactly 500 (at 380 and
  2400 respectively).
- **SO2, NO2, and CO ARE contaminated** — real 500-crossings are 2400 (not
  2100), 520 (not 800), and 51 mg/m³ (not 48) respectively.
- **O3 is a special case**: its decoded formula is genuinely
  **discontinuous** at 748 µg/m³ (see below), not just a differently-sloped
  tail — this is preserved exactly, not modelled as a clean extension.

Every **CO** fixture carries an unconditional `unresolved: CO unit
semantics` warning; every **O3** fixture above 208 µg/m³ carries an
unconditional `unresolved: O3 averaging behaviour above 208` warning; every
**O3** fixture above 748 µg/m³ *additionally* carries an unconditional
`unresolved: workbook formula artifact under investigation...` warning —
all three per this harness's brief/instructions, all regardless of whether
that specific fixture's computation succeeds.

### O3's formula artifact, briefly

O3's decoded tier-5 formula is `300+(C-208)*100/539` (not `/540` —
`748-208=540` would be the clean divisor; the workbook literally stores the
integer `539`, confirmed twice independently at the raw byte level, not a
decoding artifact). Its tail term for `C>748` is `400+(C-400)*100/539` —
note it anchors on **400**, not 748 (the tier boundary). A continuous
formula would anchor on 748. Because it doesn't, the sub-index **jumps by
~64 points** right at C=748 (≈400.19 just at 748, ≈464.56 just above it).
**This is a workbook formula artifact under investigation, not a confirmed
CPCB policy or intentional design choice** — one plausible hypothesis is an
authoring typo in the original 2014/2015 spreadsheet, but that is
unconfirmed. This harness transcribes the workbook, it doesn't correct or
explain away what it decoded. See `tests/test_o3_discontinuity.py` and
`methodology_manifest.json` → `o3_discontinuity`.

`fixtures/future_cpcb_observations.py` defines the schema for real,
timestamp-matched CPCB station readings (provider station id/name,
coordinates, agency, pollutant/concentration/unit, observation + fetch
timestamps, published AQI/label, source URL, evidence hash) — currently an
**empty list**. Populating it, and implementing `future_adapter.py`'s
`CpcbLiveDataAdapter` interface, is the evidence-collection phase this
delivery explicitly does not attempt: that's where `DATA_GOV_API_KEY`
becomes relevant, for verifying CO unit semantics and running
timestamp-matched severe-PM10 comparisons against what CPCB itself
published. Nothing in this harness reads that env var or makes an HTTP call.

## Unresolved methodological decisions

(Full detail and evidence in `methodology_manifest.json`.)

1. **CO unit semantics** — whether every real upstream source reliably
   distinguishes mg/m³ from µg/m³ for CO — is unverified against live data.
   (The contamination fix corrected CO's *math*; it doesn't touch this
   separate question.)
2. **O3 averaging behaviour above 208 µg/m³** is unverified against the
   workbook or live data.
3. **O3's formula discontinuity at 748 µg/m³** is preserved exactly as
   decoded, not corrected — see above. Whether 400/539 were typos for
   748/540 has not been confirmed with CPCB.
4. **CPCB's public display policy for AQI > 500** was not researched; the
   harness deliberately returns `None` for `display_value`/`category_label`
   rather than guessing.
5. **Pb (lead)** is unsupported by both profiles — no breakpoint data or
   formula exists for it in `ingest/app/aqi.py` or in the workbook.
6. **`fixtures/future_cpcb_observations.py` is empty** — no real station
   data has been collected; that's explicitly the next phase, not this one.
