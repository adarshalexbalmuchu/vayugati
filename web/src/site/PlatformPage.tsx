import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { CAPABILITIES } from './content'
import { DelhiWardMap } from './maps'
import { BTN_PRIMARY, Band, Em, H2, Lead, PageHero } from './ui'

export default function PlatformPage() {
  const { session } = useAuth()
  return (
    <>
      <PageHero
        title={
          <>
            From air-quality information <Em>to local action</Em>
          </>
        }
        lead="A working platform, validated on live data from Delhi's 44 official monitors."
      >
        <Link to="/app" className={BTN_PRIMARY}>
          {session ? 'Open the platform' : 'Sign in to open the platform'}
        </Link>
      </PageHero>

      <Band tone="white">
        <div className="grid items-center gap-14 lg:grid-cols-2">
          <div>
            <H2>
              The ward is the <Em>unit of action</Em>
            </H2>
            <Lead className="mt-5">
              Officers answer for wards, so the platform estimates air quality for every ward, including wards with no
              monitor, and routes alerts and tasks to the officer who can act.
            </Lead>
          </div>
          <DelhiWardMap />
        </div>
      </Band>

      <Band tone="cream">
        <div className="grid gap-x-10 gap-y-10 sm:grid-cols-2">
          {CAPABILITIES.map((c) => (
            <div key={c.title} data-reveal className="border-t border-ink-900/20 pt-4">
              <h2 className="text-lg font-semibold">{c.title}</h2>
              <p className="mt-2 leading-relaxed text-slate-600">{c.body}</p>
            </div>
          ))}
        </div>
      </Band>
    </>
  )
}
