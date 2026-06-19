import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from './auth-context'

type Mode = 'login' | 'register'

const inputClass =
  'w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-white placeholder-slate-500 transition-all duration-200 focus:border-indigo-400/60 focus:bg-white/[0.07] focus:outline-none focus:ring-2 focus:ring-indigo-500/20'

export function AuthPage() {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setNotice(null)

    if (mode === 'register' && password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setSubmitting(true)
    const { error: authError } =
      mode === 'login' ? await signIn(email, password) : await signUp(email, password)
    setSubmitting(false)

    if (authError) {
      setError(authError)
    } else if (mode === 'register') {
      setNotice(
        'Account created. If email confirmation is enabled, check your inbox before logging in.'
      )
      setMode('login')
    }
  }

  const switchMode = (next: Mode) => {
    setMode(next)
    setError(null)
    setNotice(null)
  }

  return (
    <div className="ambient flex min-h-screen items-center justify-center bg-surface px-4">
      <div className="relative z-10 w-full max-w-sm animate-fade-up">
        <div className="mb-8 text-center">
          <svg className="mx-auto size-16" viewBox="0 0 24 24" fill="none" stroke="url(#toolbox-grad)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <defs>
              <linearGradient id="toolbox-grad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#6366f1" />
                <stop offset="50%" stopColor="#8b5cf6" />
                <stop offset="100%" stopColor="#22d3ee" />
              </linearGradient>
            </defs>
            <path d="M3 9h18v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9Z" />
            <path d="M8 9V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v3" />
            <path d="M3 13h6m6 0h6" />
            <path d="M9 11v4m6-4v4" />
          </svg>
          <h1 className="mt-4 text-3xl font-bold tracking-tight text-white">
            <span className="text-gradient">Toolbox</span>
          </h1>
          <p className="mt-1.5 text-sm text-slate-400">
            {mode === 'login' ? 'Log in to your account' : 'Create a new account'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="glass space-y-4 rounded-2xl p-6 shadow-2xl">
          <div>
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-slate-300">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-slate-300">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={6}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
              placeholder="••••••••"
            />
          </div>

          {mode === 'register' && (
            <div>
              <label
                htmlFor="confirm-password"
                className="mb-1.5 block text-sm font-medium text-slate-300"
              >
                Confirm password
              </label>
              <input
                id="confirm-password"
                type="password"
                required
                minLength={6}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={inputClass}
                placeholder="••••••••"
              />
            </div>
          )}

          {error && (
            <p className="rounded-xl border border-red-500/20 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-300">
              {error}
            </p>
          )}
          {notice && (
            <p className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3.5 py-2.5 text-sm text-emerald-300">
              {notice}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-2.5 font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all duration-200 hover:shadow-indigo-500/40 hover:brightness-110 disabled:opacity-50 disabled:hover:brightness-100"
          >
            {submitting ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Register'}
          </button>
        </form>

        <p className="mt-5 text-center text-sm text-slate-400">
          {mode === 'login' ? (
            <>
              No account yet?{' '}
              <button
                onClick={() => switchMode('register')}
                className="no-glow font-medium text-indigo-300 transition-colors hover:text-indigo-200"
              >
                Register
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button
                onClick={() => switchMode('login')}
                className="no-glow font-medium text-indigo-300 transition-colors hover:text-indigo-200"
              >
                Log in
              </button>
            </>
          )}
        </p>

        <p className="mt-3 text-center text-sm">
          <Link
            to="/"
            className="text-slate-500 transition-colors hover:text-slate-300"
          >
            Continue without an account →
          </Link>
        </p>
      </div>
    </div>
  )
}
