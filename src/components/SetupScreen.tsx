/**
 * Shown when Supabase credentials are missing (no `.env`). The whole app runs
 * on Supabase for auth and per-user saving, so without credentials there is
 * nothing to render — this explains how to fix it instead of a blank page.
 */
export function SetupScreen() {
  return (
    <div className="ambient flex min-h-screen items-center justify-center bg-surface px-6 py-12 text-slate-200">
      <div className="glass relative z-10 w-full max-w-xl rounded-2xl p-8">
        <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">
          Setup needed
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">
          Add your <span className="text-gradient">Supabase</span> credentials
        </h1>
        <p className="mt-3 text-sm text-slate-400">
          This app uses Supabase for sign-in and saving your settings. It can't start until you
          create a <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs">.env</code>{' '}
          file in the project root with your project's credentials.
        </p>

        <ol className="mt-6 space-y-3 text-sm text-slate-300">
          <li>
            <span className="font-semibold text-white">1.</span> In your Supabase dashboard, open{' '}
            <span className="text-slate-200">Project Settings → API</span>.
          </li>
          <li>
            <span className="font-semibold text-white">2.</span> Create a file named{' '}
            <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs">.env</code> next to{' '}
            <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs">package.json</code>{' '}
            with:
          </li>
        </ol>

        <pre className="mt-3 overflow-x-auto rounded-xl border border-white/10 bg-black/40 p-4 font-mono text-xs leading-relaxed text-slate-300">
          <code>
            VITE_SUPABASE_URL=https://your-project-ref.supabase.co{'\n'}
            VITE_SUPABASE_ANON_KEY=your-anon-public-key
          </code>
        </pre>

        <p className="mt-4 text-sm text-slate-400">
          <span className="font-semibold text-white">3.</span> Restart the dev server (
          <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs">npm run dev</code>) —
          Vite only reads <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs">.env</code>{' '}
          on startup.
        </p>
      </div>
    </div>
  )
}
