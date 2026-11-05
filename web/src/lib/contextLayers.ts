/**
 * The Jharkhand context layers: one definition shared by the layer panel
 * (MapLayerControl), the Map page and the map renderer (CityContextLayers).
 * Pure: no React, no MapLibre.
 *
 * Every note names its source and date. OpenStreetMap layers are
 * volunteer-mapped and incomplete, and say so.
 */

export interface ContextLayerDef {
  key: string
  label: string
  note: string
  /** On by default. */
  on: boolean
}

export const CONTEXT_LAYER_DEFS = [
  { key: 'districts', label: 'State and district outlines', on: true,
    note: 'Jharkhand and its 24 districts. Outlines from geoBoundaries (approximate, not Survey of India). Click a district, or pick one, to see it in 3D with its profile.' },
  { key: 'landcover', label: 'Land cover (ESA WorldCover 2021)', on: false,
    note: 'Satellite-mapped land cover at 10 m by the European Space Agency (2021), shown at about 150 m: tree cover, cropland, built-up, bare ground and mines, water.' },
  { key: 'nightlights', label: 'Night lights (NASA Black Marble 2016)', on: false,
    note: 'Lights at night from NASA’s VIIRS satellite, 2016 composite (the latest global one NASA serves as map tiles). Towns, mines and industry glow.' },
  { key: 'satellite', label: 'Satellite imagery', on: false, note: 'MapTiler satellite imagery.' },
  { key: 'relief', label: 'Shaded relief and contours', on: false,
    note: 'Hill shading from the MapTiler elevation model, with contour lines every 10 to 100 m (from zoom 9).' },
  { key: 'forest', label: 'Forest areas (mapped)', on: false,
    note: 'Forest and woodland drawn in OpenStreetMap (data as of 3 Nov 2026), areas over 0.5 km². Official forest cover per district is in the district profile (ISFR 2023).' },
  { key: 'protected', label: 'Protected areas', on: true,
    note: 'National park, wildlife sanctuaries and reserves as drawn in OpenStreetMap; boundaries are approximate, not the notified ones.' },
  { key: 'water', label: 'Rivers and water bodies', on: true,
    note: 'Rivers, canals, lakes and reservoirs from OpenStreetMap (3 Nov 2026).' },
  { key: 'places', label: 'Towns and villages', on: true,
    note: 'Cities, towns and villages with a name in OpenStreetMap (3 Nov 2026). Villages appear from zoom 10.' },
  { key: 'towngrid', label: 'Town grids (3 km, not wards)', on: false,
    note: 'A 3 km grid over 29 main towns, covering their built-up land (ESA WorldCover 2021). It is a Vayu Gati working grid, NOT ward or municipal boundaries: Jharkhand ward maps are not published as GIS. Dhanbad district has its own grid.' },
  { key: 'builtup', label: 'Built-up areas (mapped)', on: false,
    note: 'Residential areas drawn in OpenStreetMap, over 0.05 km². Incomplete; ESA land cover shows built-up land everywhere.' },
  { key: 'facilities', label: 'Schools and hospitals', on: false,
    note: 'Schools, colleges, hospitals and clinics in OpenStreetMap (3 Nov 2026), from zoom 10. Many are missing.' },
  { key: 'railways', label: 'Railways and stations', on: false,
    note: 'Railway lines, coal sidings and stations from OpenStreetMap (3 Nov 2026).' },
  { key: 'roads', label: 'Main roads', on: false,
    note: 'Main roads from OpenStreetMap (trunk, primary and secondary; 3 Nov 2026).' },
  { key: 'power', label: 'Power lines and substations', on: false,
    note: 'Transmission lines and substations from OpenStreetMap (3 Nov 2026).' },
  { key: 'mines', label: 'Mining and quarry areas', on: false,
    note: 'Mining and quarry areas drawn by OpenStreetMap volunteers (3 Nov 2026). Not official lease boundaries; many are missing (e.g. large parts of the North Karanpura coalfield).' },
  { key: 'industry', label: 'Industry and power plants', on: false,
    note: 'Industrial land from OpenStreetMap (purple). Yellow dots: power plants and large works whose names and operators were checked (Nov 2026).' },
  { key: 'kilns', label: 'Brick kilns', on: false,
    note: 'Brick kilns mapped in OpenStreetMap. Far from complete: most kilns are not mapped.' },
  { key: 'fires', label: 'Satellite heat detections', on: true,
    note: 'NASA FIRMS VIIRS detections over Jharkhand and its border areas, last 5 days. Each dot is a 375 m pixel that read unusually hot: a surface coal fire, industrial heat or open burning. Not a measured fire area.' },
  { key: 'landmarks', label: 'Peaks, waterfalls and dams', on: false,
    note: 'Hill peaks (with height where mapped), waterfalls and dams from OpenStreetMap.' },
] as const satisfies readonly ContextLayerDef[]

export type CityContextLayerKey = (typeof CONTEXT_LAYER_DEFS)[number]['key']
export type CityContextVisibility = Record<CityContextLayerKey, boolean>

/** Default visibility (the Command overview uses it as is). */
export const DEFAULT_CONTEXT_VISIBLE = Object.fromEntries(
  CONTEXT_LAYER_DEFS.map((d) => [d.key, d.on]),
) as CityContextVisibility

/** The layer panel's key for a context layer. */
export type ContextPanelKey = `ctx_${CityContextLayerKey}`
export const ctxPanelKey = (k: CityContextLayerKey): ContextPanelKey => `ctx_${k}`
export const CONTEXT_PANEL_KEYS: ContextPanelKey[] = CONTEXT_LAYER_DEFS.map((d) => ctxPanelKey(d.key))
export function isContextPanelKey(k: string): k is ContextPanelKey {
  return k.startsWith('ctx_')
}

/** Themes for the on-map layer control, and a colour swatch per layer. */
export const CONTEXT_GROUPS: { label: string; keys: CityContextLayerKey[] }[] = [
  { label: 'Boundaries', keys: ['districts', 'towngrid'] },
  { label: 'Imagery and terrain', keys: ['satellite', 'relief', 'landcover', 'nightlights'] },
  { label: 'Nature', keys: ['forest', 'protected', 'water', 'landmarks'] },
  { label: 'People', keys: ['places', 'builtup', 'facilities'] },
  { label: 'Transport and energy', keys: ['railways', 'roads', 'power'] },
  { label: 'Industry and fires', keys: ['mines', 'industry', 'kilns', 'fires'] },
]

export const CONTEXT_SWATCH: Record<CityContextLayerKey, string> = {
  districts: '#2E2219', towngrid: '#1F6F8B', satellite: '#4A5D3A', relief: '#A9814F', landcover: '#006400',
  nightlights: '#E9B949', forest: '#2F7D3A', protected: '#1B5E20', water: '#3B82C4', landmarks: '#6D4C41',
  places: '#5B4A3A', builtup: '#C8663E', facilities: '#D62D20', railways: '#2B2B2B', roads: '#C0392B',
  power: '#8E44AD', mines: '#3D3D3D', industry: '#9B6BD1', kilns: '#A0522D', fires: '#E4572E',
}
