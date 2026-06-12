import { useState } from 'react'
import type { FormEvent } from 'react'
import { useAuth } from './auth-context'

type Mode = 'login' | 'register'

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
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="text-4xl">🧰</span>
          <h1 className="mt-2 text-2xl font-bold text-white">Toolbox</h1>
          <p className="mt-1 text-sm text-slate-400">
            {mode === 'login' ? 'Log in to your account' : 'Create a new account'}
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-6 shadow-xl"
        >
          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium text-slate-300">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-slate-300">
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
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              placeholder="••••••••"
            />
          </div>

          {mode === 'register' && (
            <div>
              <label
                htmlFor="confirm-password"
                className="mb-1 block text-sm font-medium text-slate-300"
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
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                placeholder="••••••••"
              />
            </div>
          )}

          {error && (
            <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</p>
          )}
          {notice && (
            <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400">
              {notice}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {submitting ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Register'}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-slate-400">
          {mode === 'login' ? (
            <>
              No account yet?{' '}
              <button
                onClick={() => switchMode('register')}
                className="font-medium text-indigo-400 hover:text-indigo-300"
              >
                Register
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button
                onClick={() => switchMode('login')}
                className="font-medium text-indigo-400 hover:text-indigo-300"
              >
                Log in
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  )
}
