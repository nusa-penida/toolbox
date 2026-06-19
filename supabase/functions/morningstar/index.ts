// Morningstar proxy for the "Stock Tracker" utility.
//
// Backed by Morningstar Direct Web Services. The browser can't call it directly
// (no CORS) and shouldn't hold the auth credentials, so this function does the
// MaaS token exchange and proxies the data calls.
//
// Morningstar uses short-lived (60-minute) bearer tokens minted from your API
// account credentials via Basic auth against /token/oauth. Each user brings
// their OWN Morningstar username + password — the browser stores them in that
// user's RLS-protected utility_configs row and passes them here per request via
// the `x-ms-user` / `x-ms-pass` headers. We never persist them; we only cache
// the minted token in memory for its lifetime to avoid re-minting every call.
//
// NOTE: Direct Web Services is a paid, entitled product. Endpoint paths and the
// exact data points returned depend on your account's entitlements. The paths
// below match Morningstar's published Data Access Library (ecint/v1).
//
// Actions (?action=):
//   search   — find securities matching a term (param: q)
//   history  — daily/weekly/monthly price series (params: id, frequency, start)
//   holdings — the underlying portfolio of a fund/ETF (params: id, viewId, count)
//
// Latest price and day change are derived client-side from the history series,
// so no separate quote entitlement is required. Fund holdings come from the
// securities-details endpoint under a holdings-bearing view; the exact viewId
// is entitlement-specific, so the client passes it through.
//
// Deploy with: npx supabase functions deploy morningstar

// Region → API host. The token endpoint and the ecint/v1 data endpoints both
// live under the same regional host.
const HOSTS: Record<string, string> = {
  na: 'www.us-api.morningstar.com',
  emea: 'www.emea-api.morningstar.com',
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-ms-user, x-ms-pass, x-ms-region',
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

// --- Token minting + cache ----------------------------------------------
//
// A MaaS token is a JWT whose payload carries an `exp` (seconds). We cache the
// minted token per (host + credentials) until shortly before it expires. The
// cache lives only for the lifetime of this function instance.

interface CachedToken {
  token: string
  expMs: number
}
const tokenCache = new Map<string, CachedToken>()

function tokenExpiryMs(token: string): number {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    if (typeof payload.exp === 'number') return payload.exp * 1000
  } catch {
    // Not a JWT we can read — treat as short-lived.
  }
  return Date.now() + 55 * 60 * 1000 // assume ~60 min, refresh a little early
}

async function getToken(host: string, user: string, pass: string): Promise<string> {
  const key = `${host}:${user}:${pass}`
  const cached = tokenCache.get(key)
  if (cached && cached.expMs - 60_000 > Date.now()) return cached.token

  const basic = btoa(`${user}:${pass}`)
  const res = await fetch(`https://${host}/token/oauth`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' },
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(
      res.status === 401
        ? 'Morningstar rejected those credentials (401). Check your API username and password.'
        : `Morningstar token request failed (${res.status}). ${text.slice(0, 200)}`
    )
  }
  // The endpoint may return the raw token or a JSON envelope; handle both.
  let token = text.trim()
  try {
    const parsed = JSON.parse(text)
    token = parsed.access_token ?? parsed.token ?? parsed.maas_token ?? token
  } catch {
    // Plain-text token, use as-is.
  }
  token = token.replace(/^"|"$/g, '').replace(/^Bearer\s+/i, '')
  if (!token) throw new Error('Morningstar returned an empty token.')

  tokenCache.set(key, { token, expMs: tokenExpiryMs(token) })
  return token
}

async function apiGet(host: string, token: string, path: string): Promise<Json> {
  const res = await fetch(`https://${host}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  const text = await res.text()
  let data: Json = {}
  try {
    data = JSON.parse(text)
  } catch {
    data = { _raw: text }
  }
  if (!res.ok) {
    const msg = data?.message ?? data?.error ?? text.slice(0, 200)
    throw new Error(`Morningstar returned ${res.status}: ${msg}`)
  }
  return data
}

// --- Response extraction (defensive) ------------------------------------
//
// Field casing varies across entitlements/views, so look these up leniently.

function pick(obj: Json, ...keys: string[]): Json {
  if (!obj || typeof obj !== 'object') return undefined
  for (const k of keys) {
    if (obj[k] != null) return obj[k]
    const found = Object.keys(obj).find((kk) => kk.toLowerCase() === k.toLowerCase())
    if (found && obj[found] != null) return obj[found]
  }
  return undefined
}

function mapSecurity(row: Json) {
  return {
    id: pick(row, 'secId', 'SecId', 'securityId', 'masterPortfolioId'),
    name: pick(row, 'name', 'Name', 'standardName') ?? 'Unknown',
    ticker: pick(row, 'ticker', 'Ticker', 'tenforeId', 'symbol') ?? null,
    exchange: pick(row, 'exchange', 'Exchange', 'exchangeId') ?? null,
    type: pick(row, 'investmentType', 'InvestmentType', 'securityType') ?? null,
    currency: pick(row, 'currency', 'Currency', 'priceCurrency') ?? null,
  }
}

// Walk the securities-details payload and pull out fund holdings. Holdings live
// under views like PortfolioHoldings(Us)Data as arrays of { secId, name, weight,
// holdingType }; nesting varies by entitlement, so find the largest array whose
// elements carry both a name and a numeric weight.
function extractHoldings(data: Json, count: number) {
  let best: Json[] = []

  const nameOf = (n: Json) => pick(n, 'name', 'Name', 'securityName', 'StandardName', 'holdingName')
  const weightOf = (n: Json) =>
    pick(n, 'weight', 'Weight', 'weighting', 'Weighting', 'InitialWeight', 'percentage', 'Percent')

  const visit = (node: Json) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      const looksLikeHoldings =
        node.length > 0 &&
        node.every((el) => el && typeof el === 'object') &&
        node.filter((el) => nameOf(el) != null && weightOf(el) != null).length >= node.length / 2
      if (looksLikeHoldings && node.length > best.length) best = node
      node.forEach(visit)
      return
    }
    for (const k of Object.keys(node)) if (typeof node[k] === 'object') visit(node[k])
  }
  visit(data)

  return best
    .map((h) => ({
      secId: pick(h, 'secId', 'SecId', 'securityId') ?? null,
      name: nameOf(h) ?? 'Unknown',
      ticker: pick(h, 'ticker', 'Ticker', 'symbol') ?? null,
      weight: weightOf(h) != null ? Number(weightOf(h)) : null,
      type: pick(h, 'holdingType', 'HoldingType', 'securityType') ?? null,
    }))
    .filter((h) => !isNaN(h.weight ?? NaN))
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, count)
}

// Walk the time-series payload and pull out { date, value } points wherever
// they live (TimeSeries.Security[].HistoryDetail[] is the documented shape).
function extractSeries(data: Json): { date: string; value: number }[] {
  const points: { date: string; value: number }[] = []

  const visit = (node: Json) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    const date = pick(node, 'EndDate', 'endDate', 'date', 'd')
    const value = pick(node, 'Value', 'value', 'v', 'close', 'price')
    if (date != null && value != null && !isNaN(Number(value))) {
      points.push({ date: String(date), value: Number(value) })
    }
    for (const k of Object.keys(node)) {
      if (typeof node[k] === 'object') visit(node[k])
    }
  }
  visit(data)

  // De-dupe by date and sort ascending so the client can chart directly.
  const byDate = new Map<string, number>()
  for (const p of points) byDate.set(p.date, p.value)
  return [...byDate.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

// --- Handlers ------------------------------------------------------------

async function handleSearch(host: string, token: string, p: URLSearchParams) {
  const q = (p.get('q') ?? '').trim()
  if (!q) throw new Error('Missing search term')
  const lang = p.get('lang') || 'en-US'
  const currency = p.get('currency') || 'USD'
  const dataPoints = 'secId,tenforeId,name,closePrice,investmentType,exchange,currency,universe'

  const path =
    `/ecint/v1/screener?page=1&pageSize=20&sortOrder=${encodeURIComponent('Name asc')}` +
    `&outputType=json&version=1&languageId=${encodeURIComponent(lang)}` +
    `&currencyId=${encodeURIComponent(currency)}&universeIds=` +
    `&securityDataPoints=${encodeURIComponent(dataPoints)}&filters=&term=${encodeURIComponent(q)}`

  const data = await apiGet(host, token, path)
  const rows: Json[] = pick(data, 'rows', 'Rows', 'results', 'securities') ?? []
  return (Array.isArray(rows) ? rows : []).map(mapSecurity).filter((s) => s.id)
}

async function handleHistory(host: string, token: string, p: URLSearchParams) {
  const id = (p.get('id') ?? '').trim()
  if (!id) throw new Error('Missing security id')
  const frequency = p.get('frequency') || 'daily'
  const start = p.get('start') || '2020-01-01'
  const lang = p.get('lang') || 'en-US'
  const currency = p.get('currency') || 'USD'

  const path =
    `/ecint/v1/timeseries/price?id=${encodeURIComponent(id)}&idtype=MSID` +
    `&frequency=${encodeURIComponent(frequency)}&startDate=${encodeURIComponent(start)}` +
    `&languageId=${encodeURIComponent(lang)}&currencyId=${encodeURIComponent(currency)}&outputType=json`

  const data = await apiGet(host, token, path)
  const series = extractSeries(data)
  if (!series.length) {
    throw new Error('No price history returned for that security on your entitlement.')
  }
  return { currency, frequency, series }
}

async function handleHoldings(host: string, token: string, p: URLSearchParams) {
  const id = (p.get('id') ?? '').trim()
  if (!id) throw new Error('Missing security id')
  const viewId = p.get('viewId') || 'portfolio'
  const count = Math.min(100, Math.max(1, Number(p.get('count')) || 25))
  const lang = p.get('lang') || 'en-US'
  const currency = p.get('currency') || 'USD'

  const path =
    `/ecint/v1/securities/${encodeURIComponent(id)}?viewId=${encodeURIComponent(viewId)}` +
    `&idtype=msid&languageId=${encodeURIComponent(lang)}` +
    `&currencyId=${encodeURIComponent(currency)}&responseViewFormat=json`

  const data = await apiGet(host, token, path)
  const holdings = extractHoldings(data, count)
  // `sectors` is returned for shape parity with the Alpha Vantage provider;
  // Morningstar's sector breakdown lives under a different view, so it's empty
  // here unless your holdings view happens to include it.
  return { viewId, count: holdings.length, holdings, sectors: [] }
}

// --- Entry ---------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })

  const user = req.headers.get('x-ms-user')
  const pass = req.headers.get('x-ms-pass')
  if (!user || !pass) {
    return json({ error: 'Missing Morningstar API credentials.' }, 400)
  }
  const region = (req.headers.get('x-ms-region') || 'na').toLowerCase()
  const host = HOSTS[region] ?? HOSTS.na

  const url = new URL(req.url)
  const action = url.searchParams.get('action')

  try {
    const token = await getToken(host, user, pass)
    if (action === 'search') return json({ data: await handleSearch(host, token, url.searchParams) })
    if (action === 'history') return json({ data: await handleHistory(host, token, url.searchParams) })
    if (action === 'holdings') return json({ data: await handleHoldings(host, token, url.searchParams) })
    return json({ error: `Unknown action: ${action}` }, 400)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Request failed' }, 502)
  }
})
