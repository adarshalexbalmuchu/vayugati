/**
 * Pure derivation rules for the commander Map page (MapPage.tsx). No I/O
 * here - mirrors overviewRules.ts's/incidentRules.ts's own convention. Every
 * input comes from data already fetched by existing lib/*.ts functions.
 */
import { POLLUTANT_LABEL } from './incidentRules'
import { hotspotStatus, type HotspotStatus, type TimeWindowHours } from './overviewRules'
import type { ForecastPoint, StationMarker, WardForecastSummary, WardSummary } from './data'

export type MapPollutant = 'aqi' | 'pm25' | 'pm10' | 'no2'
export type MapTimeMode = 'now' | '24h' | '48h'

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
   *  severity-colour scale for raw forecast PM2.5 µg/m³, so forecast mode
   *  colours by crossing-risk tier instead of inventing one. */
  colorMode: 'aqi' | 'status'
  aqiForColor: number | null
  status: HotspotStatus | null
}

/** Marker colour stays AQI-only in "now" mode (there is no established
 *  severity scale for raw PM10/NO2 µg/m³) - the pollutant selector only
 *  changes which number is displayed. Forecast modes are PM2.5-only, per the
 *  forecast pipeline's own scope, and colour by hotspotStatus's tiering. */
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
    }
  }

  const horizonHours: TimeWindowHours = timeMode === '24h' ? 24 : 48
  const point = nearestForecastPoint(forecast, horizonHours)
  const status = hotspotStatus(
    { hoursToSevere: forecast?.hoursToSevere ?? null, peakExcess: point?.local_excess ?? null, aqi: null },
    horizonHours,
  )
  return {
    value: point?.pm25_pred ?? null,
    unit: 'µg/m³ (forecast)',
    colorMode: 'status',
    aqiForColor: null,
    status,
  }
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
