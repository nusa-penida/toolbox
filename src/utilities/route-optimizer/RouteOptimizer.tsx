import { useState } from 'react'
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

function appleMapsUrl(stops: Stop[], roundTrip: boolean, mode: TravelMode): string {
  const points = roundTrip ? [...stops, stops[0]] : stops
  const coord = (s: Stop) => `${s.lat},${s.lon}`
  // Apple Maps chains extra stops with "+to:" in daddr.
  const daddr = points.slice(1).map(coord).join('+to:')
  const flag = mode === 'walking' ? 'w' : mode === 'bicycling' ? 'c' : 'd'
  return `https://maps.apple.com/?saddr=${encodeURIComponent(coord(points[0]))}&daddr=${encodeURIComponent(daddr)}&dirflg=${flag}`
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

  const addresses = input
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

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
    for (let i = 0; i < addresses.length; i++) {
      setPhase({ kind: 'working', message: `Looking up location ${i + 1} of ${addresses.length}…` })
      try {
        const hit = await geocode(addresses[i])
        if (hit) stops.push({ address: addresses[i], ...hit })
        else failed.push(addresses[i])
      } catch {
        failed.push(addresses[i])
      }
      // Nominatim asks for at most one request per second.
      if (i < addresses.length - 1) await sleep(1100)
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
    <div className="max-w-2xl animate-fade-up">
      <div className="flex items-baseline justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Shortest Route</h1>
        <SaveStatus saving={saving} />
      </div>
      <p className="mt-2 text-slate-400">
        Paste a list of locations and get them back in the shortest visiting order, with links to
        start the route in Google Maps, Apple Maps or Waze.
      </p>

      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        rows={7}
        placeholder={'One location per line, e.g.\nGrote Markt, Brussels\nAtomium, Brussels\nGravensteen, Ghent'}
        className="glass mt-8 w-full resize-y rounded-2xl p-4 text-white placeholder-slate-500 transition-all duration-200 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
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
                className="text-xs text-indigo-300 transition-colors hover:text-indigo-200"
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
              <a
                href={appleMapsUrl(phase.stops, phase.roundTrip, phase.mode)}
                target="_blank"
                rel="noreferrer"
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 transition-all duration-200 hover:border-white/20 hover:bg-white/10"
              >
                🍎 Apple Maps
              </a>
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
