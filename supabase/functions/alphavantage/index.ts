// Alpha Vantage proxy for the "Stock Tracker" utility — the free provider.
//
// Alpha Vantage offers a genuinely free API key (no card, ~25 requests/day,
// 5/min) that covers everything this utility needs with reasonably fresh data:
//   • SYMBOL_SEARCH      — security search
//   • TIME_SERIES_*      — daily/weekly/monthly price history
//   • ETF_PROFILE        — fund/ETF holdings (symbol, name, weight) + sectors
//
// Each user brings their OWN Alpha Vantage key — the browser stores it in that
// user's RLS-protected utility_configs row and passes it here via the `x-av-key`
// header. We never persist it. Responses are normalized to the SAME shapes the
// `morningstar` function returns, so the UI is provider-agnostic.
//
// Deploy with: npx supabase functions deploy alphavantage

const API_BASE = 'https://www.alphavantage.co/query'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-av-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

async function avGet(params: Record<string, string>, key: string): Promise<Json> {
  const qs = new URLSearchParams({ ...params, apikey: key }).toString()
  const res = await fetch(`${API_BASE}?${qs}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Alpha Vantage returned ${res.status}`)
  // Alpha Vantage signals problems in 200-OK bodies, not status codes.
  if (data['Error Message']) throw new Error(String(data['Error Message']))
  if (data['Information']) throw new Error(String(data['Information']))
  if (data['Note']) {
    throw new Error('Alpha Vantage rate limit reached (free tier: ~25 requests/day). Try again later.')
  }
  return data
}

// --- Handlers ------------------------------------------------------------

async function handleSearch(p: URLSearchParams, key: string) {
  const q = (p.get('q') ?? '').trim()
  if (!q) throw new Error('Missing search term')
  const data = await avGet({ function: 'SYMBOL_SEARCH', keywords: q }, key)
  const matches: Json[] = data.bestMatches ?? []
  return matches.map((m) => ({
    id: m['1. symbol'], // Alpha Vantage keys everything by ticker symbol
    name: m['2. name'] ?? m['1. symbol'],
    ticker: m['1. symbol'],
    exchange: m['4. region'] ?? null,
    type: m['3. type'] ?? null,
    currency: m['8. currency'] ?? null,
  })).filter((s: Json) => s.id)
}

// `outputsize=full` on TIME_SERIES_DAILY is a premium feature, so daily uses
// the default `compact` window (~100 trading days, enough for 1M/3M). Weekly
// and monthly return full history for free, so longer ranges use those.
const SERIES_FN: Record<string, { fn: string; outputsize?: string }> = {
  daily: { fn: 'TIME_SERIES_DAILY', outputsize: 'compact' },
  weekly: { fn: 'TIME_SERIES_WEEKLY' },
  monthly: { fn: 'TIME_SERIES_MONTHLY' },
}

async function handleHistory(p: URLSearchParams, key: string) {
  const id = (p.get('id') ?? '').trim()
  if (!id) throw new Error('Missing security id')
  const frequency = p.get('frequency') || 'daily'
  const start = p.get('start') || '2020-01-01'
  const spec = SERIES_FN[frequency] ?? SERIES_FN.daily

  const params: Record<string, string> = { function: spec.fn, symbol: id }
  if (spec.outputsize) params.outputsize = spec.outputsize
  const data = await avGet(params, key)

  // The time-series object key varies by function ("Time Series (Daily)" etc.).
  const seriesKey = Object.keys(data).find((k) => k.toLowerCase().includes('time series'))
  if (!seriesKey) throw new Error('No price history returned for that symbol.')
  const raw: Json = data[seriesKey]

  const series = Object.entries(raw)
    .map(([date, vals]) => ({
      date,
      value: Number((vals as Json)['4. close'] ?? (vals as Json)['5. adjusted close']),
    }))
    .filter((pt) => !isNaN(pt.value) && pt.date >= start)
    .sort((a, b) => a.date.localeCompare(b.date))

  if (!series.length) throw new Error('No price history in the selected range.')
  // Alpha Vantage doesn't return a currency with prices; the UI shows the raw
  // number when currency is null rather than guessing a symbol.
  return { currency: null, frequency, series }
}

async function handleHoldings(p: URLSearchParams, key: string) {
  const id = (p.get('id') ?? '').trim()
  if (!id) throw new Error('Missing security id')
  const count = Math.min(100, Math.max(1, Number(p.get('count')) || 25))
  const data = await avGet({ function: 'ETF_PROFILE', symbol: id }, key)

  const raw: Json[] = data.holdings ?? []
  if (!Array.isArray(raw) || raw.length === 0) {
    // Not an ETF, or no holdings published — let the UI show an empty state.
    return { count: 0, holdings: [], sectors: [], asOf: null }
  }
  const holdings = raw
    .map((h) => ({
      secId: null,
      name: h.description ?? h.symbol ?? 'Unknown',
      ticker: h.symbol ?? null,
      weight: h.weight != null ? Number(h.weight) * 100 : null, // fraction → %
      type: null,
    }))
    .filter((h) => !isNaN(h.weight ?? NaN))
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, count)

  const sectors = (data.sectors ?? []).map((s: Json) => ({
    name: s.sector,
    weight: s.weight != null ? Number(s.weight) * 100 : null,
  }))

  return { count: holdings.length, holdings, sectors }
}

// --- Entry ---------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })

  const key = req.headers.get('x-av-key')
  if (!key) return json({ error: 'Missing Alpha Vantage API key.' }, 400)

  const url = new URL(req.url)
  const action = url.searchParams.get('action')

  try {
    if (action === 'search') return json({ data: await handleSearch(url.searchParams, key) })
    if (action === 'history') return json({ data: await handleHistory(url.searchParams, key) })
    if (action === 'holdings') return json({ data: await handleHoldings(url.searchParams, key) })
    return json({ error: `Unknown action: ${action}` }, 400)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Request failed' }, 502)
  }
})
