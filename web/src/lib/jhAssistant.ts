import type { FactField } from './jhFacts'

/** Actions the Jharkhand assistant backend returns (ingest/app/jh_assistant.py). */
export type AssistantAction =
  | { type: 'set_layers'; on: string[]; off: string[]; only: boolean }
  | { type: 'go_to'; kind: 'state' | 'district' | 'place'; name?: string | null; lng?: number | null; lat?: number | null }
  | { type: 'rank'; field: FactField; order: 'desc' | 'asc'; limit: number; open_top?: boolean }
  | { type: 'facts'; district: string; fields: FactField[] }
  | { type: 'zoom'; direction: 'in' | 'out' }
  | { type: 'overview' }
  | { type: 'unsupported'; reason: string }

export interface AssistantResponse {
  reply: string
  actions: AssistantAction[]
}

export interface AssistantTurn {
  role: 'user' | 'assistant'
  text: string
}

const INGEST_URL = (import.meta.env.VITE_INGEST_URL as string) || 'http://localhost:8000'

export interface MapStateForAssistant {
  layers_on: string[]
  district: string | null
  zoom: number | null
  view3d: boolean
}

export type AskResult = { ok: true; data: AssistantResponse } | { ok: false; reason: string }

export async function askAssistant(
  question: string,
  history: AssistantTurn[],
  layers: { key: string; label: string; note?: string }[],
  state?: MapStateForAssistant,
): Promise<AskResult> {
  try {
    const res = await fetch(`${INGEST_URL}/jharkhand/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history: history.slice(-6), layers, state }),
      signal: AbortSignal.timeout(30_000),
    })
    if (res.status === 429) return { ok: false, reason: 'Too many questions just now. Please try again in a little while.' }
    if (!res.ok) return { ok: false, reason: 'The assistant is not available right now.' }
    return { ok: true, data: (await res.json()) as AssistantResponse }
  } catch {
    return { ok: false, reason: 'Could not reach the assistant. Check your connection and try again.' }
  }
}
