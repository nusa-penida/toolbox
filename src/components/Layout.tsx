import { useState } from 'react'
import { Link, NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/auth-context'
import { getUtilities } from '../utilities/registry'

export function Layout() {
  const { user, signOut } = useAuth()
  const utilities = getUtilities().filter((u) => user || u.availableWithoutAccount)
  const [navOpen, setNavOpen] = useState(false)
  const closeNav = () => setNavOpen(false)

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `group flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-all duration-200 ${
      isActive
        ? 'bg-indigo-500/15 text-indigo-200 shadow-[inset_0_1px_0_rgb(255_255_255/0.06)] ring-1 ring-indigo-400/30'
        : 'text-slate-400 hover:bg-white/5 hover:text-white'
    }`

  return (
    <div className="ambient flex min-h-dvh bg-surface text-white lg:h-dvh lg:overflow-hidden">
      {/* Sidebar: a full-screen drawer on mobile, a static rail from lg up. */}
      <aside
        className={`glass-strong fixed inset-0 z-30 flex w-full shrink-0 flex-col transition-transform duration-300 lg:static lg:z-10 lg:m-3 lg:w-64 lg:translate-x-0 lg:rounded-2xl ${
          navOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between pr-3 lg:pr-0">
          <NavLink to="/" onClick={closeNav} className="group flex items-center gap-3 px-5 py-5">
            <span className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-cyan-400 shadow-lg shadow-indigo-500/30 transition-transform duration-200 group-hover:scale-105">
              <svg className="size-6 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 9h18v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9Z" />
                <path d="M8 9V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v3" />
                <path d="M3 13h6m6 0h6" />
                <path d="M9 11v4m6-4v4" />
              </svg>
            </span>
            <span className="text-lg font-bold tracking-tight">Toolbox</span>
          </NavLink>
          {/* Close affordance — the drawer covers the whole screen on mobile. */}
          <button
            onClick={closeNav}
            aria-label="Close menu"
            className="grid size-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/5 text-slate-200 transition-colors hover:bg-white/10 hover:text-white lg:hidden"
          >
            <svg className="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3">
          <p className="px-3 pb-2 pt-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">
            Utilities
          </p>
          {utilities.map((u) => (
            <NavLink key={u.id} to={`/tools/${u.id}`} onClick={closeNav} className={linkClass}>
              <span className="transition-transform duration-200 group-hover:scale-110">
                {u.icon}
              </span>
              <span className="flex-1">{u.name}</span>
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-white/5 p-4">
          {user ? (
            <>
              <p className="truncate text-xs text-slate-500" title={user.email ?? ''}>
                {user.email}
              </p>
              <button
                onClick={signOut}
                className="mt-3 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-sm font-medium text-slate-300 transition-all duration-200 hover:border-white/20 hover:bg-white/10 hover:text-white"
              >
                Log out
              </button>
            </>
          ) : (
            <>
              <p className="text-xs text-slate-500">Sign in to save your settings.</p>
              <Link
                to="/login"
                onClick={closeNav}
                className="mt-3 block w-full rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-3 py-1.5 text-center text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all duration-200 hover:brightness-110"
              >
                Log in
              </Link>
            </>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar with the menu toggle — hidden from lg up. */}
        <header className="glass-strong z-10 m-3 mb-0 flex items-center gap-3 rounded-2xl px-4 py-3 lg:hidden">
          <button
            onClick={() => setNavOpen(true)}
            aria-label="Open menu"
            className="grid size-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/5 text-slate-200 transition-colors hover:bg-white/10 hover:text-white"
          >
            <svg className="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
            </svg>
          </button>
          <Link to="/" className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-indigo-500 via-violet-500 to-cyan-400 shadow-lg shadow-indigo-500/30">
              <svg className="size-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 9h18v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9Z" />
                <path d="M8 9V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v3" />
                <path d="M3 13h6m6 0h6" />
                <path d="M9 11v4m6-4v4" />
              </svg>
            </span>
            <span className="font-bold tracking-tight">Toolbox</span>
          </Link>
        </header>

        <main className="relative z-10 flex-1 p-5 sm:p-8 lg:overflow-y-auto lg:p-10">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
