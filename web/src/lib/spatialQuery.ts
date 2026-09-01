import turfBooleanIntersects from '@turf/boolean-intersects'
import turfCircle from '@turf/circle'
import turfDistance from '@turf/distance'
import { feature as turfFeature, point as turfPoint } from '@turf/helpers'

export interface RadiusQueryWard {
  id: number
  name: string
  lat: number | null
  lng: number | null
}

export interface RadiusQueryStation {
  id: number
  name: string
  lat: number | null
  lng: number | null
}

export interface RadiusQueryIncident {
  id: number
  lat: number | null
  lng: number | null
  summary: string | null
}

export interface RadiusMatch {
  id: number
  label: string
}

export interface RadiusMatches {
  wards: RadiusMatch[]
  stations: RadiusMatch[]
  incidents: RadiusMatch[]
}

/**
 * Wards/stations/incidents within radiusKm of center. Points use exact
 * centroid distance; wards prefer true polygon `boolean-intersects` against
 * the real boundary geometry (any part of the ward overlapping the circle
 * counts, matching a real GIS "select by location" query), falling back to
 * centroid distance for the few wards with no captured boundary yet.
 *
 * Extracted from the manual Buffer tool's original inline computation
 * (MapPage.tsx) so the GeoAI `query` action shares the exact same spatial
 * engine rather than a second implementation that could silently drift.
 */
export function findWithinRadius(
  center: [number, number],
  radiusKm: number,
  data: {
    wards: RadiusQueryWard[]
    stations: RadiusQueryStation[]
    incidents: RadiusQueryIncident[]
    wardBoundaryByWardId: Map<number, GeoJSON.Polygon | GeoJSON.MultiPolygon>
  },
): RadiusMatches {
  const centerPt = turfPoint(center)
  const circle = turfCircle(center, radiusKm, { steps: 64, units: 'kilometers' })

  const withinPoint = (lat: number | null | undefined, lng: number | null | undefined) =>
    lat != null && lng != null && turfDistance(centerPt, turfPoint([lng, lat]), { units: 'kilometers' }) <= radiusKm

  const wardWithin = (w: RadiusQueryWard) => {
    const geometry = data.wardBoundaryByWardId.get(w.id)
    if (geometry) return turfBooleanIntersects(circle, turfFeature(geometry))
    return withinPoint(w.lat, w.lng)
  }

  return {
    wards: data.wards.filter(wardWithin).map((w) => ({ id: w.id, label: w.name })),
    stations: data.stations.filter((s) => withinPoint(s.lat, s.lng)).map((s) => ({ id: s.id, label: s.name })),
    incidents: data.incidents
      .filter((i) => withinPoint(i.lat, i.lng))
      .map((i) => ({ id: i.id, label: i.summary ?? `Incident #${i.id}` })),
  }
}

/** Numeric comparison for GeoAI query thresholds - the one piece of
 *  filtering logic no existing tool needed until now (the manual Buffer
 *  tool has no threshold, only radius). */
export function matchesThreshold(value: number | null | undefined, op: '>' | '>=' | '<' | '<=', threshold: number): boolean {
  if (value == null) return false
  switch (op) {
    case '>':
      return value > threshold
    case '>=':
      return value >= threshold
    case '<':
      return value < threshold
    case '<=':
      return value <= threshold
  }
}
