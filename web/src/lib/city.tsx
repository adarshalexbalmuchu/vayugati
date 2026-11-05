import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from './auth'
import {
  buildCityOptions,
  CITY_REGISTRY,
  DEFAULT_CITY_CODE,
  normalizeCityCode,
  readStoredCityCode,
  resolveActiveCityCode,
  writeStoredCityCode,
  type CityMapSettings,
  type CityOption,
} from './cities'
import { fetchCities } from './ops'
import { clearAsyncCache } from './useAsync'

/**
 * The active city (see cities.ts for the registry and the resolution order).
 *
 * Resolved from: ?city=<code> in the URL, then the last choice saved in
 * localStorage, then the signed-in user's profile ward's city, then 'delhi'.
 * Only cities that are active in city_config (and have map settings) count.
 */
export interface CityContextValue {
  cityCode: string
  /** city_config.id; null when city_config could not be read (signed out,
   *  or the request failed) — data queries then stay unfiltered, as before. */
  cityId: number | null
  map: CityMapSettings
  /** Every city the user can switch to (active rows in city_config). */
  cities: CityOption[]
  /** True while city_config is being read for a signed-in user. */
  loading: boolean
  setCity: (code: string) => void
}

/** Used until city_config is read, or when it can't be. */
const FALLBACK_MAP: CityMapSettings = CITY_REGISTRY[DEFAULT_CITY_CODE]

const CityContext = createContext<CityContextValue>({
  cityCode: DEFAULT_CITY_CODE,
  cityId: null,
  map: FALLBACK_MAP,
  cities: [],
  loading: false,
  setCity: () => {},
})

export function CityProvider({ children }: { children: React.ReactNode }) {
  const { session, profile } = useAuth()
  const userId = session?.user.id ?? null
  const [searchParams, setSearchParams] = useSearchParams()
  const urlCity = normalizeCityCode(searchParams.get('city'))

  const [cities, setCities] = useState<CityOption[]>([])
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const [storedCity, setStoredCity] = useState<string | null>(() => readStoredCityCode())

  // city_config is readable by any authenticated user (RLS), so read it once
  // per signed-in user. A failure leaves the list empty: the app falls back
  // to Delhi with no city filter, i.e. exactly the old behaviour.
  useEffect(() => {
    if (!userId) {
      setCities([])
      setLoadedFor(null)
      return
    }
    let cancelled = false
    fetchCities()
      .then((rows) => {
        if (!cancelled) setCities(buildCityOptions(rows))
      })
      .catch(() => {
        if (!cancelled) setCities([])
      })
      .finally(() => {
        if (!cancelled) setLoadedFor(userId)
      })
    return () => {
      cancelled = true
    }
  }, [userId])

  const loading = userId != null && loadedFor !== userId

  const profileCityCode = useMemo(
    () => cities.find((c) => c.id === profile?.wardCityId)?.cityCode ?? null,
    [cities, profile?.wardCityId],
  )

  const cityCode = resolveActiveCityCode({
    urlCity,
    storedCity,
    profileCityCode,
    available: cities.map((c) => c.cityCode),
  })
  const active = cities.find((c) => c.cityCode === cityCode) ?? null

  // A valid ?city= is an explicit choice: remember it, so in-app navigation
  // (which drops the query string) keeps the same city.
  useEffect(() => {
    if (urlCity && cities.some((c) => c.cityCode === urlCity) && urlCity !== storedCity) {
      writeStoredCityCode(urlCity)
      setStoredCity(urlCity)
    }
  }, [urlCity, cities, storedCity])

  // Cached page data belongs to the city it was fetched for. Clear it as the
  // city changes, during render, so pages remounted for the new city (App
  // keys its routes by cityCode) never seed from the old city's results.
  const lastCityCode = useRef(cityCode)
  if (lastCityCode.current !== cityCode) {
    lastCityCode.current = cityCode
    clearAsyncCache()
  }

  const setCity = useCallback(
    (code: string) => {
      const next = normalizeCityCode(code)
      if (!next) return
      writeStoredCityCode(next)
      setStoredCity(next)
      // The URL outranks storage, so a ?city= left in place would undo the choice.
      if (searchParams.has('city')) {
        const params = new URLSearchParams(searchParams)
        params.set('city', next)
        setSearchParams(params, { replace: true })
      }
    },
    [searchParams, setSearchParams],
  )

  const value = useMemo<CityContextValue>(
    () => ({
      cityCode: active?.cityCode ?? DEFAULT_CITY_CODE,
      cityId: active?.id ?? null,
      map: active?.map ?? FALLBACK_MAP,
      cities,
      loading,
      setCity,
    }),
    [active, cities, loading, setCity],
  )

  return <CityContext.Provider value={value}>{children}</CityContext.Provider>
}

export function useCity(): CityContextValue {
  return useContext(CityContext)
}
