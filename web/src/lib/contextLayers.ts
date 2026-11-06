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
    note: 'Jharkhand and its 24 districts. Outlines combine three open datasets (Datameet / Census 2011, OpenStreetMap, geoBoundaries), chosen per district to match official areas and 42 towns of known district (0.9% mean difference, 4.1% at most). Not Survey of India’s own file. Click a district, or pick one, to see it in 3D with its profile.' },
  { key: 'landcover', label: 'Land cover (ESA WorldCover 2021)', on: true,
    note: 'Satellite-mapped land cover at 10 m by the European Space Agency (2021), shown at about 150 m: tree cover, cropland, built-up, bare ground and mines, water.' },
  { key: 'nightlights', label: 'Night lights (NASA Black Marble 2016)', on: false,
    note: 'Lights at night from NASA’s VIIRS satellite, 2016 composite (the latest global one NASA serves as map tiles). Towns, mines and industry glow.' },
  { key: 'satellite', label: 'Satellite imagery', on: false, note: 'MapTiler satellite imagery.' },
  { key: 'relief', label: 'Shaded relief and contours', on: false,
    note: 'Hill shading from the MapTiler elevation model, with contour lines every 10 to 100 m (from zoom 9).' },
  { key: 'forest', label: 'Forest areas (mapped)', on: false,
    note: 'Forest and woodland drawn in OpenStreetMap (data as of 3 Nov 2026), areas over 0.5 km². Official forest cover per district is in the district profile (ISFR 2023).' },
  { key: 'protected', label: 'Protected areas', on: true,
    note: 'The 11 wildlife sanctuaries and the national park of Jharkhand, from the India-WRIS list (Central Water Commission, Ministry of Jal Shakti), with notification year and notified area. Outlines are approximate and can differ from the notified area; click one to compare.' },
  { key: 'majorrivers', label: 'Major rivers (India-WRIS)', on: true,
    note: 'The main rivers India-WRIS (Central Water Commission, Ministry of Jal Shakti) maps in Jharkhand, with the basin each belongs to. Smaller streams are in the OpenStreetMap layer below.' },
  { key: 'basins', label: 'River basins and sub-basins', on: true,
    note: 'Basins and sub-basins of the Central Water Commission, from India-WRIS: the river system each area drains into.' },
  { key: 'water', label: 'Streams, canals and lakes (mapped)', on: false,
    note: 'Rivers, streams, canals, lakes and reservoirs drawn in OpenStreetMap (3 Nov 2026). Volunteer-mapped, so incomplete; most lines have no name.' },
  { key: 'dams', label: 'Large dams', on: false,
    note: 'Large dams in the National Register of Large Dams (Central Water Commission), via India-WRIS: height, year, reservoir size, purpose and owner. Smaller dams are not in the register.' },
  { key: 'places', label: 'Towns and villages', on: true,
    note: 'Cities, towns and villages with a name in OpenStreetMap (3 Nov 2026). Villages appear from zoom 10.' },
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
  { key: 'fires', label: 'Satellite heat detections', on: false,
    note: 'NASA FIRMS VIIRS detections over Jharkhand and its border areas, last 5 days. Each dot is a 375 m pixel that read unusually hot: a surface coal fire, industrial heat or open burning. Not a measured fire area.' },
  { key: 'landmarks', label: 'Peaks and waterfalls', on: false,
    note: 'Hill peaks (with height where mapped) and waterfalls from OpenStreetMap.' },
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
  { label: 'Boundaries', keys: ['districts'] },
  { label: 'Imagery and terrain', keys: ['satellite', 'relief', 'landcover', 'nightlights'] },
  { label: 'Nature', keys: ['forest', 'protected', 'landmarks'] },
  { label: 'Rivers and water', keys: ['majorrivers', 'basins', 'water', 'dams'] },
  { label: 'People', keys: ['places', 'builtup', 'facilities'] },
  { label: 'Transport and energy', keys: ['railways', 'roads', 'power'] },
  { label: 'Industry and fires', keys: ['mines', 'industry', 'kilns', 'fires'] },
]

export const CONTEXT_SWATCH: Record<CityContextLayerKey, string> = {
  districts: '#2E2219', satellite: '#4A5D3A', relief: '#A9814F', landcover: '#006400',
  nightlights: '#E9B949', forest: '#2F7D3A', protected: '#1B5E20', water: '#3B82C4', landmarks: '#6D4C41',
  majorrivers: '#1D6FB8', basins: '#5B7FA6', dams: '#0B3C7D',
  places: '#5B4A3A', builtup: '#C8663E', facilities: '#D62D20', railways: '#2B2B2B', roads: '#C0392B',
  power: '#8E44AD', mines: '#3D3D3D', industry: '#9B6BD1', kilns: '#A0522D', fires: '#E4572E',
}

/** What a layer's symbols mean on the map. Colours match the renderer (CityContextLayers.tsx). */
export interface LegendSymbol {
  shape: 'area' | 'line' | 'dash' | 'dot' | 'ring' | 'ramp'
  color: string
  label: string
}

export const CONTEXT_LEGEND: Record<CityContextLayerKey, LegendSymbol[]> = {
  districts: [{ shape: 'line', color: '#2E2219', label: 'State and district outline' }],
  landcover: [], // the land-cover colour key is shown from its own metadata (landcover_2021.json)
  nightlights: [{ shape: 'ramp', color: 'linear-gradient(90deg,#0b0b12,#f5d76e,#ffffff)', label: 'Lights at night: dark to bright' }],
  satellite: [],
  relief: [{ shape: 'line', color: '#6B4F2E', label: 'Contour line (10 to 100 m)' }],
  forest: [{ shape: 'area', color: '#2F7D3A', label: 'Forest or woodland' }],
  protected: [{ shape: 'dash', color: '#1B5E20', label: 'Protected area (national park, sanctuary)' }],
  water: [
    { shape: 'area', color: '#3B82C4', label: 'Lake or reservoir (mapped)' },
    { shape: 'line', color: '#3B82C4', label: 'River, stream or canal (mapped)' },
  ],
  majorrivers: [{ shape: 'line', color: '#1D6FB8', label: 'Major river' }],
  basins: [{ shape: 'dash', color: '#5B7FA6', label: 'River basin or sub-basin boundary' }],
  dams: [{ shape: 'dot', color: '#0B3C7D', label: 'Large dam' }],
  places: [
    { shape: 'ring', color: '#2E2219', label: 'City or town' },
    { shape: 'dot', color: '#5B4A3A', label: 'Village' },
  ],
  builtup: [{ shape: 'area', color: '#C8663E', label: 'Built-up area (mapped)' }],
  facilities: [
    { shape: 'dot', color: '#1E88E5', label: 'School or college' },
    { shape: 'dot', color: '#D62D20', label: 'Hospital or clinic' },
  ],
  railways: [
    { shape: 'line', color: '#2B2B2B', label: 'Railway line' },
    { shape: 'line', color: '#7A4E2D', label: 'Siding or yard' },
    { shape: 'dot', color: '#2B2B2B', label: 'Station' },
  ],
  roads: [{ shape: 'line', color: '#C0392B', label: 'Main road' }],
  power: [
    { shape: 'line', color: '#8E44AD', label: 'Power line' },
    { shape: 'dot', color: '#8E44AD', label: 'Substation' },
  ],
  mines: [{ shape: 'area', color: '#3D3D3D', label: 'Mining or quarry area (mapped)' }],
  industry: [
    { shape: 'area', color: '#9B6BD1', label: 'Industrial land (mapped)' },
    { shape: 'dot', color: '#FFBF00', label: 'Power plant or large works (checked)' },
  ],
  kilns: [{ shape: 'dot', color: '#A0522D', label: 'Brick kiln (mapped)' }],
  fires: [{ shape: 'dot', color: '#E4572E', label: 'Satellite heat detection' }],
  landmarks: [
    { shape: 'dot', color: '#6D4C41', label: 'Hill peak' },
    { shape: 'dot', color: '#0288D1', label: 'Waterfall' },
  ],
}
