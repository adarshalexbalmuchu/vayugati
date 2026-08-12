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
}

// Delhi metro bounding box — particles spawn and die here
const B = { w: 76.82, e: 77.42, s: 28.38, n: 28.90 }

const N_PARTICLES = 750
const TRAIL_FRAMES = 24
// Degrees per m/s per frame — tuned so a 5 m/s wind crosses Delhi in ~12 s at 60fps
const DEG_PER_MS_PER_FRAME = 0.00017

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

export default function WindParticles({ map, points, visible }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Stable refs so the rAF loop always reads the latest values
  const pointsRef = useRef(points)
  const visibleRef = useRef(visible)
  useEffect(() => { pointsRef.current = points }, [points])
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

    const particles: Particle[] = Array.from({ length: N_PARTICLES }, spawn)

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
        p.lng += u * DEG_PER_MS_PER_FRAME
        p.lat += v * DEG_PER_MS_PER_FRAME
        p.life++

        const { x, y } = map.project([p.lng, p.lat])
        p.trail.push([x, y])
        if (p.trail.length > TRAIL_FRAMES) p.trail.shift()

        const inB = p.lng >= B.w && p.lng <= B.e && p.lat >= B.s && p.lat <= B.n
        if (p.life >= p.maxLife || !inB) {
          Object.assign(p, spawn())
          p.trail = []
          continue
        }

        if (p.trail.length < 3) continue

        // Colour: slow = cool blue (#64b4ff), fast = bright white-blue (#c8eeff)
        const t = Math.min(1, spd / 10)
        const fadeIn = Math.min(1, p.life / 25)
        const alpha = fadeIn * (0.38 + t * 0.48)
        const r = Math.round(100 + t * 100)
        const g = Math.round(180 + t * 58)

        ctx.beginPath()
        ctx.moveTo(p.trail[0][0], p.trail[0][1])
        for (let i = 1; i < p.trail.length; i++) ctx.lineTo(p.trail[i][0], p.trail[i][1])
        ctx.strokeStyle = `rgba(${r},${g},255,${alpha})`
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
        // 'screen' blend: on a dark basemap, particle light adds and glows
        mixBlendMode: 'screen',
      }}
    />
  )
}
