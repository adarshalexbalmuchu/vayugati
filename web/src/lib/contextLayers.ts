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
    note: 'Hill shading from the MapTiler elevation model (about 30 m grid, a surface model that includes tree tops), with contour lines every 10 to 100 m (from zoom 9).' },
  { key: 'protected', label: 'Protected areas', on: true,
    note: 'The 11 wildlife sanctuaries and the national park of Jharkhand, from the India-WRIS list (Central Water Commission, Ministry of Jal Shakti), with notification year and notified area. Outlines are approximate and can differ from the notified area; click one to compare.' },
  { key: 'majorrivers', label: 'Major rivers (India-WRIS)', on: true,
    note: 'The main rivers India-WRIS (Central Water Commission, Ministry of Jal Shakti) maps in Jharkhand, with the basin each belongs to. Smaller streams are in the OpenStreetMap layer below.' },
  { key: 'basins', label: 'River basins and sub-basins', on: true,
    note: 'Basins and sub-basins of the Central Water Commission, from India-WRIS: the river system each area drains into.' },
  { key: 'water', label: 'Streams, canals and lakes (mapped)', on: false,
    note: 'Rivers, streams, canals, lakes and reservoirs drawn in OpenStreetMap (3 Nov 2026). Volunteer-mapped, so incomplete; most lines have no name.' },
  { key: 'canals', label: 'Canals (India-WRIS)', on: false,
    note: 'Irrigation and other canals of the water-resource projects recorded in India-WRIS (Central Water Commission), with canal type and project name.' },
  { key: 'groundwater', label: 'Ground water by block (CGWB 2020)', on: false,
    note: 'Ground water status of each block in the Central Ground Water Board assessment of 2020 (Dynamic Ground Water Resources), via India-WRIS: safe, semi-critical, critical or over-exploited, by how much of the yearly replenishable water is drawn. Click a block for the figures.' },
  { key: 'monitors', label: 'Water monitoring stations', on: false,
    note: 'Ground water level, water quality, rainfall and reservoir stations listed in India-WRIS (CGWB, CWC, CPCB, the state and DVC). Sites only; readings are on India-WRIS.' },
  { key: 'aquifers', label: 'Major aquifers (CGWB)', on: false,
    note: 'The main aquifer rock types of Jharkhand (sandstone, gneiss, alluvium and others) from the Central Ground Water Board aquifer map, via India-WRIS. A generalised map, not a well-level survey.' },
  { key: 'dams', label: 'Large dams', on: false,
    note: 'Large dams in the National Register of Large Dams (Central Water Commission), via India-WRIS: height, year, reservoir size, purpose and owner. Smaller dams are not in the register.' },
  { key: 'places', label: 'Towns and villages (Census 2011)', on: true,
    note: 'The 229 towns and 32,073 villages of the Census of India 2011, with population, households and area, as published in India-WRIS (Ministry of Jal Shakti). Villages appear from zoom 10. Points are village centres and approximate.' },
  { key: 'railways', label: 'Railways and stations', on: false,
    note: 'Railway lines, coal sidings and stations from OpenStreetMap (3 Nov 2026).' },
  { key: 'roads', label: 'Main roads', on: false,
    note: 'Main roads from OpenStreetMap (trunk, primary and secondary; 3 Nov 2026).' },
  { key: 'power', label: 'Power lines and substations', on: false,
    note: 'Transmission lines and substations from OpenStreetMap (3 Nov 2026).' },
  { key: 'coalmines', label: 'Coal mines (Global Energy Monitor)', on: false,
    note: '91 of the 151 Jharkhand coal mines in Global Energy Monitor\u2019s Global Coal Mine Tracker (August 2026 release, CC BY 4.0): owner, status, capacity and output. Only mines the tracker places exactly are drawn; the 60 it places only approximately are left out, and 2 rows with coordinates outside the state were dropped. It lists mines of 1 million tonnes a year or more and some smaller ones, so it is not a complete list. Mine boundaries are shown where the tracker has them.' },
  { key: 'coalplants', label: 'Coal power plants (Global Energy Monitor)', on: false,
    note: 'The 15 coal-fired power plants of Jharkhand in Global Energy Monitor\u2019s Global Coal Plant Tracker (July 2026 release, CC BY 4.0), with owner, unit capacities and start years. Includes captive plants of steel and other works.' },
  { key: 'industry', label: 'Power plants and large works (checked)', on: false,
    note: 'Power plants and large works whose names and operators were checked by Vayu Gati (Nov 2026); positions from OpenStreetMap, capacity from the Central Electricity Authority list via the WRI Global Power Plant Database (2019-20 data, so it can lag).' },
  { key: 'fires', label: 'Satellite heat detections', on: false,
    note: 'NASA FIRMS VIIRS detections over Jharkhand and its border areas, last 5 days. Each dot is a 375 m pixel that read unusually hot: a surface coal fire, industrial heat or open burning. Not a measured fire area.' },
  { key: 'seismic', label: 'Earthquake zones', on: false,
    note: 'The seismic zones of India (II lowest to V highest) as published in India-WRIS. Jharkhand lies in zones II to IV.' },
  { key: 'blocks', label: 'Blocks (CD blocks)', on: false,
    note: 'The 260 community development blocks, as mapped in India-WRIS (Survey of India / NWIC). Click a block for its district and ground water status.' },
  { key: 'constituencies', label: 'Assembly constituencies', on: false,
    note: 'The 81 assembly constituencies of Jharkhand, as published in India-WRIS.' },
  { key: 'landmarks', label: 'Peaks and waterfalls', on: false,
    note: 'Hill peaks (with height where mapped) and waterfalls from OpenStreetMap.' },
] as const satisfies readonly ContextLayerDef[]

export type CityContextLayerKey = (typeof CONTEXT_LAYER_DEFS)[number]['key']
export type CityContextVisibility = Record<CityContextLayerKey, boolean>

/** Default visibility (the Command overview uses it as is). */
export const DEFAULT_CONTEXT_VISIBLE = Object.fromEntries(
  CONTEXT_LAYER_DEFS.map((d) => [d.key, d.on]),
) as CityContextVisibility

/** Satellite imagery, land cover and night lights are full-map pictures that cover each other, so only one of them
 *  can be seen at a time. The one just switched on wins; the others in the same change are switched off. */
export const BASE_IMAGES = ['satellite', 'landcover', 'nightlights'] as const satisfies readonly CityContextLayerKey[]
export function normalizeBaseImages(
  patch: Partial<CityContextVisibility>,
  current: Partial<CityContextVisibility>,
): Partial<CityContextVisibility> {
  const on = BASE_IMAGES.filter((k) => patch[k] === true)
  if (!on.length) return patch
  // If a patch turns several on at once (e.g. "Defaults"), keep the first in the list that is already on, else the first.
  const keep = on.length === 1 ? on[0] : (on.find((k) => current[k]) ?? on[0])
  const next: Partial<CityContextVisibility> = { ...patch }
  for (const k of BASE_IMAGES) if (k !== keep) next[k] = false
  return next
}

/** The layer panel's key for a context layer. */
export type ContextPanelKey = `ctx_${CityContextLayerKey}`
export const ctxPanelKey = (k: CityContextLayerKey): ContextPanelKey => `ctx_${k}`
export const CONTEXT_PANEL_KEYS: ContextPanelKey[] = CONTEXT_LAYER_DEFS.map((d) => ctxPanelKey(d.key))
export function isContextPanelKey(k: string): k is ContextPanelKey {
  return k.startsWith('ctx_')
}

/** Themes for the on-map layer control, and a colour swatch per layer. */
export const CONTEXT_GROUPS: { label: string; keys: CityContextLayerKey[] }[] = [
  { label: 'Boundaries', keys: ['districts', 'blocks', 'constituencies'] },
  { label: 'Imagery and terrain', keys: ['satellite', 'relief', 'landcover', 'nightlights'] },
  { label: 'Nature', keys: ['protected', 'landmarks'] },
  { label: 'Rivers and water', keys: ['majorrivers', 'basins', 'water', 'canals', 'dams', 'groundwater', 'aquifers', 'monitors'] },
  { label: 'Hazards', keys: ['seismic'] },
  { label: 'People', keys: ['places'] },
  { label: 'Transport and energy', keys: ['railways', 'roads', 'power'] },
  { label: 'Industry and fires', keys: ['coalmines', 'coalplants', 'industry', 'fires'] },
]

export const CONTEXT_SWATCH: Record<CityContextLayerKey, string> = {
  districts: '#2E2219', satellite: '#4A5D3A', relief: '#A9814F', landcover: '#006400',
  nightlights: '#E9B949', protected: '#1B5E20', water: '#3B82C4', landmarks: '#6D4C41',
  majorrivers: '#1D6FB8', basins: '#5B7FA6', dams: '#0B3C7D',
  canals: '#4FA3D9', coalmines: '#212121', coalplants: '#B23A48', aquifers: '#8FB8A8', seismic: '#F08A4B', groundwater: '#E8B93C', monitors: '#00796B', blocks: '#7A7A7A', constituencies: '#7E57C2',
  places: '#5B4A3A', railways: '#2B2B2B', roads: '#C0392B',
  power: '#8E44AD', industry: '#9B6BD1', fires: '#E4572E',
}

/** Who the data of each layer comes from, short, for the strip along the bottom of the map. Only layers that are on are
 *  listed, each source once. The full notes (with dates) are in CONTEXT_LAYER_DEFS and in the popups. */
export const CONTEXT_SOURCES: Record<CityContextLayerKey, string[]> = {
  districts: ['Datameet / Census 2011', 'OpenStreetMap contributors (ODbL)', 'geoBoundaries (CC BY 4.0)'],
  landcover: ['© ESA WorldCover 2021 (CC BY 4.0)'],
  nightlights: ['NASA Black Marble (GIBS)'],
  satellite: ['© MapTiler'],
  relief: ['© MapTiler', 'Copernicus DEM'],
  protected: ['India-WRIS'],
  majorrivers: ['India-WRIS'],
  basins: ['India-WRIS'],
  water: ['OpenStreetMap contributors (ODbL)'],
  canals: ['India-WRIS'],
  groundwater: ['CGWB', 'India-WRIS'],
  monitors: ['India-WRIS'],
  aquifers: ['CGWB', 'India-WRIS'],
  dams: ['CWC', 'India-WRIS'],
  places: ['Census of India 2011', 'India-WRIS'],
  railways: ['OpenStreetMap contributors (ODbL)'],
  roads: ['OpenStreetMap contributors (ODbL)'],
  power: ['OpenStreetMap contributors (ODbL)'],
  coalmines: ['Global Energy Monitor (CC BY 4.0)'],
  coalplants: ['Global Energy Monitor (CC BY 4.0)'],
  industry: ['OpenStreetMap contributors (ODbL)', 'WRI Global Power Plant Database (CC BY 4.0)'],
  fires: ['NASA FIRMS (VIIRS)'],
  seismic: ['India-WRIS'],
  blocks: ['India-WRIS'],
  constituencies: ['India-WRIS'],
  landmarks: ['OpenStreetMap contributors (ODbL)'],
}

/** Sources of the district profile (shown while a district is open). */
export const DISTRICT_PROFILE_SOURCES = ['Census of India 2011', 'FSI India State of Forest Report 2023', 'Copernicus DEM', 'ERA5 (Copernicus C3S)', 'ESA WorldCover 2021', 'CGWB 2020']

/** The sources of the layers that are on, each once, in layer order. */
export function activeSources(v: Partial<CityContextVisibility>): string[] {
  const seen = new Set<string>()
  for (const d of CONTEXT_LAYER_DEFS) {
    if (!v[d.key as CityContextLayerKey]) continue
    for (const s of CONTEXT_SOURCES[d.key as CityContextLayerKey]) seen.add(s)
  }
  return [...seen]
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
  protected: [{ shape: 'dash', color: '#1B5E20', label: 'Protected area (national park, sanctuary)' }],
  water: [
    { shape: 'area', color: '#3B82C4', label: 'Lake or reservoir (mapped)' },
    { shape: 'line', color: '#3B82C4', label: 'River, stream or canal (mapped)' },
  ],
  majorrivers: [{ shape: 'line', color: '#1D6FB8', label: 'Major river' }],
  basins: [{ shape: 'dash', color: '#5B7FA6', label: 'River basin or sub-basin boundary' }],
  dams: [{ shape: 'dot', color: '#0B3C7D', label: 'Large dam' }],
  places: [
    { shape: 'ring', color: '#2E2219', label: 'City or town (Census 2011)' },
    { shape: 'dot', color: '#5B4A3A', label: 'Village (Census 2011)' },
  ],
  canals: [{ shape: 'line', color: '#4FA3D9', label: 'Canal' }],
  coalplants: [{ shape: 'dot', color: '#B23A48', label: 'Coal power plant (GEM)' }],
  coalmines: [
    { shape: 'dot', color: '#212121', label: 'Coal mine: operating' },
    { shape: 'dot', color: '#F9A825', label: 'Coal mine: proposed' },
    { shape: 'dot', color: '#8E8E8E', label: 'Coal mine: mothballed or shelved' },
    { shape: 'dot', color: '#C62828', label: 'Coal mine: closed' },
    { shape: 'area', color: '#212121', label: 'Coal mine boundary (GEM)' },
  ],
  seismic: [
    { shape: 'area', color: '#FFE9A8', label: 'Zone II (low)' },
    { shape: 'area', color: '#F9C46B', label: 'Zone III (moderate)' },
    { shape: 'area', color: '#F08A4B', label: 'Zone IV (severe)' },
  ],
  aquifers: [
    { shape: 'area', color: '#E8B77A', label: 'Sandstone' },
    { shape: 'area', color: '#F2E08A', label: 'Alluvium' },
    { shape: 'area', color: '#9CC5A1', label: 'Gneiss and basement complex' },
    { shape: 'area', color: '#7FB69E', label: 'Schist' },
    { shape: 'area', color: '#6C7A89', label: 'Basalt' },
    { shape: 'area', color: '#8EC9E8', label: 'Limestone' },
    { shape: 'area', color: '#D98C5F', label: 'Laterite' },
    { shape: 'area', color: '#B8A9C9', label: 'Other (granite, intrusive, quartzite, charnockite)' },
  ],
  groundwater: [
    { shape: 'area', color: '#7CC576', label: 'Block: safe' },
    { shape: 'area', color: '#F2D45C', label: 'Block: semi-critical' },
    { shape: 'area', color: '#F29B4B', label: 'Block: critical' },
    { shape: 'area', color: '#D9534F', label: 'Block: over-exploited' },
  ],
  monitors: [
    { shape: 'dot', color: '#00796B', label: 'Ground water level station' },
    { shape: 'dot', color: '#C2185B', label: 'Water quality station' },
    { shape: 'dot', color: '#0277BD', label: 'Rainfall station' },
    { shape: 'dot', color: '#283593', label: 'Reservoir station' },
  ],
  blocks: [{ shape: 'dash', color: '#7A7A7A', label: 'Block boundary' }],
  constituencies: [{ shape: 'dash', color: '#7E57C2', label: 'Assembly constituency boundary' }],
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
  industry: [
    { shape: 'dot', color: '#FFBF00', label: 'Power plant or large works (checked)' },
  ],
  fires: [{ shape: 'dot', color: '#E4572E', label: 'Satellite heat detection' }],
  landmarks: [
    { shape: 'dot', color: '#6D4C41', label: 'Hill peak' },
    { shape: 'dot', color: '#0288D1', label: 'Waterfall' },
  ],
}
