import { useRef, useState } from 'react'
import { SaveStatus } from '../../components/SaveStatus'
import { useUtilityConfig } from '../../hooks/useUtilityConfig'

/**
 * Shortest route generator: paste a list of addresses, the tool geocodes them
 * (Nominatim/OpenStreetMap) and reorders the stops so the route is as short
 * as possible (nearest-neighbour seed + 2-opt on straight-line distances),
 * then builds Google Maps / Apple Maps / Waze links to start navigating.
 */

type TravelMode = 'driving' | 'walking' | 'bicycling'

interface Stop {
  address: string
  lat: number
  lon: number
  label: string
}

const MAX_STOPS = 30

const TRAVEL_MODES: { id: TravelMode; label: string; icon: string }[] = [
  { id: 'driving', label: 'Driving', icon: '🚗' },
  { id: 'walking', label: 'Walking', icon: '🚶' },
  { id: 'bicycling', label: 'Cycling', icon: '🚴' },
]

// --- Geocoding (Nominatim, max 1 request/second per usage policy) ---

async function geocode(query: string): Promise<Omit<Stop, 'address'> | null> {
  const url =
    'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' +
    encodeURIComponent(query)
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) return null
  const data: { lat: string; lon: string; display_name: string }[] = await res.json()
  if (!data.length) return null
  return {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon),
    label: data[0].display_name,
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// --- Shared list import (Google Maps lists & Apple Maps guides) ---
//
// Neither Google nor Apple offers a public API for shared lists, so this
// reads the same data their own web pages embed. Google: the internal
// `entitylist/getlist` endpoint keyed by the list id from the share URL.
// Apple: the `shell-props` JSON embedded in the maps.apple.com guide page.
// Both are fetched through a public CORS proxy (allorigins) since the
// browser can't call google.com/apple.com directly; the proxy is flaky, so
// requests retry a few times.

interface ImportedList {
  title: string | null
  stops: { address: string; lat: number; lon: number }[]
}

// Proxy strategies, tried in order. The Supabase edge function (if deployed)
// is ours and reliable; the public proxies are best-effort fallbacks that go
// down or rate-limit regularly.
const PROXY_STRATEGIES: ((url: string) => Promise<string>)[] = [
  async (url) => {
    const base = import.meta.env.VITE_SUPABASE_URL
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY
    const res = await fetch(`${base}/functions/v1/cors-proxy?url=${encodeURIComponent(url)}`, {
      headers: { Authorization: `Bearer ${key}`, apikey: key },
    })
    if (!res.ok) throw new Error(`Edge proxy returned ${res.status}`)
    return res.text()
  },
  async (url) => {
    const res = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`)
    if (!res.ok) throw new Error(`allorigins returned ${res.status}`)
    const data: { contents?: string } = await res.json()
    if (!data.contents) throw new Error('allorigins returned an empty body')
    return data.contents
  },
  async (url) => {
    const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`)
    if (!res.ok) throw new Error(`allorigins raw returned ${res.status}`)
    return res.text()
  },
  async (url) => {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { 'X-Return-Format': 'html' },
    })
    if (!res.ok) throw new Error(`jina returned ${res.status}`)
    return res.text()
  },
]

async function fetchViaProxy(url: string): Promise<string> {
  let lastError: unknown = null
  for (const strategy of PROXY_STRATEGIES) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await strategy(url)
      } catch (e) {
        lastError = e
      }
      await sleep(800)
    }
  }
  throw lastError
}

function parseGoogleList(raw: string): ImportedList {
  // Response is anti-JSON-hijacking prefixed with )]}'
  const data = JSON.parse(raw.slice(raw.indexOf('\n') + 1))
  const items: unknown[][] = data?.[0]?.[8] ?? []
  return {
    title: typeof data?.[0]?.[4] === 'string' ? data[0][4] : null,
    stops: items
      .map((it) => {
        const coords = (it?.[1] as unknown[][])?.[5]
        return { address: it?.[2], lat: coords?.[2], lon: coords?.[3] }
      })
      .filter(
        (s): s is ImportedList['stops'][number] =>
          typeof s.address === 'string' && typeof s.lat === 'number' && typeof s.lon === 'number'
      ),
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function parseAppleGuide(html: string): ImportedList {
  const m = html.match(/<script id="shell-props" type="application\/json">([\s\S]*?)<\/script>/)
  if (!m) throw new Error('Could not find guide data in the Apple Maps page.')
  const state: any = JSON.parse(m[1]).initialState
  const cache: Record<string, any> = state?.placeCache ?? {}
  const card = (state?.cards ?? []).find((c: any) => c?.opts?.placeRefs?.length)
  const refs: string[] = card?.opts?.placeRefs ?? Object.keys(cache)
  return {
    title: card?.opts?.collection?.name ?? null,
    stops: refs.flatMap((ref) => {
      const place = cache[ref]
      const name = (place?.component ?? []).find(
        (c: any) => c?.value?.[0]?.entity?.name?.[0]?.stringValue
      )?.value[0].entity.name[0].stringValue
      const center = place?.mapsId?.shardedId?.center
      return name && typeof center?.lat === 'number'
        ? [{ address: name, lat: center.lat, lon: center.lng }]
        : []
    }),
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function importSharedList(rawUrl: string): Promise<ImportedList> {
  let url: URL
  try {
    url = new URL(rawUrl.trim())
  } catch {
    throw new Error('That does not look like a link. Paste the full share URL.')
  }

  if (url.hostname.endsWith('apple.com')) {
    const ug = url.searchParams.get('ug')
    if (!ug) throw new Error('This Apple Maps link is not a shared guide (no list data in it).')
    const html = await fetchViaProxy(`https://maps.apple.com/?ug=${encodeURIComponent(ug)}`)
    return parseAppleGuide(html)
  }

  // Google: find the list id, resolving the short link via the proxy if needed.
  let id =
    rawUrl.match(/!2s([A-Za-z0-9_-]{15,})/)?.[1] ??
    rawUrl.match(/placelists\/list\/([A-Za-z0-9_-]{15,})/)?.[1]
  if (!id) {
    // _imcp=1 makes the goo.gl shortener return the real page instead of a
    // JS interstitial when fetched from a datacenter IP (like our proxy).
    url.searchParams.set('_imcp', '1')
    const html = await fetchViaProxy(url.toString())
    // The list id appears in the page's getlist URL (!1m4!1s<id>) and in the
    // data blob (!2s<id>); !1s alone also matches unrelated session tokens.
    id =
      html.match(/(?:%211m4%211s|!1m4!1s)([A-Za-z0-9_-]{15,})/)?.[1] ??
      html.match(/(?:%212s|!2s)([A-Za-z0-9_-]{15,})/)?.[1]
  }
  if (!id) throw new Error('Could not find a shared list in that link.')
  const pb = `!1m4!1s${id}!2e1!3m1!1e1!2e2!3e2!4i500`
  const raw = await fetchViaProxy(
    `https://www.google.com/maps/preview/entitylist/getlist?authuser=0&hl=en&gl=us&pb=${encodeURIComponent(pb)}`
  )
  return parseGoogleList(raw)
}

// --- Route solving ---

function haversineKm(a: Stop, b: Stop): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.asin(Math.sqrt(h))
}

function routeLength(order: number[], dist: number[][], roundTrip: boolean): number {
  let total = 0
  for (let i = 0; i < order.length - 1; i++) total += dist[order[i]][order[i + 1]]
  if (roundTrip && order.length > 1) total += dist[order[order.length - 1]][order[0]]
  return total
}

function nearestNeighbor(dist: number[][], start: number): number[] {
  const n = dist.length
  const visited = new Array<boolean>(n).fill(false)
  const order = [start]
  visited[start] = true
  while (order.length < n) {
    const last = order[order.length - 1]
    let best = -1
    for (let i = 0; i < n; i++) {
      if (!visited[i] && (best === -1 || dist[last][i] < dist[last][best])) best = i
    }
    order.push(best)
    visited[best] = true
  }
  return order
}

function twoOpt(order: number[], dist: number[][], roundTrip: boolean, lockFirst: boolean) {
  let best = [...order]
  let bestLen = routeLength(best, dist, roundTrip)
  let improved = true
  while (improved) {
    improved = false
    const first = lockFirst || roundTrip ? 1 : 0
    for (let i = first; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = [
          ...best.slice(0, i),
          ...best.slice(i, j + 1).reverse(),
          ...best.slice(j + 1),
        ]
        const len = routeLength(candidate, dist, roundTrip)
        if (len < bestLen - 1e-9) {
          best = candidate
          bestLen = len
          improved = true
        }
      }
    }
  }
  return { order: best, length: bestLen }
}

function solveOrder(
  stops: Stop[],
  roundTrip: boolean,
  fixedStart: boolean
): { order: number[]; lengthKm: number } {
  const dist = stops.map((a) => stops.map((b) => haversineKm(a, b)))
  if (stops.length <= 2) {
    const order = stops.map((_, i) => i)
    return { order, lengthKm: routeLength(order, dist, roundTrip) }
  }
  // For a round trip the starting point doesn't change the cycle length, so a
  // single seed is enough; for an open route without a fixed start, try every
  // start and keep the shortest.
  const starts = fixedStart || roundTrip ? [0] : stops.map((_, i) => i)
  let best: { order: number[]; length: number } | null = null
  for (const s of starts) {
    const result = twoOpt(nearestNeighbor(dist, s), dist, roundTrip, fixedStart)
    if (!best || result.length < best.length) best = result
  }
  return { order: best!.order, lengthKm: best!.length }
}

// --- Navigation links ---

// Google Maps allows at most 9 waypoints per link on mobile, so a route is at
// most 11 points (origin + 9 waypoints + destination). Longer routes are split
// into consecutive links where each part starts at the previous part's end.
const GOOGLE_MAX_POINTS = 11

function googleMapsUrls(stops: Stop[], roundTrip: boolean, mode: TravelMode): string[] {
  const points = roundTrip ? [...stops, stops[0]] : stops
  const coord = (s: Stop) => `${s.lat},${s.lon}`
  const urls: string[] = []
  for (let start = 0; start < points.length - 1; start += GOOGLE_MAX_POINTS - 1) {
    const part = points.slice(start, start + GOOGLE_MAX_POINTS)
    const waypoints = part.slice(1, -1).map(coord).join('|')
    let url =
      `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(coord(part[0]))}` +
      `&destination=${encodeURIComponent(coord(part[part.length - 1]))}&travelmode=${mode}`
    if (waypoints) url += `&waypoints=${encodeURIComponent(waypoints)}`
    urls.push(url)
  }
  return urls
}

// Apple Maps supports multistop directions via the unified /directions URL
// (iOS 18.4+ / macOS 15.4+) with a repeated `waypoint` parameter. The Maps
// app allows up to 14 stops per route, so longer routes split into
// consecutive links like the Google ones.
const APPLE_MAX_POINTS = 15

function appleMapsUrls(stops: Stop[], roundTrip: boolean, mode: TravelMode): string[] {
  const points = roundTrip ? [...stops, stops[0]] : stops
  const coord = (s: Stop) => `${s.lat},${s.lon}`
  const urls: string[] = []
  for (let start = 0; start < points.length - 1; start += APPLE_MAX_POINTS - 1) {
    const part = points.slice(start, start + APPLE_MAX_POINTS)
    const params = new URLSearchParams()
    params.set('source', coord(part[0]))
    for (const w of part.slice(1, -1)) params.append('waypoint', coord(w))
    params.set('destination', coord(part[part.length - 1]))
    params.set('mode', mode === 'bicycling' ? 'cycling' : mode)
    urls.push(`https://maps.apple.com/directions?${params.toString()}`)
  }
  return urls
}

function wazeUrl(stop: Stop): string {
  // Waze deep links only support a single destination, so each stop gets its own link.
  return `https://waze.com/ul?ll=${stop.lat},${stop.lon}&navigate=yes`
}

// --- Component ---

type Phase =
  | { kind: 'idle' }
  | { kind: 'working'; message: string }
  | { kind: 'error'; message: string }
  | {
      kind: 'done'
      stops: Stop[]
      lengthKm: number
      failed: string[]
      roundTrip: boolean
      mode: TravelMode
    }

export function RouteOptimizer() {
  const { config, setConfig, loading, saving } = useUtilityConfig('route-optimizer', {
    roundTrip: false,
    fixedStart: true,
    travelMode: 'driving' as TravelMode,
  })
  const [input, setInput] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [copied, setCopied] = useState(false)
  const [shareUrl, setShareUrl] = useState('')
  const [importStatus, setImportStatus] = useState<
    { kind: 'idle' } | { kind: 'working' } | { kind: 'error' | 'done'; message: string }
  >({ kind: 'idle' })
  // Imported stops come with exact coordinates, so they skip geocoding.
  // Keyed by the line text; editing a line falls back to Nominatim.
  const coordCache = useRef(new Map<string, Omit<Stop, 'address'>>())

  const addresses = input
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  async function importList() {
    if (!shareUrl.trim()) return
    setImportStatus({ kind: 'working' })
    try {
      const { title, stops } = await importSharedList(shareUrl)
      if (!stops.length) {
        setImportStatus({
          kind: 'error',
          message: 'The list was found but contained no places with coordinates.',
        })
        return
      }
      for (const s of stops) {
        coordCache.current.set(s.address, { lat: s.lat, lon: s.lon, label: s.address })
      }
      setInput((prev) => {
        const existing = new Set(
          prev.split('\n').map((l) => l.trim()).filter(Boolean)
        )
        const fresh = stops.map((s) => s.address).filter((a) => !existing.has(a))
        return [...existing, ...fresh].join('\n')
      })
      setShareUrl('')
      setImportStatus({
        kind: 'done',
        message: `Imported ${stops.length} place${stops.length === 1 ? '' : 's'}${title ? ` from “${title}”` : ''}.`,
      })
    } catch (e) {
      setImportStatus({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Import failed. Try again in a moment.',
      })
    }
  }

  async function optimize() {
    if (addresses.length < 2) {
      setPhase({ kind: 'error', message: 'Enter at least two locations (one per line).' })
      return
    }
    if (addresses.length > MAX_STOPS) {
      setPhase({ kind: 'error', message: `Maximum ${MAX_STOPS} stops (you entered ${addresses.length}).` })
      return
    }
    const stops: Stop[] = []
    const failed: string[] = []
    let geocoded = false
    for (let i = 0; i < addresses.length; i++) {
      const cached = coordCache.current.get(addresses[i])
      if (cached) {
        stops.push({ address: addresses[i], ...cached })
        continue
      }
      setPhase({ kind: 'working', message: `Looking up location ${i + 1} of ${addresses.length}…` })
      // Nominatim asks for at most one request per second.
      if (geocoded) await sleep(1100)
      geocoded = true
      try {
        const hit = await geocode(addresses[i])
        if (hit) stops.push({ address: addresses[i], ...hit })
        else failed.push(addresses[i])
      } catch {
        failed.push(addresses[i])
      }
    }
    if (stops.length < 2) {
      setPhase({ kind: 'error', message: 'Could not find enough of those locations. Try adding city or country names.' })
      return
    }
    setPhase({ kind: 'working', message: 'Calculating shortest order…' })
    const { order, lengthKm } = solveOrder(stops, config.roundTrip, config.fixedStart)
    setPhase({
      kind: 'done',
      stops: order.map((i) => stops[i]),
      lengthKm,
      failed,
      roundTrip: config.roundTrip,
      mode: config.travelMode,
    })
  }

  async function copyOrder(stops: Stop[]) {
    await navigator.clipboard.writeText(stops.map((s, i) => `${i + 1}. ${s.address}`).join('\n'))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (loading) {
    return <p className="animate-pulse text-slate-400">Loading your settings…</p>
  }

  const working = phase.kind === 'working'

  return (
    <div className="animate-fade-up">
      <div className="flex items-baseline justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Shortest Route</h1>
        <SaveStatus saving={saving} />
      </div>
      <p className="mt-2 text-slate-400">
        Paste a list of locations and get them back in the shortest visiting order, with links to
        start the route in Google Maps, Apple Maps or Waze.
      </p>

      <div className="glass mt-8 rounded-2xl p-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">
          Import a shared list
        </p>
        <div className="mt-2.5 flex gap-2">
          <input
            type="url"
            value={shareUrl}
            onChange={(e) => setShareUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && importList()}
            placeholder="https://maps.app.goo.gl/… or https://guides.apple.com/?ug=…"
            className="glass min-w-0 flex-1 rounded-xl px-3.5 py-2 text-sm text-white placeholder-slate-500 transition-all duration-200 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          />
          <button
            onClick={importList}
            disabled={importStatus.kind === 'working' || !shareUrl.trim()}
            className="shrink-0 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 transition-all duration-200 hover:border-white/20 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {importStatus.kind === 'working' ? 'Importing…' : 'Import'}
          </button>
        </div>
        {importStatus.kind === 'error' && (
          <p className="mt-2 text-xs text-red-300">{importStatus.message}</p>
        )}
        {importStatus.kind === 'done' && (
          <p className="mt-2 text-xs text-emerald-300">{importStatus.message}</p>
        )}
        <p className="mt-2 text-xs text-slate-500">
          Paste a Google Maps shared list or Apple Maps shared guide link — the places are added
          below with their exact locations. This reads the public share page, so it only works for
          publicly shared lists and may break if Google or Apple change their format.
        </p>
      </div>

      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        rows={7}
        placeholder={'One location per line, e.g.\nGrote Markt, Brussels\nAtomium, Brussels\nGravensteen, Ghent'}
        className="glass mt-4 w-full resize-y rounded-2xl p-4 text-white placeholder-slate-500 transition-all duration-200 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
      />

      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex gap-2">
          {TRAVEL_MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => setConfig({ travelMode: m.id })}
              className={`rounded-xl px-3.5 py-1.5 text-sm transition-all duration-200 ${
                config.travelMode === m.id
                  ? 'bg-gradient-to-r from-indigo-500 to-violet-500 text-white shadow-lg shadow-indigo-500/25'
                  : 'border border-white/10 bg-white/5 text-slate-300 hover:border-white/20 hover:bg-white/10 hover:text-white'
              }`}
            >
              {m.icon} {m.label}
            </button>
          ))}
        </div>
        <label className="flex cursor-pointer items-center gap-2.5 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={config.fixedStart}
            onChange={(e) => setConfig({ fixedStart: e.target.checked })}
            className="size-4 accent-indigo-500"
          />
          First line is my starting point
        </label>
        <label className="flex cursor-pointer items-center gap-2.5 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={config.roundTrip}
            onChange={(e) => setConfig({ roundTrip: e.target.checked })}
            className="size-4 accent-indigo-500"
          />
          Return to start (round trip)
        </label>
      </div>

      <button
        onClick={optimize}
        disabled={working || addresses.length < 2}
        className="mt-6 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all duration-200 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {working ? phase.message : `Optimize route${addresses.length > 1 ? ` (${addresses.length} stops)` : ''}`}
      </button>
      <p className="mt-2 text-xs text-slate-500">
        Locations are looked up via OpenStreetMap (about one per second), and the order is
        optimized on straight-line distances.
      </p>

      {phase.kind === 'error' && (
        <p className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {phase.message}
        </p>
      )}

      {phase.kind === 'done' && (
        <div className="mt-8 space-y-4">
          {phase.failed.length > 0 && (
            <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
              Skipped (not found): {phase.failed.join(' · ')}
            </p>
          )}

          <div className="glass rounded-2xl p-5">
            <div className="flex items-baseline justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">
                Optimized order · ~{phase.lengthKm.toFixed(1)} km as the crow flies
              </p>
              <button
                onClick={() => copyOrder(phase.stops)}
                className="no-glow text-xs text-indigo-300 transition-colors hover:text-indigo-200"
              >
                {copied ? 'Copied ✓' : 'Copy list'}
              </button>
            </div>
            <ol className="mt-3 space-y-2">
              {phase.stops.map((s, i) => (
                <li key={`${s.lat},${s.lon}`} className="flex gap-3 text-sm">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 text-xs font-bold text-white">
                    {i + 1}
                  </span>
                  <span>
                    <span className="text-white">{s.address}</span>
                    <span className="block text-xs text-slate-500">{s.label}</span>
                  </span>
                </li>
              ))}
              {phase.roundTrip && (
                <li className="flex gap-3 text-sm text-slate-400">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-white/15 text-xs">
                    ↩
                  </span>
                  back to {phase.stops[0].address}
                </li>
              )}
            </ol>
          </div>

          <div className="glass rounded-2xl p-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">
              Start navigating
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {googleMapsUrls(phase.stops, phase.roundTrip, phase.mode).map((url, i, urls) => (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all duration-200 hover:brightness-110"
                >
                  🗺️ Google Maps{urls.length > 1 ? ` · part ${i + 1}/${urls.length}` : ''}
                </a>
              ))}
              {appleMapsUrls(phase.stops, phase.roundTrip, phase.mode).map((url, i, urls) => (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 transition-all duration-200 hover:border-white/20 hover:bg-white/10"
                >
                  🍎 Apple Maps{urls.length > 1 ? ` · part ${i + 1}/${urls.length}` : ''}
                </a>
              ))}
            </div>
            <p className="mt-4 text-xs text-slate-500">
              Waze only supports one destination per link — open the next stop as you go:
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {(phase.roundTrip ? [...phase.stops.slice(1), phase.stops[0]] : phase.stops.slice(1)).map(
                (s, i) => (
                  <a
                    key={`${s.lat},${s.lon},${i}`}
                    href={wazeUrl(s)}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition-all duration-200 hover:border-white/20 hover:bg-white/10 hover:text-white"
                  >
                    Waze → stop {i + 2 > phase.stops.length ? '↩' : i + 2}
                  </a>
                )
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
