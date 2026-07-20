import { ListTree } from 'lucide-react'
import { sourceCategoryLabel, type Severity, type SourceCategory } from '../../lib/incidentRules'
import { SEVERITY_HEX, SOURCE_CATEGORY_HEX } from '../../lib/mapMarkers'

const SEVERITY_ORDER: Severity[] = ['severe', 'high', 'moderate', 'low']
const PHYSICAL_SOURCES: SourceCategory[] = ['vehicular', 'industrial', 'construction_dust', 'road_dust', 'open_burning', 'waste']

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

/** Floating legend, paired with MapLayerControl. Only shows keys for layers
 *  that can genuinely appear (severity/source colours, marker shapes, sensor
 *  freshness) - no invented categories. */
export default function MapLegend({ sourceAttributionOn }: { sourceAttributionOn: boolean }) {
  return (
    <div className="w-56 rounded-xl border border-slate-200 bg-white/97 p-2.5 shadow-card-lg backdrop-blur-sm">
      <div className="mb-1.5 flex items-center gap-1.5">
        <ListTree className="h-3.5 w-3.5 text-accent-600" strokeWidth={2} aria-hidden />
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Legend</p>
      </div>

      <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Severity</p>
      <ul className="mt-1 space-y-1">
        {SEVERITY_ORDER.map((s) => (
          <li key={s} className="flex items-center gap-1.5 text-[11px] capitalize text-slate-600">
            <Swatch color={SEVERITY_HEX[s]} shape="diamond" />
            {s}
          </li>
        ))}
      </ul>

      <p className="mt-2.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Marker types</p>
      <ul className="mt-1 space-y-1 text-[11px] text-slate-600">
        <li className="flex items-center gap-1.5">
          <Swatch color="#64748B" shape="circle" />
          Ward
        </li>
        <li className="flex items-center gap-1.5">
          <Swatch color="#64748B" shape="square" />
          Station
        </li>
        <li className="flex items-center gap-1.5">
          <Swatch color="#64748B" shape="diamond" />
          Incident
        </li>
        <li className="flex items-center gap-1.5">
          <Swatch color="#0F6CBD" shape="ring" />
          Citizen report
        </li>
      </ul>

      <p className="mt-2.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Sensor state</p>
      <ul className="mt-1 space-y-1 text-[11px] text-slate-600">
        <li className="flex items-center gap-1.5">
          <Swatch color="#64748B" shape="square" />
          Fresh
        </li>
        <li className="flex items-center gap-1.5">
          <Swatch color="#D97706" shape="ring" />
          Stale (no recent reading)
        </li>
      </ul>

      {sourceAttributionOn && (
        <>
          <p className="mt-2.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Leading source</p>
          <ul className="mt-1 space-y-1">
            {PHYSICAL_SOURCES.map((c) => (
              <li key={c} className="flex items-center gap-1.5 text-[11px] text-slate-600">
                <Swatch color={SOURCE_CATEGORY_HEX[c]} />
                {sourceCategoryLabel(c)}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
