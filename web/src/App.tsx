import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import ErrorBoundary from './components/ErrorBoundary'
import RequireRole from './components/RequireRole'
import { AuthProvider, roleHome, useAuth } from './lib/auth'
import CitizenView from './pages/CitizenView'
import CommandView from './pages/CommandView'
import FieldView from './pages/FieldView'
import IncidentsView from './pages/IncidentsView'
import Login from './pages/Login'
import MapPage from './pages/MapPage'
import MissionsView from './pages/MissionsView'
import OpsView from './pages/OpsView'
import SensorsView from './pages/SensorsView'

// "/" -> the logged-in user's home view, or /login
function Home() {
  const { session, profile, loading } = useAuth()
  if (loading) {
    return <div className="flex h-screen items-center justify-center text-gray-500">Loading…</div>
  }
  if (!session || !profile) return <Navigate to="/login" replace />
  return <Navigate to={roleHome(profile.role)} replace />
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<Login />} />
            <Route
              path="/citizen"
              element={
                <RequireRole allow={['citizen', 'admin']}>
                  <CitizenView />
                </RequireRole>
              }
            />
            <Route
              path="/field"
              element={
                <RequireRole allow={['field_officer', 'admin']}>
                  <FieldView />
                </RequireRole>
              }
            />
            <Route
              path="/command"
              element={
                <RequireRole allow={['commander', 'admin']}>
                  <CommandView />
                </RequireRole>
              }
            />
            {/* Phase 3: the incident queue is added alongside the existing
                /command dashboard, not in place of it. */}
            <Route
              path="/incidents"
              element={
                <RequireRole allow={['commander', 'admin']}>
                  <IncidentsView />
                </RequireRole>
              }
            />
            <Route
              path="/missions"
              element={
                <RequireRole allow={['field_officer', 'admin']}>
                  <MissionsView />
                </RequireRole>
              }
            />
            {/* Phase 10: system health + minimal pilot admin surface. */}
            <Route
              path="/ops"
              element={
                <RequireRole allow={['commander', 'admin']}>
                  <OpsView />
                </RequireRole>
              }
            />
            <Route
              path="/sensors"
              element={
                <RequireRole allow={['commander', 'admin']}>
                  <SensorsView />
                </RequireRole>
              }
            />
            <Route
              path="/map"
              element={
                <RequireRole allow={['commander', 'admin']}>
                  <MapPage />
                </RequireRole>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ErrorBoundary>
  )
}
