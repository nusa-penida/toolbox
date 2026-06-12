import { useState } from 'react'
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
    return <p className="text-slate-400">Loading your settings…</p>
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">Text Case Converter</h1>
        <span className="text-xs text-slate-500">{saving ? 'Saving…' : 'Settings saved'}</span>
      </div>
      <p className="mt-1 text-slate-400">
        Your selected case and options are remembered on your account.
      </p>

      <div className="mt-6 flex flex-wrap gap-2">
        {CASE_MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => setConfig({ mode: m.id })}
            className={`rounded-lg px-3 py-1.5 text-sm transition ${
              config.mode === m.id
                ? 'bg-indigo-600 text-white'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <label className="mt-4 flex items-center gap-2 text-sm text-slate-300">
        <input
          type="checkbox"
          checked={config.autoTrim}
          onChange={(e) => setConfig({ autoTrim: e.target.checked })}
          className="accent-indigo-600"
        />
        Trim whitespace automatically
      </label>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder="Type or paste text here…"
        className="mt-6 w-full rounded-lg border border-slate-700 bg-slate-900 p-3 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
      />

      <div className="mt-4 rounded-lg border border-slate-800 bg-slate-900 p-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Result</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-white">
          {text ? convert(text, config.mode, config.autoTrim) : '—'}
        </p>
      </div>
    </div>
  )
}
