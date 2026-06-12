// HashRouter so deep links survive refresh on GitHub Pages (no rewrite rules there).
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
  return <Component />
}

function AppRoutes() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-400">
        Loading…
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
