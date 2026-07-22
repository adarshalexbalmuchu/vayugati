import { useId, useState } from 'react'
import { AlertCircle, CheckCircle2, Eye, EyeOff } from 'lucide-react'
import { Navigate } from 'react-router-dom'
import { LogoWordmark } from '../components/AppShell'
import { roleHome, useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'

/**
 * Login/auth brand surface (logo + sky-blue background redesign). Scoped
 * entirely to this page - every colour below is an explicit arbitrary-value
 * class (`bg-[#C7EAF9]` etc.), not a change to tailwind.config.js's shared
 * tokens, so the Commander/Field/Citizen/Ops workspaces (which reuse those
 * same tokens) are provably unaffected. All auth behaviour (handlers,
 * validation, session/role redirect) is untouched from the previous version
 * - only markup/classes changed.
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

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[#C7EAF9] px-4 py-8 sm:px-5">
      <div className="w-full max-w-[420px] animate-fade-in">
        {/* Logo + tagline - one brand block, compact spacing */}
        <div className="mb-6 flex flex-col items-center text-center">
          <LogoWordmark className="h-auto w-[150px] sm:w-[190px]" />
          <p className="mt-3 text-base font-semibold text-[#422B1B]">जानकारी से कार्यवाही तक</p>
          <p className="text-xs text-[#422B1B]/70">From information to action</p>
        </div>

        {/* Auth card */}
        <form
          onSubmit={signIn}
          className="rounded-2xl border border-[#E5E7EB] bg-white p-6 shadow-card sm:p-8"
          noValidate={false}
        >
          <div className="space-y-4">
            <div>
              <label htmlFor={emailId} className="mb-1.5 block text-xs font-semibold text-slate-700">
                Email
              </label>
              <input
                id={emailId}
                type="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="auth-input min-h-[44px] w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#422B1B] focus:ring-2 focus:ring-[#422B1B]/20"
              />
            </div>
            <div>
              <label htmlFor={passwordId} className="mb-1.5 block text-xs font-semibold text-slate-700">
                Password
              </label>
              <div className="relative">
                <input
                  id={passwordId}
                  type={showPassword ? 'text' : 'password'}
                  required
                  minLength={6}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="auth-input min-h-[44px] w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 pr-11 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#422B1B] focus:ring-2 focus:ring-[#422B1B]/20"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-slate-400 outline-none transition hover:text-slate-600 focus-visible:ring-2 focus-visible:ring-[#422B1B]/40"
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

          <div className="mt-5 flex flex-col gap-2.5 sm:flex-row">
            <button
              type="submit"
              disabled={busy}
              className="focus-ring order-1 min-h-[44px] flex-1 rounded-xl bg-[#422B1B] px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-[#341f14] disabled:cursor-not-allowed disabled:opacity-50 sm:order-2"
            >
              {busy ? 'Please wait…' : 'Sign in'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={signUp}
              className="focus-ring order-2 min-h-[44px] flex-1 rounded-xl border border-[#E5E7EB] bg-white px-4 text-sm font-semibold text-[#422B1B] transition hover:bg-[#422B1B]/5 disabled:cursor-not-allowed disabled:opacity-50 sm:order-1"
            >
              Sign up
            </button>
          </div>
        </form>

        <p className="mt-4 text-center text-xs text-[#6B7280]">Delhi City Pack · pan-India air incident response</p>
      </div>
    </div>
  )
}
