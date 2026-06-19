import { useCallback, useEffect, useRef, useState } from 'react'
import { SaveStatus } from '../../components/SaveStatus'
import { useUtilityConfig } from '../../hooks/useUtilityConfig'

/**
 * Stock Tracker. Search securities, build a watchlist with prices + charts, and
 * drill into a fund/ETF's underlying holdings.
 *
 * Two interchangeable data providers, both proxied by a Supabase edge function
 * that keeps the credentials server-side and normalizes responses to the same
 * shapes (search → Security[], history → {series}, holdings → {holdings,sectors}):
 *
 *   • Alpha Vantage (free)  — a no-cost API key (≈25 requests/day) covering
 *     search, daily/weekly price history and ETF holdings with fresh data.
 *   • Morningstar (paid)    — Direct Web Services, for entitled accounts.
 *
 * Each user brings their own key/credentials, saved to their account config
 * (RLS-protected) and forwarded per request — never bundled. Latest price +
 * change are derived from the history series, so no quote entitlement is needed.
 */

const fnUrl = (name: string) => `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${name}`
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string

type Provider = 'alphavantage' | 'fmp' | 'morningstar'
type Region = 'na' | 'emea'

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF']

// Chart ranges → how far back to request and how to bucket the series.
// Daily uses Alpha Vantage's free `compact` window (~100 points, ~5 months), so
// longer ranges step down to weekly/monthly, which the free tier returns in full.
const RANGES = [
  { key: '1M', label: '1M', days: 31, frequency: 'daily' },
  { key: '3M', label: '3M', days: 93, frequency: 'daily' },
  { key: '1Y', label: '1Y', days: 366, frequency: 'weekly' },
  { key: 'MAX', label: 'Max', days: 365 * 20, frequency: 'monthly' },
] as const
type RangeKey = (typeof RANGES)[number]['key']

interface Security {
  id: string
  name: string
  ticker: string | null
  exchange: string | null
  type: string | null
  currency: string | null
}

interface Point {
  date: string
  value: number
}

interface History {
  currency: string | null
  frequency: string
  series: Point[]
}

interface Holding {
  secId: string | null
  name: string
  ticker: string | null
  weight: number | null
  type: string | null
}

interface Sector {
  name: string
  weight: number | null
}

interface Holdings {
  count: number
  holdings: Holding[]
  sectors: Sector[]
  // Set when holdings were sourced from a different provider than the one
  // selected (FMP gates holdings behind a paid plan, so we fall back to AV).
  via?: string
}

interface Config extends Record<string, unknown> {
  provider: Provider
  // Alpha Vantage
  avKey: string
  // Financial Modeling Prep
  fmpKey: string
  // Morningstar
  username: string
  password: string
  region: Region
  currency: string
  holdingsViewId: string
  // Shared
  range: RangeKey
  watchlist: Security[]
}

const DEFAULTS: Config = {
  provider: 'alphavantage',
  avKey: '',
  fmpKey: '',
  username: '',
  password: '',
  region: 'na',
  currency: 'USD',
  holdingsViewId: 'portfolio',
  range: '3M',
  watchlist: [],
}

// Whether the current provider has enough credentials to make calls.
function hasCredentials(c: Config): boolean {
  if (c.provider === 'alphavantage') return c.avKey.trim().length > 0
  if (c.provider === 'fmp') return c.fmpKey.trim().length > 0
  return c.username.trim().length > 0 && c.password.length > 0
}

// Build the request URL + headers for the selected provider.
function providerRequest(c: Config, params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString()
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ANON_KEY}`,
    apikey: ANON_KEY,
  }
  if (c.provider === 'alphavantage') {
    headers['x-av-key'] = c.avKey.trim()
    return { url: `${fnUrl('alphavantage')}?${qs}`, headers }
  }
  if (c.provider === 'fmp') {
    headers['x-fmp-key'] = c.fmpKey.trim()
    return { url: `${fnUrl('fmp')}?${qs}`, headers }
  }
  headers['x-ms-user'] = c.username.trim()
  headers['x-ms-pass'] = c.password
  headers['x-ms-region'] = c.region
  return { url: `${fnUrl('morningstar')}?${qs}`, headers }
}

// Alpha Vantage's free tier caps bursts at ~1 request/second. Reserve 1.2s
// slots so concurrent watchlist loads queue instead of tripping the limit.
let nextAvSlot = 0
function avGate(): Promise<void> {
  const now = Date.now()
  const wait = Math.max(0, nextAvSlot - now)
  nextAvSlot = Math.max(now, nextAvSlot) + 1200
  return wait ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve()
}

async function callFn(c: Config, params: Record<string, string>) {
  if (c.provider === 'alphavantage') await avGate()
  const { url, headers } = providerRequest(c, params)
  const res = await fetch(url, { headers })
  const body = await res.json()
  if (!res.ok || body.error) throw new Error(body.error ?? `Request failed (${res.status})`)
  return body.data
}

// Date `days` ago in yyyy-mm-dd, for the history start parameter.
function startDate(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().slice(0, 10)
}

// Format a price; with no currency (Alpha Vantage) show a plain number.
function fmtPrice(v: number, currency: string | null): string {
  if (!currency) return v.toFixed(2)
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(v)
  } catch {
    return v.toFixed(2)
  }
}

// First/last of a series → absolute and percentage change over the range.
function rangeChange(series: Point[]): { abs: number; pct: number } | null {
  if (series.length < 2) return null
  const first = series[0].value
  const last = series[series.length - 1].value
  if (!first) return null
  return { abs: last - first, pct: ((last - first) / first) * 100 }
}

function Sparkline({
  series,
  width = 120,
  height = 32,
  up,
}: {
  series: Point[]
  width?: number
  height?: number
  up: boolean
}) {
  if (series.length < 2) return null
  const values = series.map((p) => p.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const stepX = width / (series.length - 1)
  const points = values
    .map((v, i) => `${(i * stepX).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`)
    .join(' ')
  const stroke = up ? '#34d399' : '#f87171'
  return (
    <svg width={width} height={height} className="overflow-visible" aria-hidden>
      <polyline points={points} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  )
}

// Larger chart with axis-free area fill, used in the expanded row.
function AreaChart({ series, up }: { series: Point[]; up: boolean }) {
  const width = 560
  const height = 180
  if (series.length < 2) return null
  const values = series.map((p) => p.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const stepX = width / (series.length - 1)
  const coords = values.map(
    (v, i) => [i * stepX, height - ((v - min) / span) * (height - 12) - 6] as const
  )
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `0,${height} ${line} ${width},${height}`
  const stroke = up ? '#34d399' : '#f87171'
  const fill = up ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)'
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="mt-3 w-full" preserveAspectRatio="none">
      <polygon points={area} fill={fill} />
      <polyline points={line} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" />
    </svg>
  )
}

function ChangeBadge({
  change,
  currency,
}: {
  change: { abs: number; pct: number } | null
  currency: string | null
}) {
  if (!change) return <span className="text-xs text-slate-500">—</span>
  const up = change.abs >= 0
  return (
    <span className={`text-sm font-medium tabular-nums ${up ? 'text-emerald-400' : 'text-red-400'}`}>
      {up ? '▲' : '▼'} {fmtPrice(Math.abs(change.abs), currency)} ({up ? '+' : ''}
      {change.pct.toFixed(2)}%)
    </span>
  )
}

// A labelled weight bar, reused for both holdings and sectors.
function WeightBar({ label, sub, weight, max }: { label: string; sub?: string; weight: number | null; max: number }) {
  const w = weight != null ? Math.max(2, (weight / max) * 100) : 0
  return (
    <li className="flex items-center gap-3">
      <span className="w-40 shrink-0 truncate text-xs text-slate-300" title={label}>
        {label}
        {sub && <span className="ml-1 text-slate-600">{sub}</span>}
      </span>
      <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-white/5">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-indigo-500 to-violet-500"
          style={{ width: `${w}%` }}
        />
      </span>
      <span className="w-12 shrink-0 text-right text-xs tabular-nums text-slate-400">
        {weight != null ? `${weight.toFixed(1)}%` : '—'}
      </span>
    </li>
  )
}

function HoldingsPanel({
  holdings,
  loading,
  error,
}: {
  holdings: Holdings | undefined
  loading: boolean
  error: string | undefined
}) {
  if (loading) return <p className="mt-4 animate-pulse text-xs text-slate-500">Loading holdings…</p>
  if (error) return <p className="mt-4 text-xs text-amber-300">{error}</p>
  if (!holdings) return null
  if (!holdings.holdings.length) {
    return (
      <p className="mt-4 text-xs text-slate-500">
        No holdings published for this security — it looks like an individual stock rather than a
        fund or ETF.
      </p>
    )
  }
  const maxHolding = Math.max(...holdings.holdings.map((h) => h.weight ?? 0), 1)
  const maxSector = Math.max(...holdings.sectors.map((s) => s.weight ?? 0), 1)
  return (
    <div className="mt-4 border-t border-white/10 pt-4">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">
        Top holdings ({holdings.holdings.length})
        {holdings.via && <span className="ml-2 normal-case tracking-normal text-slate-600">via {holdings.via}</span>}
      </p>
      <ul className="space-y-1.5">
        {holdings.holdings.map((h, i) => (
          <WeightBar
            key={h.secId ?? h.ticker ?? `${h.name}-${i}`}
            label={h.name}
            sub={h.ticker ?? undefined}
            weight={h.weight}
            max={maxHolding}
          />
        ))}
      </ul>
      {holdings.sectors.length > 0 && (
        <>
          <p className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">
            Sectors
          </p>
          <ul className="space-y-1.5">
            {holdings.sectors.map((s) => (
              <WeightBar key={s.name} label={s.name} weight={s.weight} max={maxSector} />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function WatchRow({
  security,
  history,
  loading,
  expanded,
  holdings,
  holdingsLoading,
  holdingsError,
  onToggle,
  onRemove,
}: {
  security: Security
  history: History | undefined
  loading: boolean
  expanded: boolean
  holdings: Holdings | undefined
  holdingsLoading: boolean
  holdingsError: string | undefined
  onToggle: () => void
  onRemove: () => void
}) {
  const series = history?.series ?? []
  const currency = history?.currency ?? security.currency ?? null
  const change = rangeChange(series)
  const up = (change?.abs ?? 0) >= 0
  const latest = series.length ? series[series.length - 1].value : null

  return (
    <li className="glass rounded-2xl p-4">
      <div className="flex items-center gap-3">
        <button onClick={onToggle} className="min-w-0 flex-1 text-left">
          <p className="truncate text-sm font-medium text-white">{security.name}</p>
          <p className="mt-0.5 truncate text-xs text-slate-500">
            {[security.ticker, security.exchange, security.type].filter(Boolean).join(' · ') || security.id}
          </p>
        </button>

        {loading ? (
          <span className="animate-pulse text-xs text-slate-500">Loading…</span>
        ) : (
          <>
            <div className="hidden sm:block">
              <Sparkline series={series} up={up} />
            </div>
            <div className="text-right">
              <p className="text-sm font-semibold tabular-nums text-white">
                {latest != null ? fmtPrice(latest, currency) : '—'}
              </p>
              <ChangeBadge change={change} currency={currency} />
            </div>
          </>
        )}

        <button
          onClick={onRemove}
          title="Remove from watchlist"
          className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-400 transition-all duration-200 hover:border-red-500/40 hover:text-red-300"
        >
          ✕
        </button>
      </div>

      {expanded && (
        <>
          {!loading && series.length > 1 && (
            <>
              <AreaChart series={series} up={up} />
              <p className="mt-1 text-center text-[11px] text-slate-500">
                {series[0].date} → {series[series.length - 1].date} · {series.length} points
                {currency ? ` · ${currency}` : ''}
              </p>
            </>
          )}
          <HoldingsPanel holdings={holdings} loading={holdingsLoading} error={holdingsError} />
        </>
      )}
    </li>
  )
}

export function StockTracker() {
  const { config, setConfig, loading, saving } = useUtilityConfig<Config>('stock-tracker', DEFAULTS)

  const hasCreds = hasCredentials(config)
  const isAv = config.provider === 'alphavantage'

  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Security[]>([])
  const [searching, setSearching] = useState(false)
  // History is cached per (security, range) so flipping ranges or re-rendering
  // never refetches — important against Alpha Vantage's 25-requests/day cap.
  const [histories, setHistories] = useState<Record<string, History>>({})
  const [loadingIds, setLoadingIds] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [holdingsMap, setHoldingsMap] = useState<Record<string, Holdings>>({})
  const [holdingsLoading, setHoldingsLoading] = useState<Record<string, boolean>>({})
  const [holdingsError, setHoldingsError] = useState<Record<string, string>>({})
  const inFlight = useRef<Set<string>>(new Set())

  const range = RANGES.find((r) => r.key === config.range) ?? RANGES[1]
  const histKey = (id: string) => `${id}::${config.provider}::${config.range}`
  const holdKey = (id: string) => `${config.provider}::${id}`

  const loadHistory = useCallback(
    async (security: Security) => {
      const key = histKey(security.id)
      if (inFlight.current.has(key)) return
      inFlight.current.add(key)
      setLoadingIds((s) => ({ ...s, [key]: true }))
      try {
        const params: Record<string, string> = {
          action: 'history',
          id: security.id,
          frequency: range.frequency,
          start: startDate(range.days),
        }
        if (config.provider === 'morningstar') params.currency = config.currency
        const data = (await callFn(config, params)) as History
        setHistories((s) => ({ ...s, [key]: data }))
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load price history.')
      } finally {
        inFlight.current.delete(key)
        setLoadingIds((s) => ({ ...s, [key]: false }))
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range.frequency, range.days, config]
  )

  const loadHoldings = useCallback(
    async (security: Security) => {
      const key = holdKey(security.id)

      // FMP's holdings endpoints require a paid plan, so when FMP is selected we
      // source holdings from Alpha Vantage instead (both key by ticker). That
      // needs a free AV key; if none is set, point the user at one.
      const fmpFallback = config.provider === 'fmp'
      if (fmpFallback && !config.avKey.trim()) {
        setHoldingsError((s) => ({
          ...s,
          [key]:
            "FMP's holdings data needs a paid plan. Add a free Alpha Vantage key above (or switch to the Alpha Vantage provider) to see holdings.",
        }))
        return
      }
      const holdingsConfig: Config = fmpFallback ? { ...config, provider: 'alphavantage' } : config

      setHoldingsLoading((s) => ({ ...s, [key]: true }))
      setHoldingsError((s) => ({ ...s, [key]: '' }))
      try {
        const params: Record<string, string> = { action: 'holdings', id: security.id, count: '25' }
        if (holdingsConfig.provider === 'morningstar') {
          params.viewId = config.holdingsViewId
          params.currency = config.currency
        }
        const data = (await callFn(holdingsConfig, params)) as Holdings
        if (fmpFallback) data.via = 'Alpha Vantage'
        setHoldingsMap((s) => ({ ...s, [key]: data }))
      } catch (e) {
        setHoldingsError((s) => ({
          ...s,
          [key]: e instanceof Error ? e.message : 'Could not load holdings.',
        }))
      } finally {
        setHoldingsLoading((s) => ({ ...s, [key]: false }))
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config]
  )

  // Load histories for any watchlist row not already cached for the current
  // (provider, range). Switching to a range that's been loaded before is instant
  // and costs no request.
  const watchKey = config.watchlist.map((s) => s.id).join(',')
  useEffect(() => {
    if (loading || !hasCreds || !config.watchlist.length) return
    config.watchlist.forEach((s) => {
      if (!histories[histKey(s.id)]) loadHistory(s)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, hasCreds, watchKey, config.provider, config.range, config.currency, config.region])

  function toggleExpand(security: Security) {
    setExpanded((cur) => {
      const next = cur === security.id ? null : security.id
      // Lazily fetch holdings the first time a row is opened (per provider).
      const key = holdKey(security.id)
      if (next === security.id && !holdingsMap[key] && !holdingsLoading[key]) {
        loadHoldings(security)
      }
      return next
    })
  }

  async function search() {
    const q = query.trim()
    if (!q || !hasCreds) return
    setSearching(true)
    setError(null)
    try {
      const params: Record<string, string> = { action: 'search', q }
      if (config.provider === 'morningstar') params.currency = config.currency
      const data = (await callFn(config, params)) as Security[]
      setResults(data)
      if (!data.length) setError('No securities matched that search.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed.')
    } finally {
      setSearching(false)
    }
  }

  function addToWatchlist(s: Security) {
    if (config.watchlist.some((w) => w.id === s.id)) return
    setConfig((prev) => ({ ...prev, watchlist: [...prev.watchlist, s] }))
    setResults([])
    setQuery('')
    loadHistory(s)
  }

  function removeFromWatchlist(id: string) {
    setConfig((prev) => ({ ...prev, watchlist: prev.watchlist.filter((w) => w.id !== id) }))
    if (expanded === id) setExpanded(null)
  }

  if (loading) {
    return <p className="animate-pulse text-slate-400">Loading your settings…</p>
  }

  const providerTab = (p: Provider) =>
    `rounded-xl px-4 py-1.5 text-sm transition-all duration-200 ${
      config.provider === p
        ? 'bg-gradient-to-r from-indigo-500 to-violet-500 text-white shadow-lg shadow-indigo-500/25'
        : 'border border-white/10 bg-white/5 text-slate-300 hover:border-white/20 hover:bg-white/10'
    }`

  return (
    <div className="max-w-2xl animate-fade-up">
      <div className="flex items-baseline justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Stock Tracker</h1>
        <SaveStatus saving={saving} />
      </div>
      <p className="mt-2 text-slate-400">
        Search securities, track a watchlist of prices and charts, and drill into any fund or ETF's
        underlying holdings.
      </p>

      {/* Provider toggle */}
      <div className="mt-8 flex flex-wrap gap-2">
        <button className={providerTab('alphavantage')} onClick={() => setConfig({ provider: 'alphavantage' })}>
          Alpha Vantage · free
        </button>
        <button className={providerTab('fmp')} onClick={() => setConfig({ provider: 'fmp' })}>
          FMP · free
        </button>
        <button className={providerTab('morningstar')} onClick={() => setConfig({ provider: 'morningstar' })}>
          Morningstar · paid
        </button>
      </div>

      {/* Credentials */}
      <div className="glass mt-4 rounded-2xl p-4">
        {isAv ? (
          <>
            <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">
              Alpha Vantage API key
            </p>
            <input
              type="password"
              value={config.avKey}
              onChange={(e) => setConfig({ avKey: e.target.value })}
              placeholder="Paste your Alpha Vantage key"
              autoComplete="off"
              className="glass mt-2.5 w-full rounded-xl px-3.5 py-2 text-sm text-white placeholder-slate-500 transition-all duration-200 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
            <p className="mt-2 text-xs text-slate-500">
              Get a free key at{' '}
              <a
                href="https://www.alphavantage.co/support/#api-key"
                target="_blank"
                rel="noreferrer"
                className="text-indigo-300 hover:text-indigo-200"
              >
                alphavantage.co
              </a>{' '}
              (no card). Free tier ≈ 25 requests/day, 1/sec — each search, chart and holdings view is
              one call, so the app throttles and caches to conserve them. Longer ranges use
              weekly/monthly data (full daily history is a premium feature). Holdings come from the
              ETF profile (US funds/ETFs). It's saved to your account (only you can read it) and sent
              straight to the provider.
            </p>
          </>
        ) : config.provider === 'fmp' ? (
          <>
            <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">
              Financial Modeling Prep API key
            </p>
            <input
              type="password"
              value={config.fmpKey}
              onChange={(e) => setConfig({ fmpKey: e.target.value })}
              placeholder="Paste your FMP key"
              autoComplete="off"
              className="glass mt-2.5 w-full rounded-xl px-3.5 py-2 text-sm text-white placeholder-slate-500 transition-all duration-200 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
            <p className="mt-2 text-xs text-slate-500">
              Get a free key at{' '}
              <a
                href="https://site.financialmodelingprep.com/developer/docs"
                target="_blank"
                rel="noreferrer"
                className="text-indigo-300 hover:text-indigo-200"
              >
                financialmodelingprep.com
              </a>{' '}
              (no card). Free plan ≈ 250 requests/day with no per-second limit — more headroom than
              Alpha Vantage for search and price history. FMP gates fund/ETF holdings behind a paid
              plan, so holdings are fetched from Alpha Vantage instead (add a free Alpha Vantage key
              above to enable them). It's saved to your account (only you can read it) and sent
              straight to the provider.
            </p>
          </>
        ) : (
          <>
            <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">
              Morningstar API credentials
            </p>
            <div className="mt-2.5 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <input
                type="text"
                value={config.username}
                onChange={(e) => setConfig({ username: e.target.value })}
                placeholder="API username"
                autoComplete="off"
                className="glass w-full rounded-xl px-3.5 py-2 text-sm text-white placeholder-slate-500 transition-all duration-200 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              />
              <input
                type="password"
                value={config.password}
                onChange={(e) => setConfig({ password: e.target.value })}
                placeholder="API password"
                autoComplete="off"
                className="glass w-full rounded-xl px-3.5 py-2 text-sm text-white placeholder-slate-500 transition-all duration-200 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              />
            </div>
            <div className="mt-3 flex flex-wrap gap-3">
              <label className="flex flex-col gap-1.5 text-xs text-slate-400">
                Region
                <select
                  value={config.region}
                  onChange={(e) => setConfig({ region: e.target.value as Region })}
                  className="glass rounded-xl px-3 py-2 text-sm text-white focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                >
                  <option value="na" className="bg-slate-900">North America (us-api)</option>
                  <option value="emea" className="bg-slate-900">EMEA (emea-api)</option>
                </select>
              </label>
              <label className="flex flex-col gap-1.5 text-xs text-slate-400">
                Currency
                <select
                  value={config.currency}
                  onChange={(e) => setConfig({ currency: e.target.value })}
                  className="glass rounded-xl px-3 py-2 text-sm text-white focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                >
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c} className="bg-slate-900">
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5 text-xs text-slate-400">
                Holdings view ID
                <input
                  type="text"
                  value={config.holdingsViewId}
                  onChange={(e) => setConfig({ holdingsViewId: e.target.value })}
                  placeholder="portfolio"
                  className="glass rounded-xl px-3 py-2 text-sm text-white placeholder-slate-600 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
              </label>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Direct Web Services is a paid, entitled product — see{' '}
              <a
                href="https://developer.morningstar.com/direct-web-services/documentation/documentation/get-started/authentication"
                target="_blank"
                rel="noreferrer"
                className="text-indigo-300 hover:text-indigo-200"
              >
                the developer docs
              </a>
              . Credentials are saved to your account (only you can read them) and exchanged for a
              short-lived token server-side. The holdings view ID is entitlement-specific.
            </p>
          </>
        )}
      </div>

      {!hasCreds && (
        <p className="mt-4 text-xs text-amber-300">
          {config.provider === 'alphavantage'
            ? 'Enter your Alpha Vantage API key above to start.'
            : config.provider === 'fmp'
              ? 'Enter your Financial Modeling Prep API key above to start.'
              : 'Enter your Morningstar API username and password above to start.'}
        </p>
      )}

      {/* Search */}
      <div className="mt-6 flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          placeholder="Search a stock, fund or ETF…"
          disabled={!hasCreds}
          className="glass flex-1 rounded-xl px-3.5 py-2 text-sm text-white placeholder-slate-500 transition-all duration-200 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-40"
        />
        <button
          onClick={search}
          disabled={!hasCreds || searching || !query.trim()}
          className="rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all duration-200 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {searching ? 'Searching…' : 'Search'}
        </button>
      </div>

      {error && (
        <p className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      )}

      {/* Search results */}
      {results.length > 0 && (
        <ul className="mt-4 space-y-2">
          {results.map((s) => {
            const added = config.watchlist.some((w) => w.id === s.id)
            return (
              <li
                key={s.id}
                className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-white">{s.name}</p>
                  <p className="truncate text-xs text-slate-500">
                    {[s.ticker, s.exchange, s.type].filter(Boolean).join(' · ') || s.id}
                  </p>
                </div>
                <button
                  onClick={() => addToWatchlist(s)}
                  disabled={added}
                  className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-200 transition-all duration-200 hover:border-white/20 hover:bg-white/10 disabled:opacity-40"
                >
                  {added ? 'Added' : '+ Watch'}
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {/* Range selector */}
      {config.watchlist.length > 0 && (
        <div className="mt-8 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-[0.15em] text-slate-500">
            Watchlist
          </h2>
          <div className="flex gap-1.5">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setConfig({ range: r.key })}
                className={`rounded-lg px-2.5 py-1 text-xs transition-all duration-200 ${
                  config.range === r.key
                    ? 'bg-gradient-to-r from-indigo-500 to-violet-500 text-white'
                    : 'border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Watchlist */}
      {config.watchlist.length > 0 ? (
        <ul className="mt-4 space-y-3">
          {config.watchlist.map((s) => (
            <WatchRow
              key={s.id}
              security={s}
              history={histories[histKey(s.id)]}
              loading={!!loadingIds[histKey(s.id)]}
              expanded={expanded === s.id}
              holdings={holdingsMap[holdKey(s.id)]}
              holdingsLoading={!!holdingsLoading[holdKey(s.id)]}
              holdingsError={holdingsError[holdKey(s.id)] || undefined}
              onToggle={() => toggleExpand(s)}
              onRemove={() => removeFromWatchlist(s.id)}
            />
          ))}
        </ul>
      ) : (
        hasCreds && (
          <p className="mt-8 text-sm text-slate-500">
            Your watchlist is empty — search above and add a security to start tracking it. Open a
            row to see its price chart and, for funds/ETFs, the underlying holdings.
          </p>
        )
      )}
    </div>
  )
}
