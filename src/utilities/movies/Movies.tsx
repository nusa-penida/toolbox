import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Film,
  Heart,
  Play,
  Settings,
  Star,
  Tv,
  X,
} from 'lucide-react'
import { SaveStatus } from '../../components/SaveStatus'
import { useUtilityConfig } from '../../hooks/useUtilityConfig'

/**
 * Movies & TV. A browse-and-watch tool backed by two free services:
 *
 *   • The Movie Database (TMDB) for metadata — popular / in-theatres-or-on-air
 *     / top-rated lists, genre categories, search and per-title details.
 *     TMDB allows browser CORS, so we call it directly with the user's own
 *     v3 API key (saved to their RLS-protected account config, never bundled).
 *   • VidFast (vidfast.pro) for playback — given a TMDB id it returns an embed
 *     player (movies by id, TV by id + season + episode), dropped into an
 *     <iframe>. No key required. These free providers monetize with redirect/
 *     popup ads and refuse to play inside a sandboxed iframe, so the embed runs
 *     unsandboxed — a browser ad blocker (e.g. uBlock Origin) is the mitigation.
 *
 * Favourites and watch history are part of the saved config, so they sync to
 * the user's account and persist across devices. Without an account the tool
 * still works; nothing is saved. The API key lives in a separate Settings tab.
 */

const TMDB_BASE = 'https://api.themoviedb.org/3'
const IMG_BASE = 'https://image.tmdb.org/t/p'

// VidFast playback host. It mirrors itself across several domains; if one is
// reset by an ISP/DNS block ("connection unexpectedly closed"), swap this for
// another: vidfast.pro, vidfast.in, vidfast.io, vidfast.me, vidfast.net,
// vidfast.pm, vidfast.xyz.
const VIDFAST_DOMAIN = 'vidfast.net'

type MediaType = 'movie' | 'tv'
type Feed = 'popular' | 'now_playing' | 'on_the_air' | 'top_rated'
type View = Feed | 'favourites' | 'watched' | 'settings'

// The three browse feeds per media type. `now_playing`/`on_the_air` are the
// media-specific middle tab; the other two ids are shared.
const FEEDS: Record<MediaType, { id: Feed; label: string; path: string }[]> = {
  movie: [
    { id: 'popular', label: 'Most Popular', path: '/movie/popular' },
    { id: 'now_playing', label: 'In Theatres', path: '/movie/now_playing' },
    { id: 'top_rated', label: 'Top Rated', path: '/movie/top_rated' },
  ],
  tv: [
    { id: 'popular', label: 'Most Popular', path: '/tv/popular' },
    { id: 'on_the_air', label: 'On Air', path: '/tv/on_the_air' },
    { id: 'top_rated', label: 'Top Rated', path: '/tv/top_rated' },
  ],
}

// Raw TMDB list item — movies and TV use different field names for the same
// concepts, which `normalize` collapses into a single `Title` shape.
interface TmdbItem {
  id: number
  title?: string
  name?: string
  poster_path: string | null
  release_date?: string
  first_air_date?: string
  vote_average: number | null
}

interface Genre {
  id: number
  name: string
}

interface SeasonInfo {
  season_number: number
  episode_count: number
  name: string
}

// Normalized title used everywhere in the UI and persisted in favourites.
interface Title {
  id: number
  mediaType: MediaType
  title: string
  poster_path: string | null
  date: string | null
  vote_average: number | null
}

// A watched title also remembers when it was opened and, for TV, the last
// season/episode so playback resumes there. `progress` (0–1) is how far
// through the title the viewer is — the fraction of episodes for a series,
// or 1 for a watched movie — used to draw the fill bar on each poster.
interface WatchEntry extends Title {
  watchedAt: string
  season?: number
  episode?: number
  progress?: number
  // Absolute playback position in seconds, used to resume via `startAt`.
  positionSec?: number
}

interface MoviesConfig extends Record<string, unknown> {
  apiKey: string
  favourites: Title[]
  watched: WatchEntry[]
}

const DEFAULTS: MoviesConfig = { apiKey: '', favourites: [], watched: [] }

// Movies and TV can collide on numeric id, so key saved items by both.
const tkey = (t: { id: number; mediaType: MediaType }) => `${t.mediaType}:${t.id}`

function normalize(item: TmdbItem, mediaType: MediaType): Title {
  return {
    id: item.id,
    mediaType,
    title: item.title ?? item.name ?? 'Untitled',
    poster_path: item.poster_path,
    date: item.release_date ?? item.first_air_date ?? null,
    vote_average: item.vote_average,
  }
}

function year(date: string | null): string {
  return date && date.length >= 4 ? date.slice(0, 4) : '—'
}

// --- TMDB client ---------------------------------------------------------

async function tmdbGet<T>(
  path: string,
  key: string,
  params: Record<string, string | number> = {}
): Promise<T> {
  const mapped = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
  const qs = new URLSearchParams({ api_key: key, ...mapped }).toString()
  const res = await fetch(`${TMDB_BASE}${path}?${qs}`)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body?.status_message ?? `TMDB returned ${res.status}`)
  }
  return body as T
}

// --- Pieces --------------------------------------------------------------

function Stars({ rating }: { rating: number | null }) {
  if (rating == null || rating === 0) return null
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-300">
      <Star className="size-3.5 fill-current" /> {rating.toFixed(1)}
    </span>
  )
}

function PosterCard({
  title,
  isFav,
  showType,
  progress,
  onOpen,
  onToggleFav,
  onRemove,
}: {
  title: Title
  isFav: boolean
  showType: boolean
  progress?: number
  onOpen: () => void
  onToggleFav: () => void
  onRemove?: () => void
}) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] transition-all duration-200 hover:border-white/20">
      <button onClick={onOpen} className="block w-full text-left" title={`Watch ${title.title}`}>
        <div className="aspect-[2/3] w-full overflow-hidden bg-slate-800">
          {title.poster_path ? (
            <img
              src={`${IMG_BASE}/w342${title.poster_path}`}
              alt={title.title}
              loading="lazy"
              className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
            />
          ) : (
            <div className="flex size-full items-center justify-center p-3 text-center text-xs text-slate-500">
              {title.title}
            </div>
          )}
        </div>
        <div className="p-2.5">
          <p className="truncate text-sm font-medium text-white">{title.title}</p>
          <div className="mt-1 flex items-center justify-between text-slate-400">
            <span className="text-xs">{year(title.date)}</span>
            <Stars rating={title.vote_average} />
          </div>
        </div>
      </button>

      {showType && (
        <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/90 backdrop-blur">
          {title.mediaType === 'tv' ? 'TV' : 'Movie'}
        </span>
      )}

      <div className="absolute right-2 top-2 flex flex-col gap-1.5">
        <button
          onClick={onToggleFav}
          title={isFav ? 'Remove from favourites' : 'Add to favourites'}
          className={`flex size-8 items-center justify-center rounded-full backdrop-blur transition-all duration-200 ${
            isFav
              ? 'bg-rose-500/90 text-white'
              : 'bg-black/50 text-white/70 opacity-0 hover:bg-black/70 hover:text-white group-hover:opacity-100'
          }`}
        >
          <Heart className={`size-4 ${isFav ? 'fill-current' : ''}`} />
        </button>
        {onRemove && (
          <button
            onClick={onRemove}
            title="Remove from history"
            className="flex size-8 items-center justify-center rounded-full bg-black/50 text-white/70 opacity-0 backdrop-blur transition-all duration-200 hover:bg-black/70 hover:text-white group-hover:opacity-100"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {/* Watch-progress fill bar pinned to the bottom edge of the card. */}
      {progress != null && (
        <div
          className="absolute inset-x-0 bottom-0 h-1.5 bg-black/50"
          title={`${Math.round(progress * 100)}% watched`}
        >
          <div
            className="h-full bg-gradient-to-r from-indigo-500 to-violet-500"
            style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
          />
        </div>
      )}
    </div>
  )
}

// Extra fields fetched from /movie/{id} or /tv/{id} for the detail card.
interface Details {
  overview?: string
  tagline?: string
  genres?: { id: number; name: string }[]
  runtime?: number
  episode_run_time?: number[]
  number_of_seasons?: number
  number_of_episodes?: number
  backdrop_path?: string | null
  vote_average?: number | null
  status?: string
  seasons?: SeasonInfo[]
}

// Hook: lock page scroll and close on Escape while an overlay is mounted.
function useOverlayChrome(onClose: () => void) {
  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
}

function SeasonEpisodePicker({
  seasons,
  season,
  episode,
  onSeason,
  onEpisode,
}: {
  seasons: SeasonInfo[]
  season: number
  episode: number
  onSeason: (s: number) => void
  onEpisode: (e: number) => void
}) {
  const current = seasons.find((s) => s.season_number === season)
  const episodeCount = current?.episode_count ?? Math.max(episode, 1)
  return (
    <div className="flex flex-wrap gap-3">
      <label className="flex flex-col gap-1 text-[11px] text-slate-400">
        Season
        <select
          value={season}
          onChange={(e) => onSeason(Number(e.target.value))}
          className="glass rounded-lg px-2.5 py-1.5 text-sm text-white focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
        >
          {seasons.length === 0 && (
            <option value={season} className="bg-slate-900">
              Season {season}
            </option>
          )}
          {seasons.map((s) => (
            <option key={s.season_number} value={s.season_number} className="bg-slate-900">
              {s.season_number === 0 ? s.name || 'Specials' : `Season ${s.season_number}`}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-slate-400">
        Episode
        <select
          value={episode}
          onChange={(e) => onEpisode(Number(e.target.value))}
          className="glass rounded-lg px-2.5 py-1.5 text-sm text-white focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
        >
          {Array.from({ length: episodeCount }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n} className="bg-slate-900">
              Episode {n}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

// The popup shown when a poster is clicked: synopsis + metadata, a favourite
// toggle, and (for TV) a season/episode picker, before pressing Play.
function DetailCard({
  title,
  apiKey,
  isFav,
  initialSeason,
  initialEpisode,
  onToggleFav,
  onPlay,
  onClose,
}: {
  title: Title
  apiKey: string
  isFav: boolean
  initialSeason: number
  initialEpisode: number
  onToggleFav: () => void
  onPlay: (season: number, episode: number) => void
  onClose: () => void
}) {
  const isTv = title.mediaType === 'tv'
  const [details, setDetails] = useState<Details | null>(null)
  const [loadingDetails, setLoadingDetails] = useState(true)
  const [season, setSeason] = useState(initialSeason)
  const [episode, setEpisode] = useState(initialEpisode)

  useOverlayChrome(onClose)

  useEffect(() => {
    let cancelled = false
    tmdbGet<Details>(`/${title.mediaType}/${title.id}`, apiKey)
      .then((d) => !cancelled && setDetails(d))
      .catch(() => {})
      .finally(() => !cancelled && setLoadingDetails(false))
    return () => {
      cancelled = true
    }
  }, [title.mediaType, title.id, apiKey])

  const seasons = (details?.seasons ?? []).filter((s) => s.episode_count > 0)
  const rating = details?.vote_average ?? title.vote_average
  const runtimeMin = isTv ? details?.episode_run_time?.[0] : details?.runtime
  const meta = [
    year(title.date),
    isTv && details?.number_of_seasons
      ? `${details.number_of_seasons} season${details.number_of_seasons === 1 ? '' : 's'}`
      : null,
    runtimeMin ? `${runtimeMin} min` : null,
  ].filter(Boolean)

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-full w-full max-w-2xl flex-col rounded-2xl border border-white/10 bg-slate-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Backdrop fills the top of the card; the info overlaps it below.
            Clipping lives here (not the card) so the close button isn't cut. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-72 overflow-hidden rounded-t-2xl">
          {details?.backdrop_path && (
            <img
              src={`${IMG_BASE}/w780${details.backdrop_path}`}
              alt=""
              className="size-full object-cover"
            />
          )}
          {/* Light tint + a bottom fade so overlaid info stays readable
              without washing the image out. */}
          <div className="absolute inset-0 bg-slate-950/20" />
          <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/55 to-transparent" />
        </div>

        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute left-4 top-4 z-20 flex size-9 items-center justify-center rounded-full bg-black/50 text-white/80 backdrop-blur transition-colors hover:bg-black/70 hover:text-white"
        >
          <X className="size-5" />
        </button>

        {/* Info sits on top of the backdrop (z-10) and scrolls if it's tall. */}
        <div className="relative z-10 min-h-0 overflow-y-auto px-6 pb-6 pt-20 sm:pt-24">
          <h2 className="text-4xl font-bold leading-tight text-white drop-shadow-lg sm:text-5xl">
            {title.title}
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-slate-300">
            <span className="rounded-md bg-white/10 px-2 py-0.5 text-xs font-medium uppercase tracking-wide">
              {isTv ? 'TV' : 'Movie'}
            </span>
            {meta.map((m) => (
              <span key={m as string}>{m}</span>
            ))}
            <Stars rating={rating ?? null} />
          </div>

          {details?.tagline && (
            <p className="mt-3 text-base italic text-slate-300">{details.tagline}</p>
          )}

          {details?.genres && details.genres.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {details.genres.map((g) => (
                <span
                  key={g.id}
                  className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-200"
                >
                  {g.name}
                </span>
              ))}
            </div>
          )}

          <p className="mt-4 max-w-2xl text-base leading-relaxed text-slate-200">
            {loadingDetails
              ? 'Loading…'
              : details?.overview || 'No synopsis available for this title.'}
          </p>

          {isTv && (
            <div className="mt-5">
              <SeasonEpisodePicker
                seasons={seasons}
                season={season}
                episode={episode}
                onSeason={(s) => {
                  setSeason(s)
                  setEpisode(1)
                }}
                onEpisode={setEpisode}
              />
            </div>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              onClick={() => onPlay(season, episode)}
              className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-6 py-3 text-base font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all duration-200 hover:brightness-110"
            >
              <Play className="size-4 fill-current" /> Play{isTv ? ` S${season} · E${episode}` : ''}
            </button>
            <button
              onClick={onToggleFav}
              className={`flex items-center gap-2 rounded-xl border px-5 py-3 text-base font-medium transition-all duration-200 ${
                isFav
                  ? 'border-rose-400/40 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25'
                  : 'border-white/10 bg-white/5 text-slate-200 hover:bg-white/10'
              }`}
            >
              <Heart className={`size-4 ${isFav ? 'fill-current' : ''}`} />
              {isFav ? 'Favourited' : 'Favourite'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

// Shape of the player's `MEDIA_DATA` payload, parsed defensively. The player may
// post its whole store (keyed by TMDB id) or just the playing title's entry;
// movies carry `progress` directly, episodes nest it under `show_progress`.
interface MediaProgressNode {
  watched?: number
  duration?: number
}
interface MediaProgressEntry {
  progress?: MediaProgressNode
  show_progress?: Record<string, { progress?: MediaProgressNode }>
}
type MediaProgressStore = MediaProgressEntry & Record<string, MediaProgressEntry>

// Full-screen player overlay — the season/episode are chosen on the card.
// Resumes at `resumeSec` and reports playback progress back via `onProgress`.
function Player({
  title,
  season,
  episode,
  resumeSec,
  onProgress,
  onClose,
}: {
  title: Title
  season: number
  episode: number
  resumeSec: number
  onProgress: (fraction: number, seconds: number) => void
  onClose: () => void
}) {
  const isTv = title.mediaType === 'tv'
  useOverlayChrome(onClose)

  // Keep the latest callback in a ref so the message listener can stay
  // subscribed once for the player's lifetime without going stale.
  const onProgressRef = useRef(onProgress)
  useEffect(() => {
    onProgressRef.current = onProgress
  })

  // The embed posts playback progress to the parent as it plays. We track the
  // latest position each tick but only persist it once, on close, to keep saves
  // (and DB writes) sparse. Parsed defensively since the exact shape isn't
  // contractual and varies by provider — we accept either form:
  //   • PLAYER_EVENT: a per-tick event carrying `currentTime` + `duration`.
  //     Some providers post this as a JSON *string*, so we parse strings first.
  //   • MEDIA_DATA: a progress store keyed by TMDB id (movies carry `progress`
  //     directly; episodes nest it under `show_progress` by `s{n}e{n}`).
  const latest = useRef<{ fraction: number; seconds: number } | null>(null)
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      let d = e.data as Record<string, unknown> | string | null
      if (typeof d === 'string') {
        try {
          d = JSON.parse(d) as Record<string, unknown>
        } catch {
          return
        }
      }
      if (!d || typeof d !== 'object') return
      const type = d.type ?? d.event
      let seconds: number
      let duration: number
      if (type === 'MEDIA_DATA') {
        const raw = (d.data ?? {}) as MediaProgressStore
        const entry = raw.progress || raw.show_progress ? raw : raw[String(title.id)]
        const node = isTv
          ? entry?.show_progress?.[`s${season}e${episode}`]?.progress
          : entry?.progress
        seconds = Number(node?.watched)
        duration = Number(node?.duration)
      } else if (type === 'PLAYER_EVENT') {
        const inner = (d.data as Record<string, unknown>) ?? d
        seconds = Number(inner.currentTime ?? inner.player_progress ?? inner.progress)
        duration = Number(inner.duration ?? inner.player_duration)
      } else return
      if (!isFinite(seconds) || !isFinite(duration) || duration <= 0) return
      latest.current = { fraction: Math.min(1, Math.max(0, seconds / duration)), seconds }
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      // Persist wherever the viewer got to when the player closes.
      if (latest.current) onProgressRef.current(latest.current.fraction, latest.current.seconds)
    }
  }, [title.id, isTv, season, episode])

  const base = isTv
    ? `https://${VIDFAST_DOMAIN}/tv/${title.id}/${season}/${episode}`
    : `https://${VIDFAST_DOMAIN}/movie/${title.id}`
  // `theme` matches our violet accent; `autoPlay` starts playback immediately
  // (the click on Play is the user gesture that permits it); `hideServer` drops
  // the server-selector button; `startAt` (seconds) resumes where we left off.
  const params = new URLSearchParams({ theme: '8b5cf6', autoPlay: 'true', hideServer: 'true' })
  if (resumeSec > 0) params.set('startAt', String(Math.floor(resumeSec)))
  const src = `${base}?${params.toString()}`

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-white">{title.title}</p>
            <p className="text-xs text-slate-500">
              {isTv ? `Season ${season} · Episode ${episode}` : year(title.date)}
            </p>
          </div>
          <button
            onClick={onClose}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="size-4" /> Close
          </button>
        </div>
        {/* Cap the player to the viewport height so its controls aren't clipped
            on shorter screens; the modal's header takes the rest. The iframe
            fills this box (the player letterboxes if the ratio differs). */}
        <div className="aspect-video max-h-[calc(100dvh-6rem)] w-full bg-black">
          <iframe
            key={src}
            src={src}
            title={title.title}
            className="size-full"
            allowFullScreen
            allow="autoplay; fullscreen; encrypted-media"
            referrerPolicy="origin"
          />
        </div>
      </div>
    </div>,
    document.body
  )
}

// --- Main ----------------------------------------------------------------

export function Movies() {
  const { config, setConfig, loading, saving } = useUtilityConfig<MoviesConfig>('movies', DEFAULTS)
  const key = config.apiKey.trim()
  const hasKey = key.length > 0

  const [mediaType, setMediaType] = useState<MediaType>('movie')
  const [view, setView] = useState<View>('popular')
  const [genres, setGenres] = useState<Genre[]>([])
  const [genreId, setGenreId] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')

  const [results, setResults] = useState<Title[]>([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // `selected` drives the detail popup; `playing` the video overlay.
  const [selected, setSelected] = useState<Title | null>(null)
  const [playing, setPlaying] = useState<{
    title: Title
    season: number
    episode: number
    resumeSec: number
  } | null>(null)

  const favSet = new Set(config.favourites.map(tkey))
  // Watch progress (0–1) by title, to draw the fill bar on any poster. Entries
  // saved before progress was tracked have none — a watched movie is fully
  // seen (1); an old TV entry's depth is unknown, so it stays bar-less.
  const progressMap = new Map(
    config.watched.map((w) => [tkey(w), w.progress ?? (w.mediaType === 'movie' ? 1 : undefined)])
  )
  const isFeed = view !== 'favourites' && view !== 'watched' && view !== 'settings'

  // Load the genre list for the current media type — powers the category filter.
  useEffect(() => {
    if (!hasKey) return
    let cancelled = false
    tmdbGet<{ genres: Genre[] }>(`/genre/${mediaType}/list`, key)
      .then((d) => !cancelled && setGenres(d.genres ?? []))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [key, hasKey, mediaType])

  // Fetch whichever list the current media type + view + filters describe.
  // Search and a genre filter route through TMDB's /search or /discover.
  const fetchResults = useCallback(async () => {
    if (!hasKey || !isFeed) return
    setBusy(true)
    setError(null)
    try {
      let data: { results: TmdbItem[]; total_pages?: number }
      if (submittedQuery) {
        data = await tmdbGet(`/search/${mediaType}`, key, {
          query: submittedQuery,
          include_adult: 'false',
          page,
        })
      } else if (genreId != null) {
        data = await tmdbGet(`/discover/${mediaType}`, key, {
          with_genres: genreId,
          sort_by: view === 'top_rated' ? 'vote_average.desc' : 'popularity.desc',
          'vote_count.gte': view === 'top_rated' ? 300 : 0,
          include_adult: 'false',
          page,
        })
      } else {
        const feed = FEEDS[mediaType].find((f) => f.id === view) ?? FEEDS[mediaType][0]
        data = await tmdbGet(feed.path, key, { page })
      }
      setResults((data.results ?? []).map((item) => normalize(item, mediaType)))
      // TMDB caps paging at 500 pages regardless of total_results.
      setTotalPages(Math.min(500, Math.max(1, data.total_pages ?? 1)))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load titles.')
      setResults([])
    } finally {
      setBusy(false)
    }
  }, [hasKey, isFeed, mediaType, view, submittedQuery, genreId, key, page])

  useEffect(() => {
    // fetchResults sets loading/error state; the synchronous setState is
    // intentional here (kick off the request for the current view/filters).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchResults()
  }, [fetchResults])

  function switchMedia(mt: MediaType) {
    if (mt === mediaType) return
    setMediaType(mt)
    // `popular`/`top_rated` exist for both; anything else (or a saved list) is
    // reset to a safe shared feed. Filters are cleared to avoid stale scoping.
    setView((v) => (v === 'favourites' || v === 'watched' || v === 'settings' ? v : 'popular'))
    setGenreId(null)
    setQuery('')
    setSubmittedQuery('')
    setPage(1)
  }

  function selectView(v: View) {
    setView(v)
    setSubmittedQuery('')
    setQuery('')
    setPage(1)
  }

  function submitSearch(e: React.FormEvent) {
    e.preventDefault()
    const q = query.trim()
    setSubmittedQuery(q)
    if (q) setGenreId(null)
    setPage(1)
  }

  // Jump to a page (clamped) and scroll the list back to the top.
  function goToPage(p: number) {
    setPage(Math.min(totalPages, Math.max(1, p)))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function toggleFav(t: Title) {
    setConfig((prev) => {
      const exists = prev.favourites.some((f) => tkey(f) === tkey(t))
      return {
        ...prev,
        favourites: exists
          ? prev.favourites.filter((f) => tkey(f) !== tkey(t))
          : [t, ...prev.favourites],
      }
    })
  }

  // Clicking a poster opens the detail card — browsing only, nothing recorded.
  function open(t: Title) {
    setSelected(t)
  }

  // Pressing Play on the card counts as a watch: record (or bump) it in
  // history, most-recent first, de-duplicated by media+id, then show the
  // player. If reopening the same movie/episode, resume from the saved
  // position; switching to a different episode starts it fresh.
  function play(t: Title, season: number, episode: number) {
    const existing = config.watched.find((w) => tkey(w) === tkey(t))
    const sameSpot =
      !!existing && (t.mediaType !== 'tv' || (existing.season === season && existing.episode === episode))
    const resumeSec = sameSpot ? existing?.positionSec ?? 0 : 0
    const progress = sameSpot ? existing?.progress ?? 0 : 0
    setSelected(null)
    setPlaying({ title: t, season, episode, resumeSec })
    setConfig((prev) => ({
      ...prev,
      watched: [
        {
          ...t,
          watchedAt: new Date().toISOString(),
          season: t.mediaType === 'tv' ? season : undefined,
          episode: t.mediaType === 'tv' ? episode : undefined,
          progress,
          positionSec: resumeSec,
        },
        ...prev.watched.filter((w) => tkey(w) !== tkey(t)),
      ].slice(0, 100),
    }))
  }

  // The player reports back how far the viewer got; store the fraction (for the
  // fill bar) and the absolute position (to resume next time). Identified by
  // title — the season/episode being played hasn't changed mid-session.
  function recordPlayback(t: Title, fraction: number, seconds: number) {
    setConfig((prev) => {
      if (!prev.watched.some((w) => tkey(w) === tkey(t))) return prev
      return {
        ...prev,
        watched: prev.watched.map((w) =>
          tkey(w) === tkey(t) ? { ...w, progress: fraction, positionSec: seconds } : w
        ),
      }
    })
  }

  function removeWatched(t: Title) {
    setConfig((prev) => ({
      ...prev,
      watched: prev.watched.filter((w) => tkey(w) !== tkey(t)),
    }))
  }

  function clearWatched() {
    setConfig((prev) => ({ ...prev, watched: [] }))
  }

  if (loading) {
    return <p className="animate-pulse text-slate-400">Loading your library…</p>
  }

  const tabClass = (active: boolean) =>
    `rounded-xl px-4 py-1.5 text-sm transition-all duration-200 ${
      active
        ? 'bg-gradient-to-r from-indigo-500 to-violet-500 text-white shadow-lg shadow-indigo-500/25'
        : 'border border-white/10 bg-white/5 text-slate-300 hover:border-white/20 hover:bg-white/10'
    }`

  const toggleClass = (active: boolean) =>
    `rounded-lg px-4 py-1.5 text-sm font-medium transition-all duration-200 ${
      active ? 'bg-white/10 text-white shadow-sm' : 'text-slate-400 hover:text-white'
    }`

  // Resume the detail card's TV picker where the user last left this title.
  const selectedEntry = selected
    ? config.watched.find((w) => tkey(w) === tkey(selected))
    : undefined

  const showingList: Title[] =
    view === 'favourites' ? config.favourites : view === 'watched' ? config.watched : results

  const emptyMessage =
    view === 'favourites'
      ? 'No favourites yet — tap the heart on any poster to save it here.'
      : view === 'watched'
        ? 'Nothing watched yet — anything you open shows up here.'
        : submittedQuery
          ? `No results for “${submittedQuery}”.`
          : 'Nothing found.'

  return (
    <div className="max-w-6xl animate-fade-up">
      <div className="flex items-baseline justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Movies &amp; TV</h1>
        <SaveStatus saving={saving} />
      </div>
      <p className="mt-2 text-slate-400">
        Browse what's popular, in theatres or on air and top rated, filter by genre or search, then
        stream it. Favourites and watch history save to your account.
      </p>

      {/* Settings view — the API key lives here, out of the way of browsing. */}
      {view === 'settings' ? (
        <>
          <div className="mt-6 flex">
            <button className={tabClass(false)} onClick={() => selectView('popular')}>
              <span className="inline-flex items-center gap-1.5">
                <ArrowLeft className="size-4" /> Back to browsing
              </span>
            </button>
          </div>
          <div className="glass mt-4 max-w-xl rounded-2xl p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">
              TMDB API key
            </p>
            <input
              type="password"
              value={config.apiKey}
              onChange={(e) => setConfig({ apiKey: e.target.value })}
              placeholder="Paste your TMDB (v3) API key"
              autoComplete="off"
              className="glass mt-2.5 w-full rounded-xl px-3.5 py-2 text-sm text-white placeholder-slate-500 transition-all duration-200 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
            <p className="mt-2 text-xs text-slate-500">
              Get a free key at{' '}
              <a
                href="https://www.themoviedb.org/settings/api"
                target="_blank"
                rel="noreferrer"
                className="text-indigo-300 hover:text-indigo-200"
              >
                themoviedb.org
              </a>{' '}
              (use the “API Key”, not the read token). It's saved to your account — only you can read
              it — and used straight from your browser. Playback is via VidFast and needs no key.
            </p>
            <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
              {hasKey ? (
                <>
                  <Check className="size-3.5 text-emerald-400" /> A key is set.
                </>
              ) : (
                'No key set yet — add one to start browsing.'
              )}
            </p>
          </div>
        </>
      ) : (
        <>
          {/* Media type toggle */}
          <div className="mt-6 inline-flex rounded-xl border border-white/10 bg-white/5 p-1">
            <button className={toggleClass(mediaType === 'movie')} onClick={() => switchMedia('movie')}>
              <span className="inline-flex items-center gap-1.5">
                <Film className="size-4" /> Movies
              </span>
            </button>
            <button className={toggleClass(mediaType === 'tv')} onClick={() => switchMedia('tv')}>
              <span className="inline-flex items-center gap-1.5">
                <Tv className="size-4" /> TV Shows
              </span>
            </button>
          </div>

          {/* Tabs */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {FEEDS[mediaType].map((f) => (
              <button key={f.id} className={tabClass(view === f.id)} onClick={() => selectView(f.id)}>
                {f.label}
              </button>
            ))}
            <button
              className={tabClass(view === 'favourites')}
              onClick={() => selectView('favourites')}
            >
              <span className="inline-flex items-center gap-1.5">
                <Heart className="size-4" /> Favourites
                {config.favourites.length > 0 && (
                  <span className="text-xs opacity-70">{config.favourites.length}</span>
                )}
              </span>
            </button>
            <button className={tabClass(view === 'watched')} onClick={() => selectView('watched')}>
              <span className="inline-flex items-center gap-1.5">
                <Clock className="size-4" /> Watched
                {config.watched.length > 0 && (
                  <span className="text-xs opacity-70">{config.watched.length}</span>
                )}
              </span>
            </button>
            <button
              className="ml-auto rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-slate-300 transition-all duration-200 hover:border-white/20 hover:bg-white/10"
              onClick={() => selectView('settings')}
              title="API settings"
            >
              <span className="inline-flex items-center gap-1.5">
                <Settings className="size-4" /> Settings
              </span>
            </button>
          </div>

          {/* Search + genre only apply to the live feeds, not saved lists */}
          {isFeed && (
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <form onSubmit={submitSearch} className="flex flex-1 gap-2">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={mediaType === 'tv' ? 'Search TV shows…' : 'Search movies…'}
                  disabled={!hasKey}
                  className="glass min-w-0 flex-1 rounded-xl px-3.5 py-2 text-sm text-white placeholder-slate-500 transition-all duration-200 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={!hasKey}
                  className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-white/10 disabled:opacity-50"
                >
                  Search
                </button>
                {submittedQuery && (
                  <button
                    type="button"
                    onClick={() => {
                      setSubmittedQuery('')
                      setQuery('')
                      setPage(1)
                    }}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
                  >
                    Clear
                  </button>
                )}
              </form>
              <label className="flex flex-col gap-1.5 text-xs text-slate-400">
                Category
                <select
                  value={genreId ?? ''}
                  disabled={!hasKey || !!submittedQuery}
                  onChange={(e) => {
                    setGenreId(e.target.value ? Number(e.target.value) : null)
                    setPage(1)
                  }}
                  className="glass rounded-xl px-3 py-2 text-sm text-white focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-50"
                >
                  <option value="" className="bg-slate-900">
                    All genres
                  </option>
                  {genres.map((g) => (
                    <option key={g.id} value={g.id} className="bg-slate-900">
                      {g.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {!hasKey && (
            <p className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
              No TMDB API key yet.{' '}
              <button onClick={() => selectView('settings')} className="font-semibold underline">
                Add one in Settings
              </button>{' '}
              to start browsing.
            </p>
          )}

          {error && (
            <p className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {error}
            </p>
          )}

          {view === 'watched' && config.watched.length > 0 && (
            <div className="mt-4 flex justify-end">
              <button
                onClick={clearWatched}
                className="text-xs text-slate-500 transition-colors hover:text-rose-300"
              >
                Clear watch history
              </button>
            </div>
          )}

          {/* Grid */}
          <div className="mt-6">
            {busy ? (
              <p className="animate-pulse text-slate-400">Loading…</p>
            ) : showingList.length === 0 ? (
              <p className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-8 text-center text-sm text-slate-400">
                {hasKey ? emptyMessage : 'Add your TMDB API key in Settings to browse.'}
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {showingList.map((t) => (
                  <PosterCard
                    key={tkey(t)}
                    title={t}
                    isFav={favSet.has(tkey(t))}
                    showType={view === 'favourites' || view === 'watched'}
                    progress={progressMap.get(tkey(t))}
                    onOpen={() => open(t)}
                    onToggleFav={() => toggleFav(t)}
                    onRemove={view === 'watched' ? () => removeWatched(t) : undefined}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Paging — only for the live TMDB feeds, which are paginated. */}
          {isFeed && !busy && showingList.length > 0 && totalPages > 1 && (
            <div className="mt-6 flex items-center justify-center gap-3 text-sm">
              <button
                onClick={() => goToPage(page - 1)}
                disabled={page <= 1}
                className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-slate-200 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft className="size-4" /> Prev
              </button>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  const v = Number(new FormData(e.currentTarget).get('page'))
                  if (v) goToPage(v)
                }}
                className="flex items-center gap-1.5 tabular-nums text-slate-400"
              >
                <label htmlFor="movies-page">Page</label>
                <input
                  id="movies-page"
                  name="page"
                  type="number"
                  min={1}
                  max={totalPages}
                  // key resets the field to the live page after Prev/Next.
                  key={page}
                  defaultValue={page}
                  onBlur={(e) => {
                    const v = Number(e.target.value)
                    if (v && v !== page) goToPage(v)
                  }}
                  className="glass w-16 rounded-lg px-2 py-1 text-center text-white focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
                of {totalPages}
              </form>
              <button
                onClick={() => goToPage(page + 1)}
                disabled={page >= totalPages}
                className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-slate-200 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next <ChevronRight className="size-4" />
              </button>
            </div>
          )}
        </>
      )}

      {selected && (
        <DetailCard
          title={selected}
          apiKey={key}
          isFav={favSet.has(tkey(selected))}
          initialSeason={selectedEntry?.season ?? 1}
          initialEpisode={selectedEntry?.episode ?? 1}
          onToggleFav={() => toggleFav(selected)}
          onPlay={(s, e) => play(selected, s, e)}
          onClose={() => setSelected(null)}
        />
      )}

      {playing && (
        <Player
          title={playing.title}
          season={playing.season}
          episode={playing.episode}
          resumeSec={playing.resumeSec}
          onProgress={(fraction, seconds) => recordPlayback(playing.title, fraction, seconds)}
          onClose={() => setPlaying(null)}
        />
      )}
    </div>
  )
}
