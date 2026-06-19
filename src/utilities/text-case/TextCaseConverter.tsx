import { useState } from 'react'
import { SaveStatus } from '../../components/SaveStatus'
import { useUtilityConfig } from '../../hooks/useUtilityConfig'

/**
 * Example utility demonstrating the groundwork pattern:
 * - useUtilityConfig persists the user's preferences (default case, auto-trim)
 *   to their account, so they're restored on the next visit / another device.
 * - Ephemeral state (the text being converted) stays in plain useState.
 */

type CaseMode = 'upper' | 'lower' | 'title' | 'kebab' | 'snake'

const CASE_MODES: { id: CaseMode; label: string }[] = [
  { id: 'upper', label: 'UPPERCASE' },
  { id: 'lower', label: 'lowercase' },
  { id: 'title', label: 'Title Case' },
  { id: 'kebab', label: 'kebab-case' },
  { id: 'snake', label: 'snake_case' },
]

function convert(text: string, mode: CaseMode, trim: boolean): string {
  const input = trim ? text.trim() : text
  switch (mode) {
    case 'upper':
      return input.toUpperCase()
    case 'lower':
      return input.toLowerCase()
    case 'title':
      return input.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
    case 'kebab':
      return input.toLowerCase().replace(/\s+/g, '-')
    case 'snake':
      return input.toLowerCase().replace(/\s+/g, '_')
  }
}

export function TextCaseConverter() {
  const { config, setConfig, loading, saving } = useUtilityConfig('text-case', {
    mode: 'upper' as CaseMode,
    autoTrim: true,
  })
  const [text, setText] = useState('')

  if (loading) {
    return <p className="animate-pulse text-slate-400">Loading your settings…</p>
  }

  return (
    <div className="animate-fade-up">
      <div className="flex items-baseline justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Text Case Converter</h1>
        <SaveStatus saving={saving} />
      </div>
      <p className="mt-2 text-slate-400">
        Convert text between case styles. With an account, your selected case and options are
        remembered.
      </p>

      <div className="mt-8 flex flex-wrap gap-2">
        {CASE_MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => setConfig({ mode: m.id })}
            className={`rounded-xl px-3.5 py-1.5 font-mono text-sm transition-all duration-200 ${
              config.mode === m.id
                ? 'bg-gradient-to-r from-indigo-500 to-violet-500 text-white shadow-lg shadow-indigo-500/25'
                : 'border border-white/10 bg-white/5 text-slate-300 hover:border-white/20 hover:bg-white/10 hover:text-white'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <label className="mt-5 flex w-fit cursor-pointer items-center gap-2.5 text-sm text-slate-300">
        <input
          type="checkbox"
          checked={config.autoTrim}
          onChange={(e) => setConfig({ autoTrim: e.target.checked })}
          className="size-4 accent-indigo-500"
        />
        Trim whitespace automatically
      </label>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder="Type or paste text here…"
        className="glass mt-8 w-full resize-y rounded-2xl p-4 text-white placeholder-slate-500 transition-all duration-200 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
      />

      <div className="glass mt-4 rounded-2xl p-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">
          Result
        </p>
        <p className="mt-2 whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-white">
          {text ? convert(text, config.mode, config.autoTrim) : '—'}
        </p>
      </div>
    </div>
  )
}
