"""Read-only AQI calculation comparison harness.

Compares two explicitly versioned AQI calculation profiles:
  - repo_current: this repository's production sub-index/AQI logic, imported
    directly from ingest/app/aqi.py (never copied — see profiles/repo_current.py)
    so this harness can never silently drift from what production actually does.
  - cpcb_workbook_formula_exact: the CPCB National AQI formula as verified against the
    official AQI-Calculator.xls workbook, WITHOUT the repository's 500 cap.

This package does not import from, call, or modify anything in ingest/app/
except a read-only import of aqi.py's pure functions. It performs no writes
to the database, no network calls, and is never imported by production code.
See methodology_manifest.json for workbook provenance and unresolved
methodological decisions.
"""
