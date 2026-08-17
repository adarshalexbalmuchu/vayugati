#!/usr/bin/env tsx
/**
 * Links each of the 13 seeded hotspot wards (`wards.is_hotspot = true`) to
 * the real MCD ward polygon that contains its lat/lng, so the Overview map
 * can render a true choropleth fill instead of a colored dot.
 *
 * Delhi's 250 MCD ward boundaries (imported by import-delhi-wards.ts) are
 * far more granular than the 13 hotspot localities - every hotspot's seed
 * coordinate falls inside exactly one MCD ward polygon (verified against
 * data/delhi/processed/delhi_wards.geojson before writing this script).
 * This script finds that containing polygon by point-in-polygon test (ray
 * casting - same algorithm as
 * web/src/lib/incidentLocationRules.ts#pointInGeometry, duplicated here so
 * this script has no dependency on the Vite app's module graph) and copies
 * its geometry onto the hotspot's own `boundary` column, tagging
 * `metadata.donor_ward_number` so the frontend can hide the now-redundant
 * MCD ward polygon underneath it.
 *
 * Only ever UPDATEs rows where is_hotspot = true, matched by id - never
 * touches the 250 imported municipal-boundary rows, and never overwrites a
 * hotspot row that already has a boundary.
 *
 * Usage:
 *   npm run link:hotspot-ward-boundaries -- --dry-run   (no writes, prints a report)
 *   npm run link:hotspot-ward-boundaries                (writes, same report after)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const GEOJSON_PATH = path.join(REPO_ROOT, 'data/delhi/processed/delhi_wards.geojson')
const SOURCE_DOCUMENT = 'data/delhi/processed/delhi_wards.geojson (point-in-polygon match against hotspot seed lat/lng)'
const MIN_WARD_NO = 1
const MAX_WARD_NO = 250

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  dotenv.config({ path: path.join(REPO_ROOT, 'ingest/.env') })
}

interface RawGeometry {
  type: 'Polygon' | 'MultiPolygon'
  coordinates: unknown
}

interface RawFeature {
  type: 'Feature'
  properties: Record<string, string | null>
  geometry: RawGeometry
}

// Ray casting (Jordan curve theorem) - point-in-polygon, no external GIS lib needed.
function raycastInsideRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

function pointInPolygonRings(lng: number, lat: number, rings: number[][][]): boolean {
  if (rings.length === 0) return false
  if (!raycastInsideRing(lng, lat, rings[0])) return false
  // Holes: a point inside a hole is outside the polygon.
  for (let i = 1; i < rings.length; i++) {
    if (raycastInsideRing(lng, lat, rings[i])) return false
  }
  return true
}

function pointInGeometry(lat: number, lng: number, geometry: RawGeometry): boolean {
  if (geometry.type === 'Polygon') {
    return pointInPolygonRings(lng, lat, geometry.coordinates as number[][][])
  }
  return (geometry.coordinates as number[][][][]).some((rings) =>
    pointInPolygonRings(lng, lat, rings as number[][][]),
  )
}

interface HotspotRow {
  id: number
  name: string
  lat: number | null
  lng: number | null
  boundary: unknown
  metadata: Record<string, unknown> | null
}

interface MatchedHotspot {
  id: number
  name: string
  donorWardNumber: number
  donorWardName: string
  geometry: RawGeometry
  metadata: Record<string, unknown>
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Set them in the environment or in ingest/.env (never committed).',
    )
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  const fc = JSON.parse(fs.readFileSync(GEOJSON_PATH, 'utf8')) as { features: RawFeature[] }
  const mcdWards = fc.features.filter((f) => {
    const wardNo = Number(f.properties.Ward_No)
    return Number.isInteger(wardNo) && wardNo >= MIN_WARD_NO && wardNo <= MAX_WARD_NO
  })

  const { data: hotspots, error } = await supabase
    .from('wards')
    .select('id, name, lat, lng, boundary, metadata')
    .eq('is_hotspot', true)
    .order('name')
  if (error) throw new Error(`Could not read hotspot wards: ${error.message}`)
  const rows = (hotspots ?? []) as HotspotRow[]
  if (rows.length === 0) throw new Error('No hotspot wards found (is_hotspot = true).')

  console.log('=== Hotspot ward boundary linking ===')
  console.log(`Mode: ${dryRun ? 'DRY RUN (no writes)' : 'LIVE UPDATE'}`)
  console.log(`Hotspot wards: ${rows.length}`)
  console.log(`MCD candidate polygons: ${mcdWards.length}`)
  console.log('')

  const matched: MatchedHotspot[] = []
  const unmatched: { name: string; reason: string }[] = []
  const alreadyLinked: string[] = []

  for (const w of rows) {
    if (w.boundary != null) {
      alreadyLinked.push(w.name)
      continue
    }
    if (w.lat == null || w.lng == null) {
      unmatched.push({ name: w.name, reason: 'no lat/lng seeded' })
      continue
    }
    const hit = mcdWards.find((f) => pointInGeometry(w.lat!, w.lng!, f.geometry))
    if (!hit) {
      unmatched.push({ name: w.name, reason: `(${w.lat}, ${w.lng}) not inside any MCD ward polygon` })
      continue
    }
    const donorWardNumber = Number(hit.properties.Ward_No)
    const donorWardName = (hit.properties.WardName ?? '').trim()
    matched.push({
      id: w.id,
      name: w.name,
      donorWardNumber,
      donorWardName,
      geometry: hit.geometry,
      metadata: {
        ...(w.metadata ?? {}),
        donor_ward_number: donorWardNumber,
        donor_ward_name: donorWardName,
        match_method: 'point_in_polygon',
        source_document: SOURCE_DOCUMENT,
      },
    })
  }

  console.log(`Already linked (has boundary, skipped): ${alreadyLinked.length ? alreadyLinked.join(', ') : '(none)'}`)
  console.log(`Matched: ${matched.length}`)
  for (const m of matched) console.log(`  ${m.name} -> MCD ward #${m.donorWardNumber} "${m.donorWardName}"`)
  console.log(`Unmatched: ${unmatched.length}`)
  for (const u of unmatched) console.log(`  ${u.name}: ${u.reason}`)

  if (dryRun) {
    console.log('\nDry run only - no rows written. Re-run without --dry-run to write.')
    return
  }

  let written = 0
  for (const m of matched) {
    const { error: updateError } = await supabase
      .from('wards')
      .update({ boundary: m.geometry, metadata: m.metadata })
      .eq('id', m.id)
      .eq('is_hotspot', true)
    if (updateError) throw new Error(`Update failed for ward "${m.name}" (id=${m.id}): ${updateError.message}`)
    written++
  }
  console.log(`\nLinked ${written} hotspot ward(s) to MCD boundary polygons.`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
