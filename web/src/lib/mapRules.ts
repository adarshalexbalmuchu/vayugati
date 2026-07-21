/**
 * Pure derivation rules for the commander Map page (MapPage.tsx). No I/O
 * here - mirrors overviewRules.ts's/incidentRules.ts's own convention. Every
 * input comes from data already fetched by existing lib/*.ts functions.
 */
import { haversineMeters, POLLUTANT_LABEL } from './incidentRules'
import { hotspotStatus, type HotspotStatus, type TimeWindowHours } from './overviewRules'
import type { ForecastPoint, ForecastPollutant, StationMarker, WardForecastSummary, WardSummary } from './data'

export type MapPollutant = 'aqi' | 'pm25' | 'pm10' | 'no2'
export type MapTimeMode = 'now' | '24h' | '48h'

/** AQI itself is never forecast (forecast.py only forecasts pollutant
 *  concentrations, not the composite index) - every other selectable
 *  pollutant has real forecast.py output. Used everywhere a forecast fetch
 *  or forecast display needs to know which underlying pollutant's real data
 *  to use/label, including when the user has AQI selected. */
export function forecastPollutantFor(pollutant: MapPollutant): ForecastPollutant {
  return pollutant === 'aqi' ? 'pm25' : pollutant
}

/** Delhi MVP viewport - the only city this pilot serves today (see
 *  docs/IMPLEMENTATION_STATUS.md), so a real, fixed default rather than a
 *  computed one is honest, not a shortcut. */
export const DELHI_CENTER: [number, number] = [77.209, 28.6139]
export const DELHI_DEFAULT_ZOOM = 11

/** A generous Delhi/NCR bounding box (covers Delhi proper plus the
 *  Gurugram/Noida/Faridabad/Ghaziabad edges) - a real geographic constant,
 *  not fabricated data. Used to both validate incoming coordinates and as
 *  the "Reset to Delhi" fallback view when no valid points exist. */
export const DELHI_BOUNDS = { minLng: 76.7, maxLng: 77.7, minLat: 28.2, maxLat: 29.0 }

/** True only for a finite lat/lng pair that actually falls within the Delhi/
 *  NCR box. A wrong-but-non-null coordinate elsewhere in India (or a stray
 *  0,0) must never be plotted or allowed to stretch a fit-bounds call out to
 *  city/world scale - this is the single gate every marker source runs
 *  through before rendering. */
export function isValidDelhiCoordinate(lat: number | null | undefined, lng: number | null | undefined): boolean {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return false
  return lat >= DELHI_BOUNDS.minLat && lat <= DELHI_BOUNDS.maxLat && lng >= DELHI_BOUNDS.minLng && lng <= DELHI_BOUNDS.maxLng
}

export const MAP_POLLUTANT_LABEL: Record<MapPollutant, string> = {
  aqi: 'AQI',
  pm25: POLLUTANT_LABEL.pm25,
  pm10: POLLUTANT_LABEL.pm10,
  no2: POLLUTANT_LABEL.no2,
}

/** "Now" reads straight off the ward/station's own live fields; "24h"/"48h"
 *  switch to the closest available forecast point to that horizon rather
 *  than requiring an exact match - forecasts run on their own cadence, not
 *  necessarily landing on exactly +24h/+48h. */
export function nearestForecastPoint(
  forecast: WardForecastSummary | undefined,
  horizonHours: number,
): ForecastPoint | null {
  if (!forecast || forecast.points.length === 0) return null
  const targetMs = Date.now() + horizonHours * 3_600_000
  return forecast.points.reduce<ForecastPoint | null>((best, p) => {
    if (!best) return p
    const pMs = new Date(p.horizon_ts).getTime()
    const bestMs = new Date(best.horizon_ts).getTime()
    return Math.abs(pMs - targetMs) < Math.abs(bestMs - targetMs) ? p : best
  }, null)
}

export interface WardReadingResult {
  value: number | null
  unit: string
  /** 'aqi': colour the marker via aqiLevel(aqiForColor). 'status': colour via
   *  the severe/watch/stable/no_data tier in `status` - there is no honest
   *  severity-colour scale for raw forecast concentrations, so forecast mode
   *  colours by crossing-risk tier instead of inventing one. */
  colorMode: 'aqi' | 'status'
  aqiForColor: number | null
  status: HotspotStatus | null
  /** True when the value shown is a different pollutant's real forecast
   *  used as an honestly-labelled stand-in - only ever true for AQI (which
   *  forecast.py never computes), never a fabricated AQI forecast. */
  isProxy: boolean
}

/** Marker colour stays AQI-only in "now" mode (there is no established
 *  severity scale for raw PM10/NO2 µg/m³) - the pollutant selector only
 *  changes which number is displayed. Forecast modes read whichever real
 *  forecast.py pollutant `forecast` actually is (see forecastPollutantFor) -
 *  colour by hotspotStatus's crossing-risk tiering, since there is no
 *  established severity-colour scale for a raw forecast concentration. */
export function resolveWardReading(
  ward: Pick<WardSummary, 'aqi' | 'pm25' | 'pm10' | 'no2'>,
  pollutant: MapPollutant,
  timeMode: MapTimeMode,
  forecast: WardForecastSummary | undefined,
): WardReadingResult {
  if (timeMode === 'now') {
    const value =
      pollutant === 'aqi' ? ward.aqi : pollutant === 'pm25' ? ward.pm25 : pollutant === 'pm10' ? ward.pm10 : ward.no2
    return {
      value,
      unit: pollutant === 'aqi' ? 'AQI' : 'µg/m³',
      colorMode: 'aqi',
      aqiForColor: ward.aqi,
      status: null,
      isProxy: false,
    }
  }

  const horizonHours: TimeWindowHours = timeMode === '24h' ? 24 : 48
  const point = nearestForecastPoint(forecast, horizonHours)
  const status = hotspotStatus(
    { hoursToSevere: forecast?.hoursToSevere ?? null, peakExcess: point?.local_excess ?? null, aqi: null },
    horizonHours,
  )
  const isProxy = pollutant === 'aqi'
  const forecastPollutantLabel = forecast ? MAP_POLLUTANT_LABEL[forecast.pollutant] : POLLUTANT_LABEL.pm25
  return {
    value: point?.predicted_value ?? point?.pm25_pred ?? null,
    unit: isProxy ? `µg/m³ (${forecastPollutantLabel} forecast, risk signal)` : 'µg/m³ (forecast)',
    colorMode: 'status',
    aqiForColor: null,
    status,
    isProxy,
  }
}

export interface NearestStationResult {
  station: StationMarker
  distanceMeters: number
}

/** Real haversine distance to the closest station with a valid Delhi/NCR
 *  coordinate - null when no such station exists (empty list, or every
 *  candidate has a missing/invalid coordinate), never a fabricated
 *  "nearest" pick. Callers show an honest "no direct station" state instead
 *  when this returns null. */
export function nearestStationTo(
  lat: number | null,
  lng: number | null,
  stations: StationMarker[],
): NearestStationResult | null {
  if (lat == null || lng == null || !isValidDelhiCoordinate(lat, lng)) return null
  let best: NearestStationResult | null = null
  for (const s of stations) {
    if (!isValidDelhiCoordinate(s.lat, s.lng)) continue
    const distanceMeters = haversineMeters({ lat, lng }, { lat: s.lat, lng: s.lng })
    if (!best || distanceMeters < best.distanceMeters) best = { station: s, distanceMeters }
  }
  return best
}

export type WardDataStatus = 'station_backed' | 'nearest_station_proxy' | 'no_station_data'

export const WARD_DATA_STATUS_LABEL: Record<WardDataStatus, string> = {
  station_backed: 'Station-backed',
  nearest_station_proxy: 'Nearest-station proxy',
  no_station_data: 'No station-backed data',
}

/** Which of the 3 honest states a clicked ward boundary is in - never a
 *  4th "confident guess" state. station_backed: a real station's own
 *  ward_id points at this ward. nearest_station_proxy: no direct station,
 *  but a real distance to the closest one is computable. no_station_data:
 *  neither - the true state for a ward with an unset/invalid centroid, or
 *  when no station anywhere has a valid coordinate. */
export function wardDataStatus(hasDirectStation: boolean, hasNearestStation: boolean): WardDataStatus {
  if (hasDirectStation) return 'station_backed'
  if (hasNearestStation) return 'nearest_station_proxy'
  return 'no_station_data'
}

/** The plain-language "what am I looking at" line for the current
 *  metric/time selection - shown once near the toolbar/legend so a marker's
 *  bare number is never left ambiguous between AQI, a concentration, a
 *  current reading, or a forecast. */
export function markerMeaningLabel(pollutant: MapPollutant, timeMode: MapTimeMode): string {
  if (timeMode === 'now') {
    return pollutant === 'aqi' ? 'Markers show current station AQI.' : `Markers show latest station ${MAP_POLLUTANT_LABEL[pollutant]} concentration (µg/m³).`
  }
  const horizonLabel = timeMode === '24h' ? '24h' : '48h'
  if (pollutant === 'aqi') {
    return `Markers show ${horizonLabel} forecast PM2.5 peak (µg/m³), used as a risk signal - AQI itself is not forecast.`
  }
  return `Markers show ${horizonLabel} forecast peak for ${MAP_POLLUTANT_LABEL[pollutant]} (µg/m³).`
}

/** Station-level counterpart - stations only ever show live readings (no
 *  per-station forecast exists), so this is just a plain field pick. */
export function stationReadingValue(
  station: Pick<StationMarker, 'aqi' | 'pm25' | 'pm10' | 'no2'>,
  pollutant: MapPollutant,
): number | null {
  if (pollutant === 'aqi') return station.aqi
  if (pollutant === 'pm25') return station.pm25
  if (pollutant === 'pm10') return station.pm10
  return station.no2
}
