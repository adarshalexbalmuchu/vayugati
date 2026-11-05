/**
 * Facts and rankings for the Jharkhand map assistant. Pure: no React, no map.
 *
 * Every figure the assistant shows is read here from district_profiles.json (built by
 * ingest/scripts/jharkhand/district_profiles.py), together with its source. The model never supplies a number:
 * it only names a district and which fields to show.
 */

export interface DistrictProfile {
  area_km2: number | null
  area_note?: string | null
  population_2011: number | null
  forest_km2: number | null
  forest_pct: number | null
  elevation_median_m: number | null
  elevation_max_m: number | null
  heat_detections: number | null
  monitors_continuous_in_feed: number | null
  monitors_manual_namp: number | null
  monitors_planned_jspcb: number | null
  landcover_pct?: Record<string, number> | null
  osm_counts?: Record<string, number> | null
}

export interface ProfilesDoc {
  sources: Record<string, string>
  heat_detection_dates: string[]
  districts: Record<string, DistrictProfile>
}

export type FactField =
  | 'area' | 'population' | 'forest_pct' | 'forest_km2' | 'highest_point' | 'typical_height' | 'heat_detections'
  | 'tree_cover_pct' | 'cropland_pct' | 'builtup_pct' | 'water_pct'
  | 'monitors_continuous' | 'monitors_manual' | 'monitors_planned'
  | 'n_mining_areas' | 'n_industrial_areas' | 'n_brick_kilns' | 'n_schools' | 'n_hospitals' | 'n_rail_stations'
  | 'n_peaks' | 'n_substations' | 'n_towns' | 'n_villages'

interface FieldDef {
  label: string
  unit: string
  get: (p: DistrictProfile) => number | null | undefined
  decimals?: number
  source: string
}

const ISFR = 'Forest Survey of India, ISFR 2023'
const ESA = 'ESA WorldCover 2021 (satellite, 10 m); shares computed by Vayu Gati'
const DEM = 'Copernicus DEM (ESA), 90 m grid; computed by Vayu Gati'

const OSM = 'OpenStreetMap, mapped by volunteers (3 Nov 2026): what is mapped, not a complete count'
const osmCount = (key: string, label: string): FieldDef => ({
  label, unit: '', get: (p) => p.osm_counts?.[key], source: OSM,
})

export const FIELD_DEFS: Record<FactField, FieldDef> = {
  area: { label: 'Area', unit: ' km²', get: (p) => p.area_km2, source: 'Survey of India area in ISFR 2023 (Kodarma, Hazaribagh: district website)' },
  population: { label: 'Population (2011)', unit: '', get: (p) => p.population_2011, source: 'Census of India 2011, Table A-02' },
  forest_pct: { label: 'Forest cover', unit: '%', get: (p) => p.forest_pct, decimals: 1, source: ISFR },
  forest_km2: { label: 'Forest area', unit: ' km²', get: (p) => p.forest_km2, decimals: 0, source: ISFR },
  highest_point: { label: 'Highest point', unit: ' m', get: (p) => p.elevation_max_m, source: DEM },
  typical_height: { label: 'Typical ground height', unit: ' m', get: (p) => p.elevation_median_m, source: DEM },
  heat_detections: { label: 'Satellite heat detections', unit: '', get: (p) => p.heat_detections, source: 'NASA FIRMS (VIIRS), last 5 days in the map data' },
  tree_cover_pct: { label: 'Tree cover (satellite)', unit: '%', get: (p) => p.landcover_pct?.['Tree cover'], decimals: 1, source: ESA },
  cropland_pct: { label: 'Cropland (satellite)', unit: '%', get: (p) => p.landcover_pct?.['Cropland'], decimals: 1, source: ESA },
  builtup_pct: { label: 'Built-up land (satellite)', unit: '%', get: (p) => p.landcover_pct?.['Built-up'], decimals: 1, source: ESA },
  water_pct: { label: 'Water (satellite)', unit: '%', get: (p) => p.landcover_pct?.['Permanent water'], decimals: 1, source: ESA },
  monitors_continuous: { label: 'Continuous air monitors in the CPCB feed', unit: '', get: (p) => p.monitors_continuous_in_feed, source: 'CPCB real-time feed, 5 Nov 2026' },
  monitors_manual: { label: 'Manual air monitors', unit: '', get: (p) => p.monitors_manual_namp, source: 'CPCB NAMP station list, 19 Nov 2024' },
  monitors_planned: { label: 'Continuous monitors planned', unit: '', get: (p) => p.monitors_planned_jspcb, source: 'JSPCB tender, 6 Dec 2025' },
  n_mining_areas: osmCount('mining_areas', 'Mapped mining and quarry areas'),
  n_industrial_areas: osmCount('industrial_areas', 'Mapped industrial areas'),
  n_brick_kilns: osmCount('brick_kilns', 'Mapped brick kilns'),
  n_schools: osmCount('schools', 'Mapped schools and colleges'),
  n_hospitals: osmCount('hospitals', 'Mapped hospitals and clinics'),
  n_rail_stations: osmCount('rail_stations', 'Mapped railway stations'),
  n_peaks: osmCount('peaks', 'Mapped hill peaks'),
  n_substations: osmCount('substations', 'Mapped electricity substations'),
  n_towns: osmCount('towns', 'Mapped cities and towns'),
  n_villages: osmCount('villages', 'Mapped villages'),
}

export function formatValue(f: FactField, v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return 'NA'
  const d = FIELD_DEFS[f]
  const s = new Intl.NumberFormat('en-IN', { maximumFractionDigits: d.decimals ?? 0 }).format(v)
  return `${s}${d.unit}`
}

export interface FactRow { field: FactField; label: string; value: string; source: string; note?: string }

/** The rows for one district. Unknown district: null. */
export function factsFor(doc: ProfilesDoc, district: string, fields: FactField[]): FactRow[] | null {
  const p = doc.districts[district]
  if (!p) return null
  return fields.map((field) => {
    const d = FIELD_DEFS[field]
    return {
      field, label: d.label, value: formatValue(field, d.get(p)), source: d.source,
      note: field === 'area' ? p.area_note ?? undefined : undefined,
    }
  })
}

export interface RankRow { district: string; value: number; text: string }

/** All districts ranked by a field; districts without a value (NA) are left out. */
export function rankDistricts(doc: ProfilesDoc, field: FactField, order: 'desc' | 'asc', limit: number): RankRow[] {
  const d = FIELD_DEFS[field]
  const rows: RankRow[] = []
  for (const [district, p] of Object.entries(doc.districts)) {
    const v = d.get(p)
    if (v != null && !Number.isNaN(v)) rows.push({ district, value: v, text: formatValue(field, v) })
  }
  rows.sort((a, b) => (order === 'desc' ? b.value - a.value : a.value - b.value) || a.district.localeCompare(b.district))
  return rows.slice(0, Math.max(1, Math.min(limit, 10)))
}

/** Which of the checked sources a ranking draws on (for the card footer). */
export function fieldSource(field: FactField): string {
  return FIELD_DEFS[field].source
}

