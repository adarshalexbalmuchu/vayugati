#!/usr/bin/env python3
"""Reproducible extraction script — decodes the ACTUAL BIFF8 formula records
from CPCB's official AQI-Calculator.xls, using xlrd's own internal formula
decompiler (xlrd.formula.decompile_formula), not a hand-rolled parser and
not a curve-fit to any expected output.

Why this exists: xlrd's public API (open_workbook / Sheet.cell) only
exposes each formula cell's last-CACHED VALUE, not its formula text — the
first pass at this harness used the repo's own breakpoint tables for
cpcb_workbook_formula_exact, which was WRONG for several pollutants (see
methodology_manifest.json's contamination_audit). This script reads the
raw BIFF8 records directly (via olefile, since the workbook is a legacy
.xls / OLE Compound File) and decompiles each pollutant's Sub-Index cell
formula into readable text, which is what profiles/cpcb_workbook_formula_exact.py
is now built from.

Usage:
    pip install xlrd==1.2.0 olefile
    python3 extract_formulas.py path/to/AQI-Calculator.xls

Requires xlrd==1.2.0 specifically — xlrd>=2.0 dropped .xls (BIFF) support
entirely and only reads .xlsx.

SHA-256 verification: before touching a single byte of the workbook, this
script hashes it and compares against EXPECTED_SHA256 (the same value
recorded in methodology_manifest.json's `workbook.sha256`). A mismatch is a
FATAL error, not a warning — this harness's whole premise is transcribing
one specific, hashed file; decoding a different (possibly CPCB-updated,
possibly tampered) file under the same filename and silently trusting it
would be exactly the kind of unverified assumption the harness exists to
avoid. Pass --expected-sha256 to deliberately verify a different, known
workbook revision instead (never a silent bypass — the new hash still has
to be typed out and still fails loudly on any OTHER mismatch).

Output: prints the decoded formula text for every pollutant's Sub-Index
cell (Sheet1, column D), plus writes decoded_formulas.json alongside this
script — the artifact methodology_manifest.json references.

Note on test isolation: the harness's tests (tools/aqi_harness/tests/) do
NOT run this script and do NOT need the workbook file or network access —
they run entirely against the checked-in profiles/cpcb_workbook_formula_exact.py,
which was itself built by hand from this script's OUTPUT
(decoded_formulas.json), not by calling this script at import or test time.
This script is a one-off provenance tool, re-run manually when the workbook
itself needs re-verifying.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
from pathlib import Path

try:
    import olefile
    import xlrd
    import xlrd.formula as xlrd_formula
except ImportError as e:
    raise SystemExit(
        f"Missing dependency: {e}. Install with: pip install xlrd==1.2.0 olefile"
    ) from e

# Recorded in methodology_manifest.json's workbook.sha256 — the exact file
# this harness's profiles/cpcb_workbook_formula_exact.py was built from.
EXPECTED_SHA256 = "92eb788f7f61bd46edea1814a9e1b8f5dd75d05dfb88f34a460905bc07bd151a"

# (label, row0, col0) — 0-indexed, matching xlrd/BIFF convention. Sheet1's
# layout: column C holds the concentration input, column D the Sub-Index
# formula, one pollutant per row-pair (row N = pollutant, row N+1 = the
# sheet's own "check" formula, not decoded here).
POLLUTANT_CELLS = [
    ("PM10", 7, 3),
    ("PM2.5", 9, 3),
    ("SO2", 11, 3),
    ("NO2", 13, 3),
    ("CO", 15, 3),
    ("O3", 17, 3),
    ("NH3", 19, 3),
]


def verify_sha256(xls_path: Path, expected: str) -> None:
    actual = hashlib.sha256(xls_path.read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit(
            f"REFUSING to extract: sha256 mismatch for {xls_path}.\n"
            f"  expected: {expected}\n"
            f"  actual:   {actual}\n"
            "This is either a different/updated workbook or a corrupted/tampered "
            "download — either way, decoding it silently under the assumption it's "
            "the same file this harness was built from would be exactly the kind "
            "of unverified assumption this harness exists to avoid. If you "
            "deliberately intend to verify a different, known workbook revision, "
            "re-run with --expected-sha256 <hash> naming that revision explicitly."
        )
    print(f"sha256 verified: {actual}")


def read_biff_records(workbook_stream: bytes) -> list[tuple[int, int, int, bytes]]:
    """Walks the raw BIFF8 record stream: [type:u16][len:u16][data]."""
    pos = 0
    records = []
    while pos + 4 <= len(workbook_stream):
        rtype, rlen = struct.unpack_from("<HH", workbook_stream, pos)
        rdata = workbook_stream[pos + 4 : pos + 4 + rlen]
        records.append((pos, rtype, rlen, rdata))
        pos += 4 + rlen
    return records


def find_formula_rgce(records: list[tuple[int, int, int, bytes]], row: int, col: int) -> bytes:
    """FORMULA record (type 0x0006) layout: rw(2) col(2) ixfe(2) num(8)
    grbit(2) chn(4) cce(2) rgce(cce). Returns the raw rgce token bytes for
    the FORMULA record matching (row, col)."""
    for _pos, rtype, _rlen, rdata in records:
        if rtype != 0x0006:
            continue
        rw, rcol = struct.unpack_from("<HH", rdata, 0)
        if rw == row and rcol == col:
            cce = struct.unpack_from("<H", rdata, 20)[0]
            return rdata[22 : 22 + cce]
    raise ValueError(f"No FORMULA record found at row={row}, col={col}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("xls_path", type=Path, help="Path to a downloaded AQI-Calculator.xls")
    parser.add_argument(
        "--expected-sha256",
        default=EXPECTED_SHA256,
        help="Override the expected sha256 (default: the hash this harness was built from). "
        "Only for deliberately verifying a different, known workbook revision.",
    )
    args = parser.parse_args()
    xls_path: Path = args.xls_path

    verify_sha256(xls_path, args.expected_sha256)

    ole = olefile.OleFileIO(str(xls_path))
    workbook_stream = ole.openstream("Workbook").read()
    records = read_biff_records(workbook_stream)

    # xlrd's Book object gives decompile_formula the sheet/name context it
    # needs (external sheet table etc.) even though every formula here is
    # purely local (no cross-sheet or named references).
    bk = xlrd.open_workbook(str(xls_path), formatting_info=False)

    results = {}
    for label, row, col in POLLUTANT_CELLS:
        rgce = find_formula_rgce(records, row, col)
        text = xlrd_formula.decompile_formula(
            bk, rgce, len(rgce), fmlatype=xlrd_formula.FMLA_TYPE_CELL, browx=row, bcolx=col
        )
        results[label] = {
            "cell": f"row={row} col={col} (0-indexed)",
            "rgce_hex": rgce.hex(),
            "decoded_formula": text,
        }
        print(f"=== {label} ===\n{text}\n")

    out_path = Path(__file__).parent / "decoded_formulas.json"
    out_path.write_text(json.dumps(results, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
