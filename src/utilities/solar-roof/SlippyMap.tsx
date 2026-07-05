import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { Minus, Plus } from 'lucide-react'
import type { LatLon } from './solar'

/**
 * A dependency-free satellite slippy map on a single <canvas>.
 *
 * Tiles come from Esri World Imagery (CORS-enabled, no key). The parent owns
 * all geometry in lat/lon (roof faces, obstacles, packed panels, and the
 * polygon being drawn); this component owns only the view (center + fractional
 * zoom), so panning never disturbs the shapes.
 *
 * Interaction: drag to pan, wheel / buttons / two-finger pinch to zoom. When
 * `placing` is true a tap reports the lat/lon under the cursor (add a point);
 * otherwise you can drag a face's corner to reshape it.
 */

const TILE = 256
const MIN_ZOOM = 3
const MAX_ZOOM = 21
const MAX_TILE_ZOOM = 19 // Esri imagery detail cap; higher zoom upscales tiles
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile'

export interface Face {
  id: string
  points: LatLon[]
  azimuth: number
  active: boolean
}

export interface SlippyMapHandle {
  flyTo: (center: LatLon, zoom?: number) => void
}

interface Props {
  initialCenter: LatLon
  initialZoom: number
  faces: Face[]
  /** The polygon currently being traced (not yet closed). */
  draft: LatLon[]
  /** Packed panel outlines (4 corners each), across all faces. */
  panels: LatLon[][]
  /** Shading obstacles to render. */
  obstacles: { point: LatLon; width: number }[]
  /** When true, a tap adds a point; when false, corners are draggable. */
  placing: boolean
  onMapClick: (p: LatLon) => void
  onVertexMove: (faceId: string, index: number, p: LatLon) => void
  heightClass?: string
}

// --- Web-Mercator math (fractional zoom) ---

const lonToWorldX = (lon: number, z: number) => ((lon + 180) / 360) * TILE * 2 ** z
const latToWorldY = (lat: number, z: number) => {
  const s = Math.sin((lat * Math.PI) / 180)
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z
}
const worldXToLon = (x: number, z: number) => (x / (TILE * 2 ** z)) * 360 - 180
const worldYToLat = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / (TILE * 2 ** z)
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI
}

export const SlippyMap = forwardRef<SlippyMapHandle, Props>(function SlippyMap(
  {
    initialCenter,
    initialZoom,
    faces,
    draft,
    panels,
    obstacles,
    placing,
    onMapClick,
    onVertexMove,
    heightClass = 'h-[65vh]',
  },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ ...initialCenter, zoom: initialZoom })
  const viewRef = useRef(view)
  viewRef.current = view
  const sizeRef = useRef({ w: 800, h: 500 })
  const tileCache = useRef(new Map<string, HTMLImageElement>())
  const rafRef = useRef(0)

  useImperativeHandle(ref, () => ({
    flyTo: (center, zoom) =>
      setView((v) => ({ lat: center.lat, lon: center.lon, zoom: zoom ?? v.zoom })),
  }))

  // Latest geometry/handlers for the draw loop and pointer logic.
  const stateRef = useRef({ faces, draft, panels, obstacles, placing, onMapClick, onVertexMove })
  stateRef.current = { faces, draft, panels, obstacles, placing, onMapClick, onVertexMove }

  const scheduleDraw = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      draw()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const getTile = useCallback(
    (z: number, x: number, y: number): HTMLImageElement | null => {
      const max = 2 ** z
      if (y < 0 || y >= max) return null
      const wx = ((x % max) + max) % max
      const key = `${z}/${y}/${wx}`
      const cached = tileCache.current.get(key)
      if (cached) return cached.complete && cached.naturalWidth > 0 ? cached : null
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.src = `${ESRI}/${z}/${y}/${wx}`
      img.onload = scheduleDraw
      tileCache.current.set(key, img)
      return null
    },
    [scheduleDraw]
  )

  // Project a lat/lon to canvas pixels for the current view.
  const projector = () => {
    const { lat, lon, zoom } = viewRef.current
    const { w, h } = sizeRef.current
    const originX = lonToWorldX(lon, zoom) - w / 2
    const originY = latToWorldY(lat, zoom) - h / 2
    return (p: LatLon) => ({
      x: lonToWorldX(p.lon, zoom) - originX,
      y: latToWorldY(p.lat, zoom) - originY,
    })
  }

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { w, h } = sizeRef.current
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr
      canvas.height = h * dpr
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const { lat, lon, zoom } = viewRef.current
    const originX = lonToWorldX(lon, zoom) - w / 2
    const originY = latToWorldY(lat, zoom) - h / 2
    const toScreen = (p: LatLon) => ({
      x: lonToWorldX(p.lon, zoom) - originX,
      y: latToWorldY(p.lat, zoom) - originY,
    })

    // Tiles: pick an integer tile level and scale it to the fractional zoom.
    ctx.fillStyle = '#0b1120'
    ctx.fillRect(0, 0, w, h)
    const tz = Math.max(MIN_ZOOM, Math.min(MAX_TILE_ZOOM, Math.round(zoom)))
    const scale = 2 ** (zoom - tz)
    const tileSize = TILE * scale
    // Origin in tz-tile pixel space.
    const tzOriginX = originX / scale
    const tzOriginY = originY / scale
    const x0 = Math.floor(tzOriginX / TILE)
    const y0 = Math.floor(tzOriginY / TILE)
    const x1 = Math.ceil((tzOriginX + w / scale) / TILE)
    const y1 = Math.ceil((tzOriginY + h / scale) / TILE)
    for (let tx = x0; tx <= x1; tx++) {
      for (let ty = y0; ty <= y1; ty++) {
        const img = getTile(tz, tx, ty)
        if (!img) continue
        const sx = tx * tileSize - originX
        const sy = ty * tileSize - originY
        // +1 px overdraw avoids hairline seams from sub-pixel scaling.
        ctx.drawImage(img, sx, sy, tileSize + 1, tileSize + 1)
      }
    }

    const { faces: fs, draft: df, panels: pn, obstacles: ob } = stateRef.current

    // Roof faces.
    for (const face of fs) {
      if (face.points.length < 2) continue
      const pts = face.points.map(toScreen)
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y)
      ctx.closePath()
      ctx.fillStyle = face.active ? 'rgba(99,102,241,0.30)' : 'rgba(56,189,248,0.18)'
      ctx.fill()
      ctx.lineWidth = face.active ? 3 : 2
      ctx.strokeStyle = face.active ? '#818cf8' : '#38bdf8'
      ctx.stroke()
      for (const p of pts) dot(ctx, p.x, p.y, face.active ? '#c7d2fe' : '#7dd3fc')
      if (face.points.length >= 3) drawArrow(ctx, pts, face.azimuth, face.active)
    }

    // Packed panels.
    if (pn.length) {
      ctx.lineWidth = 1
      for (const quad of pn) {
        const q = quad.map(toScreen)
        ctx.beginPath()
        ctx.moveTo(q[0].x, q[0].y)
        for (const p of q.slice(1)) ctx.lineTo(p.x, p.y)
        ctx.closePath()
        ctx.fillStyle = 'rgba(30,58,138,0.85)'
        ctx.fill()
        ctx.strokeStyle = 'rgba(148,197,255,0.9)'
        ctx.stroke()
      }
    }

    // Obstacles.
    for (const o of ob) {
      const c = toScreen(o.point)
      const rPx = Math.max(6, (o.width / 2 / metresPerPixel(lat, zoom)))
      ctx.beginPath()
      ctx.arc(c.x, c.y, rPx, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(249,115,22,0.25)'
      ctx.fill()
      ctx.strokeStyle = '#fb923c'
      ctx.lineWidth = 2
      ctx.stroke()
      dot(ctx, c.x, c.y, '#fdba74')
    }

    // Draft polygon.
    if (df.length) {
      const pts = df.map(toScreen)
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y)
      ctx.lineWidth = 2
      ctx.strokeStyle = '#fbbf24'
      ctx.setLineDash([6, 4])
      ctx.stroke()
      ctx.setLineDash([])
      if (pts.length >= 3) {
        ctx.lineTo(pts[0].x, pts[0].y)
        ctx.fillStyle = 'rgba(251,191,36,0.18)'
        ctx.fill()
      }
      for (const p of pts) dot(ctx, p.x, p.y, '#fde68a')
    }

    // North indicator + attribution.
    ctx.fillStyle = 'rgba(15,23,42,0.7)'
    ctx.beginPath()
    ctx.arc(w - 26, 26, 15, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#f87171'
    ctx.beginPath()
    ctx.moveTo(w - 26, 15)
    ctx.lineTo(w - 31, 27)
    ctx.lineTo(w - 21, 27)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#e2e8f0'
    ctx.font = '9px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('N', w - 26, 36)
    ctx.textAlign = 'left'
    ctx.fillStyle = 'rgba(226,232,240,0.75)'
    ctx.fillText('Imagery © Esri', 6, h - 6)
  }, [getTile])

  useEffect(scheduleDraw, [view, faces, draft, panels, obstacles, scheduleDraw])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      sizeRef.current = { w: el.clientWidth, h: el.clientHeight }
      scheduleDraw()
    })
    ro.observe(el)
    sizeRef.current = { w: el.clientWidth, h: el.clientHeight }
    return () => ro.disconnect()
  }, [scheduleDraw])

  // --- Pointer interaction ---
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pan = useRef<{ x: number; y: number; moved: number } | null>(null)
  const pinch = useRef<{ dist: number; zoom: number } | null>(null)
  const vdrag = useRef<{ faceId: string; index: number } | null>(null)

  const localXY = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const screenToLatLon = (px: number, py: number): LatLon => {
    const { lat, lon, zoom } = viewRef.current
    const originX = lonToWorldX(lon, zoom) - sizeRef.current.w / 2
    const originY = latToWorldY(lat, zoom) - sizeRef.current.h / 2
    return { lat: worldYToLat(originY + py, zoom), lon: worldXToLon(originX + px, zoom) }
  }

  const hitVertex = (px: number, py: number) => {
    const project = projector()
    for (const f of stateRef.current.faces) {
      for (let i = 0; i < f.points.length; i++) {
        const s = project(f.points[i])
        if (Math.hypot(s.x - px, s.y - py) <= 12) return { faceId: f.id, index: i }
      }
    }
    return null
  }

  const onPointerDown = (e: React.PointerEvent) => {
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    const { x, y } = localXY(e)
    pointers.current.set(e.pointerId, { x, y })
    if (pointers.current.size === 2) {
      // Start a pinch; cancel any pan/vertex drag.
      const [a, b] = [...pointers.current.values()]
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: viewRef.current.zoom }
      pan.current = null
      vdrag.current = null
      return
    }
    if (!stateRef.current.placing) {
      const hit = hitVertex(x, y)
      if (hit) {
        vdrag.current = hit
        return
      }
    }
    pan.current = { x, y, moved: 0 }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    const { x, y } = localXY(e)
    const prev = pointers.current.get(e.pointerId)!
    pointers.current.set(e.pointerId, { x, y })

    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      const target = pinch.current.zoom + Math.log2(dist / pinch.current.dist)
      zoomTo(mx, my, target)
      return
    }
    if (vdrag.current) {
      const { faceId, index } = vdrag.current
      stateRef.current.onVertexMove(faceId, index, screenToLatLon(x, y))
      return
    }
    const p = pan.current
    if (!p) return
    const dx = x - prev.x
    const dy = y - prev.y
    p.moved += Math.abs(dx) + Math.abs(dy)
    setView((v) => {
      const cx = lonToWorldX(v.lon, v.zoom) - dx
      const cy = latToWorldY(v.lat, v.zoom) - dy
      return { lat: worldYToLat(cy, v.zoom), lon: worldXToLon(cx, v.zoom), zoom: v.zoom }
    })
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const p = pan.current
    const wasVertex = vdrag.current
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    if (wasVertex) {
      vdrag.current = null
      return
    }
    pan.current = null
    if (!p || p.moved > 6) return // a pan, not a tap
    if (stateRef.current.placing) {
      const { x, y } = localXY(e)
      stateRef.current.onMapClick(screenToLatLon(x, y))
    }
  }

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const { x, y } = localXY(e as unknown as React.PointerEvent)
    zoomTo(x, y, viewRef.current.zoom + (e.deltaY < 0 ? 0.5 : -0.5))
  }

  // Zoom to a target level while keeping the point under (px,py) fixed.
  const zoomTo = (px: number, py: number, targetZoom: number) => {
    setView((v) => {
      const nz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, targetZoom))
      if (nz === v.zoom) return v
      const originX = lonToWorldX(v.lon, v.zoom) - sizeRef.current.w / 2
      const originY = latToWorldY(v.lat, v.zoom) - sizeRef.current.h / 2
      const lon = worldXToLon(originX + px, v.zoom)
      const lat = worldYToLat(originY + py, v.zoom)
      const nOriginX = lonToWorldX(lon, nz) - px
      const nOriginY = latToWorldY(lat, nz) - py
      return {
        lat: worldYToLat(nOriginY + sizeRef.current.h / 2, nz),
        lon: worldXToLon(nOriginX + sizeRef.current.w / 2, nz),
        zoom: nz,
      }
    })
  }

  const zoomBtn = (delta: number) => () =>
    zoomTo(sizeRef.current.w / 2, sizeRef.current.h / 2, viewRef.current.zoom + delta)

  return (
    <div ref={wrapRef} className={`relative w-full overflow-hidden rounded-2xl ${heightClass}`}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        className={`size-full touch-none select-none ${placing ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'}`}
      />
      <div className="absolute right-3 bottom-3 flex flex-col gap-1.5">
        <button
          onClick={zoomBtn(1)}
          className="grid size-9 place-items-center rounded-lg border border-white/15 bg-slate-900/80 text-white backdrop-blur transition-colors hover:bg-slate-800"
          aria-label="Zoom in"
        >
          <Plus className="size-4" />
        </button>
        <button
          onClick={zoomBtn(-1)}
          className="grid size-9 place-items-center rounded-lg border border-white/15 bg-slate-900/80 text-white backdrop-blur transition-colors hover:bg-slate-800"
          aria-label="Zoom out"
        >
          <Minus className="size-4" />
        </button>
      </div>
    </div>
  )
})

// --- Canvas helpers ---

/** Ground metres per screen pixel at a latitude and fractional zoom. */
function metresPerPixel(lat: number, zoom: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.beginPath()
  ctx.arc(x, y, 4, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
  ctx.lineWidth = 1.5
  ctx.strokeStyle = 'rgba(15,23,42,0.9)'
  ctx.stroke()
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  pts: { x: number; y: number }[],
  azimuth: number,
  active: boolean
) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
  const ang = (azimuth - 90) * (Math.PI / 180) // 0°=N → up
  const len = 26
  const ex = cx + Math.cos(ang) * len
  const ey = cy + Math.sin(ang) * len
  ctx.strokeStyle = active ? '#fde047' : '#fbbf24'
  ctx.fillStyle = ctx.strokeStyle
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.lineTo(ex, ey)
  ctx.stroke()
  const head = 8
  ctx.beginPath()
  ctx.moveTo(ex, ey)
  ctx.lineTo(ex - head * Math.cos(ang - 0.5), ey - head * Math.sin(ang - 0.5))
  ctx.lineTo(ex - head * Math.cos(ang + 0.5), ey - head * Math.sin(ang + 0.5))
  ctx.closePath()
  ctx.fill()
}
