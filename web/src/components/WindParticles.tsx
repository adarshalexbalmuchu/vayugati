import { useEffect, useRef } from 'react'
import type maplibregl from 'maplibre-gl'

export interface WindPoint {
  lng: number
  lat: number
  dir: number   // meteorological FROM direction (°): 0 = north
  speed: number // m/s
}

interface Props {
  map: maplibregl.Map | null
  points: WindPoint[]
  visible: boolean
  /** Light-blue glow strokes + a 'screen' canvas blend read clearly against
   *  a dark basemap (this component's original use on the Map page, which
   *  defaults to 'operational-dark') but wash out to near-invisible on a
   *  light basemap, since 'screen' only ever brightens. Set false when
   *  mounting over a light style (e.g. Overview's 'terrain' basemap) to
   *  switch to a darker stroke colour and a normal (non-blended) composite
   *  instead — added Sept 2026 when this component was reused there. */
  darkBasemap?: boolean
}

// Delhi metro bounding box — particles spawn and die here
const B = { w: 76.82, e: 77.42, s: 28.38, n: 28.90 }

const N_PARTICLES = 750
const TRAIL_FRAMES = 24
// Degrees per m/s per frame — tuned so a 5 m/s wind crosses Delhi in ~12 s at 60fps
const DEG_PER_MS_PER_FRAME = 0.00017

// Light-basemap tuning (Sept 2026) — the defaults above were designed for
// MapView.tsx's dark basemap and assume ~5 m/s wind; real current Delhi wind
// is often much calmer (~1-1.5 m/s), which at DEG_PER_MS_PER_FRAME made
// particles barely move — combined with 750 short, thick, near-identical
// strokes on a light background, the result read as static rain streaks,
// not flowing wind (screenshot feedback, Sept 2026). Three fixes:
//   1. Fewer particles — a light map reads a dense line field as noise/rain
//      the way a dark map reads it as atmospheric mist; it needs to look
//      sparse and deliberate instead.
//   2. A floor on animation speed, independent of the literal wind speed —
//      real wind is calm most of the time, and "correctly slow" should not
//      mean "visually frozen". This still scales up for genuinely fast
//      wind; it just stops calm wind from being indistinguishable from zero.
//   3. Longer, thinner, softer trails so each particle reads as a moving
//      streak with a visible head-to-tail gradient, not a static dash.
const N_PARTICLES_LIGHT = 220
const TRAIL_FRAMES_LIGHT = 40
const MIN_ANIMATED_SPEED_MS = 2.5 // floor used only for on-screen motion, never for the display value shown elsewhere

type Particle = {
  lng: number
  lat: number
  trail: [number, number][]  // screen [x, y] pairs, FIFO
  life: number
  maxLife: number
}

function spawn(): Particle {
  return {
    lng: B.w + Math.random() * (B.e - B.w),
    lat: B.s + Math.random() * (B.n - B.s),
    trail: [],
    life: 0,
    maxLife: 80 + Math.random() * 120,
  }
}

// Inverse-distance-weighted interpolation across ward centroids.
// Returns [u_lng, v_lat, speed] in world-coord units.
function idwWind(lng: number, lat: number, pts: WindPoint[]): [number, number, number] {
  if (pts.length === 0) return [0, 0, 0]
  let wu = 0, wv = 0, ws = 0, wt = 0
  for (const p of pts) {
    const d2 = (lng - p.lng) ** 2 + (lat - p.lat) ** 2
    const w = d2 < 1e-8 ? 1e8 : 1 / d2
    // dir is FROM; travel is (dir+180)%360
    const rad = ((p.dir + 180) % 360) * (Math.PI / 180)
    wu += Math.sin(rad) * p.speed * w
    wv += Math.cos(rad) * p.speed * w
    ws += p.speed * w
    wt += w
  }
  return [wu / wt, wv / wt, ws / wt]
}

export default function WindParticles({ map, points, visible, darkBasemap = true }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Stable refs so the rAF loop always reads the latest values
  const pointsRef = useRef(points)
  const visibleRef = useRef(visible)
  const darkBasemapRef = useRef(darkBasemap)
  useEffect(() => { pointsRef.current = points }, [points])
  useEffect(() => { darkBasemapRef.current = darkBasemap }, [darkBasemap])
  useEffect(() => {
    visibleRef.current = visible
    if (!visible) {
      const ctx = canvasRef.current?.getContext('2d')
      if (ctx && canvasRef.current) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
    }
  }, [visible])

  // Main animation loop — runs once per map instance
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !map) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const resize = () => {
      const el = map.getContainer()
      canvas.width = el.offsetWidth
      canvas.height = el.offsetHeight
    }
    resize()
    map.on('resize', resize)

    // darkBasemap is treated as fixed for the lifetime of this map instance
    // (neither call site changes it after mount) — read once here rather
    // than depending on it, since this effect only re-runs when `map`
    // itself changes.
    const isDarkMap = darkBasemapRef.current
    const particleCount = isDarkMap ? N_PARTICLES : N_PARTICLES_LIGHT
    const trailFrames = isDarkMap ? TRAIL_FRAMES : TRAIL_FRAMES_LIGHT
    const particles: Particle[] = Array.from({ length: particleCount }, spawn)

    // On any map movement the projected trail coords become stale — wipe them
    // so particles don't jump around. New trails form within 0.5 s.
    const clearTrails = () => { for (const p of particles) p.trail = [] }
    map.on('move', clearTrails)

    let rafId: number

    const tick = () => {
      const pts = pointsRef.current

      if (!visibleRef.current || pts.length === 0) {
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        rafId = requestAnimationFrame(tick)
        return
      }

      // Fade existing paint — creates the glowing trail persistence effect
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = 'rgba(0,0,0,0.05)'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.globalCompositeOperation = 'source-over'

      for (const p of particles) {
        const [u, v, spd] = idwWind(p.lng, p.lat, pts)
        // Animated speed has a floor on the light basemap only — real Delhi
        // wind is calm most of the time (often ~1-1.5 m/s), and at that
        // speed the raw physics made particles visually motionless. The
        // floor only affects how far the dot moves on screen each frame;
        // `spd` (used below for colour/width) stays the real, unfloored
        // value, so a genuinely calm reading still looks calm, it just
        // isn't indistinguishable from paused.
        const animSpeed = isDarkMap ? spd : Math.max(spd, MIN_ANIMATED_SPEED_MS)
        p.lng += u * (animSpeed / Math.max(spd, 0.01)) * DEG_PER_MS_PER_FRAME
        p.lat += v * (animSpeed / Math.max(spd, 0.01)) * DEG_PER_MS_PER_FRAME
        p.life++

        const { x, y } = map.project([p.lng, p.lat])
        p.trail.push([x, y])
        if (p.trail.length > trailFrames) p.trail.shift()

        const inB = p.lng >= B.w && p.lng <= B.e && p.lat >= B.s && p.lat <= B.n
        if (p.life >= p.maxLife || !inB) {
          Object.assign(p, spawn())
          p.trail = []
          continue
        }

        if (p.trail.length < 3) continue

        const t = Math.min(1, spd / 10)
        const fadeIn = Math.min(1, p.life / 25)
        const isDark = darkBasemapRef.current
        // Dark basemap: slow = cool blue (#64b4ff), fast = bright white-blue
        // (#c8eeff), relies on the 'screen' canvas blend (set below) to glow.
        // Light basemap: 'screen' only brightens, so light strokes wash out
        // to invisible on a light terrain/satellite style — use a darker,
        // more saturated blue at higher opacity with a normal composite
        // instead, so the same particles read clearly against either.
        const alpha = isDark ? fadeIn * (0.38 + t * 0.48) : fadeIn * (0.55 + t * 0.35)
        const r = isDark ? Math.round(100 + t * 100) : Math.round(20 + t * 40)
        const g = isDark ? Math.round(180 + t * 58) : Math.round(90 + t * 60)
        const b = isDark ? 255 : Math.round(200 + t * 55)

        ctx.beginPath()
        ctx.moveTo(p.trail[0][0], p.trail[0][1])
        for (let i = 1; i < p.trail.length; i++) ctx.lineTo(p.trail[i][0], p.trail[i][1])
        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`
        ctx.lineWidth = 0.9 + t * 0.6
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.stroke()
      }

      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafId)
      map.off('resize', resize)
      map.off('move', clearTrails)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
  }, [map])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        // 'screen' blend: on a dark basemap, particle light adds and glows.
        // On a light basemap 'screen' only ever brightens further (toward
        // white, i.e. invisible), so the normal composite ('normal', the
        // CSS default) is used instead — the darker/higher-opacity stroke
        // colours chosen above already read correctly without a blend mode.
        mixBlendMode: darkBasemap ? 'screen' : 'normal',
      }}
    />
  )
}
