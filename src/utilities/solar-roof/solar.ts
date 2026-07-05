/**
 * Solar geometry + clear-sky irradiance engine for the Solar Roof Planner.
 *
 * Everything here is pure and runs client-side with no API key: given a
 * latitude and a plane's tilt/azimuth it integrates the incident solar energy
 * over a whole year, so we can rank roof faces by how much sun they catch on
 * average and find the optimal orientation. It also models shading from nearby
 * obstacles (trees, buildings) and packs a panel grid onto a roof face.
 *
 * The clear-sky model is the classic ASHRAE/Masters model (see G. Masters,
 * "Renewable and Efficient Electric Power Systems"). It gives realistic
 * *relative* results between orientations; absolute output is scaled by a
 * "clearness" factor for average cloud cover (0.5–0.6 for NW Europe), which
 * can be pinned to real local data via PVGIS (see fetchPvgis below).
 */

export interface LatLon {
  lat: number
  lon: number
}

const RAD = Math.PI / 180
const sinDeg = (d: number) => Math.sin(d * RAD)
const cosDeg = (d: number) => Math.cos(d * RAD)
const tanDeg = (d: number) => Math.tan(d * RAD)
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

// --- Real-world geometry -----------------------------------------------------

const M_PER_DEG_LAT = 111_320

/** Local metres-per-degree-longitude at a latitude. */
const mPerDegLon = (lat: number) => M_PER_DEG_LAT * cosDeg(lat)

/**
 * Footprint area (horizontal, m²) of a lat/lon polygon. Projects to a local
 * equirectangular metre plane around the first vertex — accurate to a fraction
 * of a percent for building-sized shapes — then applies the shoelace formula.
 */
export function polygonAreaM2(points: LatLon[]): number {
  if (points.length < 3) return 0
  const lon0 = points[0].lon
  const lat0 = points[0].lat
  const mLon = mPerDegLon(lat0)
  const xy = points.map((p) => ({
    x: (p.lon - lon0) * mLon,
    y: (p.lat - lat0) * M_PER_DEG_LAT,
  }))
  let area = 0
  for (let i = 0; i < xy.length; i++) {
    const a = xy[i]
    const b = xy[(i + 1) % xy.length]
    area += a.x * b.y - b.x * a.y
  }
  return Math.abs(area) / 2
}

/** Centroid (lat/lon) of a polygon — anchors the on-map azimuth arrow. */
export function polygonCentroid(points: LatLon[]): LatLon {
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length
  const lon = points.reduce((s, p) => s + p.lon, 0) / points.length
  return { lat, lon }
}

/** Ground distance in metres between two coordinates (local flat-earth). */
export function distanceM(a: LatLon, b: LatLon): number {
  const dx = (b.lon - a.lon) * mPerDegLon((a.lat + b.lat) / 2)
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT
  return Math.hypot(dx, dy)
}

/** Compass bearing (0–359, clockwise from north) from a → b. */
export function bearing(a: LatLon, b: LatLon): number {
  const dx = (b.lon - a.lon) * mPerDegLon((a.lat + b.lat) / 2)
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT
  let deg = (Math.atan2(dx, dy) * 180) / Math.PI
  if (deg < 0) deg += 360
  return deg
}

/** Smallest absolute angle between two bearings, in degrees. */
function angleDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360
  return d > 180 ? 360 - d : d
}

// --- Shading obstacles -------------------------------------------------------

/** A nearby object (tree, building) that can block the sun for a roof face. */
export interface Obstacle {
  id: string
  point: LatLon
  /** Height above the roof face, metres. */
  height: number
  /** Approximate width of the object, metres (sets how wide a shadow it casts). */
  width: number
}

/** Obstacle projected to the sky as seen from a roof face. */
export interface HorizonObstacle {
  azimuth: number
  /** Elevation angle the object rises to, degrees. */
  elevation: number
  /** Angular half-width it subtends, degrees. */
  halfWidth: number
}

/** Project obstacles onto the sky dome as seen from a face's centroid. */
export function faceHorizon(obstacles: Obstacle[], from: LatLon): HorizonObstacle[] {
  const out: HorizonObstacle[] = []
  for (const o of obstacles) {
    const d = distanceM(from, o.point)
    if (d < 0.5) continue
    out.push({
      azimuth: bearing(from, o.point),
      elevation: (Math.atan(o.height / d) * 180) / Math.PI,
      halfWidth: (Math.atan(o.width / 2 / d) * 180) / Math.PI,
    })
  }
  return out
}

function isBlocked(horizon: HorizonObstacle[], sunBearing: number, sunAlt: number): boolean {
  for (const h of horizon) {
    if (sunAlt < h.elevation && angleDiff(sunBearing, h.azimuth) <= h.halfWidth) return true
  }
  return false
}

// --- Solar position + clear-sky irradiance -----------------------------------

/** Solar declination (degrees) for day-of-year n (1–365). */
function declination(n: number): number {
  return 23.45 * sinDeg((360 / 365) * (284 + n))
}

/** Sun altitude + compass bearing for a latitude, day and hour angle ω (deg). */
function sunPosition(lat: number, decl: number, omega: number) {
  const sinAlt = sinDeg(lat) * sinDeg(decl) + cosDeg(lat) * cosDeg(decl) * cosDeg(omega)
  const alt = (Math.asin(clamp(sinAlt, -1, 1)) * 180) / Math.PI
  const cosAlt = Math.cos(alt * RAD)
  let bearingDeg = 180
  if (cosAlt > 1e-6) {
    const cosAz = clamp((sinAlt * sinDeg(lat) - sinDeg(decl)) / (cosAlt * cosDeg(lat)), -1, 1)
    const azSouth = (Math.sign(omega) || 1) * ((Math.acos(cosAz) * 180) / Math.PI)
    bearingDeg = 180 + azSouth
  }
  return { alt, bearing: bearingDeg }
}

/** Angle of incidence cosine of a beam on a tilted plane. */
function cosAOI(alt: number, sunBearing: number, tilt: number, azimuth: number): number {
  return cosDeg(alt) * sinDeg(tilt) * cosDeg(sunBearing - azimuth) + sinDeg(alt) * cosDeg(tilt)
}

export interface PlaneParams {
  lat: number
  /** Tilt from horizontal, degrees (0 = flat, 90 = vertical wall). */
  tilt: number
  /** Azimuth the plane faces, degrees clockwise from north (180 = due south). */
  azimuth: number
  /** Ground reflectance (albedo). Default 0.2. */
  albedo?: number
  /** Shading obstacles projected onto the sky (see faceHorizon). */
  horizon?: HorizonObstacle[]
}

const OMEGA_STEP = 2.5 // degrees ≈ 10 minutes of solar time
const HOURS_PER_STEP = OMEGA_STEP / 15

/** Clear-sky plane-of-array energy for a single day, Wh/m². */
function dayEnergyWh(n: number, p: PlaneParams): number {
  const { lat, tilt, azimuth, albedo = 0.2, horizon = [] } = p
  const decl = declination(n)
  const omegaS = (Math.acos(clamp(-tanDeg(lat) * tanDeg(decl), -1, 1)) * 180) / Math.PI
  const A = 1160 + 75 * sinDeg((360 / 365) * (n - 275))
  const k = 0.174 + 0.035 * sinDeg((360 / 365) * (n - 100))
  const C = 0.095 + 0.04 * sinDeg((360 / 365) * (n - 100))
  let wh = 0
  for (let omega = -omegaS; omega <= omegaS; omega += OMEGA_STEP) {
    const { alt, bearing: sunBearing } = sunPosition(lat, decl, omega)
    if (alt <= 0) continue
    const sinAlt = sinDeg(alt)
    const ibn = A * Math.exp(-k / sinAlt) // beam normal, W/m²
    const cai = cosAOI(alt, sunBearing, tilt, azimuth)
    const shaded = horizon.length > 0 && isBlocked(horizon, sunBearing, alt)
    const beam = cai > 0 && !shaded ? ibn * cai : 0
    const diffuse = (C * ibn * (1 + cosDeg(tilt))) / 2
    const reflected = (albedo * ibn * (sinAlt + C) * (1 - cosDeg(tilt))) / 2
    wh += (beam + diffuse + reflected) * HOURS_PER_STEP
  }
  return wh
}

/** Annual clear-sky plane-of-array irradiation, kWh/m²/yr. */
export function annualClearSkyPOA(p: PlaneParams): number {
  let wh = 0
  const step = 3
  for (let n = 1; n <= 365; n += step) wh += dayEnergyWh(n, p) * step
  return wh / 1000
}

/** Per-month clear-sky plane-of-array irradiation, kWh/m²/month (length 12). */
export function monthlyPOA(p: PlaneParams): number[] {
  const monthly = new Array(12).fill(0)
  const step = 2
  let n = 1
  for (let m = 0; m < 12; m++) {
    const end = n + MONTH_DAYS[m]
    for (; n < end; n += step) monthly[m] += dayEnergyWh(Math.min(n, 365), p) * step
  }
  return monthly.map((wh) => wh / 1000)
}

export interface Orientation {
  tilt: number
  azimuth: number
  poa: number
}

/** Sweep tilt/azimuth to find the orientation that catches the most sun/year. */
export function optimalOrientation(lat: number, albedo = 0.2): Orientation {
  let best: Orientation = { tilt: 0, azimuth: 180, poa: 0 }
  for (let tilt = 0; tilt <= 70; tilt += 2) {
    for (let azimuth = 90; azimuth <= 270; azimuth += 5) {
      const poa = annualClearSkyPOA({ lat, tilt, azimuth, albedo })
      if (poa > best.poa) best = { tilt, azimuth, poa }
    }
  }
  return best
}

/** A tilt×azimuth grid of annual POA (fraction of the site optimum) for a heatmap. */
export interface Heatmap {
  tilts: number[]
  azimuths: number[]
  grid: number[][]
  max: number
}

export function orientationHeatmap(lat: number, albedo = 0.2): Heatmap {
  const tilts: number[] = []
  for (let t = 0; t <= 70; t += 5) tilts.push(t)
  const azimuths: number[] = []
  for (let a = 90; a <= 270; a += 15) azimuths.push(a)
  const raw = tilts.map((t) => azimuths.map((a) => annualClearSkyPOA({ lat, tilt: t, azimuth: a, albedo })))
  const max = Math.max(...raw.flat())
  return { tilts, azimuths, grid: raw.map((row) => row.map((v) => v / max)), max }
}

// --- Panel packing -----------------------------------------------------------

export interface PanelSpec {
  /** Along-ridge dimension, metres. Default 1.13 (portrait module). */
  width?: number
  /** Down-slope dimension, metres. Default 1.72. */
  length?: number
  /** Gap between panels, metres. Default 0.02. */
  gap?: number
  /** Setback kept clear from every roof edge, metres. Default 0.3. */
  setback?: number
}

export interface PackResult {
  /** Panel outlines (4 corners each) in lat/lon, for drawing on the map. */
  quads: LatLon[][]
  count: number
}

/**
 * Pack a grid of panels onto a roof face, aligned so rows run along the ridge
 * (perpendicular to the face azimuth) and columns run down the slope. Works in
 * a local metre frame rotated to the azimuth; a panel is kept only if it — plus
 * its setback margin — sits fully inside the polygon.
 */
export function packPanels(
  points: LatLon[],
  azimuth: number,
  tilt: number,
  spec: PanelSpec = {}
): PackResult {
  if (points.length < 3) return { quads: [], count: 0 }
  const { width = 1.13, length = 1.72, gap = 0.02, setback = 0.3 } = spec
  const lat0 = points[0].lat
  const lon0 = points[0].lon
  const mLon = mPerDegLon(lat0)
  // Downslope horizontal unit vector (v) and along-ridge unit vector (u).
  const vE = sinDeg(azimuth)
  const vN = cosDeg(azimuth)
  const uE = cosDeg(azimuth)
  const uN = -sinDeg(azimuth)
  const toUV = (p: LatLon) => {
    const E = (p.lon - lon0) * mLon
    const N = (p.lat - lat0) * M_PER_DEG_LAT
    return { u: E * uE + N * uN, v: E * vE + N * vN }
  }
  const toLatLon = (u: number, v: number): LatLon => {
    const E = u * uE + v * vE
    const N = u * uN + v * vN
    return { lat: lat0 + N / M_PER_DEG_LAT, lon: lon0 + E / mLon }
  }
  const poly = points.map(toUV)
  const inside = (u: number, v: number) => {
    let hit = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]
      const b = poly[j]
      if (a.v > v !== b.v > v && u < ((b.u - a.u) * (v - a.v)) / (b.v - a.v) + a.u) hit = !hit
    }
    return hit
  }
  const minU = Math.min(...poly.map((p) => p.u))
  const maxU = Math.max(...poly.map((p) => p.u))
  const minV = Math.min(...poly.map((p) => p.v))
  const maxV = Math.max(...poly.map((p) => p.v))
  // Slope shortens the down-slope footprint in the horizontal projection.
  const cellU = width + gap
  const cellV = (length + gap) * cosDeg(tilt)
  const panelV = length * cosDeg(tilt)
  const quads: LatLon[][] = []
  const cap = 4000
  for (let u = minU + setback; u + width <= maxU - setback && quads.length < cap; u += cellU) {
    for (let v = minV + setback; v + panelV <= maxV - setback; v += cellV) {
      // Require the panel + setback margin to be fully inside the polygon.
      const m = setback
      const corners: [number, number][] = [
        [u - m, v - m],
        [u + width + m, v - m],
        [u + width + m, v + panelV + m],
        [u - m, v + panelV + m],
      ]
      if (corners.every(([cu, cv]) => inside(cu, cv))) {
        quads.push([
          toLatLon(u, v),
          toLatLon(u + width, v),
          toLatLon(u + width, v + panelV),
          toLatLon(u, v + panelV),
        ])
      }
    }
  }
  return { quads, count: quads.length }
}

// --- Yield -------------------------------------------------------------------

export interface YieldInputs {
  footprintM2: number
  tilt: number
  /** Annual real-sky plane-of-array irradiation, kWh/m²/yr. */
  poaReal: number
  /** Fraction of the sloped area usable after setbacks/obstructions. Default 0.75. */
  packing?: number
  panelArea?: number
  panelWatt?: number
  performanceRatio?: number
  /** If given, uses this exact panel count instead of estimating from area. */
  panelCount?: number
}

export interface YieldResult {
  slopedM2: number
  usableM2: number
  panels: number
  kWp: number
  annualKWh: number
}

export function estimateYield(inp: YieldInputs): YieldResult {
  const {
    footprintM2,
    tilt,
    poaReal,
    packing = 0.75,
    panelArea = 1.95,
    panelWatt = 440,
    performanceRatio = 0.82,
    panelCount,
  } = inp
  const slopedM2 = footprintM2 / Math.max(0.2, cosDeg(tilt))
  const usableM2 = slopedM2 * packing
  const panels = panelCount ?? Math.floor(usableM2 / panelArea)
  const kWp = (panels * panelWatt) / 1000
  const annualKWh = kWp * poaReal * performanceRatio
  return { slopedM2, usableM2, panels, kWp, annualKWh }
}

export const PANEL_WATT = 440

// --- Optional PVGIS refinement (real local climate) --------------------------
//
// PVGIS (EU Joint Research Centre) has no CORS headers, so — like the Shortest
// Route importer — we go through best-effort public proxies. It returns the
// real-world specific yield (kWh per kWp per year) plus a monthly breakdown for
// a given tilt/azimuth, already including average cloud cover and horizon.

export interface PvgisResult {
  /** Specific yield: kWh per installed kWp per year. */
  yieldPerKWp: number
  /** Annual in-plane irradiation, kWh/m²/yr. */
  poa: number
  /** Monthly energy per kWp, kWh (length 12). */
  monthly: number[]
  source: 'pvgis'
}

async function fetchJsonViaProxy(url: string): Promise<unknown> {
  const strategies = [
    async () => {
      const r = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`)
      if (!r.ok) throw new Error(`allorigins raw ${r.status}`)
      return r.json()
    },
    async () => {
      const r = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`)
      if (!r.ok) throw new Error(`allorigins get ${r.status}`)
      const data: { contents?: string } = await r.json()
      if (!data.contents) throw new Error('allorigins empty')
      return JSON.parse(data.contents)
    },
    async () => {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`direct ${r.status}`)
      return r.json()
    },
  ]
  let lastError: unknown
  for (const strat of strategies) {
    try {
      return await strat()
    } catch (e) {
      lastError = e
    }
  }
  throw lastError
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Real-world yield for a plane at (lat, lon) with the given tilt/azimuth.
 * PVGIS azimuth ("aspect") is 0 = south, negative = east, positive = west, so
 * we convert from our north-clockwise bearing.
 */
export async function fetchPvgis(
  lat: number,
  lon: number,
  tilt: number,
  azimuth: number
): Promise<PvgisResult> {
  const aspect = Math.round(azimuth - 180)
  const url =
    `https://re.jrc.ec.europa.eu/api/v5_2/PVcalc?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}` +
    `&peakpower=1&loss=14&angle=${Math.round(tilt)}&aspect=${aspect}&outputformat=json`
  const data: any = await fetchJsonViaProxy(url)
  const totals = data?.outputs?.totals?.fixed
  const yieldPerKWp = Number(totals?.E_y)
  const poa = Number(totals?.['H(i)_y'])
  const monthly: number[] = (data?.outputs?.monthly?.fixed ?? []).map((m: any) => Number(m?.E_m))
  if (!Number.isFinite(yieldPerKWp) || !Number.isFinite(poa)) {
    throw new Error('Unexpected PVGIS response')
  }
  return { yieldPerKWp, poa, monthly: monthly.length === 12 ? monthly : [], source: 'pvgis' }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
