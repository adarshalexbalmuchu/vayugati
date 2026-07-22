import { useState } from 'react'
import { ChevronDown, ChevronRight, ListTree } from 'lucide-react'
import { sourceCategoryLabel, type Severity, type SourceCategory } from '../../lib/incidentRules'
import { SEVERITY_HEX, SOURCE_CATEGORY_HEX, TRANSIT_ACTIVITY_HEX } from '../../lib/mapMarkers'
import { MAP_POLLUTANT_LABEL, type MapPollutant } from '../../lib/mapRules'

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

/** Floating legend, paired with MapLayerControl. Collapsed by default -
 *  reference material, looked up less often than the layer toggles, so it
 *  shouldn't cost map real estate until asked for. Only shows keys for
 *  layers that can genuinely appear - no invented categories. */
export default function MapLegend({
  sourceAttributionOn,
  pollutant,
  transitActivityOn,
}: {
  sourceAttributionOn: boolean
  pollutant: MapPollutant
  transitActivityOn: boolean
}) {
  const [open, setOpen] = useState(false)

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

      {open && (
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

          <p className="mt-1.5 text-[9px] font-semibold uppercase tracking-wide text-slate-400">Severity (incidents)</p>
          <ul className="mt-0.5 space-y-0.5">
            {SEVERITY_ORDER.map((s) => (
              <li key={s} className="flex items-center gap-1.5 text-[10px] capitalize text-slate-600">
                <Swatch color={SEVERITY_HEX[s]} shape="diamond" />
                {s}
              </li>
            ))}
          </ul>

          <p className="mt-1.5 text-[9px] font-semibold uppercase tracking-wide text-slate-400">Marker types</p>
          <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500">
            AQ station readings show actual monitoring station locations. Ward-linked AQI shows the reading assigned
            to each operational hotspot ward via its own station - not an independent ward-level calculation, so the
            two often show the same number at nearby coordinates.
          </p>
          <ul className="mt-1 space-y-0.5 text-[10px] text-slate-600">
            <li className="flex items-center gap-1.5">
              <Swatch color="#64748B" shape="circle" />
              Ward-linked AQI (hotspot ward)
            </li>
            <li className="flex items-center gap-1.5">
              <Swatch color="#64748B" shape="square" />
              AQ station (actual location)
            </li>
            <li className="flex items-center gap-1.5">
              <Swatch color="#64748B" shape="diamond" />
              Incident
            </li>
            <li className="flex items-center gap-1.5">
              <Swatch color="#0F6CBD" shape="ring" />
              Citizen report
            </li>
            <li className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 flex-shrink-0 animate-pulse rounded-full bg-status-warning/50" aria-hidden />
              Forecast alert (pulsing halo - ward forecast to cross severe)
            </li>
            <li className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-sm border border-sky-500 bg-sky-500/20" aria-hidden />
              Ward boundary polygon
            </li>
          </ul>

          <p className="mt-1.5 text-[9px] font-semibold uppercase tracking-wide text-slate-400">Sensor state</p>
          <ul className="mt-0.5 space-y-0.5 text-[10px] text-slate-600">
            <li className="flex items-center gap-1.5">
              <Swatch color="#64748B" shape="square" />
              Fresh
            </li>
            <li className="flex items-center gap-1.5">
              <Swatch color="#D97706" shape="ring" />
              Stale (dashed ring + warning dot)
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
              <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500">
                Public transport activity via Delhi Open Transit Data. Context layer only — not proof of emissions or
                congestion. Marker number is nearby live vehicle count, not AQI.
              </p>
              <ul className="mt-0.5 space-y-0.5">
                <li className="flex items-center gap-1.5 text-[10px] text-slate-600">
                  <Swatch color={TRANSIT_ACTIVITY_HEX.low} />
                  Low activity
                </li>
                <li className="flex items-center gap-1.5 text-[10px] text-slate-600">
                  <Swatch color={TRANSIT_ACTIVITY_HEX.medium} />
                  Medium activity
                </li>
                <li className="flex items-center gap-1.5 text-[10px] text-slate-600">
                  <Swatch color={TRANSIT_ACTIVITY_HEX.high} />
                  High activity
                </li>
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}
