import { useState } from 'react'
import { ChevronDown, ChevronRight, Info, ListTree } from 'lucide-react'
import { FRESHNESS_HEX, FRESHNESS_LABEL, NEARBY_COVERAGE_THRESHOLD_METERS, WARD_COVERAGE_HEX, WARD_COVERAGE_LABEL, type FreshnessClass, type WardCoverageClass } from '../../lib/dataQualityRules'
import { sourceCategoryLabel, type Severity, type SourceCategory } from '../../lib/incidentRules'
import { SEVERITY_HEX, SOURCE_CATEGORY_HEX, TRANSIT_ACTIVITY_HEX } from '../../lib/mapMarkers'
import { MAP_POLLUTANT_LABEL, type MapPollutant } from '../../lib/mapRules'
import type { MapViewMode } from './MapToolbar'

const SEVERITY_ORDER: Severity[] = ['severe', 'high', 'moderate', 'low']
const PHYSICAL_SOURCES: SourceCategory[] = ['vehicular', 'industrial', 'construction_dust', 'road_dust', 'open_burning', 'waste']

// Mirrors AqiBadge.tsx's India NAQI scale - same bands/colours, kept as a
// separate small table here rather than importing that component's
// internals, since only the label/hex pair is needed for a legend key.
const AQI_BANDS: { label: string; hex: string }[] = [
  { label: 'Good (0-50)', hex: '#22c55e' },
  { label: 'Satisfactory (51-100)', hex: '#84cc16' },
  { label: 'Moderate (101-200)', hex: '#eab308' },
  { label: 'Poor (201-300)', hex: '#f97316' },
  { label: 'Very Poor (301-400)', hex: '#ef4444' },
  { label: 'Severe (400+)', hex: '#9333ea' },
]

/** Miniature station marker matching mapMarkers.ts's stationCircle() ring
 *  styles per freshness class — ring shape encodes freshness so colour alone
 *  is never the only signal (WCAG 1.4.1). */
function FreshnessRingSwatch({ cls }: { cls: FreshnessClass }) {
  const color = FRESHNESS_HEX[cls]
  const outerStyle: React.CSSProperties = {
    width: 12, height: 12, borderRadius: '50%',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
    ...(cls === 'fresh'
      ? { border: '1.5px solid rgba(34,197,94,0.6)' }
      : cls === 'delayed'
        ? { border: `1.5px dashed ${color}` }
        : cls === 'stale'
          ? { border: `1.5px solid ${color}`, boxShadow: `0 0 0 2.5px rgba(239,68,68,0.2)` }
          : cls === 'no_reading'
            ? { border: `1.5px dashed ${color}`, opacity: 0.7 }
            : /* unavailable */ { border: `1px solid ${color}`, opacity: 0.5 }),
  }
  const coreStyle: React.CSSProperties = {
    width: 7, height: 7, borderRadius: '50%', background: color,
    opacity: cls === 'stale' ? 0.75 : cls === 'unavailable' ? 0.45 : cls === 'no_reading' ? 0.65 : 1,
  }
  return (
    <span style={outerStyle} aria-hidden>
      <span style={coreStyle} />
    </span>
  )
}

function Swatch({ color, shape = 'circle' }: { color: string; shape?: 'circle' | 'square' | 'diamond' | 'ring' }) {
  const radius = shape === 'circle' ? '50%' : shape === 'square' ? '3px' : shape === 'diamond' ? '2px' : '50%'
  return (
    <span
      className="inline-block h-2.5 w-2.5 flex-shrink-0"
      style={{
        borderRadius: radius,
        background: shape === 'ring' ? 'transparent' : color,
        border: shape === 'ring' ? `1.5px dashed ${color}` : 'none',
        transform: shape === 'diamond' ? 'rotate(45deg)' : undefined,
      }}
      aria-hidden
    />
  )
}

export default function MapLegend({
  viewMode = 'pollution',
  sourceAttributionOn,
  pollutant,
  transitActivityOn,
  forecastSuppressed = false,
}: {
  viewMode?: MapViewMode
  sourceAttributionOn: boolean
  pollutant: MapPollutant
  transitActivityOn: boolean
  forecastSuppressed?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)

  return (
    <div className="w-52 rounded-lg border border-slate-200 bg-white shadow-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="focus-ring flex w-full items-center gap-1.5 px-1.5 py-1"
      >
        <ListTree className="h-3 w-3 text-accent-600" strokeWidth={2} aria-hidden />
        <p className="flex-1 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">Legend</p>
        {open ? (
          <ChevronDown className="h-3 w-3 text-slate-400" aria-hidden />
        ) : (
          <ChevronRight className="h-3 w-3 text-slate-400" aria-hidden />
        )}
      </button>

      {open && viewMode === 'data_quality' && (
        <div className="px-1.5 pb-1.5">
          <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">Station freshness</p>
          <ul className="mt-0.5 space-y-0.5">
            {(['fresh', 'delayed', 'stale', 'no_reading', 'unavailable'] as FreshnessClass[]).map((cls) => (
              <li key={cls} className="flex items-center gap-1.5 text-[10px] text-slate-600">
                <FreshnessRingSwatch cls={cls} />
                {FRESHNESS_LABEL[cls]}
              </li>
            ))}
          </ul>
          <li className="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-500 list-none">
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 10, height: 10, borderRadius: 2,
                border: '1.5px solid #f59e0b', background: '#fff',
                fontSize: 5.5, fontWeight: 700, color: '#f59e0b', flexShrink: 0,
              }}
              aria-hidden
            >F</span>
            OpenAQ fallback source
          </li>
          <p className="mt-1.5 text-[9px] font-semibold uppercase tracking-wide text-slate-400">Ward coverage</p>
          <ul className="mt-0.5 space-y-0.5">
            {(['direct', 'nearby', 'insufficient', 'unavailable'] as WardCoverageClass[]).map((cls) => (
              <li key={cls} className="flex items-center gap-1.5 text-[10px] text-slate-600">
                <span
                  className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-sm"
                  style={{ background: WARD_COVERAGE_HEX[cls] }}
                  aria-hidden
                />
                {WARD_COVERAGE_LABEL[cls]}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[9px] font-semibold uppercase tracking-wide text-slate-400">How coverage is determined</p>
          <ul className="mt-0.5 space-y-0.5 text-[10px] leading-relaxed text-slate-500">
            <li>• Straight-line distance from ward centroid to nearest active station.</li>
            <li>• {(NEARBY_COVERAGE_THRESHOLD_METERS / 1000).toFixed(0)} km threshold follows WMO/CPCB guidance for dense urban monitoring.</li>
            <li>• Inactive stations never count toward coverage, even if assigned.</li>
          </ul>
        </div>
      )}

      {open && viewMode === 'pollution' && (
        <div className="px-1.5 pb-1.5">
          {pollutant === 'aqi' ? (
            <>
              <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">AQI scale (India NAQI)</p>
              <ul className="mt-0.5 space-y-0.5">
                {AQI_BANDS.map((b) => (
                  <li key={b.label} className="flex items-center gap-1.5 text-[10px] text-slate-600">
                    <Swatch color={b.hex} shape="square" />
                    {b.label}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-[10px] text-slate-500">
              Marker colour in "Now" mode is still AQI-coloured; the number shown is {MAP_POLLUTANT_LABEL[pollutant]} in µg/m³, a
              different scale from AQI.
            </p>
          )}

          <p className="mt-1.5 text-[9px] font-semibold uppercase tracking-wide text-slate-400">Markers</p>
          <ul className="mt-0.5 space-y-0.5 text-[10px] text-slate-600">
            <li className="flex items-center gap-1.5">
              <Swatch color="#64748B" shape="circle" />
              AQ station
            </li>
            <li className="flex items-center gap-1.5">
              <Swatch color="#64748B" shape="diamond" />
              Active incident
            </li>
          </ul>

          {sourceAttributionOn && (
            <>
              <p className="mt-1.5 text-[9px] font-semibold uppercase tracking-wide text-slate-400">Leading source</p>
              <ul className="mt-0.5 space-y-0.5">
                {PHYSICAL_SOURCES.map((c) => (
                  <li key={c} className="flex items-center gap-1.5 text-[10px] text-slate-600">
                    <Swatch color={SOURCE_CATEGORY_HEX[c]} />
                    {sourceCategoryLabel(c)}
                  </li>
                ))}
              </ul>
            </>
          )}

          {transitActivityOn && (
            <>
              <p className="mt-1.5 text-[9px] font-semibold uppercase tracking-wide text-slate-400">Transit activity</p>
              <ul className="mt-0.5 space-y-0.5">
                <li className="flex items-center gap-1.5 text-[10px] text-slate-600">
                  <Swatch color={TRANSIT_ACTIVITY_HEX.low} />
                  Low
                </li>
                <li className="flex items-center gap-1.5 text-[10px] text-slate-600">
                  <Swatch color={TRANSIT_ACTIVITY_HEX.medium} />
                  Medium
                </li>
                <li className="flex items-center gap-1.5 text-[10px] text-slate-600">
                  <Swatch color={TRANSIT_ACTIVITY_HEX.high} />
                  High
                </li>
              </ul>
            </>
          )}

          <button
            type="button"
            onClick={() => setInfoOpen((v) => !v)}
            className="focus-ring mt-1.5 flex w-full items-center gap-1 text-left"
          >
            <Info className="h-3 w-3 flex-shrink-0 text-slate-400" aria-hidden />
            <span className="flex-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400">How this map works</span>
            {infoOpen
              ? <ChevronDown className="h-3 w-3 text-slate-400" aria-hidden />
              : <ChevronRight className="h-3 w-3 text-slate-400" aria-hidden />}
          </button>
          {infoOpen && (
            <div className="mt-0.5 space-y-1.5">
              <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">Incident severity</p>
              <ul className="space-y-0.5">
                {SEVERITY_ORDER.map((s) => (
                  <li key={s} className="flex items-center gap-1.5 text-[10px] capitalize text-slate-600">
                    <Swatch color={SEVERITY_HEX[s]} shape="diamond" />
                    {s}
                  </li>
                ))}
              </ul>
              <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">Other markers</p>
              <ul className="space-y-0.5 text-[10px] text-slate-600">
                <li className="flex items-center gap-1.5">
                  <Swatch color="#64748B" shape="circle" />
                  Ward hotspot (circle with halo)
                </li>
                <li className="flex items-center gap-1.5">
                  <Swatch color="#0F6CBD" shape="ring" />
                  Citizen report (hollow ring)
                </li>
                <li className="flex items-center gap-1.5">
                  <Swatch color="#D97706" shape="ring" />
                  Stale station (dashed orange ring)
                </li>
                {!forecastSuppressed && (
                  <li className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 flex-shrink-0 animate-pulse rounded-full bg-status-warning/50" aria-hidden />
                    Forecast alert (pulsing halo)
                  </li>
                )}
              </ul>
              <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">How readings are assigned</p>
              <ul className="space-y-0.5 text-[10px] leading-relaxed text-slate-500">
                <li>• Ward AQI comes from the nearest assigned station — not an independent ward-level calculation.</li>
                <li>• A blue dot on a station means CPCB/data.gov.in data was preferred over the OpenAQ fallback.</li>
                <li>• Ward boundaries are official MCD/NDMC/cantonment divisions.</li>
                <li>• Forecast alerts pulse when the ward is projected to cross Severe (AQI 400+) within the selected time window.</li>
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
