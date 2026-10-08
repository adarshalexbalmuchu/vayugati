import { useEffect, useRef, useState, type ReactNode } from 'react'

export function useInView<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true)
      return
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setSeen(true)
          io.disconnect()
        }
      },
      { threshold: 0.05, rootMargin: '0px 0px -8% 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [seen])
  return [ref, seen] as const
}

export function Container({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto max-w-6xl px-5 sm:px-8 ${className}`}>{children}</div>
}

type Tone = 'sky' | 'cream' | 'white' | 'ink'

const TONES: Record<Tone, string> = {
  sky: 'bg-gradient-to-b from-sky-200 to-sky-100 text-ink-900',
  cream: 'bg-cream text-ink-900',
  white: 'bg-white text-ink-900',
  ink: 'bg-ink-900 text-cream',
}

export function Band({
  tone = 'white',
  id,
  children,
  className = '',
  fill = false,
}: {
  tone?: Tone
  id?: string
  children: ReactNode
  className?: string
  /** Full-viewport height on large screens, content centred (used by pinned sections). */
  fill?: boolean
}) {
  return (
    <section
      id={id}
      className={`scroll-mt-24 ${TONES[tone]} ${fill ? 'lg:flex lg:h-screen lg:items-center' : ''} ${className}`}
    >
      <Container className={`py-16 sm:py-24 ${fill ? 'w-full lg:pb-8 lg:pt-24' : ''}`}>{children}</Container>
    </section>
  )
}

/** One serif-italic word or phrase inside a sans heading. */
export function Em({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <em className={`font-display text-[1.14em] font-normal italic ${className}`}>{children}</em>
}

export function H2({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <h2 className={`text-3xl font-semibold leading-tight tracking-[-0.015em] text-balance sm:text-4xl ${className}`}>{children}</h2>
}

export function Lead({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`text-lg leading-relaxed opacity-75 ${className}`}>{children}</p>
}

export function Stat({ value, label }: { value: string; label: string }) {
  // "~2 million" -> prefix "~", number 2, suffix " million"; the page hook counts the number up.
  const m = value.match(/^(\D*?)(\d+(?:\.\d+)?)(.*)$/)
  const count = m ? { 'data-count': m[2], 'data-prefix': m[1], 'data-suffix': m[3] } : {}
  return (
    <div data-reveal>
      <div {...count} className="font-display text-6xl leading-none sm:text-7xl">
        {value}
      </div>
      <p className="mt-3 max-w-[16rem] text-sm leading-snug opacity-70">{label}</p>
    </div>
  )
}

export function PageHero({ title, lead, children }: { title: ReactNode; lead?: ReactNode; children?: ReactNode }) {
  return (
    <section className="bg-gradient-to-b from-sky-300 via-sky-200 to-sky-100 text-ink-900">
      <Container className="pb-14 pt-36 sm:pb-20 sm:pt-44">
        <h1 className="max-w-3xl text-4xl font-semibold leading-[1.1] tracking-[-0.015em] sm:text-5xl lg:text-6xl">
          {title}
        </h1>
        {lead && <Lead className="mt-6 max-w-2xl">{lead}</Lead>}
        {children && <div className="mt-8">{children}</div>}
      </Container>
    </section>
  )
}

export const BTN_PRIMARY =
  'inline-flex items-center gap-2 rounded-md bg-ink-900 px-5 py-3 text-sm font-medium text-cream transition hover:bg-ink-700'
export const TEXT_LINK =
  'inline-flex items-center gap-1.5 font-medium text-accent-700 underline-offset-4 hover:underline'

export function DataTable({
  head,
  rows,
  source,
  boldLastRow = false,
}: {
  head: string[]
  rows: ReactNode[][]
  source?: string
  boldLastRow?: boolean
}) {
  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-ink-900/10 bg-white">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead>
            <tr className="border-b border-ink-900/10 text-slate-500">
              {head.map((h, i) => (
                <th key={i} scope="col" className="px-5 py-3 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-900/10">
            {rows.map((row, r) => (
              <tr key={r} className={boldLastRow && r === rows.length - 1 ? 'font-semibold' : ''}>
                {row.map((cell, c) => (
                  <td key={c} className={`px-5 py-3.5 ${c === 0 ? 'font-medium text-ink-900' : 'text-slate-700'}`}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {source && <p className="mt-3 text-xs text-slate-500">{source}</p>}
    </div>
  )
}
