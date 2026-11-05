import { Navigate } from 'react-router-dom'
import { roleHome, useAuth, type Role } from '../lib/auth'
import { useCity } from '../lib/city'

// Gates a route by role. Not logged in -> /login. Wrong role -> their own home.
export default function RequireRole({
  allow,
  children,
}: {
  allow: Role[]
  children: React.ReactNode
}) {
  const { session, profile, loading } = useAuth()
  // Pages read the active city on their first fetch, so wait for it too
  // (one small city_config read, in parallel with the profile).
  const { loading: cityLoading } = useCity()

  if (loading || cityLoading) {
    return <div className="flex h-screen items-center justify-center text-gray-500">Loading…</div>
  }
  if (!session) return <Navigate to="/login" replace />
  if (!profile) return <Navigate to="/login" replace />
  if (!allow.includes(profile.role)) return <Navigate to={roleHome(profile.role)} replace />

  return <>{children}</>
}
