import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { Fragment, useLayoutEffect, type DependencyList, type RefObject } from 'react'

gsap.registerPlugin(ScrollTrigger)
export { gsap, ScrollTrigger }

export type Conditions = { motion: boolean; pin: boolean }
type Query = (selector: string) => Element[]

/** Runs `setup` inside a GSAP matchMedia scope; skipped entirely for reduced motion. */
export function useGsap(
  scope: RefObject<HTMLElement | null>,
  setup: (c: Conditions, q: Query) => void | (() => void),
  deps: DependencyList = [],
) {
  useLayoutEffect(() => {
    const el = scope.current
    if (!el) return
    const mm = gsap.matchMedia()
    mm.add(
      {
        motion: '(prefers-reduced-motion: no-preference)',
        // Pinned sequences need a tall viewport so the pinned block never clips.
        pin: '(min-width: 1024px) and (min-height: 640px) and (prefers-reduced-motion: no-preference)',
      },
      (ctx) => {
        const c = ctx.conditions as unknown as Conditions
        if (!c.motion) return
        return setup(c, (s) => gsap.utils.toArray<Element>(s, el))
      },
    )
    return () => mm.revert()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

/** Splits a line into masked words that rise into view (animated by the page hook). */
export function Words({ text }: { text: string }) {
  return (
    <>
      {text.split(' ').map((w, i) => (
        <Fragment key={i}>
          <span className="-mb-[0.15em] -mr-[0.08em] inline-block overflow-hidden pb-[0.15em] pr-[0.08em] align-top">
            <span data-word className="inline-block">
              {w}
            </span>
          </span>{' '}
        </Fragment>
      ))}
    </>
  )
}

export type Part = string | { em: string }

/** Text whose words light up as the reader scrolls through it. */
export function ScrubText({ parts, className = '' }: { parts: Part[]; className?: string }) {
  return (
    <span data-scrub className={className}>
      {parts.flatMap((p, k) => {
        const em = typeof p !== 'string'
        const text = typeof p === 'string' ? p : p.em
        return text
          .split(' ')
          .filter(Boolean)
          .map((w, i) => (
            <Fragment key={`${k}-${i}`}>
              <span data-w className={`inline-block ${em ? 'font-display text-[1.14em] italic' : ''}`}>
                {w}
              </span>{' '}
            </Fragment>
          ))
      })}
    </span>
  )
}
