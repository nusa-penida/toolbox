import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/auth-context'
import { getUtilities } from '../utilities/registry'

export function Layout() {
  const { user, signOut } = useAuth()
  const utilities = getUtilities()

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
      isActive
        ? 'bg-indigo-600/20 text-indigo-300'
        : 'text-slate-400 hover:bg-slate-800 hover:text-white'
    }`

  return (
    <div className="flex min-h-screen bg-slate-950 text-white">
      <aside className="flex w-64 shrink-0 flex-col border-r border-slate-800 bg-slate-900">
        <NavLink to="/" className="flex items-center gap-2 px-5 py-5">
          <span className="text-2xl">🧰</span>
          <span className="text-lg font-bold">Toolbox</span>
        </NavLink>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3">
          <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Utilities
          </p>
          {utilities.map((u) => (
            <NavLink key={u.id} to={`/tools/${u.id}`} className={linkClass}>
              <span>{u.icon}</span>
              <span>{u.name}</span>
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-slate-800 p-4">
          <p className="truncate text-xs text-slate-500" title={user?.email ?? ''}>
            {user?.email}
          </p>
          <button
            onClick={signOut}
            className="mt-2 w-full rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800"
          >
            Log out
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto p-8">
        <Outlet />
      </main>
    </div>
  )
}
