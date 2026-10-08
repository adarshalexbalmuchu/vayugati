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
  { title: 'Calibrated measurement', body: 'Affordable local sensors, tied to a trusted reference.' },
  { title: 'Quality assurance', body: 'Every sensor checked, ours and the government’s.' },
  { title: 'Ward-level intelligence', body: 'Estimates, forecasts and likely sources, with uncertainty.' },
  { title: 'A route to action', body: 'Alerts and tasks for ward officers, and evidence for untied grants.' },
]

export const SOURCES = [
  {
    label: 'EPIC, Air Quality Life Index: India Fact Sheet 2025',
    href: 'https://aqli.epic.uchicago.edu/files/India%20FactSheet_2025_GlobalWV.pdf',
  },
  {
    label: 'Health Effects Institute and IHME, State of Global Air 2025 (via Down To Earth)',
    href: 'https://www.downtoearth.org.in/air/air-pollution-damaging-brain-health-worsening-disease-burden-in-india-soga-2025',
  },
  {
    label: 'The Lancet Planetary Health, Health and economic impact of air pollution in the states of India (GBD 2019)',
    href: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7805008/',
  },
  { label: 'Census of India 2011, Jharkhand', href: 'https://www.census2011.co.in/census/state/jharkhand.html' },
  { label: 'Ministry of Coal, Coal Reserves (1 April 2025)', href: 'https://coal.gov.in/major-statistics/coal-reserves' },
  {
    label: 'Mongabay India, The burning coalfields of Jharia belch poison for local residents (2019)',
    href: 'https://india.mongabay.com/2019/10/the-burning-coalfields-of-jharia-belch-poison-for-local-residents/',
  },
  {
    label: 'CSE, Status of air quality monitoring in India (2023)',
    href: 'https://www.cseindia.org/Note-AQM-Network-analysis.pdf',
  },
  {
    label: 'PIB (MoEF&CC), Allocation of funds to 131 cities under NCAP (2023)',
    href: 'https://www.pib.gov.in/PressReleasePage.aspx?PRID=1989207',
  },
  {
    label: 'IITM, SAFAR: Metropolitan Air Quality and Weather Forecasting Services',
    href: 'https://www.tropmet.res.in/project_details.php?project_id=3&position=0',
  },
  { label: 'Vayu Gati analysis of CPCB real-time data via OpenAQ (Feb 2025 to Sep 2026)', href: 'https://openaq.org' },
  {
    label: 'PRS Legislative Research, Report of the 16th Finance Commission for 2026-31',
    href: 'https://prsindia.org/policy/report-summaries/report-of-the-16th-finance-commission-for-2026-31',
  },
  {
    label: 'Centre for Policy Research, Urban Challenge Fund to Support Tier 2 and Tier 3 Cities',
    href: 'https://cprindia.org/urban-challenge-fund-to-support-tier-2-and-tier-3-cities-a-new-impetus-for-spatially-dispersed-urban-growth-in-india/',
  },
  {
    label: 'Greenpeace India, Airpocalypse IV (via The Tribune, 2020)',
    href: 'https://www.tribuneindia.com/news/nation/jharkhands-jharia-most-polluted-city-delhi-reduces-air-pollution-marginally-greenpeace-report-29598',
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
    body: 'There is no data at all. Satellite and model estimates give a first picture but cannot replace local measurement: in our tests they explained about half the day-to-day variation in PM2.5 (R² 0.51), against 82% where a dense local network anchored them.',
  },
]

export const PHASES = [
  {
    label: 'Phase 1, 12 months',
    title: 'A pilot in the Dhanbad and Jharia coalfield',
    body: 'A solar-powered, 4G-connected node with two independent particle sensors, at about ₹20,000 a unit. 30 nodes, with 3 spares, calibrated beside the JSPCB reference station at Jorapokhar and run with local officials so that maps, forecasts and alerts are used, not just published.',
  },
  {
    label: 'Phase 2, 2 to 3 years',
    title: 'Scale and embed',
    body: 'Extend the network to more towns in Jharkhand and neighbouring states, publish the sensor design and calibration method openly, and work with the state pollution control board and urban local bodies so that calibrated low-cost data complements the reference network.',
  },
]

export const DELIVERABLES = [
  'An openly documented sensor design and calibration method, proven in high humidity and coal dust',
  'A dense, quality-checked air-quality dataset for one of India’s most polluted mining regions',
  'Ward-level maps, forecasts and alerts in daily use by local officials',
  'A costed playbook for taking any town from no data to actionable data',
]

export const FOUNDER = {
  name: 'Adarsh Alex Balmuchu',
  role: 'Founder',
  bio: [
    'At IIM Ranchi, while doing his bachelor’s, he and his friends set out to make a documentary on the lives of people in Jharia and Dhanbad. All his research in those years kept returning to the same subject: the lives of people in Jharkhand, their land and their rights, seen through sociology, psychology and the Constitution.',
    'Vayu Gati is the chance to turn that work into something that changes outcomes. In Jharia, fires burn in the coal beneath the ground and families breathe the smoke every day, while the nearest reference station can fail for months without anyone noticing. A town cannot protect people from air it cannot see.',
    'It is a platform that turns air quality data into ward-level maps, forecasts and alerts, alongside affordable, solar powered monitors for places where no data exists, starting with a proposed pilot in Dhanbad and Jharia, Jharkhand. The work brings together software development, spatial data and the validation of air quality calculations.',
  ],
  principles: [
    'Accurate public information',
    'Limitations stated plainly',
    'A working prototype before expanding',
  ],
}
