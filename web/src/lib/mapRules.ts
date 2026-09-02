/**
 * Pure derivation rules for the commander Map page (MapPage.tsx). No I/O
 * here - mirrors overviewRules.ts's/incidentRules.ts's own convention. Every
 * input comes from data already fetched by existing lib/*.ts functions.
 */
import { haversineMeters, POLLUTANT_LABEL } from './incidentRules'
import { hotspotStatus, type HotspotStatus, type TimeWindowHours } from './overviewRules'
import type { ForecastPoint, ForecastPollutant, StationMarker, WardForecastSummary, WardSummary } from './data'
import type { FreshnessClass } from './dataQualityRules'

export type MapPollutant = 'aqi' | 'pm25' | 'pm10' | 'no2'
export type MapTimeMode = 'now' | '1h' | '24h' | '48h'

/** Historical observation slot — 'now' means live readings; the others scrub
 *  backward through the readings table at the given offset.  Forecast time
 *  modes are disabled whenever obsSlot !== 'now'. */
export type ObsSlot = 'now' | '-3h' | '-6h' | '-12h' | '-24h'

export const OBS_SLOTS: ObsSlot[] = ['now', '-3h', '-6h', '-12h', '-24h']

export const OBS_SLOT_LABEL: Record<ObsSlot, string> = {
  'now': 'Now',
  '-3h': '−3h',
  '-6h': '−6h',
  '-12h': '−12h',
  '-24h': '−24h',
}

/** Hours to subtract from Date.now() to get the target timestamp; 'now' has no entry. */
export const OBS_SLOT_HOURS: Partial<Record<ObsSlot, number>> = {
  '-3h': 3,
  '-6h': 6,
  '-12h': 12,
  '-24h': 24,
}

/** Whether the user is viewing a historical snapshot or comparing it against Now. */
export type ObsViewMode = 'snapshot' | 'change'

/** Direction of AQI/pollutant change between two time points. */
export type ChangeDirection = 'strong_worsening' | 'worsening' | 'stable' | 'improving' | 'strong_improving'

export const CHANGE_DIRECTION_LABEL: Record<ChangeDirection, string> = {
  strong_worsening: 'Strong worsening',
  worsening: 'Worsening',
  stable: 'Stable',
  improving: 'Improving',
  strong_improving: 'Strong improvement',
}

export const CHANGE_DIRECTION_ARROW: Record<ChangeDirection, string> = {
  strong_worsening: '↑↑',
  worsening: '↑',
  stable: '→',
  improving: '↓',
  strong_improving: '↓↓',
}

export const CHANGE_DIRECTION_HEX: Record<ChangeDirection, string> = {
  strong_worsening: '#dc2626',
  worsening: '#f97316',
  stable: '#6b7280',
  improving: '#22c55e',
  strong_improving: '#16a34a',
}

/** |Δ| ≤ this → 'stable' (per pollutant). */
export const CHANGE_STABLE_THRESHOLD: Record<MapPollutant, number> = {
  aqi: 10,
  pm25: 5,
  pm10: 5,
  no2: 5,
}

/** |Δ| between stable and this → 'worsening'/'improving'; above → 'strong_*'. */
export const CHANGE_MODERATE_THRESHOLD: Record<MapPollutant, number> = {
  aqi: 30,
  pm25: 15,
  pm10: 15,
  no2: 15,
}

export function classifyChangeDirection(delta: number, pollutant: MapPollutant): ChangeDirection {
  const abs = Math.abs(delta)
  if (abs <= CHANGE_STABLE_THRESHOLD[pollutant]) return 'stable'
  const isWorsening = delta > 0
  const isStrong = abs > CHANGE_MODERATE_THRESHOLD[pollutant]
  if (isWorsening) return isStrong ? 'strong_worsening' : 'worsening'
  return isStrong ? 'strong_improving' : 'improving'
}

/** Short badge string for a map marker in Change mode, e.g. "↑ +42" or "—". */
export function changeMarkerBadge(delta: number | null, direction: ChangeDirection | null): string {
  if (delta == null || direction == null) return '—'
  const arrow = CHANGE_DIRECTION_ARROW[direction]
  const sign = delta > 0 ? '+' : ''
  return `${arrow}${sign}${Math.round(delta)}`
}

/** Max gap (ms) between a requested historical slot and the actual reading row
 *  that is accepted as "within tolerance". Readings older than this relative
 *  to the target time are excluded so a 5h-old row never stands in for a −3h slot. */
export const HISTORICAL_TOLERANCE_MS = 2 * 3_600_000

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
export const DELHI_DEFAULT_ZOOM = 10

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
  /** Ward-level nowcasting (+1h) only - null in every other timeMode.
   *  Anchor provenance is a nowcast-specific concept: at 24h/48h the model
   *  has long since stopped leaning on the anchor reading, so a freshness
   *  label there would be noise, not signal. */
  anchorFreshness: FreshnessClass | null
  anchorObservedAt: string | null
}

// Kept in sync with FRESH_THRESHOLD_MINUTES / DELAYED_STALE_BOUNDARY_MINUTES
// in dataQualityRules.ts (duplicated, not imported - that module already
// imports from mapRules.ts, so importing the values back would be circular;
// only the FreshnessClass TYPE is imported above, which is safe - import
// type is erased at compile time and never creates a runtime circularity).
const ANCHOR_FRESH_THRESHOLD_MINUTES = 60
const ANCHOR_DELAYED_STALE_BOUNDARY_MINUTES = 180

/** Classifies how stale the real reading a nowcast point is anchored to is,
 *  computed live from the anchor timestamp (not a frozen generation-time
 *  age) - same fresh/delayed/stale cutoffs stationFreshnessClass() uses, so
 *  "stale" means the same thing everywhere in this app. `nowMs` is
 *  injectable for testing; defaults to the real current time. */
export function anchorFreshnessClass(anchorObservedAt: string | null, nowMs: number = Date.now()): FreshnessClass {
  if (!anchorObservedAt) return 'no_reading'
  const observedMs = new Date(anchorObservedAt).getTime()
  if (!Number.isFinite(observedMs)) return 'unavailable'
  const ageMinutes = (nowMs - observedMs) / 60_000
  if (ageMinutes < -5) return 'unavailable'  // future timestamp beyond clock-skew tolerance is not a valid anchor
  if (ageMinutes < ANCHOR_FRESH_THRESHOLD_MINUTES) return 'fresh'
  if (ageMinutes < ANCHOR_DELAYED_STALE_BOUNDARY_MINUTES) return 'delayed'
  return 'stale'
}

/** The ward's ONE backend-selected +1h nowcast point (forecasts.is_nowcast_point
 *  = true) - never independently recomputed as "nearest to Date.now()" here.
 *  The backend already decided which row is "1h from generation time" once,
 *  correctly anchored to generated_at rather than the (possibly stale)
 *  anchor reading's own timestamp (see forecast._select_nowcast_point) - the
 *  frontend, shadow logger, and shadow scorer all read that single decision
 *  rather than each computing their own answer, which could disagree. */
export function nowcastPoint(forecast: WardForecastSummary | undefined): ForecastPoint | null {
  return forecast?.points.find((p) => p.is_nowcast_point) ?? null
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
      anchorFreshness: null,
      anchorObservedAt: null,
    }
  }

  if (timeMode === '1h') {
    // NOT hotspotStatus's 12-48h crossing-risk path - that machinery takes a
    // closed TimeWindowHours union that doesn't include 1h, and answers a
    // different question than a single nowcast point ("risk of crossing
    // within this window" vs. "what's the value right now"). Colours by the
    // ward's CURRENT AQI bucket instead, matching 'now' mode's colouring.
    const point = nowcastPoint(forecast)
    const freshness = anchorFreshnessClass(point?.anchorObservedAt ?? null)
    const usableAnchor = freshness === 'fresh' || freshness === 'delayed'
    const isProxy = pollutant === 'aqi'
    const forecastPollutantLabel = forecast ? MAP_POLLUTANT_LABEL[forecast.pollutant] : POLLUTANT_LABEL.pm25
    return {
      value: usableAnchor ? (point?.predicted_value ?? point?.pm25_pred ?? null) : null,
      unit: isProxy ? `µg/m³ (${forecastPollutantLabel} nowcast, risk signal)` : 'µg/m³ (nowcast)',
      colorMode: 'aqi',
      aqiForColor: ward.aqi,
      status: null,
      isProxy,
      anchorFreshness: freshness,
      anchorObservedAt: point?.anchorObservedAt ?? null,
    }
  }

  const horizonHours: TimeWindowHours = timeMode === '24h' ? 24 : 48
  const point = nearestForecastPoint(forecast, horizonHours)
  const status = hotspotStatus(
    {
      hoursToSevere: forecast?.hoursToSevere ?? null,
      hoursToVeryPoor: forecast?.hoursToVeryPoor ?? null,
      peakExcess: point?.local_excess ?? null,
      aqi: null,
    },
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
    anchorFreshness: null,
    anchorObservedAt: null,
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
export function markerMeaningLabel(pollutant: MapPollutant, timeMode: MapTimeMode, obsSlot: ObsSlot = 'now'): string {
  if (obsSlot !== 'now') {
    const slotLabel = OBS_SLOT_LABEL[obsSlot]
    return pollutant === 'aqi'
      ? `Markers show station AQI observed ${slotLabel} — verified readings only, no interpolation.`
      : `Markers show station ${MAP_POLLUTANT_LABEL[pollutant]} observed ${slotLabel} (µg/m³) — verified readings only.`
  }
  if (timeMode === 'now') {
    return pollutant === 'aqi' ? 'Markers show current station AQI.' : `Markers show latest station ${MAP_POLLUTANT_LABEL[pollutant]} concentration (µg/m³).`
  }
  if (timeMode === '1h') {
    // Unlike 24h/48h (where colour and number both describe the same
    // forecast), +1h's colour reflects the CURRENT AQI bucket while the
    // number is a future predicted concentration - and unlike ward markers,
    // station markers never respond to timeMode at all (they always show
    // live/historical readings) - both distinctions need to be explicit here
    // since this is the only place this mode's meaning is communicated.
    return pollutant === 'aqi'
      ? "Ward markers: number shows the predicted PM2.5 concentration 1h from now (µg/m³), used as a risk signal - AQI itself is not forecast; colour still reflects the ward's current AQI category. Station markers are unaffected and continue showing live readings."
      : `Ward markers: number shows the predicted ${MAP_POLLUTANT_LABEL[pollutant]} concentration 1h from now (µg/m³); colour reflects current AQI. Station markers are unaffected and continue showing live readings.`
  }
  const horizonLabel = timeMode === '24h' ? '24h' : '48h'
  if (pollutant === 'aqi') {
    return `Markers show ${horizonLabel} forecast PM2.5 peak (µg/m³), used as a risk signal - AQI itself is not forecast.`
  }
  return `Markers show ${horizonLabel} forecast peak for ${MAP_POLLUTANT_LABEL[pollutant]} (µg/m³).`
}

/** Single metric accessor for both live and historical station readings.
 *  Accepts any object with the four pollutant fields so it can be used
 *  uniformly across StationMarker, HistoricalStationReading, and inline
 *  objects — no casts needed at call sites. */
export function stationReadingValue(
  station: { aqi: number | null; pm25: number | null; pm10: number | null; no2: number | null },
  pollutant: MapPollutant,
): number | null {
  if (pollutant === 'aqi') return station.aqi
  if (pollutant === 'pm25') return station.pm25
  if (pollutant === 'pm10') return station.pm10
  return station.no2
}
