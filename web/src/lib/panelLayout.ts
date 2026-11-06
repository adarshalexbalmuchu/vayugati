/**
 * Panel layout for the Jharkhand map: drag, resize, and three arrangements (free, two panes, three panes).
 *
 * The geometry (layoutRects, clampRect) is pure and tested; PanelLayout wires it to DOM elements. Panels are positioned
 * absolutely inside the map container; in the pane layouts the map is padded so its content centres in the free space.
 * Below 768 px wide the layout is switched off and the CSS bottom-sheet layout applies. The arrangement is remembered
 * in localStorage.
 */

export type PanelId = 'layers' | 'dock' | 'legend' | 'toolbar'
export type LayoutMode = 'free' | 'two' | 'three'

/** h > 0: fixed height, anchored at y. h === 0: automatic height, anchored to the bottom edge. h === -1: automatic height, anchored at y. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const GAP = 8
export const COLUMN_W = 340
export const DOCK_W = 360
/** Room kept free at the right edge for the map's zoom and compass buttons. */
export const CONTROLS_W = 56
export const MIN_VISIBLE = 60

const MINS: Record<PanelId, { w: number; h: number }> = {
  layers: { w: 260, h: 220 },
  dock: { w: 300, h: 260 },
  legend: { w: 140, h: 40 },
  toolbar: { w: 200, h: 40 },
}
export const minSize = (id: PanelId) => MINS[id]

export interface LayoutResult {
  rects: Partial<Record<PanelId, Rect>>
  /** How much of the map's left and right edges the panels cover. */
  padding: { left: number; right: number }
}

const TOOLBAR_W = 520
const LEGEND_W = 230

export function layoutRects(mode: LayoutMode, W: number, H: number): LayoutResult {
  if (mode === 'free') return { rects: {}, padding: { left: 0, right: 0 } }
  const leftCol = COLUMN_W + 2 * GAP
  if (mode === 'two') {
    // One column on the left: layers above, dock below. The map takes the rest.
    const avail = H - 3 * GAP
    const lh = Math.round(avail * 0.5)
    const mapRight = W - GAP
    return {
      rects: {
        layers: { x: GAP, y: GAP, w: COLUMN_W, h: lh },
        dock: { x: GAP, y: 2 * GAP + lh, w: COLUMN_W, h: avail - lh },
        legend: { x: leftCol + GAP, y: 0, w: 0, h: 0 },
        toolbar: { x: Math.max(leftCol + GAP, Math.round(leftCol + (mapRight - leftCol - TOOLBAR_W) / 2)), y: 0, w: 0, h: 0 },
      },
      padding: { left: leftCol, right: 0 },
    }
  }
  // three: layers on the left, dock on the right, the map between them.
  const dockX = W - CONTROLS_W - DOCK_W - GAP
  const mapRight = dockX - GAP
  return {
    rects: {
      layers: { x: GAP, y: GAP, w: COLUMN_W, h: H - 2 * GAP },
      dock: { x: dockX, y: GAP, w: DOCK_W, h: H - GAP - 64 }, // bottom room for the "Ask the map" button
      legend: { x: leftCol + GAP, y: 0, w: 0, h: 0 },
      toolbar: { x: Math.max(leftCol + GAP, Math.round(leftCol + (mapRight - leftCol - TOOLBAR_W) / 2)), y: 0, w: 0, h: 0 },
    },
    padding: { left: leftCol, right: W - dockX + GAP },
  }
}

/** Keep a panel inside the container with at least MIN_VISIBLE px of it showing, and above the bottom edge. */
export function clampRect(r: Rect, W: number, H: number, id?: PanelId): Rect {
  const min = id ? MINS[id] : { w: 120, h: 40 }
  const w = Math.min(Math.max(r.w, r.w > 0 ? min.w : 0), Math.max(W, min.w))
  const h = r.h > 0 ? Math.min(Math.max(r.h, min.h), Math.max(H, min.h)) : r.h
  const x = Math.min(Math.max(r.x, MIN_VISIBLE - (w || LEGEND_W)), W - MIN_VISIBLE)
  const y = h === 0 ? r.y : Math.min(Math.max(r.y, 0), H - 30)
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: h > 0 ? Math.round(h) : h }
}

/** Resize from the bottom-right corner, never below the panel's minimum and never past the container. */
export function resizeRect(start: Rect, dx: number, dy: number, W: number, H: number, id: PanelId): Rect {
  const min = MINS[id]
  const w = Math.min(Math.max(start.w + dx, min.w), Math.max(min.w, W - start.x))
  const h = start.h > 0 ? Math.min(Math.max(start.h + dy, min.h), Math.max(min.h, H - start.y)) : start.h
  return { ...start, w: Math.round(w), h: Math.round(h) }
}

// ── the DOM wiring ───────────────────────────────────────────────────────────────────────────────────────────────

interface Registered {
  el: HTMLElement
  handles: HTMLElement[]
  resizable: boolean
}

const INTERACTIVE = 'button,input,select,textarea,label,a'

export class PanelLayout {
  mode: LayoutMode = 'free'
  private panels = new Map<PanelId, Registered>()
  private free: Partial<Record<PanelId, Rect>> = {}
  private z = 20
  private onResize = () => this.apply()

  constructor(
    private container: HTMLElement,
    private onPadding: (p: { left: number; right: number }) => void,
    private onChange: (mode: LayoutMode) => void = () => {},
    private storageKey = 'vg-jh-layout-v1',
  ) {
    try {
      const saved = JSON.parse(localStorage.getItem(this.storageKey) ?? 'null') as { mode?: LayoutMode; free?: Partial<Record<PanelId, Rect>> } | null
      if (saved?.mode && ['free', 'two', 'three'].includes(saved.mode)) this.mode = saved.mode
      if (saved?.free) this.free = saved.free
    } catch {
      // storage unavailable: start with the defaults
    }
    window.addEventListener('resize', this.onResize)
  }

  destroy() {
    window.removeEventListener('resize', this.onResize)
    this.onPadding({ left: 0, right: 0 })
  }

  /** Padding the current layout asks of the map (0 in free mode or on small screens). */
  reserved(): { left: number; right: number } {
    if (!this.enabled() || this.mode === 'free') return { left: 0, right: 0 }
    return layoutRects(this.mode, this.container.clientWidth, this.container.clientHeight).padding
  }

  private enabled() {
    return this.container.clientWidth >= 768
  }

  register(id: PanelId, el: HTMLElement, opts: { handles: HTMLElement[]; resizable?: boolean }) {
    this.panels.set(id, { el, handles: opts.handles, resizable: !!opts.resizable })
    el.addEventListener('pointerdown', () => { el.style.zIndex = String(++this.z) })
    for (const h of opts.handles) {
      h.classList.add('cursor-grab')
      h.addEventListener('pointerdown', (e) => this.startDrag(id, e as PointerEvent, h))
    }
    if (opts.resizable) {
      const grip = document.createElement('div')
      grip.className = 'absolute bottom-0 right-0 z-20 hidden h-4 w-4 cursor-nwse-resize md:block'
      grip.title = 'Drag to resize'
      grip.innerHTML = '<svg viewBox="0 0 16 16" class="h-4 w-4 text-slate-400"><path d="M14 6 6 14M14 10l-4 4M14 2 2 14" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>'
      grip.addEventListener('pointerdown', (e) => this.startResize(id, e))
      el.appendChild(grip)
    }
  }

  setMode(mode: LayoutMode) {
    this.mode = mode
    this.apply()
    this.save()
    this.onChange(mode)
  }

  reset() {
    this.free = {}
    this.setMode('free')
  }

  /** Apply the current mode to every panel. */
  apply() {
    const W = this.container.clientWidth
    const H = this.container.clientHeight
    if (!this.enabled()) {
      for (const p of this.panels.values()) this.clear(p.el)
      this.onPadding({ left: 0, right: 0 })
      return
    }
    if (this.mode === 'free') {
      for (const [id, p] of this.panels) {
        const r = this.free[id]
        if (r) this.place(p.el, clampRect(r, W, H, id))
        else this.clear(p.el)
      }
      this.onPadding({ left: 0, right: 0 })
      return
    }
    const { rects, padding } = layoutRects(this.mode, W, H)
    for (const [id, p] of this.panels) {
      const r = rects[id]
      if (r) this.place(p.el, r)
    }
    this.onPadding(padding)
  }

  private place(el: HTMLElement, r: Rect) {
    el.style.left = `${r.x}px`
    el.style.right = 'auto'
    el.style.transform = 'none'
    if (r.h > 0) {
      el.style.top = `${r.y}px`
      el.style.bottom = 'auto'
      el.style.height = `${r.h}px`
      el.style.maxHeight = 'none'
      el.dataset.sized = '1'
    } else if (r.h === -1) {
      el.style.top = `${r.y}px`
      el.style.bottom = 'auto'
      el.style.height = 'auto'
      delete el.dataset.sized
    } else {
      el.style.top = 'auto'
      el.style.bottom = '12px'
      el.style.height = 'auto'
      delete el.dataset.sized
    }
    if (r.w > 0) {
      el.style.width = `${r.w}px`
      el.style.maxWidth = 'none'
    } else el.style.width = ''
  }

  private clear(el: HTMLElement) {
    for (const k of ['left', 'right', 'top', 'bottom', 'width', 'height', 'maxHeight', 'maxWidth', 'transform'] as const) el.style[k] = ''
    delete el.dataset.sized
  }

  /** The panel's current box inside the container, as a Rect (fixed height if it has one, else automatic). */
  private measure(id: PanelId): Rect {
    const p = this.panels.get(id)!
    const c = this.container.getBoundingClientRect()
    const b = p.el.getBoundingClientRect()
    const sized = p.el.dataset.sized === '1'
    return { x: Math.round(b.left - c.left), y: Math.round(b.top - c.top), w: Math.round(b.width), h: sized ? Math.round(b.height) : -1 }
  }

  /** Leaving a pane layout by dragging: freeze today's arrangement as the free layout first. */
  private toFree() {
    if (this.mode === 'free') return
    const W = this.container.clientWidth
    const H = this.container.clientHeight
    const { rects } = layoutRects(this.mode, W, H)
    this.free = {}
    for (const id of this.panels.keys()) {
      const r = id in rects ? this.measure(id) : undefined
      if (r) this.free[id] = r
    }
    this.mode = 'free'
    this.onPadding({ left: 0, right: 0 })
    this.onChange('free')
  }

  private startDrag(id: PanelId, e: PointerEvent, handle: HTMLElement) {
    if (!this.enabled() || e.button !== 0) return
    if ((e.target as HTMLElement).closest(INTERACTIVE) && !(e.target as HTMLElement).closest('summary')) return
    const sx = e.clientX
    const sy = e.clientY
    let started = false
    let start: Rect
    const p = this.panels.get(id)!
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx
      const dy = ev.clientY - sy
      if (!started) {
        if (Math.abs(dx) + Math.abs(dy) < 5) return
        started = true
        this.toFree()
        start = this.measure(id)
        this.place(p.el, start)
        handle.setPointerCapture?.(e.pointerId)
        handle.classList.replace('cursor-grab', 'cursor-grabbing')
      }
      const r = clampRect({ ...start, x: start.x + dx, y: start.y + dy }, this.container.clientWidth, this.container.clientHeight, id)
      this.place(p.el, r)
      this.free[id] = r
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      handle.classList.replace('cursor-grabbing', 'cursor-grab')
      if (started) {
        // a drag must not also toggle a <summary> it started on
        const swallow = (ev: Event) => { ev.preventDefault(); ev.stopPropagation() }
        handle.addEventListener('click', swallow, { capture: true, once: true })
        setTimeout(() => handle.removeEventListener('click', swallow, true), 0)
        this.save()
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  private startResize(id: PanelId, e: PointerEvent) {
    if (!this.enabled() || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    this.toFree()
    const p = this.panels.get(id)!
    p.el.dataset.sized = '1'
    const b = p.el.getBoundingClientRect()
    const c = this.container.getBoundingClientRect()
    const start: Rect = { x: Math.round(b.left - c.left), y: Math.round(b.top - c.top), w: Math.round(b.width), h: Math.round(b.height) }
    const sx = e.clientX
    const sy = e.clientY
    const move = (ev: PointerEvent) => {
      const r = resizeRect(start, ev.clientX - sx, ev.clientY - sy, this.container.clientWidth, this.container.clientHeight, id)
      this.place(p.el, r)
      this.free[id] = r
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      this.save()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  private save() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify({ mode: this.mode, free: this.free }))
    } catch {
      // storage unavailable: the arrangement just is not remembered
    }
  }
}
