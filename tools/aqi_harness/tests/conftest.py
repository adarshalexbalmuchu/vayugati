"""Puts tools/ on sys.path so `import aqi_harness...` works regardless of
where pytest is invoked from (repo root, tools/, or tools/aqi_harness/)."""

import sys
from pathlib import Path

_TOOLS_DIR = Path(__file__).resolve().parents[2]
if str(_TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_TOOLS_DIR))
