import type { Session } from '@supabase/supabase-js'
import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from './supabase'

export type Role = 'citizen' | 'field_officer' | 'commander' | 'admin'

export interface Profile {
  role: Role
  wardId: number | null
  wardName: string | null
}

/** Where each role lands after login. */
export function roleHome(role: Role): string {
  switch (role) {
    case 'field_officer':
      return '/field'
    case 'commander':
    case 'admin':
      return '/command'
    default:
      return '/citizen'
  }
}

interface AuthState {
  session: Session | null
  profile: Profile | null
  loading: boolean
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState>({
  session: null,
  profile: null,
  loading: true,
  signOut: async () => {},
})

async function fetchProfile(userId: string): Promise<Profile> {
  const { data } = await supabase
    .from('profiles')
    .select('role, ward_id, wards(name)')
    .eq('id', userId)
    .maybeSingle()

  if (!data) {
    // first login: create the profile row (RLS allows self-insert), default citizen.
    // Roles are promoted by an admin in SQL — see README.
    await supabase.from('profiles').insert({ id: userId })
    return { role: 'citizen', wardId: null, wardName: null }
  }

  const ward = data.wards as { name: string } | { name: string }[] | null
  return {
    role: data.role as Role,
    wardId: data.ward_id,
    wardName: Array.isArray(ward) ? (ward[0]?.name ?? null) : (ward?.name ?? null),
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  // Bug fix (Sept 2026): Supabase's client auto-refreshes the access token
  // on a timer AND re-validates on tab focus/visibility — both fire
  // onAuthStateChange with a brand-new `session` object even when it's the
  // SAME signed-in user, just a refreshed token. This effect used to depend
  // on `session` itself, so every such event (i.e. every tab switch back to
  // this app) re-ran fetchProfile() and flipped `loading` true→false again,
  // which every consumer of useAuth() sees as "reload" — this was the cause
  // of the whole app appearing to refresh whenever the tab regained focus.
  // Depending on the stable user id instead means a token refresh for the
  // same user is a no-op here; only an actual sign-in/sign-out/different-
  // user event (a real id change) re-fetches the profile.
  const userId = session?.user.id ?? null
  useEffect(() => {
    let cancelled = false
    if (!userId) {
      setProfile(null)
      setLoading(false)
      return
    }
    setLoading(true)
    fetchProfile(userId)
      .then((p) => {
        if (!cancelled) setProfile(p)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [userId])

  const signOut = async () => {
    await supabase.auth.signOut()
  }

  return (
    <AuthContext.Provider value={{ session, profile, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
