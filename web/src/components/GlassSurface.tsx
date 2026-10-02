import type { ReactNode } from 'react'

/**
 * Apple-style "liquid glass" surface — adapted from the reference component
 * (Sept 2026 direct request) rather than the earlier blur-only approximation,
 * which the user correctly rejected as not the same effect. The real look
 * needs three stacked layers plus an SVG distortion filter, not just
 * `backdrop-blur` + translucency:
 *   1. A `backdrop-filter: blur(...) url(#glass-distortion)` layer — the
 *      filter warps whatever is behind it (map tiles, in our case) using
 *      the turbulence+displacement pipeline defined in <GlassFilterDefs>.
 *   2. A translucent white tint layer.
 *   3. An inset box-shadow layer faking the glass edge catching light.
 * Content renders in a fourth, un-filtered layer on top so text/controls
 * stay sharp — only the background behind the pill gets warped.
 */
export function GlassSurface({
  children,
  className = '',
  radiusClassName = 'rounded-3xl',
  ambientShadow = true,
}: {
  children: ReactNode
  /** Layout classes (flex/gap/padding/sizing) for the actual content —
   *  applied to the CONTENT layer, not the outer shell. Fixed bug (Sept
   *  2026): this used to land on the outer shell, which also stacks the
   *  three absolutely-positioned background layers as flex "children" —
   *  those are out of flow, so flex there did nothing, while the real
   *  content one level deeper had no sizing/layout of its own and
   *  collapsed to block layout, ballooning the bar's height. */
  className?: string
  /** Kept as a separate prop (not folded into className) because it has to
   *  be repeated on all three background layers, not just the outer shell. */
  radiusClassName?: string
  /** The reference component's soft all-around drop shadow, tuned for a
   *  small floating rounded dock. Bug fix (Sept 2026): AppShell's header
   *  uses this component at `rounded-none` for a full-width flush bar, not
   *  a floating pill — that same shadow then rendered as a soft, blurred
   *  rectangular band trailing below the entire header, reading as a
   *  disconnected "ghost" shape rather than a shadow anchored to it. Set
   *  false for any flush/edge-to-edge surface; leave true (default) for an
   *  actual floating pill like the Map/Overview toolbars, where the
   *  reference's shadow is correct as-is. */
  ambientShadow?: boolean
}) {
  return (
    <div
      className={`relative isolate overflow-hidden ${radiusClassName}`}
      style={ambientShadow ? { boxShadow: '0 6px 6px rgba(0,0,0,0.2), 0 0 20px rgba(0,0,0,0.1)' } : undefined}
    >
      <div
        className={`absolute inset-0 z-0 overflow-hidden ${radiusClassName}`}
        style={{ backdropFilter: 'blur(3px) url(#glass-distortion)', isolation: 'isolate' }}
      />
      <div className={`absolute inset-0 z-10 ${radiusClassName}`} style={{ background: 'rgba(255,255,255,0.25)' }} />
      <div
        className={`absolute inset-0 z-20 overflow-hidden ${radiusClassName}`}
        style={{
          boxShadow:
            'inset 2px 2px 1px 0 rgba(255,255,255,0.5), inset -1px -1px 1px 1px rgba(255,255,255,0.5)',
        }}
      />
      <div className={`relative z-30 ${className}`}>{children}</div>
    </div>
  )
}

/** The turbulence/displacement filter every <GlassSurface> references by
 *  url(#glass-distortion) — mounted once at the app root (or once per page
 *  that uses glass surfaces); an SVG <filter> has no visual output of its
 *  own; `display:none` on the host <svg> is safe. Copied from the
 *  reference implementation, unmodified — this is a known-good recipe, not
 *  something to hand-tune per use site. */
export function GlassFilterDefs() {
  return (
    <svg style={{ display: 'none' }} aria-hidden>
      <filter id="glass-distortion" x="0%" y="0%" width="100%" height="100%" filterUnits="objectBoundingBox">
        <feTurbulence type="fractalNoise" baseFrequency="0.001 0.005" numOctaves={1} seed={17} result="turbulence" />
        <feComponentTransfer in="turbulence" result="mapped">
          <feFuncR type="gamma" amplitude={1} exponent={10} offset={0.5} />
          <feFuncG type="gamma" amplitude={0} exponent={1} offset={0} />
          <feFuncB type="gamma" amplitude={0} exponent={1} offset={0.5} />
        </feComponentTransfer>
        <feGaussianBlur in="turbulence" stdDeviation={3} result="softMap" />
        <feSpecularLighting in="softMap" surfaceScale={5} specularConstant={1} specularExponent={100} lightingColor="white" result="specLight">
          <fePointLight x={-200} y={-200} z={300} />
        </feSpecularLighting>
        <feComposite in="specLight" operator="arithmetic" k1={0} k2={1} k3={1} k4={0} result="litImage" />
        <feDisplacementMap in="SourceGraphic" in2="softMap" scale={200} xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  )
}
