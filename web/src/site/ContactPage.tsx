import { BTN_PRIMARY, Band, Em, Lead, PageHero } from './ui'

const LINKEDIN = 'https://www.linkedin.com/in/adarshalexbalmuchu/'

export default function ContactPage() {
  return (
    <>
      <PageHero
        title={
          <>
            Get <Em>in touch</Em>
          </>
        }
        lead="For partnerships, pilots, data or questions about Vayu Gati, reach out on LinkedIn."
      />
      <Band tone="white">
        <Lead className="max-w-xl">Adarsh Alex Balmuchu, Founder</Lead>
        <a href={LINKEDIN} target="_blank" rel="noopener noreferrer" className={`${BTN_PRIMARY} mt-6`}>
          Connect on LinkedIn
        </a>
      </Band>
    </>
  )
}
