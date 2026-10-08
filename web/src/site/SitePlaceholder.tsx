import { Band, PageHero } from './ui'

export default function SitePlaceholder({ title }: { title: string }) {
  return (
    <>
      <PageHero title={title} />
      <Band tone="cream">
        <p className="text-lg text-slate-600">Content coming soon.</p>
      </Band>
    </>
  )
}
