// Financial Modeling Prep proxy for the "Stock Tracker" utility — a second free
// provider with a more generous quota than Alpha Vantage.
//
// Each user brings their OWN FMP key, passed here via the `x-fmp-key` header; we
// never persist it. Responses are normalized to the SAME shapes the other Stock
// Tracker providers return. (Ported from the Supabase edge function; CORS
// headers are added by ../index.mjs.)

import { json } from './_shared.mjs'

const API_BASE = 'https://financialmodelingprep.com'

async function fmpGet(path, params, key) {
  const qs = new URLSearchParams({ ...params, apikey: key }).toString()
  const res = await fetch(`${API_BASE}${path}?${qs}`)
  // Errors (e.g. 402 "Restricted Endpoint") come back as plain text, not JSON.
  const text = await res.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    data = null
  }
  if (!res.ok) {
    const msg =
      (data && (data['Error Message'] ?? data['message'])) ||
      text.trim().slice(0, 200) ||
      `FMP returned ${res.status}`
    throw new Error(String(msg))
  }
  if (data && !Array.isArray(data) && (data['Error Message'] || data['message'])) {
    throw new Error(String(data['Error Message'] ?? data['message']))
  }
  return data
}

// "29.43%" | "0.2943"-as-already-percent | 7.12 → a percentage number (0–100).
function toPercent(v) {
  if (v == null) return null
  const n = Number(String(v).replace('%', '').trim())
  return isNaN(n) ? null : n
}

// --- Handlers ------------------------------------------------------------

async function handleSearch(p, key) {
  const q = (p.get('q') ?? '').trim()
  if (!q) throw new Error('Missing search term')
  const rows = await fmpGet('/stable/search-symbol', { query: q, limit: '25' }, key)
  return (Array.isArray(rows) ? rows : []).slice(0, 25).map((r) => ({
    id: r.symbol,
    name: r.name ?? r.symbol,
    ticker: r.symbol,
    exchange: r.exchangeFullName ?? r.exchange ?? null,
    type: null,
    currency: r.currency ?? null,
  })).filter((s) => s.id)
}

async function handleHistory(p, key) {
  const id = (p.get('id') ?? '').trim()
  if (!id) throw new Error('Missing security id')
  const start = p.get('start') || '2020-01-01'

  // Use the `light` EOD endpoint (date + price): it's on the free plan, whereas
  // `historical-price-eod/full` (OHLC/VWAP) is a premium dataset and 402s.
  const data = await fmpGet('/stable/historical-price-eod/light', { symbol: id, from: start }, key)
  // Stable returns a flat array; the legacy v3 shape wraps it under `historical`.
  const bars = Array.isArray(data) ? data : (data.historical ?? [])
  if (!bars.length) throw new Error('No price history returned for that symbol.')

  const series = bars
    .map((b) => ({
      date: String(b.date).slice(0, 10),
      value: Number(b.price ?? b.close ?? b.adjClose),
    }))
    .filter((pt) => !isNaN(pt.value) && pt.date >= start)
    .sort((a, b) => a.date.localeCompare(b.date))

  if (!series.length) throw new Error('No price history in the selected range.')
  // FMP doesn't return a currency with each bar; the UI shows the raw number.
  return { currency: null, frequency: 'daily', series }
}

async function handleHoldings(p, key) {
  const id = (p.get('id') ?? '').trim()
  if (!id) throw new Error('Missing security id')
  const count = Math.min(100, Math.max(1, Number(p.get('count')) || 25))

  const raw = await fmpGet('/stable/etf/holdings', { symbol: id }, key)
  if (!Array.isArray(raw) || raw.length === 0) {
    return { count: 0, holdings: [], sectors: [] }
  }
  const holdings = raw
    .map((h) => ({
      secId: null,
      name: h.name ?? h.asset ?? 'Unknown',
      ticker: h.asset ?? h.symbol ?? null,
      weight: toPercent(h.weightPercentage ?? h.weight),
      type: null,
    }))
    .filter((h) => h.weight != null)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, count)

  // Sector breakdown is a separate endpoint; treat it as best-effort so a
  // holdings result still renders if sectors aren't available on the plan.
  let sectors = []
  try {
    const sec = await fmpGet('/stable/etf/sector-weightings', { symbol: id }, key)
    if (Array.isArray(sec)) {
      sectors = sec
        .map((s) => ({ name: s.sector ?? 'Unknown', weight: toPercent(s.weightPercentage ?? s.weight) }))
        .filter((s) => s.weight != null)
    }
  } catch {
    sectors = []
  }

  return { count: holdings.length, holdings, sectors }
}

// --- Entry ---------------------------------------------------------------

export async function handle({ url, header }) {
  const key = header('x-fmp-key')
  if (!key) return json({ error: 'Missing Financial Modeling Prep API key.' }, 400)

  const action = url.searchParams.get('action')
  try {
    if (action === 'search') return json({ data: await handleSearch(url.searchParams, key) })
    if (action === 'history') return json({ data: await handleHistory(url.searchParams, key) })
    if (action === 'holdings') return json({ data: await handleHoldings(url.searchParams, key) })
    return json({ error: `Unknown action: ${action}` }, 400)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Request failed' }, 502)
  }
}
