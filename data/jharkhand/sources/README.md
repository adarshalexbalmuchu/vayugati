# Government source tables for the district profiles

Extracted as printed; nothing estimated. Re-extract only from these documents.

| File | Source | Published |
|---|---|---|
| `census2011_population.csv` | Census of India 2011, Table A-02 "Decadal variation in population 1901-2011, Jharkhand" (Office of the Registrar General & Census Commissioner). https://censusindia.gov.in/nada/index.php/catalog/43353 (PDF: download/47042). District sum = state total 3,29,88,134. | 2011 Census |
| `isfr2023_district_forest.csv` | Forest Survey of India, India State of Forest Report 2023, Jharkhand chapter, Table 10.11.3 "District-wise Forest Cover in Jharkhand" (area = calculated area by Survey of India). https://forest.jharkhand.gov.in/files/ISFR_Report/jharkhand-isfr-2023.pdf. Sums match the Grand Total (79,716 km² area, 23,765.78 km² forest). | Dec 2024 |

District names follow the Census spelling (Purbi Singhbhum, Pashchimi Singhbhum, Saraikela-Kharsawan),
which matches `processed/districts.geojson`.
| `osm_districts_admin5_2026-11-03.geojson` | The 24 district boundaries (admin_level 5) from OpenStreetMap, extracted from the Geofabrik eastern-zone pbf (data as of 3 Nov 2026), ODbL. One of three open sources fused into the district outlines. | OSM, 3 Nov 2026 |
