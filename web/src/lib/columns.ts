/**
 * 3D columns for coal mines, coal power plants and large dams. Pure: no MapLibre.
 *
 * Height is proportional to one published figure per layer, never to a made-up score:
 *   coal mine   capacity (million tonnes a year, Global Energy Monitor)   1 Mt a year = 1 km
 *   coal plant  operating capacity (MW, Global Energy Monitor)            1 MW = 8 m
 *   large dam   dam height (m, National Register of Large Dams)           1 m = 150 m (exaggerated)
 * A feature without that figure gets no column (it keeps its flat symbol); nothing is filled in.
 * The three scales are different on purpose and are written in the legend: columns of different layers are not comparable.
 * Each feature is drawn twice: a wide column for the state view and a narrow one from zoom 8.5, because a column a few
 * hundred metres wide is smaller than a pixel when the whole state is on screen.
 */
import type { Feature, FeatureCollection, Polygon } from 'geojson'

export type ColumnKind = 'mines' | 'plants' | 'dams'

export const COLUMN_SCALE: Record<ColumnKind, { metresPer: number; unit: string; label: string }> = {
  mines: { metresPer: 1000, unit: 'Mt a year', label: 'Coal mine: column height = capacity (1 Mt a year = 1 km)' },
  plants: { metresPer: 8, unit: 'MW', label: 'Coal plant: column height = operating capacity (1 MW = 8 m)' },
  dams: { metresPer: 150, unit: 'm', label: 'Large dam: column height = dam height (shown 150 times taller than real)' },
}

export const COLUMN_RADIUS_M = { far: 2500, near: 800 } as const
export const COLUMN_NEAR_FROM_ZOOM = 8.5

type Props = Record<string, unknown>

/** The published figure a column is drawn from, or null when the feature has none (then it has no column). */
export function columnFigure(kind: ColumnKind, p: Props): number | null {
  const v = kind === 'mines' ? p.capacity_mtpa : kind === 'plants' ? p.operating_mw : p.height_m
  const n = typeof v === 'number' ? v : v == null || v === '' ? NaN : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function columnHeightM(kind: ColumnKind, p: Props): number | null {
  const f = columnFigure(kind, p)
  return f == null ? null : Math.round(f * COLUMN_SCALE[kind].metresPer)
}

/** A regular polygon around a point, `rM` metres from the centre. */
export function circlePolygon(lng: number, lat: number, rM: number, n = 14): number[][] {
  const ring: number[][] = []
  const dLat = rM / 110540
  const dLng = rM / (111320 * Math.cos((lat * Math.PI) / 180))
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI
    ring.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)])
  }
  ring.push(ring[0])
  return ring
}

/** Column polygons (a wide and a narrow one per feature) for the points that have a figure. */
export function buildColumns(kind: ColumnKind, points: FeatureCollection): FeatureCollection<Polygon> {
  const features: Feature<Polygon>[] = []
  for (const f of points.features) {
    if (f.geometry?.type !== 'Point') continue
    const props = (f.properties ?? {}) as Props
    const h = columnHeightM(kind, props)
    if (h == null) continue
    const [lng, lat] = f.geometry.coordinates
    for (const tier of ['far', 'near'] as const) {
      features.push({
        type: 'Feature',
        properties: { ...props, h, tier },
        geometry: { type: 'Polygon', coordinates: [circlePolygon(lng, lat, COLUMN_RADIUS_M[tier])] },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}
