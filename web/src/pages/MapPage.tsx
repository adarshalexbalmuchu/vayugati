import { useState } from 'react'
import AppShell from '../components/AppShell'
import MapView, { type WardMarker } from '../components/MapView'
import { Card, CardHeader, ErrorState, Skeleton, Tabs } from '../components/ui'
import { fetchAllStationsWithReadings, fetchAllWardsAqi } from '../lib/data'
import { useAsync } from '../lib/useAsync'

type Layer = 'wards' | 'stations'

const LAYER_TABS = [
  { key: 'wards', label: 'Wards' },
  { key: 'stations', label: 'Stations' },
]

export default function MapPage() {
  const [layer, setLayer] = useState<Layer>('wards')
  const wardsState = useAsync(fetchAllWardsAqi, [])
  const stationsState = useAsync(fetchAllStationsWithReadings, [])

  const wardMarkers: WardMarker[] = (wardsState.data ?? [])
    .filter((w) => w.lat != null && w.lng != null)
    .map((w) => ({ id: w.id, name: w.name, lat: w.lat as number, lng: w.lng as number, aqi: w.aqi }))
  const stationMarkers: WardMarker[] = stationsState.data ?? []

  const active = layer === 'wards' ? wardsState : stationsState
  const markers = layer === 'wards' ? wardMarkers : stationMarkers

  return (
    <AppShell subtitle="Map">
      <div className="flex h-full min-h-0 flex-col gap-3 p-3 sm:p-4">
        <Card className="flex-shrink-0 overflow-hidden">
          <CardHeader title="Map" subtitle={`${markers.length} ${layer === 'wards' ? 'ward(s)' : 'station(s)'} shown`} />
          <Tabs tabs={LAYER_TABS} active={layer} onChange={(key) => setLayer(key as Layer)} />
        </Card>
        <Card className="min-h-0 flex-1 overflow-hidden p-0">
          {active.loading ? (
            <div className="flex h-full items-center justify-center p-4">
              <Skeleton className="h-full w-full" />
            </div>
          ) : active.error ? (
            <ErrorState message={active.error} onRetry={active.refresh} />
          ) : (
            <MapView markers={markers} />
          )}
        </Card>
      </div>
    </AppShell>
  )
}
