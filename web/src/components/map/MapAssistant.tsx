import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUp, MessageCircle, X } from 'lucide-react'
import { askAssistant, type AssistantAction, type AssistantTurn, type MapStateForAssistant } from '../../lib/jhAssistant'
import type { FeatureCollection } from 'geojson'
import { factsFor, fieldSource, FIELD_DEFS, rankDistricts, stateOverview, type FactRow, type FactField, type OverviewRow, type ProfilesDoc, type RankRow } from '../../lib/jhFacts'
import { near, NEAR_SPECS, type NearHit, type NearWhat, type NearSpec } from '../../lib/jhNear'

/** What the assistant's actions do on the map; supplied by CityContextLayers. */
export interface AssistantHandlers {
  setLayers: (patch: Record<string, boolean>) => void
  goDistrict: (name: string | null) => void
  goPlace: (lng: number, lat: number, name: string, zoom?: number) => void
  /** A data file of the map's pack ('sources', 'facilities', 'places' ...). */
  getFile: (file: NearSpec['file']) => Promise<FeatureCollection | null>
  /** What is on screen now, sent with every message so "I can't see it" and "this" make sense. */
  getState: () => MapStateForAssistant
  zoom: (direction: 'in' | 'out') => void
}

/** The map layer that shows what a "near" question counts. */
const NEAR_LAYER: Record<NearWhat, string> = {
  mines: 'mines', industrial: 'industry', plants: 'industry', kilns: 'kilns', schools: 'facilities',
  hospitals: 'facilities', towns: 'places', villages: 'places', heat: 'fires', peaks: 'landmarks',
  rail_stations: 'railways', substations: 'power',
}

type Card =
  | { kind: 'facts'; district: string; rows: FactRow[] }
  | { kind: 'rank'; field: FactField; order: 'desc' | 'asc'; rows: RankRow[] }
  | { kind: 'near'; place: string; radiusKm: number; count: number; nearest: NearHit[]; spec: NearSpec }
  | { kind: 'overview'; rows: OverviewRow[] }
  | { kind: 'note'; text: string }
  | { kind: 'done'; text: string }

interface Msg {
  role: 'user' | 'assistant'
  text: string
  cards?: Card[]
}

const SUGGESTIONS = [
  'Show coal mines and rivers in Hazaribagh',
  'Which district has the most forest?',
  'Tell me about Ranchi',
  'Likely pollution sources around Bokaro',
  'How many schools are within 10 km of Ranchi?',
  'Which district has the most brick kilns? Show it',
  'Take me to Jhumri Tilaiya',
]

const label = (key: string, layers: { key: string; label: string }[]) => layers.find((l) => l.key === key)?.label ?? key

export default function MapAssistant({
  container,
  slot,
  open,
  onOpenChange,
  layers,
  profiles,
  handlers,
}: {
  /** The map container: the launcher button lives here. */
  container: HTMLElement
  /** The dock's chat slot: the chat panel renders here while open. */
  slot: HTMLElement | null
  open: boolean
  onOpenChange: (open: boolean) => void
  layers: { key: string; label: string; note?: string }[]
  profiles: ProfilesDoc | null
  handlers: AssistantHandlers
}) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [msgs, busy, open])

  /** Carry out the actions in order and describe each result with data from the checked profiles. */
  async function execute(actions: AssistantAction[]): Promise<Card[]> {
    const cards: Card[] = []
    for (const a of actions) {
      if (a.type === 'go_to') {
        if (a.kind === 'state') { handlers.goDistrict(null); cards.push({ kind: 'done', text: 'Showing the whole of Jharkhand' }) }
        else if (a.kind === 'district' && a.name) { handlers.goDistrict(a.name); cards.push({ kind: 'done', text: `Showing ${a.name} district in 3D` }) }
        else if (a.kind === 'place' && a.name && a.lng != null && a.lat != null) { handlers.goPlace(a.lng, a.lat, a.name); cards.push({ kind: 'done', text: `Flying to ${a.name}` }) }
      } else if (a.type === 'set_layers') {
        const patch: Record<string, boolean> = {}
        if (a.only) for (const l of layers) patch[l.key] = false
        for (const k of a.off) patch[k] = false
        for (const k of a.on) patch[k] = true
        handlers.setLayers(patch)
        if (a.on.length) cards.push({ kind: 'done', text: `Switched on: ${a.on.map((k) => label(k, layers)).join(', ')}` })
        if (a.off.length) cards.push({ kind: 'done', text: `Switched off: ${a.off.map((k) => label(k, layers)).join(', ')}` })
        if (a.only) cards.push({ kind: 'done', text: 'All other layers are off' })
      } else if (a.type === 'facts') {
        const rows = profiles ? factsFor(profiles, a.district, a.fields) : null
        cards.push(rows ? { kind: 'facts', district: a.district, rows } : { kind: 'note', text: 'The district data has not loaded yet. Please try again.' })
      } else if (a.type === 'rank') {
        const rows = profiles ? rankDistricts(profiles, a.field, a.order, a.limit) : []
        cards.push(rows.length ? { kind: 'rank', field: a.field, order: a.order, rows } : { kind: 'note', text: 'No data to rank for that.' })
        if (a.open_top && rows.length) { handlers.goDistrict(rows[0].district); cards.push({ kind: 'done', text: `Showing ${rows[0].district} district in 3D` }) }
      } else if (a.type === 'near') {
        if (a.lng == null || a.lat == null || !a.place_name) continue
        const spec = NEAR_SPECS[a.what]
        const fc = await handlers.getFile(spec.file)
        if (!fc) { cards.push({ kind: 'note', text: 'The map data has not loaded yet. Please try again.' }); continue }
        const r = near(fc, a.what, a.lng, a.lat, a.radius_km)
        handlers.setLayers({ [NEAR_LAYER[a.what]]: true })
        handlers.goPlace(a.lng, a.lat, a.place_name, Math.min(14, Math.max(8.5, 14.9 - Math.log2(a.radius_km))))
        cards.push({ kind: 'near', place: a.place_name, radiusKm: a.radius_km, count: r.count, nearest: r.nearest, spec })
      } else if (a.type === 'zoom') {
        handlers.zoom(a.direction)
        cards.push({ kind: 'done', text: `Zoomed ${a.direction}` })
      } else if (a.type === 'overview') {
        cards.push(profiles ? { kind: 'overview', rows: stateOverview(profiles) } : { kind: 'note', text: 'The district data has not loaded yet. Please try again.' })
      } else if (a.type === 'unsupported') {
        cards.push({ kind: 'note', text: a.reason })
      }
    }
    return cards
  }

  async function send(q: string) {
    const question = q.trim()
    if (!question || busy) return
    setText('')
    const history: AssistantTurn[] = msgs.map((m) => ({ role: m.role, text: m.text }))
    setMsgs((m) => [...m, { role: 'user', text: question }])
    setBusy(true)
    const r = await askAssistant(question, history, layers, handlers.getState())
    setBusy(false)
    if (!r.ok) { setMsgs((m) => [...m, { role: 'assistant', text: r.reason }]); return }
    const cards = await execute(r.data.actions)
    // The model's wording carries no figures (enforced server-side); every number is in the cards below.
    const onlyNotes = r.data.actions.every((a) => a.type === 'unsupported')
    setMsgs((m) => [...m, { role: 'assistant', text: onlyNotes ? '' : r.data.reply, cards }])
  }

  const panel = (
    <div className="flex h-[min(34rem,calc(100svh-15rem))] flex-col md:h-[min(34rem,calc(100svh-14rem))]">
      <div className="flex items-center justify-between gap-2 border-b border-ink-900/10 px-3 py-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-ink-500">Ask the map</p>
          <p className="font-display text-xl leading-none text-ink-900">Jharkhand assistant</p>
        </div>
        <button type="button" onClick={() => onOpenChange(false)} aria-label="Close" className="focus-ring rounded-md p-1 text-ink-600 hover:bg-white">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-[7rem] flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
        {msgs.length === 0 && (
          <div className="space-y-2">
            <p className="text-ink-700">
              Ask for a place, a district, a comparison, or tell me what to show. Every figure comes from checked data and
              names its source. I do not have air-quality readings.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => send(s)}
                  className="focus-ring rounded-full border border-ink-900/15 bg-white px-2.5 py-1 text-[11px] text-ink-800 hover:bg-ink-50">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
            {m.role === 'user' ? (
              <p className="max-w-[85%] rounded-xl bg-ink-900 px-3 py-1.5 text-cream">{m.text}</p>
            ) : (
              <div className="space-y-2">
                {m.text && <p className="text-ink-900">{m.text}</p>}
                {m.cards?.map((c, j) => <ResultCard key={j} card={c} />)}
              </div>
            )}
          </div>
        ))}
        {busy && <p className="text-ink-500">Thinking…</p>}
        <div ref={endRef} />
      </div>
      <form
        className="flex items-center gap-2 border-t border-ink-900/10 px-3 py-2"
        onSubmit={(e) => { e.preventDefault(); void send(text) }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={400}
          placeholder="Ask about Jharkhand…"
          aria-label="Ask the Jharkhand map"
          className="focus-ring min-w-0 flex-1 rounded-lg border border-ink-900/15 bg-white px-2.5 py-2 text-sm text-ink-900 placeholder:text-ink-400"
        />
        <button type="submit" disabled={busy || !text.trim()} aria-label="Send"
          className="focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ink-900 text-cream disabled:opacity-40">
          <ArrowUp className="h-4 w-4" />
        </button>
      </form>
    </div>
  )

  return (
    <>
      {open && slot && createPortal(panel, slot)}
      {!open && createPortal(
        <button type="button" onClick={() => onOpenChange(true)}
          className="focus-ring absolute bottom-16 left-3 z-20 flex items-center gap-2 rounded-full bg-ink-900 px-4 py-2.5 font-site text-sm font-medium text-cream shadow-card-lg hover:bg-ink-700 md:bottom-3 md:left-auto md:right-16">
          <MessageCircle className="h-4 w-4" aria-hidden /> Ask the map
        </button>,
        container,
      )}
    </>
  )
}

function ResultCard({ card }: { card: Card }) {
  if (card.kind === 'done') {
    return <p className="flex items-start gap-1.5 text-ink-700"><span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-600" />{card.text}</p>
  }
  if (card.kind === 'note') {
    return <p className="rounded-lg border border-ink-900/10 bg-white px-2.5 py-2 text-ink-700">{card.text}</p>
  }
  if (card.kind === 'overview') {
    return (
      <div className="rounded-xl border border-ink-900/10 bg-white">
        <p className="border-b border-ink-900/10 px-2.5 py-1.5 font-display text-lg leading-none text-ink-900">Jharkhand at a glance</p>
        <dl className="divide-y divide-ink-900/10">
          {card.rows.map((r) => (
            <div key={r.label} className="px-2.5 py-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-600">{r.label}</dt>
                <dd className="text-right font-semibold tabular-nums text-ink-900">{r.value}</dd>
              </div>
              <p className="text-[10px] leading-snug text-ink-500">{r.source}</p>
            </div>
          ))}
        </dl>
      </div>
    )
  }
  if (card.kind === 'near') {
    return (
      <div className="rounded-xl border border-ink-900/10 bg-white px-2.5 py-2">
        <p className="text-ink-600">Within {card.radiusKm} km of {card.place}</p>
        <p className="mt-0.5 flex items-baseline gap-1.5">
          <span className="font-display text-3xl leading-none text-ink-900">{card.count}</span>
          <span className="text-ink-700">{card.spec.label}</span>
        </p>
        {card.nearest.length > 0 && (
          <ul className="mt-1.5 divide-y divide-ink-900/10 text-ink-800">
            {card.nearest.map((h, i) => (
              <li key={i} className="flex items-baseline justify-between gap-2 py-1">
                <span className="min-w-0 truncate">{h.name || `(unnamed ${h.kind.replace('_', ' ')})`}</span>
                <span className="shrink-0 tabular-nums text-ink-600">{h.km.toFixed(1)} km</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1.5 text-[10px] leading-snug text-ink-500">{card.spec.source} Distances are straight-line to the feature's centre.</p>
      </div>
    )
  }
  if (card.kind === 'facts') {
    return (
      <div className="rounded-xl border border-ink-900/10 bg-white">
        <p className="border-b border-ink-900/10 px-2.5 py-1.5 font-display text-lg leading-none text-ink-900">{card.district}</p>
        <dl className="divide-y divide-ink-900/10">
          {card.rows.map((r) => (
            <div key={r.field} className="px-2.5 py-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-ink-600">{r.label}</dt>
                <dd className={`font-semibold tabular-nums ${r.value === 'NA' ? 'text-ink-300' : 'text-ink-900'}`}>{r.value}</dd>
              </div>
              <p className="text-[10px] leading-snug text-ink-500">{r.source}</p>
              {r.note && <p className="text-[10px] leading-snug text-ink-600">{r.note}</p>}
            </div>
          ))}
        </dl>
      </div>
    )
  }
  const max = Math.max(...card.rows.map((r) => r.value), 1)
  return (
    <div className="rounded-xl border border-ink-900/10 bg-white px-2.5 py-2">
      <p className="mb-1.5 text-ink-600">
        {FIELD_DEFS[card.field].label}, {card.order === 'desc' ? 'highest first' : 'lowest first'}
      </p>
      <ol className="space-y-1.5">
        {card.rows.map((r, i) => (
          <li key={r.district}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-ink-900">{i + 1}. {r.district}</span>
              <span className="font-semibold tabular-nums text-ink-900">{r.text}</span>
            </div>
            <div className="mt-0.5 h-1.5 rounded-full bg-ink-100"><div className="h-1.5 rounded-full bg-ink-700" style={{ width: `${Math.max(3, (r.value / max) * 100)}%` }} /></div>
          </li>
        ))}
      </ol>
      <p className="mt-1.5 text-[10px] leading-snug text-ink-500">{fieldSource(card.field)}</p>
    </div>
  )
}
