export const CAPABILITIES = [
  {
    title: 'Ward-level estimates',
    body: 'Air quality for every ward, including wards with no monitor, with honest uncertainty ranges tested against monitors held out of training. Daily PM2.5 R² of 0.82 within Delhi.',
  },
  {
    title: 'Forecasts you can trust',
    body: 'Six pollutants forecast, with a machine-learning model served only where it beats simple rules in weekly back-tests.',
  },
  {
    title: 'Faulty sensors flagged',
    body: 'Stuck analysers accounted for 18% of NO₂ monitor-days across the Indo-Gangetic plain. Every reading is checked before anyone acts on it.',
  },
  {
    title: 'Alerts and tasks for officers',
    body: 'Alerts and tasks are routed to ward officers, so information turns into action on the ground.',
  },
]

export const LEVERS = [
  { title: 'Calibrated measurement', body: 'Six pollutants measured at neighbourhood scale, checked against reference stations.' },
  { title: 'Quality assurance', body: 'Every sensor checked, ours and the government’s.' },
  { title: 'Ward-level evidence', body: 'Where and when the air is worst, with honest uncertainty.' },
  { title: 'A route to action', body: 'Decisions agreed with officials in advance, and the air measured before and after.' },
]

export const SOURCES = [
  {
    label: 'CSE, Status of air quality monitoring in India (2023)',
    href: 'https://www.cseindia.org/Note-AQM-Network-analysis.pdf',
  },
  {
    label: 'EPIC, Air Quality Life Index: India Fact Sheet 2025',
    href: 'https://aqli.epic.uchicago.edu/files/India%20FactSheet_2025_GlobalWV.pdf',
  },
  {
    label: 'CREA, Tracing the Hazy Air 2026: Progress Report on NCAP (January 2026)',
    href: 'https://energyandcleanair.org/wp/wp-content/uploads/2026/01/CREA_Tracing-the-Hazy-Air-2026_-Progress-Report-on-National-Clean-Air-Programme-NCAP.pdf',
  },
  {
    label: 'NITI Aayog, National Multidimensional Poverty Index: A Progress Review 2023',
    href: 'https://www.niti.gov.in/sites/default/files/2023-08/India-National-Multidimentional-Poverty-Index-2023.pdf',
  },
  {
    label: 'CPCB, Ambient Air Quality Monitoring Network (Manual) under NAMP, as on 19 November 2024',
    href: 'https://cpcb.gov.in/uploads/Stations_NAMP.pdf',
  },
  {
    label: 'CPCB, National Air Quality Index daily bulletins, September to October 2026',
    href: 'https://cpcb.nic.in/upload/Downloads/AQI_Bulletin_20261027.pdf',
  },
  { label: 'Vayu Gati analysis of CPCB real-time data via OpenAQ (Feb 2025 to Sep 2026)', href: 'https://openaq.org' },
  {
    label: 'JSPCB, Tender for 15 continuous air-quality monitoring stations (December 2025)',
    href: 'https://my.jspcb.org.in/upload/file/CAAQMS%20Final%20Tender%20doc..pdf',
  },
  {
    label: 'MoEF&CC (2022), as compiled by CSPS India, Air Quality Monitoring Measures in India',
    href: 'https://cspsindia.org/air-quality-monitoring-measures-in-india',
  },
  {
    label: 'Mongabay India, The burning coalfields of Jharia belch poison for local residents (2019)',
    href: 'https://india.mongabay.com/2019/10/the-burning-coalfields-of-jharia-belch-poison-for-local-residents/',
  },
  {
    label: 'The Week, Cabinet clears revised Jharia Master Plan (June 2025)',
    href: 'https://www.theweek.in/news/india/2025/06/25/jharia-s-burning-belly-gets-a-fresh-lifeline-cabinet-clears-revised-rs-5-940-cr-rehabilitation-plan.html',
  },
  {
    label: 'Suresh et al., Real-time air quality monitoring with low-cost sensors in a Jharia surface mine (Sustainability, 2025)',
    href: 'https://ideas.repec.org/a/gam/jsusta/v17y2025i3p1301-d1584416.html',
  },
  {
    label: 'PIB (MoEF&CC), Allocation of funds to 131 cities under NCAP (2023)',
    href: 'https://www.pib.gov.in/PressReleasePage.aspx?PRID=1989207',
  },
  {
    label: 'Government of Jharkhand, report to the National Green Tribunal in O.A. 687 of 2023',
    href: 'https://www.greentribunal.gov.in/sites/default/files/news_updates/REPORT%20BY%20GOVT.%20OF%20JHARKHAND%20IN%20OA%20NO.687%20of%202023%20AIR%20QUALITY%20INDEX%20IN%20VARIOUS%20CITIES.pdf',
  },
  {
    label: 'CSTEP, Why NCAP must identify emerging air pollution hotspots (Deccan Herald, October 2026)',
    href: 'https://www.deccanherald.com/opinion/call-for-preemptive-action-why-ncap-must-identify-emerging-air-pollution-hotspots-before-it-is-too-late-4184485',
  },
  { label: 'Breathe London, About the network', href: 'https://breathelondon.org/about' },
  {
    label: 'RIVM, Eight years of Samen Meten: 4,000 sensors (February 2025)',
    href: 'https://www.rivm.nl/nieuws/opbrengst-van-acht-jaar-samen-meten-4000-sensoren-en-7-miljard-metingen',
  },
  {
    label: 'Ministry of Ecology and Environment, China, on Beijing’s micro-monitoring stations (2017)',
    href: 'https://www.mee.gov.cn/gkml/hbb/jytafw/201709/t20170928_422694.htm',
  },
]

export const SITUATIONS = [
  {
    range: 'Within 2 km of a monitor',
    share: 'about 4% of Indians',
    body: 'One station describes one point, and its data can fail for months unnoticed. What is needed is routine quality control and a way to extend each reading across a ward or town.',
  },
  {
    range: '2 to 50 km from a monitor',
    share: 'about 49% of Indians',
    body: 'A distant station is the only reference, and it cannot see a colliery, a brick kiln or a smouldering waste dump. What is needed is local measurement, calibrated against that station.',
  },
  {
    range: 'More than 50 km from a monitor',
    share: 'about 47% of Indians, some 655 million people',
    body: 'There is no nearby ground measurement. Satellite and model estimates give a first picture but are not enough on their own: in our tests they explained about half the day-to-day variation in PM2.5 (R² 0.51), against 82% where local monitors anchored them.',
  },
]

export const PHASES = [
  {
    label: 'First',
    title: 'Starting in Dhanbad–Jharia',
    body: 'We are building a small, solar-powered monitor that measures six pollutants: PM2.5, PM10, NO₂, O₃, SO₂ and CO. After testing it beside government reference stations, we will place twelve across the coalfield: near mines, haul roads, schools and the town centre. Every reading will be public.',
  },
  {
    label: 'Next',
    title: 'More towns, if it works',
    body: 'If the monitors prove reliable and useful, we will add more across the coalfield and bring the approach to other towns where the air is getting worse. The monitor’s design and the way we calibrate it will be published openly.',
  },
]

export const DELIVERABLES = [
  'A public map of the air across Dhanbad–Jharia, with every value labelled as measured, estimated, flagged or unavailable',
  'Warnings for schools and health centres on the worst days',
  'An honest report on how well the monitors work, including where they fall short',
  'An open monitor design that others can build on',
]

export const FOUNDER = {
  name: 'Adarsh Alex Balmuchu',
  role: 'Founder',
  bio: [
    'Picture living in Jharia, where fires burn in the coal beneath the ground and the smoke reaches your home every day. The nearest reference station can fail for months without anyone noticing, so when you ask how bad the air is, nobody can give you a number. A town cannot protect people from air it cannot see.',
    'His interest began at IIM Ranchi, where, while doing his bachelor’s, he and his friends set out to make a documentary on the lives of people in Jharia and Dhanbad. All his research in those years kept returning to the same subject: the lives of people in Jharkhand, their land and their rights, seen through sociology, psychology and the Constitution.',
    'Vayu Gati is his chance to turn that work into something that changes outcomes: a platform that turns air quality data into ward-level maps, forecasts and alerts, alongside solar-powered monitors for places with little reliable data, starting with a proposed pilot in Dhanbad and Jharia, Jharkhand. It brings together software development, spatial data and the validation of air quality calculations.',
  ],
  principles: [
    'Accurate public information',
    'Limitations stated plainly',
    'A working prototype before expanding',
  ],
}
