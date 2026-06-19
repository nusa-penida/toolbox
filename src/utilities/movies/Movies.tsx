import { useCallback, useEffect, useState } from 'react'
import { SaveStatus } from '../../components/SaveStatus'
import { useUtilityConfig } from '../../hooks/useUtilityConfig'

/**
 * Movies. A browse-and-watch tool backed by two free services:
 *
 *   • The Movie Database (TMDB) for metadata — popular / now-playing /
 *     top-rated lists, genre categories, search and per-title details.
 *     TMDB allows browser CORS, so we call it directly with the user's own
 *     v3 API key (saved to their RLS-protected account config, never bundled).
 *   • VidAPI (vidapi.ru) for playback — given a TMDB id it returns an embed
 *     player, dropped into an <iframe>. No key required.
 *
 * Favourites and watch history are part of the saved config, so they sync to
 * the user's account and persist across devices. Without an account the tool
 * still works; nothing is saved.
 */

const TMDB_BASE = 'https://api.themoviedb.org/3'
const IMG_BASE = 'https://image.tmdb.org/t/p'
// VidAPI embed player — accepts a bare TMDB id for movies.
const VIDAPI_MOVIE = (tmdbId: number) => `https://vidapi.ru/embed/movie/${tmdbId}`

type Feed = 'popular' | 'now_playing' | 'top_rated'

const FEEDS: { id: Feed; label: string; path: string }[] = [
  { id: 'popular', label: 'Most Popular', path: '/movie/popular' },
  { id: 'now_playing', label: 'In Theatres', path: '/movie/now_playing' },
  { id: 'top_rated', label: 'Top Rated', path: '/movie/top_rated' },
]

interface Movie {
  id: number
  title: string
  poster_path: string | null
  release_date: string | null
  vote_average: number | null
  overview?: string
}

interface Genre {
  id: number
  name: string
}

// Stored per movie in favourites / watch history — a trimmed Movie plus,
// for history, when it was last opened.
interface SavedMovie {
  id: number
  title: string
  poster_path: string | null
  release_date: string | null
  vote_average: number | null
}
interface WatchEntry extends SavedMovie {
  watchedAt: string
}

interface MoviesConfig extends Record<string, unknown> {
  apiKey: string
  favourites: SavedMovie[]
  watched: WatchEntry[]
}

const DEFAULTS: MoviesConfig = { apiKey: '', favourites: [], watched: [] }

function toSaved(m: Movie | SavedMovie): SavedMovie {
  return {
    id: m.id,
    title: m.title,
    poster_path: m.poster_path,
    release_date: m.release_date,
    vote_average: m.vote_average,
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
  const qs = new URLSearchParams({ api_key: key, ...mapParams(params) }).toString()
  const res = await fetch(`${TMDB_BASE}${path}?${qs}`)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body?.status_message ?? `TMDB returned ${res.status}`)
  }
  return body as T
}

function mapParams(p: Record<string, string | number>): Record<string, string> {
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)]))
}

// --- Pieces --------------------------------------------------------------

function Stars({ rating }: { rating: number | null }) {
  if (rating == null) return null
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-300">
      ★ {rating.toFixed(1)}
    </span>
  )
}

function PosterCard({
  movie,
  isFav,
  onOpen,
  onToggleFav,
}: {
  movie: Movie | SavedMovie
  isFav: boolean
  onOpen: () => void
  onToggleFav: () => void
}) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] transition-all duration-200 hover:border-white/20">
      <button
        onClick={onOpen}
        className="block w-full text-left"
        title={`Watch ${movie.title}`}
      >
        <div className="aspect-[2/3] w-full overflow-hidden bg-slate-800">
          {movie.poster_path ? (
            <img
              src={`${IMG_BASE}/w342${movie.poster_path}`}
              alt={movie.title}
              loading="lazy"
              className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
            />
          ) : (
            <div className="flex size-full items-center justify-center p-3 text-center text-xs text-slate-500">
              {movie.title}
            </div>
          )}
        </div>
        <div className="p-2.5">
          <p className="truncate text-sm font-medium text-white">{movie.title}</p>
          <div className="mt-1 flex items-center justify-between text-slate-400">
            <span className="text-xs">{year(movie.release_date)}</span>
            <Stars rating={movie.vote_average} />
          </div>
        </div>
      </button>
      <button
        onClick={onToggleFav}
        title={isFav ? 'Remove from favourites' : 'Add to favourites'}
        className={`absolute right-2 top-2 flex size-8 items-center justify-center rounded-full backdrop-blur transition-all duration-200 ${
          isFav
            ? 'bg-rose-500/90 text-white'
            : 'bg-black/50 text-white/70 opacity-0 hover:bg-black/70 hover:text-white group-hover:opacity-100'
        }`}
      >
        {isFav ? '♥' : '♡'}
      </button>
    </div>
  )
}

function Player({
  movie,
  onClose,
}: {
  movie: SavedMovie
  onClose: () => void
}) {
  // Close on Escape for a less fiddly exit from the full-screen overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-5xl overflow-hidden rounded-2xl border border-white/10 bg-slate-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-white">{movie.title}</p>
            <p className="text-xs text-slate-500">
              {year(movie.release_date)} · playing via VidAPI
            </p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            Close ✕
          </button>
        </div>
        <div className="aspect-video w-full bg-black">
          <iframe
            src={VIDAPI_MOVIE(movie.id)}
            title={movie.title}
            className="size-full"
            allowFullScreen
            referrerPolicy="origin"
          />
        </div>
        <p className="px-4 py-2.5 text-[11px] text-slate-500">
          Source streams are provided by VidAPI, a third party. If a title won't play, it may not be
          available yet.
        </p>
      </div>
    </div>
  )
}

// --- Main ----------------------------------------------------------------

export function Movies() {
  const { config, setConfig, loading, saving } = useUtilityConfig<MoviesConfig>(
    'movies',
    DEFAULTS
  )
  const key = config.apiKey.trim()
  const hasKey = key.length > 0

  type View = Feed | 'favourites' | 'watched'
  const [view, setView] = useState<View>('popular')
  const [genres, setGenres] = useState<Genre[]>([])
  const [genreId, setGenreId] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')

  const [movies, setMovies] = useState<Movie[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState<SavedMovie | null>(null)

  const favIds = new Set(config.favourites.map((f) => f.id))

  // Load the genre list once a key is available — powers the category filter.
  useEffect(() => {
    if (!hasKey) return
    let cancelled = false
    tmdbGet<{ genres: Genre[] }>('/genre/movie/list', key)
      .then((d) => !cancelled && setGenres(d.genres ?? []))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [key, hasKey])

  // Fetch whichever list the current view + filters describe. Searching and a
  // genre filter both route through TMDB's /discover or /search endpoints.
  const fetchMovies = useCallback(async () => {
    if (!hasKey || view === 'favourites' || view === 'watched') return
    setBusy(true)
    setError(null)
    try {
      let data: { results: Movie[] }
      if (submittedQuery) {
        data = await tmdbGet('/search/movie', key, {
          query: submittedQuery,
          include_adult: 'false',
        })
      } else if (genreId != null) {
        data = await tmdbGet('/discover/movie', key, {
          with_genres: genreId,
          sort_by: view === 'top_rated' ? 'vote_average.desc' : 'popularity.desc',
          'vote_count.gte': view === 'top_rated' ? 300 : 0,
          include_adult: 'false',
        })
      } else {
        const feed = FEEDS.find((f) => f.id === view)!
        data = await tmdbGet(feed.path, key)
      }
      setMovies(data.results ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load movies.')
      setMovies([])
    } finally {
      setBusy(false)
    }
  }, [hasKey, view, submittedQuery, genreId, key])

  useEffect(() => {
    // fetchMovies sets loading/error state; the synchronous setState is
    // intentional here (kick off the request for the current view/filters).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchMovies()
  }, [fetchMovies])

  function selectView(v: View) {
    setView(v)
    setSubmittedQuery('')
    setQuery('')
  }

  function submitSearch(e: React.FormEvent) {
    e.preventDefault()
    const q = query.trim()
    setSubmittedQuery(q)
    // A search spans all categories, so clear the genre filter to avoid
    // implying it's scoped.
    if (q) setGenreId(null)
  }

  function toggleFav(movie: Movie | SavedMovie) {
    setConfig((prev) => {
      const exists = prev.favourites.some((f) => f.id === movie.id)
      return {
        ...prev,
        favourites: exists
          ? prev.favourites.filter((f) => f.id !== movie.id)
          : [toSaved(movie), ...prev.favourites],
      }
    })
  }

  // Opening the player counts as a watch — record (or bump) it in history,
  // most-recent first, de-duplicated by id.
  function open(movie: Movie | SavedMovie) {
    const saved = toSaved(movie)
    setPlaying(saved)
    setConfig((prev) => ({
      ...prev,
      watched: [
        { ...saved, watchedAt: new Date().toISOString() },
        ...prev.watched.filter((w) => w.id !== saved.id),
      ].slice(0, 100),
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

  const showingList: (Movie | SavedMovie)[] =
    view === 'favourites'
      ? config.favourites
      : view === 'watched'
        ? config.watched
        : movies

  const emptyMessage =
    view === 'favourites'
      ? 'No favourites yet — tap the heart on any poster to save it here.'
      : view === 'watched'
        ? 'Nothing watched yet — anything you open shows up here.'
        : submittedQuery
          ? `No results for “${submittedQuery}”.`
          : 'No movies found.'

  return (
    <div className="max-w-6xl animate-fade-up">
      <div className="flex items-baseline justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Movies</h1>
        <SaveStatus saving={saving} />
      </div>
      <p className="mt-2 text-slate-400">
        Browse what's popular, in theatres or top rated, filter by genre or search, then stream it.
        Favourites and watch history save to your account.
      </p>

      {/* TMDB API key */}
      <div className="glass mt-8 rounded-2xl p-4">
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
          (use the “API Key”, not the read token). It's saved to your account — only you can read it
          — and used straight from your browser. Playback is via VidAPI and needs no key.
        </p>
      </div>

      {!hasKey && (
        <p className="mt-4 text-xs text-amber-300">Enter your TMDB API key above to start.</p>
      )}

      {/* Tabs + search + genre filter */}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        {FEEDS.map((f) => (
          <button key={f.id} className={tabClass(view === f.id)} onClick={() => selectView(f.id)}>
            {f.label}
          </button>
        ))}
        <button className={tabClass(view === 'favourites')} onClick={() => selectView('favourites')}>
          ♥ Favourites
          {config.favourites.length > 0 && (
            <span className="ml-1.5 text-xs opacity-70">{config.favourites.length}</span>
          )}
        </button>
        <button className={tabClass(view === 'watched')} onClick={() => selectView('watched')}>
          🕑 Watched
          {config.watched.length > 0 && (
            <span className="ml-1.5 text-xs opacity-70">{config.watched.length}</span>
          )}
        </button>
      </div>

      {/* Search + genre only apply to the TMDB feeds, not saved lists */}
      {view !== 'favourites' && view !== 'watched' && (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <form onSubmit={submitSearch} className="flex flex-1 gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search movies…"
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
              onChange={(e) => setGenreId(e.target.value ? Number(e.target.value) : null)}
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
            {hasKey ? emptyMessage : 'Add your TMDB API key to browse movies.'}
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {showingList.map((m) => (
              <PosterCard
                key={m.id}
                movie={m}
                isFav={favIds.has(m.id)}
                onOpen={() => open(m)}
                onToggleFav={() => toggleFav(m)}
              />
            ))}
          </div>
        )}
      </div>

      {playing && <Player movie={playing} onClose={() => setPlaying(null)} />}
    </div>
  )
}
