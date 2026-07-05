import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Compass,
  LocateFixed,
  MapPin,
  Mountain,
  Pentagon,
  Plus,
  Ruler,
  Sparkles,
  Sun,
  Trash2,
  Undo2,
} from 'lucide-react'
import { SaveStatus } from '../../components/SaveStatus'
import { useUtilityConfig } from '../../hooks/useUtilityConfig'
import { useLang, useT } from '../../i18n/LanguageContext'
import { SlippyMap, type Face as MapFace, type SlippyMapHandle } from './SlippyMap'
import {
  annualClearSkyPOA,
  bearing,
  estimateYield,
  faceHorizon,
  fetchPvgis,
  monthlyPOA,
  optimalOrientation,
  orientationHeatmap,
  packPanels,
  PANEL_WATT,
  polygonAreaM2,
  polygonCentroid,
  type LatLon,
  type Obstacle,
  type PvgisResult,
} from './solar'

/**
 * Solar Roof Planner: search an address, trace each roof face on the satellite
 * map, mark shading obstacles, set each face's tilt and orientation, and see
 * how much sun (and power, and money) each face is worth over a year — so you
 * can pick the best surface for panels. Solar figures come from a built-in
 * clear-sky model and can be refined with real local climate data from PVGIS.
 */

interface RoofFace {
  id: string
  points: LatLon[]
  tilt: number
  azimuth: number
  pvgis?: PvgisResult
}

type Config = {
  site: LatLon
  faces: RoofFace[]
  obstacles: Obstacle[]
  clearness: number
  packing: number
  costPerKWp: number
  priceKWh: number
  co2PerKWh: number
}

const DEFAULT_CENTER: LatLon = { lat: 50.8503, lon: 4.3517 } // Brussels
const PR = 0.82 // system performance ratio, matches estimateYield default
const SYSTEM_LIFE = 25 // years, for lifetime savings

type Mode = 'idle' | 'draw' | 'obstacle' | 'ridge'

// --- i18n --------------------------------------------------------------------

const STR = {
  en: {
    title: 'Solar Roof Planner',
    intro:
      'Find the best surface on a roof for solar panels. Search an address, trace each roof face, mark anything that shades it, set its slope and direction, and see the yearly sun, power and payback for each — and how many panels fit.',
    searchPlaceholder: 'Enter an address, e.g. Grote Markt, Brussels',
    search: 'Search',
    searching: 'Searching…',
    myLocation: 'Use my location',
    notFound: 'Address not found. Try adding a city or country.',
    searchError: 'Search failed. Try again in a moment.',
    geoError: 'Could not get your location.',
    step1: 'Search an address to centre the map on the building. Then trace a roof face.',
    idleHint: 'Tip: drag a corner to reshape a face. Zoom with the wheel, buttons or pinch.',
    drawHint:
      'Click the corners of one roof face; close it when you have at least three points. Add a separate face for each slope of the roof.',
    obstacleHint:
      'Click to drop a tree or building that shades the roof. Set its height and size below. Click “Done” when finished.',
    ridgeHint: 'Click the two ends of this face’s ridge (its top edge) to set the direction it faces.',
    addFace: 'Trace a roof face',
    addObstacle: 'Add shading obstacle',
    finishFace: 'Finish face',
    undoPoint: 'Undo point',
    done: 'Done',
    cancel: 'Cancel',
    showPanels: 'Show panel layout',
    drawingPoints: (n: number) => `${n} point${n === 1 ? '' : 's'} — click to add more`,
    facesHeading: 'Roof faces',
    noFaces: 'No faces yet. Trace one on the map to get started.',
    face: (i: number) => `Face ${i}`,
    area: 'Roof area',
    footprint: 'footprint',
    tilt: 'Slope (tilt)',
    flat: 'flat',
    steep: 'steep',
    direction: 'Direction it faces',
    fromRidge: 'Set from ridge',
    perYear: 'Sun / m² per year',
    panels: 'Panels',
    fit: 'that fit',
    system: 'System size',
    production: 'Est. production',
    delete: 'Remove',
    best: 'Best surface',
    shaded: 'shaded',
    n: 'N',
    e: 'E',
    s: 'S',
    w: 'W',
    obstaclesHeading: 'Shading obstacles',
    noObstacles: 'None. Add trees or buildings that cast shade on the roof.',
    obstacle: (i: number) => `Obstacle ${i}`,
    height: 'Height',
    width: 'Size',
    assumptions: 'Assumptions',
    clearness: 'Average clearness (cloud cover)',
    clearnessHint:
      'Share of clear-sky sunlight that actually reaches the ground on average — about 0.5–0.6 in cloudy NW Europe, higher in sunnier climates. Set automatically when you refine with PVGIS.',
    packing: 'Usable roof (fallback when no panel layout)',
    cost: 'Install cost',
    price: 'Electricity price',
    co2: 'Grid CO₂',
    refine: 'Refine with local climate (PVGIS)',
    refining: 'Fetching local climate data…',
    refined: 'Refined with real local climate & horizon data from PVGIS.',
    refineFailed: 'Could not reach PVGIS just now — showing model estimates.',
    modelNote: 'Estimates from a built-in clear-sky model. Refine with PVGIS for real local figures.',
    summary: 'Summary',
    totalProduction: 'Total estimated production',
    totalPanels: 'Total panels',
    payback: 'Payback time',
    years: (n: string) => `${n} yr`,
    annualSavings: 'Yearly savings',
    lifetimeSavings: (n: number) => `Net savings over ${n} yr`,
    co2Avoided: 'CO₂ avoided / yr',
    bestOrientation: 'Best possible orientation here',
    bestOrientationValue: (tilt: number, dir: string) => `${tilt}° tilt, facing ${dir}`,
    heatmap: 'Sun by orientation',
    heatmapHint:
      'Annual sunlight for every slope and direction here — brighter is more. Dots show your faces; ★ marks the ideal.',
    monthly: 'Production by month',
    tiltAxis: 'Tilt →',
    kwh: 'kWh',
    kwp: 'kWp',
    kg: 'kg',
    perYearShort: '/yr',
    loading: 'Loading your saved plan…',
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  },
  nl: {
    title: 'Zonnedak Planner',
    intro:
      'Vind het beste dakvlak voor zonnepanelen. Zoek een adres, teken elk dakvlak, markeer wat er schaduw op werpt, stel helling en richting in, en bekijk per vlak de jaarlijkse zon, opbrengst en terugverdientijd — en hoeveel panelen passen.',
    searchPlaceholder: 'Geef een adres in, bv. Grote Markt, Brussel',
    search: 'Zoeken',
    searching: 'Zoeken…',
    myLocation: 'Mijn locatie',
    notFound: 'Adres niet gevonden. Voeg een stad of land toe.',
    searchError: 'Zoeken mislukt. Probeer het zo dadelijk opnieuw.',
    geoError: 'Kon je locatie niet ophalen.',
    step1: 'Zoek een adres om de kaart op het gebouw te centreren. Teken dan een dakvlak.',
    idleHint: 'Tip: sleep een hoek om een vlak aan te passen. Zoom met het wiel, de knoppen of knijpen.',
    drawHint:
      'Klik de hoeken van één dakvlak aan; sluit het af bij minstens drie punten. Voeg een apart vlak toe voor elke helling.',
    obstacleHint:
      'Klik om een boom of gebouw te plaatsen dat schaduw geeft. Stel hieronder hoogte en grootte in. Klik “Klaar” als je klaar bent.',
    ridgeHint: 'Klik de twee uiteinden van de nok (bovenrand) van dit vlak om de richting in te stellen.',
    addFace: 'Dakvlak tekenen',
    addObstacle: 'Schaduwobstakel toevoegen',
    finishFace: 'Vlak afwerken',
    undoPoint: 'Punt terug',
    done: 'Klaar',
    cancel: 'Annuleren',
    showPanels: 'Paneelindeling tonen',
    drawingPoints: (n: number) => `${n} punt${n === 1 ? '' : 'en'} — klik om meer toe te voegen`,
    facesHeading: 'Dakvlakken',
    noFaces: 'Nog geen vlakken. Teken er een op de kaart om te beginnen.',
    face: (i: number) => `Vlak ${i}`,
    area: 'Dakoppervlak',
    footprint: 'grondvlak',
    tilt: 'Helling',
    flat: 'plat',
    steep: 'steil',
    direction: 'Richting waarnaar het wijst',
    fromRidge: 'Via nok instellen',
    perYear: 'Zon / m² per jaar',
    panels: 'Panelen',
    fit: 'passen',
    system: 'Systeemgrootte',
    production: 'Gesch. opbrengst',
    delete: 'Verwijderen',
    best: 'Beste vlak',
    shaded: 'schaduw',
    n: 'N',
    e: 'O',
    s: 'Z',
    w: 'W',
    obstaclesHeading: 'Schaduwobstakels',
    noObstacles: 'Geen. Voeg bomen of gebouwen toe die schaduw op het dak werpen.',
    obstacle: (i: number) => `Obstakel ${i}`,
    height: 'Hoogte',
    width: 'Grootte',
    assumptions: 'Aannames',
    clearness: 'Gemiddelde helderheid (bewolking)',
    clearnessHint:
      'Aandeel van het heldere-hemel-zonlicht dat gemiddeld de grond bereikt — ongeveer 0,5–0,6 in bewolkt NW-Europa, hoger in zonnigere streken. Wordt automatisch ingesteld bij verfijning met PVGIS.',
    packing: 'Bruikbaar dak (terugval zonder paneelindeling)',
    cost: 'Installatiekost',
    price: 'Elektriciteitsprijs',
    co2: 'Net-CO₂',
    refine: 'Verfijn met lokaal klimaat (PVGIS)',
    refining: 'Lokale klimaatgegevens ophalen…',
    refined: 'Verfijnd met echte lokale klimaat- en horizongegevens van PVGIS.',
    refineFailed: 'PVGIS niet bereikbaar op dit moment — modelschattingen worden getoond.',
    modelNote:
      'Schattingen uit een ingebouwd heldere-hemel-model. Verfijn met PVGIS voor echte lokale cijfers.',
    summary: 'Samenvatting',
    totalProduction: 'Totale geschatte opbrengst',
    totalPanels: 'Totaal panelen',
    payback: 'Terugverdientijd',
    years: (n: string) => `${n} jr`,
    annualSavings: 'Jaarlijkse besparing',
    lifetimeSavings: (n: number) => `Nettobesparing over ${n} jr`,
    co2Avoided: 'CO₂ vermeden / jr',
    bestOrientation: 'Best mogelijke oriëntatie hier',
    bestOrientationValue: (tilt: number, dir: string) => `${tilt}° helling, gericht op ${dir}`,
    heatmap: 'Zon per oriëntatie',
    heatmapHint:
      'Jaarlijks zonlicht voor elke helling en richting hier — helderder is meer. Stippen tonen je vlakken; ★ markeert het ideaal.',
    monthly: 'Opbrengst per maand',
    tiltAxis: 'Helling →',
    kwh: 'kWh',
    kwp: 'kWp',
    kg: 'kg',
    perYearShort: '/jr',
    loading: 'Je opgeslagen plan laden…',
    months: ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'],
  },
}

// --- Helpers -----------------------------------------------------------------

let idCounter = 0
const newId = (p: string) => `${p}-${Date.now()}-${idCounter++}`

async function geocode(query: string): Promise<LatLon | null> {
  const url =
    'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(query)
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) return null
  const data: { lat: string; lon: string }[] = await res.json()
  if (!data.length) return null
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) }
}

function bearingLabel(b: number, t: (typeof STR)['en']): string {
  const dirs = [t.n, `${t.n}${t.e}`, t.e, `${t.s}${t.e}`, t.s, `${t.s}${t.w}`, t.w, `${t.n}${t.w}`]
  return dirs[Math.round((b % 360) / 45) % 8]
}

const angDiff = (a: number, b: number) => {
  const d = Math.abs(((a - b) % 360) + 360) % 360
  return d > 180 ? 360 - d : d
}

function heatColor(v: number): string {
  const stops = [
    [15, 23, 42],
    [30, 64, 175],
    [14, 165, 233],
    [250, 204, 21],
    [253, 224, 71],
  ]
  const x = Math.max(0, Math.min(1, v)) * (stops.length - 1)
  const i = Math.floor(x)
  const f = x - i
  const a = stops[i]
  const b = stops[Math.min(stops.length - 1, i + 1)]
  const c = a.map((ch, k) => Math.round(ch + (b[k] - ch) * f))
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

// --- Compass dial ------------------------------------------------------------

function CompassDial({
  value,
  onChange,
  t,
}: {
  value: number
  onChange: (v: number) => void
  t: (typeof STR)['en']
}) {
  const ref = useRef<SVGSVGElement>(null)
  const R = 46
  const C = 60
  const handleX = C + R * Math.sin((value * Math.PI) / 180)
  const handleY = C - R * Math.cos((value * Math.PI) / 180)

  const update = (e: React.PointerEvent) => {
    const svg = ref.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const dx = ((e.clientX - rect.left) / rect.width) * 120 - C
    const dy = ((e.clientY - rect.top) / rect.height) * 120 - C
    let b = (Math.atan2(dx, -dy) * 180) / Math.PI
    if (b < 0) b += 360
    onChange(Math.round(b))
  }

  return (
    <svg
      ref={ref}
      viewBox="0 0 120 120"
      className="size-24 shrink-0 cursor-pointer touch-none select-none"
      onPointerDown={(e) => {
        ;(e.target as Element).setPointerCapture(e.pointerId)
        update(e)
      }}
      onPointerMove={(e) => e.buttons === 1 && update(e)}
    >
      <circle cx={C} cy={C} r={R} fill="rgba(30,41,59,0.6)" stroke="rgba(255,255,255,0.15)" />
      {[t.n, t.e, t.s, t.w].map((label, i) => {
        const a = (i * 90 * Math.PI) / 180
        const lx = C + (R - 12) * Math.sin(a)
        const ly = C - (R - 12) * Math.cos(a)
        return (
          <text key={i} x={lx} y={ly + 4} textAnchor="middle" className="fill-slate-400 text-[10px] font-semibold">
            {label}
          </text>
        )
      })}
      <line x1={C} y1={C} x2={handleX} y2={handleY} stroke="#fbbf24" strokeWidth={3} strokeLinecap="round" />
      <circle cx={handleX} cy={handleY} r={7} fill="#fde047" stroke="#0f172a" strokeWidth={2} />
      <circle cx={C} cy={C} r={3} fill="#94a3b8" />
    </svg>
  )
}

// --- Main component ----------------------------------------------------------

export function SolarRoof() {
  const t = useT(STR)
  const { locale } = useLang()
  const { config, setConfig, loading, saving } = useUtilityConfig<Config>('solar-roof', {
    site: DEFAULT_CENTER,
    faces: [],
    obstacles: [],
    clearness: 0.55,
    packing: 0.75,
    costPerKWp: 1600,
    priceKWh: 0.35,
    co2PerKWh: 0.2,
  })
  const mapRef = useRef<SlippyMapHandle>(null)

  const [query, setQuery] = useState('')
  const [searchState, setSearchState] = useState<
    { kind: 'idle' | 'working' } | { kind: 'error'; msg: string }
  >({ kind: 'idle' })
  const [mode, setMode] = useState<Mode>('idle')
  const [draft, setDraft] = useState<LatLon[]>([])
  const [ridge, setRidge] = useState<{ faceId: string; pts: LatLon[] } | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showPanels, setShowPanels] = useState(true)
  const [refineState, setRefineState] = useState<{ kind: 'idle' | 'working' | 'error' | 'done' }>({
    kind: 'idle',
  })

  const nf = (v: number, digits = 0) => v.toLocaleString(locale, { maximumFractionDigits: digits })

  // Centre the map on the saved/loaded site once config is ready.
  const centeredRef = useRef(false)
  useEffect(() => {
    if (loading || centeredRef.current) return
    centeredRef.current = true
    mapRef.current?.flyTo(config.site, config.faces.length ? 19 : 12)
  }, [loading, config.site, config.faces.length])

  async function runSearch() {
    if (!query.trim()) return
    setSearchState({ kind: 'working' })
    try {
      const hit = await geocode(query)
      if (!hit) return setSearchState({ kind: 'error', msg: t.notFound })
      setConfig({ site: hit })
      mapRef.current?.flyTo(hit, 19)
      setSearchState({ kind: 'idle' })
    } catch {
      setSearchState({ kind: 'error', msg: t.searchError })
    }
  }

  function useMyLocation() {
    if (!navigator.geolocation) return setSearchState({ kind: 'error', msg: t.geoError })
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const hit = { lat: pos.coords.latitude, lon: pos.coords.longitude }
        setConfig({ site: hit })
        mapRef.current?.flyTo(hit, 19)
      },
      () => setSearchState({ kind: 'error', msg: t.geoError })
    )
  }

  // --- Drawing / mode dispatch ---
  function onMapClick(p: LatLon) {
    if (mode === 'draw') setDraft((d) => [...d, p])
    else if (mode === 'obstacle')
      setConfig((c) => ({
        ...c,
        obstacles: [...c.obstacles, { id: newId('obs'), point: p, height: 8, width: 6 }],
      }))
    else if (mode === 'ridge' && ridge) {
      const pts = [...ridge.pts, p]
      if (pts.length >= 2) applyRidge(ridge.faceId, pts[0], pts[1])
      else setRidge({ ...ridge, pts })
    }
  }

  function applyRidge(faceId: string, a: LatLon, b: LatLon) {
    const face = config.faces.find((f) => f.id === faceId)
    if (!face) return
    const centroid = polygonCentroid(face.points)
    const mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 }
    const ridgeBearing = bearing(a, b)
    const toCentroid = bearing(mid, centroid)
    // Downslope is perpendicular to the ridge, on the side of the roof centroid.
    const cand = [(ridgeBearing + 90) % 360, (ridgeBearing + 270) % 360]
    const azimuth = angDiff(cand[0], toCentroid) < angDiff(cand[1], toCentroid) ? cand[0] : cand[1]
    updateFace(faceId, { azimuth: Math.round(azimuth) })
    setMode('idle')
    setRidge(null)
  }

  function finishFace() {
    if (draft.length < 3) return
    const face: RoofFace = { id: newId('face'), points: draft, tilt: 35, azimuth: 180 }
    setConfig((c) => ({ ...c, faces: [...c.faces, face] }))
    setSelectedId(face.id)
    setDraft([])
    setMode('idle')
  }

  function updateFace(id: string, patch: Partial<RoofFace>) {
    const orientationChanged = 'tilt' in patch || 'azimuth' in patch || 'points' in patch
    setConfig((c) => ({
      ...c,
      faces: c.faces.map((f) =>
        f.id === id ? { ...f, ...patch, pvgis: orientationChanged ? undefined : f.pvgis } : f
      ),
    }))
  }

  const onVertexMove = useCallback(
    (faceId: string, index: number, p: LatLon) => {
      setConfig((c) => ({
        ...c,
        faces: c.faces.map((f) =>
          f.id === faceId
            ? { ...f, pvgis: undefined, points: f.points.map((pt, i) => (i === index ? p : pt)) }
            : f
        ),
      }))
    },
    [setConfig]
  )

  function deleteFace(id: string) {
    setConfig((c) => ({ ...c, faces: c.faces.filter((f) => f.id !== id) }))
    if (selectedId === id) setSelectedId(null)
  }

  function updateObstacle(id: string, patch: Partial<Obstacle>) {
    setConfig((c) => ({
      ...c,
      faces: c.faces.map((f) => ({ ...f, pvgis: undefined })), // shading changed → drop PVGIS
      obstacles: c.obstacles.map((o) => (o.id === id ? { ...o, ...patch } : o)),
    }))
  }

  function deleteObstacle(id: string) {
    setConfig((c) => ({
      ...c,
      faces: c.faces.map((f) => ({ ...f, pvgis: undefined })),
      obstacles: c.obstacles.filter((o) => o.id !== id),
    }))
  }

  async function refineWithPvgis() {
    if (!config.faces.length) return
    setRefineState({ kind: 'working' })
    try {
      const results = await Promise.all(
        config.faces.map(async (f) => {
          const c = polygonCentroid(f.points)
          try {
            return { id: f.id, pvgis: await fetchPvgis(c.lat, c.lon, f.tilt, f.azimuth) }
          } catch {
            return { id: f.id, pvgis: undefined }
          }
        })
      )
      const sample = results.find((r) => r.pvgis)
      if (!sample?.pvgis) return setRefineState({ kind: 'error' })
      // Pin the clearness factor from a refined face so model & heatmap agree.
      let clearness = config.clearness
      const f = config.faces.find((x) => x.id === sample.id)!
      const clear = annualClearSkyPOA({ lat: polygonCentroid(f.points).lat, tilt: f.tilt, azimuth: f.azimuth })
      if (clear > 0) clearness = Math.max(0.2, Math.min(0.95, sample.pvgis.poa / clear))
      setConfig((c) => ({
        ...c,
        clearness,
        faces: c.faces.map((f) => ({ ...f, pvgis: results.find((r) => r.id === f.id)?.pvgis ?? f.pvgis })),
      }))
      setRefineState({ kind: 'done' })
    } catch {
      setRefineState({ kind: 'error' })
    }
  }

  // Auto-refine once, when the first face appears.
  const autoTried = useRef(false)
  useEffect(() => {
    if (autoTried.current || loading) return
    if (config.faces.length > 0 && !config.faces.some((f) => f.pvgis)) {
      autoTried.current = true
      // Deferred so the network call doesn't setState within the effect body.
      const id = setTimeout(refineWithPvgis, 0)
      return () => clearTimeout(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.faces.length, loading])

  // --- Per-face derived figures ---
  const computed = useMemo(() => {
    return config.faces.map((f) => {
      const centroid = polygonCentroid(f.points)
      const footprintM2 = polygonAreaM2(f.points)
      const horizon = faceHorizon(config.obstacles, centroid)
      const params = { lat: centroid.lat, tilt: f.tilt, azimuth: f.azimuth }
      const poaClear = annualClearSkyPOA({ ...params, horizon })
      const poaClearNoShade = horizon.length ? annualClearSkyPOA(params) : poaClear
      const shadeFactor = poaClearNoShade > 0 ? poaClear / poaClearNoShade : 1
      const pack = packPanels(f.points, f.azimuth, f.tilt)
      const y = estimateYield({
        footprintM2,
        tilt: f.tilt,
        poaReal: poaClear * config.clearness,
        packing: config.packing,
        panelCount: pack.count,
        panelWatt: PANEL_WATT,
      })
      let poaReal: number
      let annualKWh: number
      let monthly: number[]
      if (f.pvgis) {
        poaReal = f.pvgis.poa * shadeFactor
        annualKWh = y.kWp * f.pvgis.yieldPerKWp * shadeFactor
        monthly =
          f.pvgis.monthly.length === 12
            ? f.pvgis.monthly.map((m) => m * y.kWp * shadeFactor)
            : monthlyPOA({ ...params, horizon }).map((p) => y.kWp * p * config.clearness * PR)
      } else {
        poaReal = poaClear * config.clearness
        annualKWh = y.annualKWh
        monthly = monthlyPOA({ ...params, horizon }).map((p) => y.kWp * p * config.clearness * PR)
      }
      return {
        face: f,
        footprintM2,
        slopedM2: y.slopedM2,
        poaReal,
        panels: y.panels,
        kWp: y.kWp,
        annualKWh,
        monthly,
        shadeFactor,
        quads: pack.quads,
      }
    })
  }, [config.faces, config.obstacles, config.clearness, config.packing])

  const ranked = useMemo(() => [...computed].sort((a, b) => b.annualKWh - a.annualKWh), [computed])
  const bestId = ranked[0]?.face.id
  const totalKWh = computed.reduce((s, c) => s + c.annualKWh, 0)
  const totalKWp = computed.reduce((s, c) => s + c.kWp, 0)
  const totalPanels = computed.reduce((s, c) => s + c.panels, 0)
  const usingPvgis = computed.some((c) => c.face.pvgis)
  const totalMonthly = useMemo(() => {
    const m = new Array(12).fill(0)
    for (const c of computed) c.monthly.forEach((v, i) => (m[i] += v))
    return m
  }, [computed])

  // Financials.
  const installCost = totalKWp * config.costPerKWp
  const annualSavings = totalKWh * config.priceKWh
  const paybackYears = annualSavings > 0 ? installCost / annualSavings : 0
  const lifetimeSavings = annualSavings * SYSTEM_LIFE - installCost
  const co2Avoided = totalKWh * config.co2PerKWh

  const optimal = useMemo(() => optimalOrientation(config.site.lat), [config.site.lat])
  const heat = useMemo(() => orientationHeatmap(config.site.lat), [config.site.lat])

  const mapFaces: MapFace[] = config.faces.map((f) => ({
    id: f.id,
    points: f.points,
    azimuth: f.azimuth,
    active: f.id === selectedId,
  }))
  const mapPanels = showPanels ? computed.flatMap((c) => c.quads) : []

  const hint =
    mode === 'draw' ? t.drawHint : mode === 'obstacle' ? t.obstacleHint : mode === 'ridge' ? t.ridgeHint : config.faces.length ? t.idleHint : t.step1

  if (loading) return <p className="animate-pulse text-slate-400">{t.loading}</p>

  return (
    <div className="animate-fade-up">
      <div className="flex items-baseline justify-between">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <Sun className="size-7 text-amber-400" /> {t.title}
        </h1>
        <SaveStatus saving={saving} />
      </div>
      <p className="mt-2 max-w-3xl text-slate-400">{t.intro}</p>

      {/* Address search */}
      <div className="mt-6 flex flex-wrap gap-2">
        <div className="glass flex min-w-0 flex-1 items-center gap-2 rounded-xl px-3">
          <MapPin className="size-4 shrink-0 text-slate-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runSearch()}
            placeholder={t.searchPlaceholder}
            className="min-w-0 flex-1 bg-transparent py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none"
          />
        </div>
        <button
          onClick={runSearch}
          disabled={searchState.kind === 'working' || !query.trim()}
          className="shrink-0 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all duration-200 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {searchState.kind === 'working' ? t.searching : t.search}
        </button>
        <button
          onClick={useMyLocation}
          className="flex shrink-0 items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-slate-200 transition-colors hover:bg-white/10"
        >
          <LocateFixed className="size-4" /> <span className="hidden sm:inline">{t.myLocation}</span>
        </button>
      </div>
      {searchState.kind === 'error' && <p className="mt-2 text-xs text-red-300">{searchState.msg}</p>}

      {/* Map toolbar */}
      <div className="mt-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {mode === 'idle' && (
            <>
              <button
                onClick={() => {
                  setMode('draw')
                  setDraft([])
                }}
                className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-amber-500/25 transition-all duration-200 hover:brightness-110"
              >
                <Pentagon className="size-4" /> {t.addFace}
              </button>
              <button
                onClick={() => setMode('obstacle')}
                className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-white/10"
              >
                <Mountain className="size-4" /> {t.addObstacle}
              </button>
              <label className="ml-auto flex cursor-pointer items-center gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={showPanels}
                  onChange={(e) => setShowPanels(e.target.checked)}
                  className="size-4 accent-indigo-500"
                />
                {t.showPanels}
              </label>
            </>
          )}
          {mode === 'draw' && (
            <>
              <span className="text-sm text-amber-300">{t.drawingPoints(draft.length)}</span>
              <button
                onClick={finishFace}
                disabled={draft.length < 3}
                className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-emerald-500/25 transition-all duration-200 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Plus className="size-4" /> {t.finishFace}
              </button>
              <button
                onClick={() => setDraft((d) => d.slice(0, -1))}
                disabled={!draft.length}
                className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-200 transition-colors hover:bg-white/10 disabled:opacity-40"
              >
                <Undo2 className="size-4" /> {t.undoPoint}
              </button>
              <button
                onClick={() => {
                  setMode('idle')
                  setDraft([])
                }}
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-300 transition-colors hover:bg-white/10"
              >
                {t.cancel}
              </button>
            </>
          )}
          {mode === 'obstacle' && (
            <>
              <span className="flex items-center gap-2 text-sm text-orange-300">
                <Mountain className="size-4" /> {t.obstacleHint}
              </span>
              <button
                onClick={() => setMode('idle')}
                className="ml-auto rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-2 text-sm font-semibold text-white transition-all hover:brightness-110"
              >
                {t.done}
              </button>
            </>
          )}
          {mode === 'ridge' && (
            <>
              <span className="flex items-center gap-2 text-sm text-amber-300">
                <Ruler className="size-4" /> {t.ridgeHint}
              </span>
              <button
                onClick={() => {
                  setMode('idle')
                  setRidge(null)
                }}
                className="ml-auto rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-300 transition-colors hover:bg-white/10"
              >
                {t.cancel}
              </button>
            </>
          )}
        </div>

        <SlippyMap
          ref={mapRef}
          initialCenter={config.site}
          initialZoom={12}
          faces={mapFaces}
          draft={mode === 'ridge' && ridge ? ridge.pts : draft}
          panels={mapPanels}
          obstacles={config.obstacles}
          placing={mode !== 'idle'}
          onMapClick={onMapClick}
          onVertexMove={onVertexMove}
        />
        <p className="mt-2 text-xs text-slate-500">{hint}</p>
      </div>

      {/* Faces + results */}
      <div className="mt-8 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
          {/* Faces */}
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-[0.15em] text-slate-400">{t.facesHeading}</h2>
            {config.faces.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">{t.noFaces}</p>
            ) : (
              <div className="mt-3 space-y-4">
                {computed.map((c, i) => {
                  const f = c.face
                  const isBest = f.id === bestId
                  return (
                    <div
                      key={f.id}
                      onClick={() => setSelectedId(f.id)}
                      className={`glass cursor-pointer rounded-2xl p-4 transition-all ${
                        f.id === selectedId ? 'ring-2 ring-indigo-400/60' : ''
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-white">{t.face(i + 1)}</span>
                          {isBest && (
                            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
                              ★ {t.best}
                            </span>
                          )}
                          {c.shadeFactor < 0.97 && (
                            <span className="rounded-full bg-orange-500/20 px-2 py-0.5 text-[11px] font-semibold text-orange-300">
                              −{Math.round((1 - c.shadeFactor) * 100)}% {t.shaded}
                            </span>
                          )}
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            deleteFace(f.id)
                          }}
                          className="text-slate-500 transition-colors hover:text-red-400"
                          aria-label={t.delete}
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-5">
                        <CompassDial value={f.azimuth} onChange={(v) => updateFace(f.id, { azimuth: v })} t={t} />
                        <div className="flex-1 space-y-3">
                          <div>
                            <div className="flex items-center justify-between text-xs text-slate-400">
                              <span className="flex items-center gap-1">
                                <Compass className="size-3.5" /> {t.direction}
                              </span>
                              <span className="text-slate-200">
                                {bearingLabel(f.azimuth, t)} · {f.azimuth}°
                              </span>
                            </div>
                            <input
                              type="range"
                              min={0}
                              max={359}
                              value={f.azimuth}
                              onChange={(e) => updateFace(f.id, { azimuth: +e.target.value })}
                              className="mt-1 w-full accent-amber-500"
                            />
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                setSelectedId(f.id)
                                setMode('ridge')
                                setRidge({ faceId: f.id, pts: [] })
                              }}
                              className="mt-1 flex items-center gap-1 text-[11px] text-indigo-300 transition-colors hover:text-indigo-200"
                            >
                              <Ruler className="size-3" /> {t.fromRidge}
                            </button>
                          </div>
                          <div>
                            <div className="flex items-center justify-between text-xs text-slate-400">
                              <span>{t.tilt}</span>
                              <span className="text-slate-200">{f.tilt}°</span>
                            </div>
                            <input
                              type="range"
                              min={0}
                              max={60}
                              value={f.tilt}
                              onChange={(e) => updateFace(f.id, { tilt: +e.target.value })}
                              className="mt-1 w-full accent-indigo-500"
                            />
                            <div className="flex justify-between text-[10px] text-slate-600">
                              <span>{t.flat}</span>
                              <span>{t.steep}</span>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-white/5 pt-3 text-sm sm:grid-cols-4">
                        <Stat label={t.area} value={`${nf(c.slopedM2)} m²`} sub={`${nf(c.footprintM2)} m² ${t.footprint}`} />
                        <Stat label={t.perYear} value={`${nf(c.poaReal)} ${t.kwh}`} />
                        <Stat label={t.panels} value={nf(c.panels)} sub={`${nf(c.kWp, 1)} ${t.kwp}`} />
                        <Stat label={t.production} value={`${nf(c.annualKWh)} ${t.kwh}`} sub={t.perYearShort} highlight />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Obstacles */}
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.15em] text-slate-400">
              <Mountain className="size-4" /> {t.obstaclesHeading}
            </h2>
            {config.obstacles.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">{t.noObstacles}</p>
            ) : (
              <div className="mt-3 space-y-3">
                {config.obstacles.map((o, i) => (
                  <div key={o.id} className="glass rounded-xl p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-slate-200">{t.obstacle(i + 1)}</span>
                      <button
                        onClick={() => deleteObstacle(o.id)}
                        className="text-slate-500 transition-colors hover:text-red-400"
                        aria-label={t.delete}
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-3">
                      <label className="block">
                        <div className="flex justify-between text-xs text-slate-400">
                          <span>{t.height}</span>
                          <span className="text-slate-200">{o.height} m</span>
                        </div>
                        <input
                          type="range"
                          min={1}
                          max={30}
                          value={o.height}
                          onChange={(e) => updateObstacle(o.id, { height: +e.target.value })}
                          className="mt-1 w-full accent-orange-500"
                        />
                      </label>
                      <label className="block">
                        <div className="flex justify-between text-xs text-slate-400">
                          <span>{t.width}</span>
                          <span className="text-slate-200">{o.width} m</span>
                        </div>
                        <input
                          type="range"
                          min={1}
                          max={30}
                          value={o.width}
                          onChange={(e) => updateObstacle(o.id, { width: +e.target.value })}
                          className="mt-1 w-full accent-orange-500"
                        />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Refine + assumptions */}
          <div className="glass rounded-2xl p-4">
            <button
              onClick={refineWithPvgis}
              disabled={refineState.kind === 'working' || !config.faces.length}
              className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-white/10 disabled:opacity-50"
            >
              <Sparkles className="size-4 text-amber-300" />
              {refineState.kind === 'working' ? t.refining : t.refine}
            </button>
            {refineState.kind === 'error' && <p className="mt-2 text-xs text-amber-300">{t.refineFailed}</p>}
            <p className="mt-2 text-xs text-slate-500">{usingPvgis ? t.refined : t.modelNote}</p>

            <div className="mt-4 grid gap-x-5 gap-y-3 sm:grid-cols-2">
              <Slider label={t.clearness} value={Math.round(config.clearness * 100)} min={30} max={90} suffix="%" onChange={(v) => setConfig({ clearness: v / 100 })} accent="amber" />
              <Slider label={t.packing} value={Math.round(config.packing * 100)} min={40} max={95} suffix="%" onChange={(v) => setConfig({ packing: v / 100 })} accent="indigo" />
              <Slider label={t.cost} value={config.costPerKWp} min={800} max={3000} step={50} suffix=" €/kWp" onChange={(v) => setConfig({ costPerKWp: v })} accent="emerald" />
              <Slider label={t.price} value={config.priceKWh} min={0.05} max={0.8} step={0.01} digits={2} suffix=" €/kWh" onChange={(v) => setConfig({ priceKWh: v })} accent="emerald" />
              <Slider label={t.co2} value={config.co2PerKWh} min={0} max={0.7} step={0.01} digits={2} suffix=" kg/kWh" onChange={(v) => setConfig({ co2PerKWh: v })} accent="emerald" />
            </div>
            <p className="mt-2 text-[11px] text-slate-600">{t.clearnessHint}</p>
          </div>
        </div>

        {/* Summary + charts */}
        <div className="space-y-6">
          {config.faces.length > 0 && (
            <div className="glass rounded-2xl p-5">
              <h2 className="text-sm font-semibold uppercase tracking-[0.15em] text-slate-400">{t.summary}</h2>
              <div className="mt-3 space-y-3">
                <div className="rounded-xl bg-gradient-to-r from-amber-500/15 to-orange-500/10 p-4">
                  <div className="text-xs text-slate-400">{t.totalProduction}</div>
                  <div className="text-2xl font-bold text-amber-300">
                    {nf(totalKWh)} {t.kwh}
                    <span className="text-sm font-normal text-slate-400"> {t.perYearShort}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {nf(totalPanels)} {t.panels.toLowerCase()} · {nf(totalKWp, 1)} {t.kwp}
                  </div>
                </div>
                <Row label={t.payback} value={paybackYears > 0 ? t.years(nf(paybackYears, 1)) : '—'} />
                <Row label={t.annualSavings} value={`€ ${nf(annualSavings)}`} />
                <Row label={t.lifetimeSavings(SYSTEM_LIFE)} value={`€ ${nf(lifetimeSavings)}`} highlight />
                <Row label={t.co2Avoided} value={`${nf(co2Avoided)} ${t.kg}`} />
                <Row
                  label={t.bestOrientation}
                  value={t.bestOrientationValue(Math.round(optimal.tilt), bearingLabel(optimal.azimuth, t))}
                />
              </div>
            </div>
          )}

          {config.faces.length > 0 && (
            <div className="glass rounded-2xl p-5">
              <h2 className="text-sm font-semibold uppercase tracking-[0.15em] text-slate-400">{t.monthly}</h2>
              <MonthlyChart monthly={totalMonthly} labels={t.months} unit={t.kwh} nf={nf} />
            </div>
          )}

          <div className="glass rounded-2xl p-5">
            <h2 className="text-sm font-semibold uppercase tracking-[0.15em] text-slate-400">{t.heatmap}</h2>
            <div className="mt-4">
              <Heatmap heat={heat} faces={config.faces} optimal={optimal} t={t} />
            </div>
            <p className="mt-3 text-[11px] text-slate-500">{t.heatmapHint}</p>
          </div>
        </div>
      </div>
    </div>
  )
}

// --- Small presentational pieces ---------------------------------------------

function Stat({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`font-semibold ${highlight ? 'text-amber-300' : 'text-slate-100'}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
    </div>
  )
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-slate-400">{label}</span>
      <span className={highlight ? 'font-semibold text-emerald-300' : 'text-slate-100'}>{value}</span>
    </div>
  )
}

const ACCENTS: Record<string, string> = {
  amber: 'accent-amber-500',
  indigo: 'accent-indigo-500',
  emerald: 'accent-emerald-500',
}

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  digits = 0,
  suffix = '',
  accent,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  digits?: number
  suffix?: string
  accent: string
  onChange: (v: number) => void
}) {
  return (
    <label className="block">
      <div className="flex justify-between text-xs text-slate-400">
        <span>{label}</span>
        <span className="text-slate-200">
          {value.toLocaleString(undefined, { maximumFractionDigits: digits })}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
        className={`mt-1 w-full ${ACCENTS[accent]}`}
      />
    </label>
  )
}

function MonthlyChart({
  monthly,
  labels,
  unit,
  nf,
}: {
  monthly: number[]
  labels: string[]
  unit: string
  nf: (v: number, d?: number) => string
}) {
  const max = Math.max(1, ...monthly)
  return (
    <div className="mt-4">
      <div className="flex h-32 items-end gap-1">
        {monthly.map((v, i) => (
          <div key={i} className="group relative flex flex-1 flex-col items-center justify-end">
            <div
              className="w-full rounded-t bg-gradient-to-t from-amber-600 to-amber-300 transition-all"
              style={{ height: `${(v / max) * 100}%` }}
            />
            <div className="pointer-events-none absolute -top-6 rounded bg-slate-900 px-1.5 py-0.5 text-[10px] text-amber-200 opacity-0 shadow transition-opacity group-hover:opacity-100">
              {nf(v)} {unit}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1">
        {labels.map((m, i) => (
          <div key={i} className="flex-1 text-center text-[9px] text-slate-500">
            {m[0]}
          </div>
        ))}
      </div>
    </div>
  )
}

function Heatmap({
  heat,
  faces,
  optimal,
  t,
}: {
  heat: ReturnType<typeof orientationHeatmap>
  faces: RoofFace[]
  optimal: ReturnType<typeof optimalOrientation>
  t: (typeof STR)['en']
}) {
  const { tilts, azimuths, grid } = heat
  const xFor = (az: number) => (az - azimuths[0]) / (azimuths[azimuths.length - 1] - azimuths[0])
  const yFor = (tilt: number) => (tilt - tilts[0]) / (tilts[tilts.length - 1] - tilts[0])
  const clampX = (az: number) => Math.max(azimuths[0], Math.min(azimuths[azimuths.length - 1], az))
  const clampY = (tl: number) => Math.max(tilts[0], Math.min(tilts[tilts.length - 1], tl))

  return (
    <div>
      <div className="relative">
        <div className="grid overflow-hidden rounded-lg" style={{ gridTemplateColumns: `repeat(${azimuths.length}, 1fr)` }}>
          {grid.map((row, r) =>
            row.map((v, c) => (
              <div key={`${r}-${c}`} title={`${tilts[r]}° · ${azimuths[c]}°`} style={{ background: heatColor(v), aspectRatio: '1 / 1' }} />
            ))
          )}
        </div>
        <Marker x={xFor(optimal.azimuth)} y={yFor(optimal.tilt)} label="★" color="#fde047" />
        {faces.map((f, i) => (
          <Marker key={f.id} x={xFor(clampX(f.azimuth))} y={yFor(clampY(f.tilt))} label={`${i + 1}`} color="#818cf8" />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-slate-500">
        <span>{t.e}</span>
        <span>{t.s}</span>
        <span>{t.w}</span>
      </div>
      <div className="mt-0.5 text-[10px] text-slate-600">{t.tiltAxis}</div>
    </div>
  )
}

function Marker({ x, y, label, color }: { x: number; y: number; label: string; color: string }) {
  return (
    <div className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${x * 100}%`, top: `${y * 100}%` }}>
      <span className="grid size-4 place-items-center rounded-full text-[9px] font-bold text-slate-900 shadow" style={{ background: color }}>
        {label}
      </span>
    </div>
  )
}
