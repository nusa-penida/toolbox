import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Film,
  Heart,
  Loader2,
  Play,
  Settings,
  Star,
  Tv,
  X,
} from 'lucide-react'
import { SaveStatus } from '../../components/SaveStatus'
import { useUtilityConfig } from '../../hooks/useUtilityConfig'
import { useT } from '../../i18n/LanguageContext'

/**
 * Movies & TV. A browse-and-watch tool backed by two services:
 *
 *   • The Movie Database (TMDB) for metadata — popular / in-theatres-or-on-air
 *     / top-rated lists, genre categories, search and per-title details.
 *     TMDB allows browser CORS, so we call it directly with the user's own
 *     v3 API key (saved to their RLS-protected account config, never bundled).
 *   • cinepro-core for playback — our self-hosted OMSS scraping/streaming
 *     backend (the cinepro/ deployment in the toolbox-backend repo). Given a
 *     TMDB id it returns real stream URLs + subtitles as JSON and proxies the
 *     bytes itself, so we play them in a native <video> (HLS via hls.js) with
 *     our own quality + subtitle controls — no third-party ad-iframe. Its base
 *     URL comes from VITE_CINEPRO_URL; unset means playback is disabled.
 *
 * Favourites and watch history are part of the saved config, so they sync to
 * the user's account and persist across devices. Without an account the tool
 * still works; nothing is saved. The API key lives in a separate Settings tab.
 */

const TMDB_BASE = 'https://api.themoviedb.org/3'
const IMG_BASE = 'https://image.tmdb.org/t/p'

// Base origin of the self-hosted cinepro-core backend (VITE_CINEPRO_URL, e.g.
// https://cine.example.com — origin only, no /v1). Empty when unset, which
// disables playback while browsing keeps working. Stream/subtitle URLs in
// cinepro responses are proxy paths resolved against this origin.
const CINEPRO_BASE =
  (import.meta.env.VITE_CINEPRO_URL as string | undefined)?.replace(/\/+$/, '') || ''

type MediaType = 'movie' | 'tv'
type Feed = 'popular' | 'now_playing' | 'on_the_air' | 'top_rated'
type View = Feed | 'favourites' | 'watched' | 'settings'

// The three browse feeds per media type. `now_playing`/`on_the_air` are the
// media-specific middle tab; the other two ids are shared. Labels are
// translated at render time by `id` (see STR.feeds), so only ids/paths here.
const FEEDS: Record<MediaType, { id: Feed; path: string }[]> = {
  movie: [
    { id: 'popular', path: '/movie/popular' },
    { id: 'now_playing', path: '/movie/now_playing' },
    { id: 'top_rated', path: '/movie/top_rated' },
  ],
  tv: [
    { id: 'popular', path: '/tv/popular' },
    { id: 'on_the_air', path: '/tv/on_the_air' },
    { id: 'top_rated', path: '/tv/top_rated' },
  ],
}

/** All user-facing strings for this tool, co-located per language. */
const STR = {
  en: {
    // Feed/tab labels, keyed by Feed id.
    feeds: {
      popular: 'Most Popular',
      now_playing: 'In Theatres',
      on_the_air: 'On Air',
      top_rated: 'Top Rated',
    } as Record<Feed, string>,
    // PosterCard
    watchTitle: (name: string) => `Watch ${name}`,
    typeTv: 'TV',
    typeMovie: 'Movie',
    removeFav: 'Remove from favourites',
    addFav: 'Add to favourites',
    removeHistory: 'Remove from history',
    percentWatched: (pct: number) => `${pct}% watched`,
    // SeasonEpisodePicker
    season: 'Season',
    episode: 'Episode',
    specials: 'Specials',
    seasonN: (n: number) => `Season ${n}`,
    episodeN: (n: number) => `Episode ${n}`,
    // DetailCard
    close: 'Close',
    seasonsCount: (n: number) => `${n} season${n === 1 ? '' : 's'}`,
    minutes: (n: number) => `${n} min`,
    loadingEllipsis: 'Loading…',
    noSynopsis: 'No synopsis available for this title.',
    play: 'Play',
    playTv: (s: number, e: number) => ` S${s} · E${e}`,
    favourited: 'Favourited',
    favourite: 'Favourite',
    // Player
    seasonEpisode: (s: number, e: number) => `Season ${s} · Episode ${e}`,
    findingSources: 'Finding sources…',
    noSources: 'No playable sources found for this title.',
    playbackNotConfigured:
      'Playback backend isn’t configured (VITE_CINEPRO_URL is unset).',
    playbackError: 'This source failed to play — try another below.',
    retry: 'Retry',
    source: 'Source',
    sourceN: (n: number) => `Source ${n}`,
    // Main
    loadingLibrary: 'Loading your library…',
    heading: 'Movies & TV',
    intro:
      "Browse what's popular, in theatres or on air and top rated, filter by genre or search, then stream it. Favourites and watch history save to your account.",
    backToBrowsing: 'Back to browsing',
    apiKeyLabel: 'TMDB API key',
    apiKeyPlaceholder: 'Paste your TMDB (v3) API key',
    getKeyAt: 'Get a free key at',
    apiKeyHelp:
      '(use the “API Key”, not the read token). It’s saved to your account — only you can read it — and used straight from your browser. Playback runs through the self-hosted cinepro backend and needs no key.',
    keyIsSet: 'A key is set.',
    noKeyYetHelp: 'No key set yet — add one to start browsing.',
    movies: 'Movies',
    tvShows: 'TV Shows',
    favourites: 'Favourites',
    watched: 'Watched',
    settings: 'Settings',
    apiSettings: 'API settings',
    searchTv: 'Search TV shows…',
    searchMovies: 'Search movies…',
    searchBtn: 'Search',
    clear: 'Clear',
    category: 'Category',
    allGenres: 'All genres',
    noKeyYet: 'No TMDB API key yet.',
    addOneInSettings: 'Add one in Settings',
    toStartBrowsing: 'to start browsing.',
    clearHistory: 'Clear watch history',
    addKeyToBrowse: 'Add your TMDB API key in Settings to browse.',
    emptyFavourites: 'No favourites yet — tap the heart on any poster to save it here.',
    emptyWatched: 'Nothing watched yet — anything you open shows up here.',
    noResultsFor: (q: string) => `No results for “${q}”.`,
    nothingFound: 'Nothing found.',
    couldNotLoad: 'Could not load titles.',
    prev: 'Prev',
    next: 'Next',
    page: 'Page',
    ofPages: (n: number) => `of ${n}`,
  },
  nl: {
    feeds: {
      popular: 'Populairst',
      now_playing: 'In de bioscoop',
      on_the_air: 'Nu op tv',
      top_rated: 'Best beoordeeld',
    } as Record<Feed, string>,
    watchTitle: (name: string) => `${name} bekijken`,
    typeTv: 'Tv',
    typeMovie: 'Film',
    removeFav: 'Uit favorieten verwijderen',
    addFav: 'Aan favorieten toevoegen',
    removeHistory: 'Uit geschiedenis verwijderen',
    percentWatched: (pct: number) => `${pct}% bekeken`,
    season: 'Seizoen',
    episode: 'Aflevering',
    specials: 'Specials',
    seasonN: (n: number) => `Seizoen ${n}`,
    episodeN: (n: number) => `Aflevering ${n}`,
    close: 'Sluiten',
    seasonsCount: (n: number) => `${n} seizoen${n === 1 ? '' : 'en'}`,
    minutes: (n: number) => `${n} min`,
    loadingEllipsis: 'Laden…',
    noSynopsis: 'Geen synopsis beschikbaar voor deze titel.',
    play: 'Afspelen',
    playTv: (s: number, e: number) => ` S${s} · A${e}`,
    favourited: 'Favoriet',
    favourite: 'Favoriet maken',
    seasonEpisode: (s: number, e: number) => `Seizoen ${s} · Aflevering ${e}`,
    findingSources: 'Bronnen zoeken…',
    noSources: 'Geen afspeelbare bronnen gevonden voor deze titel.',
    playbackNotConfigured:
      'Afspeel-backend is niet geconfigureerd (VITE_CINEPRO_URL ontbreekt).',
    playbackError: 'Deze bron kon niet afspelen — probeer hieronder een andere.',
    retry: 'Opnieuw',
    source: 'Bron',
    sourceN: (n: number) => `Bron ${n}`,
    loadingLibrary: 'Je bibliotheek laden…',
    heading: 'Films & TV',
    intro:
      'Blader door wat populair is, in de bioscoop of op tv en best beoordeeld, filter op genre of zoek, en stream het. Favorieten en kijkgeschiedenis worden in je account bewaard.',
    backToBrowsing: 'Terug naar bladeren',
    apiKeyLabel: 'TMDB API-sleutel',
    apiKeyPlaceholder: 'Plak je TMDB (v3) API-sleutel',
    getKeyAt: 'Haal een gratis sleutel op bij',
    apiKeyHelp:
      '(gebruik de “API Key”, niet het read-token). Hij wordt in je account bewaard — alleen jij kunt hem lezen — en rechtstreeks vanuit je browser gebruikt. Afspelen verloopt via de zelf-gehoste cinepro-backend en vereist geen sleutel.',
    keyIsSet: 'Er is een sleutel ingesteld.',
    noKeyYetHelp: 'Nog geen sleutel ingesteld — voeg er een toe om te beginnen bladeren.',
    movies: 'Films',
    tvShows: 'Tv-series',
    favourites: 'Favorieten',
    watched: 'Bekeken',
    settings: 'Instellingen',
    apiSettings: 'API-instellingen',
    searchTv: 'Tv-series zoeken…',
    searchMovies: 'Films zoeken…',
    searchBtn: 'Zoeken',
    clear: 'Wissen',
    category: 'Categorie',
    allGenres: 'Alle genres',
    noKeyYet: 'Nog geen TMDB API-sleutel.',
    addOneInSettings: 'Voeg er een toe bij Instellingen',
    toStartBrowsing: 'om te beginnen bladeren.',
    clearHistory: 'Kijkgeschiedenis wissen',
    addKeyToBrowse: 'Voeg je TMDB API-sleutel toe bij Instellingen om te bladeren.',
    emptyFavourites:
      'Nog geen favorieten — tik op het hartje van een poster om het hier op te slaan.',
    emptyWatched: 'Nog niets bekeken — alles wat je opent verschijnt hier.',
    noResultsFor: (q: string) => `Geen resultaten voor “${q}”.`,
    nothingFound: 'Niets gevonden.',
    couldNotLoad: 'Kon de titels niet laden.',
    prev: 'Vorige',
    next: 'Volgende',
    page: 'Pagina',
    ofPages: (n: number) => `van ${n}`,
  },
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
  const t = useT(STR)
  return (
    <div className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] transition-all duration-200 hover:border-white/20">
      <button onClick={onOpen} className="block w-full text-left" title={t.watchTitle(title.title)}>
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
          {title.mediaType === 'tv' ? t.typeTv : t.typeMovie}
        </span>
      )}

      <div className="absolute right-2 top-2 flex flex-col gap-1.5">
        <button
          onClick={onToggleFav}
          title={isFav ? t.removeFav : t.addFav}
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
            title={t.removeHistory}
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
          title={t.percentWatched(Math.round(progress * 100))}
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
  const t = useT(STR)
  const current = seasons.find((s) => s.season_number === season)
  const episodeCount = current?.episode_count ?? Math.max(episode, 1)
  return (
    <div className="flex flex-wrap gap-3">
      <label className="flex flex-col gap-1 text-[11px] text-slate-400">
        {t.season}
        <select
          value={season}
          onChange={(e) => onSeason(Number(e.target.value))}
          className="glass rounded-lg px-2.5 py-1.5 text-sm text-white focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
        >
          {seasons.length === 0 && (
            <option value={season} className="bg-slate-900">
              {t.seasonN(season)}
            </option>
          )}
          {seasons.map((s) => (
            <option key={s.season_number} value={s.season_number} className="bg-slate-900">
              {s.season_number === 0 ? s.name || t.specials : t.seasonN(s.season_number)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-slate-400">
        {t.episode}
        <select
          value={episode}
          onChange={(e) => onEpisode(Number(e.target.value))}
          className="glass rounded-lg px-2.5 py-1.5 text-sm text-white focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
        >
          {Array.from({ length: episodeCount }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n} className="bg-slate-900">
              {t.episodeN(n)}
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
  const t = useT(STR)
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
    isTv && details?.number_of_seasons ? t.seasonsCount(details.number_of_seasons) : null,
    runtimeMin ? t.minutes(runtimeMin) : null,
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
          aria-label={t.close}
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
              {isTv ? t.typeTv : t.typeMovie}
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
              ? t.loadingEllipsis
              : details?.overview || t.noSynopsis}
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
              <Play className="size-4 fill-current" /> {t.play}
              {isTv ? t.playTv(season, episode) : ''}
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
              {isFav ? t.favourited : t.favourite}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

// --- cinepro playback ------------------------------------------------------
// A cinepro (OMSS) `Source`: `url` is a proxy path (`/v1/proxy?data=…`) that
// streams the bytes for us, so no upstream headers/CORS are our problem.
interface CineSource {
  url: string
  type: 'hls' | 'dash' | 'http' | 'mp4' | 'mkv' | 'webm'
  quality?: string
  provider?: { id?: string; name?: string }
}
interface CineSubtitle {
  url: string
  label: string
  format: 'vtt' | 'srt' | 'ass' | 'ssa'
}
interface CineResponse {
  sources?: CineSource[]
  subtitles?: CineSubtitle[]
}

// Resolve a cinepro URL field against the backend origin. `url` fields are
// usually root-relative proxy paths; absolute URLs are passed through.
const cineUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : `${CINEPRO_BASE}${u}`)

// Pull a pixel height out of a quality string ("1080p" → 1080) for sorting.
const qualityRank = (q?: string) => {
  const m = /(\d{3,4})\s*p/i.exec(q ?? '')
  return m ? Number(m[1]) : 0
}

// Rank sources best-first: HLS ahead of everything else (segmented, so each
// response stays under the tunnel's 100 MB cap and it seeks cleanly), then by
// resolution. A single-file mp4 would blow the tunnel cap, so it sinks.
const sortSources = (sources: CineSource[]) =>
  [...sources].sort((a, b) => {
    const ah = a.type === 'hls' ? 1 : 0
    const bh = b.type === 'hls' ? 1 : 0
    return ah !== bh ? bh - ah : qualityRank(b.quality) - qualityRank(a.quality)
  })

type PlayerStatus = 'config' | 'loading' | 'ready' | 'empty' | 'error'

// Full-screen player overlay — the season/episode are chosen on the card.
// Fetches stream sources from cinepro, plays the chosen one in a native
// <video> (HLS via hls.js), resumes at `resumeSec`, and reports playback
// progress back via `onProgress` (persisted once, on close, to keep saves
// sparse). A quality/source selector lets the viewer switch if one fails.
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
  const t = useT(STR)
  const isTv = title.mediaType === 'tv'
  useOverlayChrome(onClose)

  const [status, setStatus] = useState<PlayerStatus>(CINEPRO_BASE ? 'loading' : 'config')
  const [sources, setSources] = useState<CineSource[]>([])
  const [subtitles, setSubtitles] = useState<CineSubtitle[]>([])
  const [selected, setSelected] = useState(0)
  const [playError, setPlayError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<{ destroy(): void } | null>(null)

  // Persist-on-close bookkeeping (mirrors the old iframe behaviour): track the
  // latest position each tick, seed the resume point, and write it once when
  // the player unmounts. `positionRef` also survives source switches so
  // changing quality keeps your place.
  const latest = useRef<{ fraction: number; seconds: number } | null>(null)
  const positionRef = useRef(resumeSec)
  const onProgressRef = useRef(onProgress)
  useEffect(() => {
    onProgressRef.current = onProgress
  })
  useEffect(
    () => () => {
      if (latest.current) onProgressRef.current(latest.current.fraction, latest.current.seconds)
    },
    []
  )

  // Fetch stream sources for this exact title/episode from cinepro.
  useEffect(() => {
    if (!CINEPRO_BASE) return // status was initialised to 'config'
    const path = isTv
      ? `/v1/tv/${title.id}/seasons/${season}/episodes/${episode}`
      : `/v1/movies/${title.id}`
    const ctrl = new AbortController()
    // Genuine data-fetch effect: show the loading state again whenever the
    // title/episode (or a retry) changes the request.
    /* eslint-disable react-hooks/set-state-in-effect */
    setStatus('loading')
    setPlayError(false)
    /* eslint-enable react-hooks/set-state-in-effect */
    fetch(`${CINEPRO_BASE}${path}`, { signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`cinepro ${r.status}`)
        return (await r.json()) as CineResponse
      })
      .then((data) => {
        const srcs = sortSources(data.sources ?? [])
        // Only VTT subtitles render as native <track>s; srt/ass aren't supported.
        setSubtitles((data.subtitles ?? []).filter((s) => s.format === 'vtt'))
        setSources(srcs)
        setSelected(0)
        setStatus(srcs.length ? 'ready' : 'empty')
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setStatus('error')
      })
    return () => ctrl.abort()
  }, [title.id, isTv, season, episode, reloadKey])

  // Attach the selected source to the <video>: hls.js for HLS (except where the
  // browser plays it natively, e.g. Safari), a plain src otherwise.
  useEffect(() => {
    const video = videoRef.current
    const source = sources[selected]
    if (status !== 'ready' || !video || !source) return
    setPlayError(false)
    let cancelled = false
    const url = cineUrl(source.url)
    const nativeHls = !!video.canPlayType('application/vnd.apple.mpegurl')

    async function load(el: HTMLVideoElement) {
      if (source.type === 'hls' && !nativeHls) {
        const { default: Hls } = await import('hls.js')
        if (cancelled) return
        if (Hls.isSupported()) {
          const hls = new Hls({ enableWorker: true })
          hlsRef.current = hls
          hls.on(Hls.Events.ERROR, (_evt, data) => {
            if (data.fatal) setPlayError(true)
          })
          hls.loadSource(url)
          hls.attachMedia(el)
          return
        }
      }
      el.src = url
      el.load()
    }
    void load(video)

    return () => {
      cancelled = true
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
      video.removeAttribute('src')
      video.load()
    }
  }, [status, sources, selected])

  function handleTimeUpdate(e: SyntheticEvent<HTMLVideoElement>) {
    const v = e.currentTarget
    const seconds = v.currentTime
    const duration = v.duration
    if (!isFinite(seconds) || !isFinite(duration) || duration <= 0) return
    positionRef.current = seconds
    latest.current = { fraction: Math.min(1, Math.max(0, seconds / duration)), seconds }
  }

  function handleLoadedMetadata(e: SyntheticEvent<HTMLVideoElement>) {
    const v = e.currentTarget
    const pos = positionRef.current
    if (pos > 0 && pos < (v.duration || Infinity)) v.currentTime = pos
  }

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
              {isTv ? t.seasonEpisode(season, episode) : year(title.date)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* Source/quality picker — only when there's a choice to make. */}
            {status === 'ready' && sources.length > 1 && (
              <select
                value={selected}
                onChange={(e) => setSelected(Number(e.target.value))}
                aria-label={t.source}
                className="glass max-w-[11rem] rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:border-indigo-400/60 focus:outline-none"
              >
                {sources.map((s, i) => (
                  <option key={i} value={i} className="bg-slate-900">
                    {[
                      s.quality && s.quality !== 'unknown' ? s.quality : null,
                      s.type?.toUpperCase(),
                      s.provider?.name,
                    ]
                      .filter(Boolean)
                      .join(' · ') || t.sourceN(i + 1)}
                  </option>
                ))}
              </select>
            )}
            <button
              onClick={onClose}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
            >
              <X className="size-4" /> {t.close}
            </button>
          </div>
        </div>
        {/* Cap the player to the viewport height so its controls aren't clipped
            on shorter screens; the modal's header takes the rest. */}
        <div className="relative aspect-video max-h-[calc(100dvh-6rem)] w-full bg-black">
          {status === 'ready' ? (
            <>
              <video
                ref={videoRef}
                className="size-full"
                controls
                autoPlay
                playsInline
                crossOrigin="anonymous"
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={handleLoadedMetadata}
                onError={() => setPlayError(true)}
              >
                {subtitles.map((s, i) => (
                  <track
                    key={i}
                    kind="subtitles"
                    src={cineUrl(s.url)}
                    label={s.label}
                    default={i === 0}
                  />
                ))}
              </video>
              {playError && (
                <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-3">
                  <span className="pointer-events-auto flex items-center gap-2 rounded-lg bg-rose-500/90 px-3 py-1.5 text-xs font-medium text-white shadow-lg">
                    <AlertTriangle className="size-4" /> {t.playbackError}
                  </span>
                </div>
              )}
            </>
          ) : (
            <div className="flex size-full flex-col items-center justify-center gap-3 px-6 text-center text-slate-400">
              {status === 'loading' ? (
                <>
                  <Loader2 className="size-7 animate-spin text-indigo-400" />
                  <p className="text-sm">{t.findingSources}</p>
                </>
              ) : (
                <>
                  <AlertTriangle className="size-7 text-slate-500" />
                  <p className="max-w-sm text-sm">
                    {status === 'config'
                      ? t.playbackNotConfigured
                      : status === 'empty'
                        ? t.noSources
                        : t.couldNotLoad}
                  </p>
                  {(status === 'empty' || status === 'error') && (
                    <button
                      onClick={() => setReloadKey((k) => k + 1)}
                      className="mt-1 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-slate-200 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      {t.retry}
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

// --- Main ----------------------------------------------------------------

export function Movies() {
  const t = useT(STR)
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
      setError(e instanceof Error ? e.message : t.couldNotLoad)
      setResults([])
    } finally {
      setBusy(false)
    }
  }, [hasKey, isFeed, mediaType, view, submittedQuery, genreId, key, page, t])

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
    return <p className="animate-pulse text-slate-400">{t.loadingLibrary}</p>
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
      ? t.emptyFavourites
      : view === 'watched'
        ? t.emptyWatched
        : submittedQuery
          ? t.noResultsFor(submittedQuery)
          : t.nothingFound

  return (
    <div className="max-w-6xl animate-fade-up">
      <div className="flex items-baseline justify-between">
        <h1 className="text-3xl font-bold tracking-tight">{t.heading}</h1>
        <SaveStatus saving={saving} />
      </div>
      <p className="mt-2 text-slate-400">{t.intro}</p>

      {/* Settings view — the API key lives here, out of the way of browsing. */}
      {view === 'settings' ? (
        <>
          <div className="mt-6 flex">
            <button className={tabClass(false)} onClick={() => selectView('popular')}>
              <span className="inline-flex items-center gap-1.5">
                <ArrowLeft className="size-4" /> {t.backToBrowsing}
              </span>
            </button>
          </div>
          <div className="glass mt-4 max-w-xl rounded-2xl p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">
              {t.apiKeyLabel}
            </p>
            <input
              type="password"
              value={config.apiKey}
              onChange={(e) => setConfig({ apiKey: e.target.value })}
              placeholder={t.apiKeyPlaceholder}
              autoComplete="off"
              className="glass mt-2.5 w-full rounded-xl px-3.5 py-2 text-sm text-white placeholder-slate-500 transition-all duration-200 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
            <p className="mt-2 text-xs text-slate-500">
              {t.getKeyAt}{' '}
              <a
                href="https://www.themoviedb.org/settings/api"
                target="_blank"
                rel="noreferrer"
                className="text-indigo-300 hover:text-indigo-200"
              >
                themoviedb.org
              </a>{' '}
              {t.apiKeyHelp}
            </p>
            <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
              {hasKey ? (
                <>
                  <Check className="size-3.5 text-emerald-400" /> {t.keyIsSet}
                </>
              ) : (
                t.noKeyYetHelp
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
                <Film className="size-4" /> {t.movies}
              </span>
            </button>
            <button className={toggleClass(mediaType === 'tv')} onClick={() => switchMedia('tv')}>
              <span className="inline-flex items-center gap-1.5">
                <Tv className="size-4" /> {t.tvShows}
              </span>
            </button>
          </div>

          {/* Tabs */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {FEEDS[mediaType].map((f) => (
              <button key={f.id} className={tabClass(view === f.id)} onClick={() => selectView(f.id)}>
                {t.feeds[f.id]}
              </button>
            ))}
            <button
              className={tabClass(view === 'favourites')}
              onClick={() => selectView('favourites')}
            >
              <span className="inline-flex items-center gap-1.5">
                <Heart className="size-4" /> {t.favourites}
                {config.favourites.length > 0 && (
                  <span className="text-xs opacity-70">{config.favourites.length}</span>
                )}
              </span>
            </button>
            <button className={tabClass(view === 'watched')} onClick={() => selectView('watched')}>
              <span className="inline-flex items-center gap-1.5">
                <Clock className="size-4" /> {t.watched}
                {config.watched.length > 0 && (
                  <span className="text-xs opacity-70">{config.watched.length}</span>
                )}
              </span>
            </button>
            <button
              className="ml-auto rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-slate-300 transition-all duration-200 hover:border-white/20 hover:bg-white/10"
              onClick={() => selectView('settings')}
              title={t.apiSettings}
            >
              <span className="inline-flex items-center gap-1.5">
                <Settings className="size-4" /> {t.settings}
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
                  placeholder={mediaType === 'tv' ? t.searchTv : t.searchMovies}
                  disabled={!hasKey}
                  className="glass min-w-0 flex-1 rounded-xl px-3.5 py-2 text-sm text-white placeholder-slate-500 transition-all duration-200 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={!hasKey}
                  className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-white/10 disabled:opacity-50"
                >
                  {t.searchBtn}
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
                    {t.clear}
                  </button>
                )}
              </form>
              <label className="flex flex-col gap-1.5 text-xs text-slate-400">
                {t.category}
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
                    {t.allGenres}
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
              {t.noKeyYet}{' '}
              <button onClick={() => selectView('settings')} className="font-semibold underline">
                {t.addOneInSettings}
              </button>{' '}
              {t.toStartBrowsing}
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
                {t.clearHistory}
              </button>
            </div>
          )}

          {/* Grid */}
          <div className="mt-6">
            {busy ? (
              <p className="animate-pulse text-slate-400">{t.loadingEllipsis}</p>
            ) : showingList.length === 0 ? (
              <p className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-8 text-center text-sm text-slate-400">
                {hasKey ? emptyMessage : t.addKeyToBrowse}
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
                <ChevronLeft className="size-4" /> {t.prev}
              </button>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  const v = Number(new FormData(e.currentTarget).get('page'))
                  if (v) goToPage(v)
                }}
                className="flex items-center gap-1.5 tabular-nums text-slate-400"
              >
                <label htmlFor="movies-page">{t.page}</label>
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
                {t.ofPages(totalPages)}
              </form>
              <button
                onClick={() => goToPage(page + 1)}
                disabled={page >= totalPages}
                className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-slate-200 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t.next} <ChevronRight className="size-4" />
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
