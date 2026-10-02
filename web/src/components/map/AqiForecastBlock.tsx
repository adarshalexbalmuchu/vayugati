import { fetchWardAqiForecast } from '../../lib/data'
import { aqiOutlook, POLLUTANT_NAME } from '../../lib/aqiForecastRules'
import { useAsync } from '../../lib/useAsync'
import { aqiLevel } from '../AqiBadge'
import { Skeleton } from '../ui'

function whenLabel(ts: string): string {
  return new Date(ts).toLocaleString(undefined, { weekday: 'short', hour: 'numeric' })
}

/** Backtest of the forecast AQI against the AQI the monitors gave
 *  (scripts/aqi_forecast_backtest.py; six weeks, three of them winter, each
 *  forecast from models trained only on earlier data). Filled from its
 *  report; shown under the outlook so the numbers carry their track record. */
export const AQI_FORECAST_VALIDATION =
  'Tested on six past weeks (three in winter): typical error about 4 AQI points at 3 h, 9 at 6 h and 21 at 12 h, 30-57% smaller than assuming the current AQI holds. Not shown beyond 12 h, where it was no better.'

/** A monitored ward's forecast AQI for the next 12 hours, by CPCB's own
 *  rule from all pollutants' forecasts. Renders nothing when the ward has
 *  none (stale readings, or no validated lead). */
export default function AqiForecastBlock({ wardId }: { wardId: number }) {
  const state = useAsync(() => fetchWardAqiForecast(wardId), [wardId], { cacheKey: `aqi-forecast:${wardId}` })
  if (state.loading) return <Skeleton className="mt-2 h-14 w-full" />
  const outlook = aqiOutlook(state.data ?? [])
  if (outlook.length === 0) return null

  return (
    <div className="mt-3">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">AQI forecast</p>
      <div className="mt-1 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${outlook.length}, minmax(0, 1fr))` }}>
        {outlook.map(({ hours, point }) => {
          const lvl = aqiLevel(point.aqi)
          return (
            <div key={hours} className="rounded-lg px-2 py-1.5" style={{ backgroundColor: `${lvl.hex}1a` }}>
              <p className="text-[10px] text-slate-500">in {hours} h</p>
              <p className="text-base font-extrabold tabular-nums leading-tight" style={{ color: lvl.hex }}>{point.aqi}</p>
              <p className="text-[10px] font-semibold" style={{ color: lvl.hex }}>{lvl.label}</p>
              <p className="text-[10px] tabular-nums text-slate-500">{point.aqiLow}–{point.aqiHigh}</p>
            </div>
          )
        })}
      </div>
      <p className="mt-1 text-[10px] leading-snug text-slate-400">
        AQI for the 24 h ending at each time ({outlook.map((o) => whenLabel(o.point.targetTs)).join(', ')}), by CPCB's method from the
        forecasts of every pollutant; mainly driven by {POLLUTANT_NAME[outlook[outlook.length - 1].point.dominantPollutant] ?? outlook[outlook.length - 1].point.dominantPollutant}.
        Range holds about 80% of outcomes.{AQI_FORECAST_VALIDATION ? ` ${AQI_FORECAST_VALIDATION}` : ''}
      </p>
    </div>
  )
}
