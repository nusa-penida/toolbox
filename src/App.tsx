// HashRouter so deep links survive refresh on GitHub Pages (no rewrite rules there).
import { Suspense } from 'react'
import { HashRouter, Navigate, Route, Routes, useParams } from 'react-router-dom'
import { AuthProvider } from './auth/AuthContext'
import { useAuth } from './auth/auth-context'
import { AuthPage } from './auth/AuthPage'
import { Layout } from './components/Layout'
import { Home } from './pages/Home'
import { getUtility } from './utilities/registry'
import './utilities' // registers all utilities

function UtilityPage() {
  const { utilityId } = useParams()
  const utility = utilityId ? getUtility(utilityId) : undefined
  if (!utility) return <Navigate to="/" replace />
  const Component = utility.component
  return (
    <Suspense fallback={<p className="animate-pulse text-slate-400">Loading tool…</p>}>
      <Component />
    </Suspense>
  )
}

function AppRoutes() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="ambient flex min-h-screen items-center justify-center bg-surface text-slate-400">
        <span className="relative z-10 animate-pulse">Loading…</span>
      </div>
    )
  }

  if (!user) {
    return <AuthPage />
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/tools/:utilityId" element={<UtilityPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <HashRouter>
        <AppRoutes />
      </HashRouter>
    </AuthProvider>
  )
}
