import { useId, useState } from 'react'
import { AlertCircle, CheckCircle2, Eye, EyeOff } from 'lucide-react'
import { Navigate } from 'react-router-dom'
import { LogoWordmark } from '../components/AppShell'
import { roleHome, useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'
import headerSkyline from '../assets/header-skyline.jpg'

/**
 * Login / auth surface. Scoped to this page: every colour is an explicit arbitrary-value class, not a change to
 * tailwind.config.js's shared tokens, so the other workspaces are unaffected. Auth behaviour (handlers, validation,
 * session and role redirect) is unchanged; only markup, classes and copy differ. No query runs on this
 * unauthenticated page.
 */
export default function Login() {
  const { session, profile, loading } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const emailId = useId()
  const passwordId = useId()

  if (session && profile && !loading) {
    return <Navigate to={roleHome(profile.role)} replace />
  }

  const signIn = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setMessage(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(error.message)
    setBusy(false)
  }

  const signUp = async () => {
    if (!email || password.length < 6) {
      setError('Enter an email and a password of at least 6 characters.')
      return
    }
    setBusy(true)
    setError(null)
    setMessage(null)
    const { error } = await supabase.auth.signUp({ email, password })
    if (error) setError(error.message)
    else setMessage('Account created. If email confirmation is on, check your inbox, then sign in.')
    setBusy(false)
  }

  const field =
    'auth-input h-11 w-full rounded-lg border border-slate-200 bg-white px-3.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 hover:border-slate-300 focus:border-[#422B1B] focus:ring-2 focus:ring-[#422B1B]/15'

  return (
    <div className="relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden bg-gradient-to-b from-[#CFE4F6] via-[#E3EFF8] to-[#F6F1E4] px-4 pb-24 pt-8">
      {/* The same illustrated Delhi skyline as the app header, fading up into the sky. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[clamp(90px,12vw,170px)] bg-cover bg-bottom bg-no-repeat"
        style={{
          backgroundImage: `url(${headerSkyline})`,
          WebkitMaskImage: 'linear-gradient(to top, #000 55%, transparent)',
          maskImage: 'linear-gradient(to top, #000 55%, transparent)',
        }}
      />
      <div className="relative z-10 w-full max-w-[400px] animate-fade-in [@media(min-height:860px)]:max-w-[440px]">
        <div className="mb-6 flex flex-col items-center text-center [@media(max-height:700px)]:mb-4">
          <LogoWordmark className="h-auto w-[104px] sm:w-[116px] [@media(max-height:700px)]:w-[84px] [@media(min-height:860px)]:w-[150px]" />
          <p className="mt-3 text-sm font-semibold text-[#422B1B]">जानकारी से कार्यवाही तक</p>
          <p className="mt-0.5 text-xs text-[#422B1B]/60">From information to action</p>
        </div>

        <form
          onSubmit={signIn}
          className="rounded-2xl border border-white/80 bg-white/95 p-6 shadow-[0_1px_2px_rgba(66,43,27,0.06),0_16px_40px_-12px_rgba(66,43,27,0.18)] sm:p-7"
        >
          <h1 className="text-lg font-semibold text-slate-900">Sign in</h1>
          <p className="mt-1 text-sm text-slate-500 [@media(max-height:700px)]:hidden">Use your work email to continue.</p>

          <div className="mt-5 space-y-3.5">
            <div>
              <label htmlFor={emailId} className="mb-1.5 block text-[13px] font-medium text-slate-700">
                Email
              </label>
              <input
                id={emailId}
                type="email"
                required
                autoFocus
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={field}
              />
            </div>
            <div>
              <label htmlFor={passwordId} className="mb-1.5 block text-[13px] font-medium text-slate-700">
                Password
              </label>
              <div className="relative">
                <input
                  id={passwordId}
                  type={showPassword ? 'text' : 'password'}
                  required
                  minLength={6}
                  autoComplete="current-password"
                  placeholder="At least 6 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={`${field} pr-10`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-slate-400 outline-none transition hover:text-slate-600 focus-visible:ring-2 focus-visible:ring-[#422B1B]/40"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                </button>
              </div>
            </div>
          </div>

          {error && (
            <p role="alert" className="mt-4 flex items-start gap-1.5 rounded-lg bg-status-critical/10 px-3 py-2.5 text-sm text-status-critical">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
              <span>{error}</span>
            </p>
          )}
          {message && (
            <p role="status" className="mt-4 flex items-start gap-1.5 rounded-lg bg-status-success/10 px-3 py-2.5 text-sm text-status-success">
              <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
              <span>{message}</span>
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="focus-ring mt-5 h-11 w-full rounded-lg bg-[#422B1B] px-4 text-sm font-semibold text-white transition hover:bg-[#341f14] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Please wait…' : 'Sign in'}
          </button>

          <p className="mt-4 text-center text-sm text-slate-500">
            No account yet?{' '}
            <button
              type="button"
              disabled={busy}
              onClick={signUp}
              className="font-semibold text-[#422B1B] underline-offset-4 outline-none hover:underline focus-visible:underline disabled:opacity-50"
            >
              Create one with the details above
            </button>
          </p>
        </form>

        <p className="mt-5 text-center text-xs text-[#422B1B]/60 [@media(max-height:760px)]:hidden">
          Vayu Gati · air quality and geospatial data for city and district teams
        </p>
      </div>
    </div>
  )
}
