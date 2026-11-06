import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUp, MessageCircle, X } from 'lucide-react'
import { askAssistant, type AssistantAction, type AssistantTurn, type MapStateForAssistant } from '../../lib/jhAssistant'
import { factsFor, fieldSource, FIELD_DEFS, rankDistricts, stateOverview, type FactRow, type FactField, type OverviewRow, type ProfilesDoc, type RankRow } from '../../lib/jhFacts'

/** What the assistant's actions do on the map; supplied by CityContextLayers. */
export interface AssistantHandlers {
  setLayers: (patch: Record<string, boolean>) => void
  goDistrict: (name: string | null) => void
  goPlace: (lng: number, lat: number, name: string, zoom?: number) => void
  /** What is on screen now, sent with every message so "I can't see it" and "this" make sense. */
  getState: () => MapStateForAssistant
  /** Tell the map whether answers are being shown in the side panel (it folds the layers away). */
  onResults: (has: boolean) => void
  zoom: (direction: 'in' | 'out') => void
}


type Card =
  | { kind: 'facts'; district: string; rows: FactRow[] }
  | { kind: 'rank'; field: FactField; order: 'desc' | 'asc'; rows: RankRow[] }
  | { kind: 'overview'; rows: OverviewRow[] }
  | { kind: 'note'; text: string }
  | { kind: 'done'; text: string }

interface Msg {
  role: 'user' | 'assistant'
  text: string
  cards?: Card[]
  /** Data cards were shown in the left card's answers section. */
  moved?: boolean
}

const SUGGESTIONS = [
  'Show coal mines and rivers in Hazaribagh',
  'Which district has the most forest?',
  'Tell me about Ranchi',
  'Likely pollution sources around Bokaro',
  'Which district gets the most rain?',
  'Winter wind direction in Ranchi',
  'Take me to Jhumri Tilaiya',
]

const label = (key: string, layers: { key: string; label: string }[]) => layers.find((l) => l.key === key)?.label ?? key

export default function MapAssistant({
  container,
  slot,
  resultsSlot,
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
  /** The left card's answers section; on wide screens the data cards render here instead of in the chat. */
  resultsSlot: HTMLElement | null
  open: boolean
  onOpenChange: (open: boolean) => void
  layers: { key: string; label: string; note?: string }[]
  profiles: ProfilesDoc | null
  handlers: AssistantHandlers
}) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  // Answers (rankings, facts, overview) go to the left card on wide screens; the chat keeps the conversation.
  const [results, setResults] = useState<{ q: string; cards: Card[] }[]>([])
  const wide = typeof window !== 'undefined' && window.innerWidth >= 768
  const sideResults = wide && resultsSlot != null
  // Show or hide the Answers section and fold the layers away, directly on the card's DOM, so it does not depend on
  // a reference held in another component.
  useEffect(() => {
    const has = sideResults && results.length > 0
    handlers.onResults(has)
    const wrap = resultsSlot?.closest('details') as HTMLDetailsElement | null
    const layersEl = wrap?.parentElement?.querySelector('details[data-layers]') as HTMLDetailsElement | null | undefined
    if (!wrap) return
    wrap.style.display = has ? '' : 'none'
    if (has) {
      wrap.open = true
      if (layersEl) layersEl.open = false
    } else if (layersEl) layersEl.open = true
  }, [results.length, sideResults, resultsSlot])
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
    const isData = (c: Card) => c.kind === 'facts' || c.kind === 'rank' || c.kind === 'overview'
    const dataCards = sideResults ? cards.filter(isData) : []
    if (dataCards.length) setResults((rs) => [{ q: question, cards: dataCards }, ...rs].slice(0, 8))
    setMsgs((m) => [...m, { role: 'assistant', text: onlyNotes ? '' : r.data.reply, cards: sideResults ? cards.filter((c) => !isData(c)) : cards, moved: dataCards.length > 0 }])
  }

  const panel = (
    <div className="flex h-[min(34rem,calc(100svh-15rem))] flex-col md:h-[min(34rem,calc(100svh-14rem))]">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">Ask the map</p>
          <p className="text-base font-bold leading-none text-slate-900">Jharkhand assistant</p>
        </div>
        <button type="button" onClick={() => onOpenChange(false)} aria-label="Close" className="focus-ring rounded-md p-1 text-slate-500 hover:bg-slate-50">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-[7rem] flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
        {msgs.length === 0 && (
          <div className="space-y-2">
            <p className="text-slate-600">
              Ask for a place, a district, a comparison, or tell me what to show. Every figure comes from checked data and
              names its source. I do not have air-quality readings.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => send(s)}
                  className="focus-ring rounded-full border border-slate-300 bg-white px-2.5 py-1 text-[11px] text-slate-700 hover:bg-slate-50">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
            {m.role === 'user' ? (
              <p className="max-w-[85%] rounded-lg bg-accent-500 px-3 py-1.5 text-white">{m.text}</p>
            ) : (
              <div className="space-y-2">
                {m.text && <p className="text-slate-900">{m.text}</p>}
                {m.cards?.map((c, j) => <ResultCard key={j} card={c} />)}
                {m.moved && <p className="text-[11px] text-slate-400">← Shown in the Answers section on the left.</p>}
              </div>
            )}
          </div>
        ))}
        {busy && <p className="text-slate-400">Thinking…</p>}
        <div ref={endRef} />
      </div>
      <form
        className="flex items-center gap-2 border-t border-slate-200 px-3 py-2"
        onSubmit={(e) => { e.preventDefault(); void send(text) }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={400}
          placeholder="Ask about Jharkhand…"
          aria-label="Ask the Jharkhand map"
          className="focus-ring min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-900 placeholder:text-slate-400"
        />
        <button type="submit" disabled={busy || !text.trim()} aria-label="Send"
          className="focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-500 text-white disabled:opacity-40">
          <ArrowUp className="h-4 w-4" />
        </button>
      </form>
    </div>
  )

  const resultsPanel = (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-slate-400">{results.length} {results.length === 1 ? 'answer' : 'answers'}, newest first</p>
        <button type="button" onClick={() => setResults([])}
          className="focus-ring rounded-md border border-slate-300 px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50">Clear</button>
      </div>
      {results.map((r, i) => (
        <div key={i} className="space-y-1.5">
          <p className="text-[11px] font-semibold text-slate-600">“{r.q}”</p>
          {r.cards.map((c, j) => <ResultCard key={j} card={c} />)}
        </div>
      ))}
    </div>
  )

  return (
    <>
      {sideResults && results.length > 0 && resultsSlot && createPortal(resultsPanel, resultsSlot)}
      {open && slot && createPortal(panel, slot)}
      {!open && createPortal(
        <button type="button" onClick={() => onOpenChange(true)}
          className="focus-ring absolute bottom-16 left-3 z-20 flex items-center gap-2 rounded-full bg-accent-500 px-4 py-2.5 text-sm font-medium text-white shadow-card-lg hover:bg-accent-600 md:bottom-3 md:left-auto md:right-16">
          <MessageCircle className="h-4 w-4" aria-hidden /> Ask the map
        </button>,
        container,
      )}
    </>
  )
}

function ResultCard({ card }: { card: Card }) {
  if (card.kind === 'done') {
    return <p className="flex items-start gap-1.5 text-slate-600"><span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-600" />{card.text}</p>
  }
  if (card.kind === 'note') {
    return <p className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-slate-600">{card.text}</p>
  }
  if (card.kind === 'overview') {
    return (
      <div className="rounded-lg border border-slate-200 bg-white">
        <p className="border-b border-slate-200 px-2.5 py-1.5 text-sm font-bold leading-none text-slate-900">Jharkhand at a glance</p>
        <dl className="divide-y divide-slate-100">
          {card.rows.map((r) => (
            <div key={r.label} className="px-2.5 py-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-slate-500">{r.label}</dt>
                <dd className="text-right font-semibold tabular-nums text-slate-900">{r.value}</dd>
              </div>
              <p className="text-[10px] leading-snug text-slate-400">{r.source}</p>
            </div>
          ))}
        </dl>
      </div>
    )
  }
  if (card.kind === 'facts') {
    return (
      <div className="rounded-lg border border-slate-200 bg-white">
        <p className="border-b border-slate-200 px-2.5 py-1.5 text-sm font-bold leading-none text-slate-900">{card.district}</p>
        <dl className="divide-y divide-slate-100">
          {card.rows.map((r) => (
            <div key={r.field} className="px-2.5 py-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-slate-500">{r.label}</dt>
                <dd className={`font-semibold tabular-nums ${r.value === 'NA' ? 'text-slate-300' : 'text-slate-900'}`}>{r.value}</dd>
              </div>
              <p className="text-[10px] leading-snug text-slate-400">{r.source}</p>
              {r.note && <p className="text-[10px] leading-snug text-slate-500">{r.note}</p>}
            </div>
          ))}
        </dl>
      </div>
    )
  }
  const max = Math.max(...card.rows.map((r) => r.value), 1)
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-2.5 py-2">
      <p className="mb-1.5 text-slate-500">
        {FIELD_DEFS[card.field].label}, {card.order === 'desc' ? 'highest first' : 'lowest first'}
      </p>
      <ol className="space-y-1.5">
        {card.rows.map((r, i) => (
          <li key={r.district}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-slate-900">{i + 1}. {r.district}</span>
              <span className="font-semibold tabular-nums text-slate-900">{r.text}</span>
            </div>
            <div className="mt-0.5 h-1.5 rounded-full bg-slate-100"><div className="h-1.5 rounded-full bg-accent-500" style={{ width: `${Math.max(3, (r.value / max) * 100)}%` }} /></div>
          </li>
        ))}
      </ol>
      <p className="mt-1.5 text-[10px] leading-snug text-slate-400">{fieldSource(card.field)}</p>
    </div>
  )
}
