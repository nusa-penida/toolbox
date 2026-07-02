import { useState } from 'react'
import { SaveStatus } from '../../components/SaveStatus'
import { useUtilityConfig } from '../../hooks/useUtilityConfig'
import { useT, useLang } from '../../i18n/LanguageContext'
import { functionsBase } from '../../lib/supabase'

/**
 * Soccer Predictor. Two modes, both backed by the `soccer` Supabase edge
 * function which proxies football-data.org:
 *
 *   • Matchup — pick any two teams (or countries) and get a win probability
 *     and most-likely scoreline from their recent form + head-to-head.
 *   • Upcoming — browse a competition's scheduled matches and predict each.
 *
 * The win % and the predicted score both come from one model: expected goals
 * per side (own recent scoring blended with the opponent's conceding, nudged
 * for home advantage) fed into Poisson scoreline distributions. Each user
 * brings their own football-data.org API token, saved to their account config
 * (RLS-protected) and forwarded to the function per request — never bundled.
 *
 * Note: line-ups aren't available on any free football API, so predictions are
 * based on recent goals and head-to-head, not the specific starting XI.
 */

const STR = {
  en: {
    loadingSettings: 'Loading your settings…',
    title: 'Soccer Predictor',
    intro:
      "Compare two teams or browse a competition's upcoming matches, and get a win probability and most-likely scoreline from each side's recent form and head-to-head record.",
    tokenLabel: 'football-data.org API token',
    tokenPlaceholder: 'Paste your football-data.org token',
    getTokenPrefix: 'Get a free token at',
    tokenHelpSuffix:
      ". It's saved to your account (only you can read it) and sent straight to the provider. Free tier: 12 competitions, current season, 10 requests/minute. Line-ups aren't available on any free tier, so predictions use recent goals and head-to-head.",
    competition: 'Competition',
    matchupTab: 'Matchup',
    upcomingTab: 'Upcoming',
    enterTokenPrompt: 'Enter your football-data.org token above to start.',
    loadTeamsLoading: 'Loading teams…',
    teamsLoaded: (n: number) => `Teams loaded (${n})`,
    loadTeams: 'Load teams for this competition',
    homeTeam: 'Home team',
    awayTeam: 'Away team',
    teamPlaceholder: 'Start typing a team…',
    neutralVenue: 'Neutral venue (no home advantage)',
    calculating: 'Calculating…',
    predictResult: 'Predict result',
    loadMatchesLoading: 'Loading matches…',
    loadMatches: 'Load matches',
    seasonFinishedNotice:
      'This competition has no scheduled matches right now — showing the most recent results instead. Predictions use the form leading up to each match.',
    vs: 'vs',
    matchday: (n: number) => ` · MD ${n}`,
    recalculate: 'Recalculate',
    predict: 'Predict',
    // Errors / notices
    couldNotLoadTeams: 'Could not load teams.',
    pickBothTeams: 'Pick both teams from the list (load the competition first).',
    pickTwoDifferent: 'Pick two different teams.',
    couldNotCalculate: 'Could not calculate.',
    noMatchesFound: 'No matches found for that competition.',
    couldNotLoadFixtures: 'Could not load fixtures.',
    requestFailed: (status: number) => `Request failed (${status})`,
    // PredictionCard
    noDataNotice: (subject: string) =>
      `${subject} no recent matches in the data available on the free tier, so this is a league-average baseline — not a real prediction. Try teams from a competition that's currently in season (e.g. the domestic leagues).`,
    neitherTeamHas: 'Neither team has',
    teamHas: (name: string) => `${name} has`,
    mostLikelyScore: 'most likely score',
    expectedGoals: (home: number, away: number) => `expected goals ${home}–${away}`,
    neutralVenueTag: 'neutral venue',
    winPct: (pct: number, name: string) => `${pct}% ${name}`,
    drawPct: (pct: number) => `${pct}% draw`,
    basedOnForm: (
      homeName: string,
      homeMatches: number,
      homeFor: number | null,
      homeAgainst: number | null,
      awayName: string,
      awayMatches: number,
      awayFor: number | null,
      awayAgainst: number | null
    ) =>
      `Based on ${homeName}'s last ${homeMatches} (${homeFor}–${homeAgainst} goals/game) and ${awayName}'s last ${awayMatches} (${awayFor}–${awayAgainst})`,
    basedOnLimited: 'Based on limited recent data',
    h2hSuffix: (n: number) => `, plus ${n} head-to-head meeting${n === 1 ? '' : 's'}.`,
    noH2hSuffix: ' (no head-to-head history on the free tier).',
  },
  nl: {
    loadingSettings: 'Je instellingen laden…',
    title: 'Voetbalvoorspeller',
    intro:
      'Vergelijk twee ploegen of blader door de komende wedstrijden van een competitie, en krijg een winkans en de meest waarschijnlijke uitslag op basis van de recente vorm en onderlinge resultaten van elke ploeg.',
    tokenLabel: 'football-data.org API-token',
    tokenPlaceholder: 'Plak je football-data.org-token',
    getTokenPrefix: 'Haal een gratis token op bij',
    tokenHelpSuffix:
      '. Het wordt opgeslagen bij je account (alleen jij kan het lezen) en rechtstreeks naar de aanbieder gestuurd. Gratis tarief: 12 competities, huidig seizoen, 10 aanvragen/minuut. Opstellingen zijn op geen enkel gratis tarief beschikbaar, dus voorspellingen gebruiken recente doelpunten en onderlinge resultaten.',
    competition: 'Competitie',
    matchupTab: 'Onderling',
    upcomingTab: 'Komende',
    enterTokenPrompt: 'Voer hierboven je football-data.org-token in om te beginnen.',
    loadTeamsLoading: 'Ploegen laden…',
    teamsLoaded: (n: number) => `Ploegen geladen (${n})`,
    loadTeams: 'Ploegen voor deze competitie laden',
    homeTeam: 'Thuisploeg',
    awayTeam: 'Uitploeg',
    teamPlaceholder: 'Begin een ploeg te typen…',
    neutralVenue: 'Neutraal terrein (geen thuisvoordeel)',
    calculating: 'Berekenen…',
    predictResult: 'Resultaat voorspellen',
    loadMatchesLoading: 'Wedstrijden laden…',
    loadMatches: 'Wedstrijden laden',
    seasonFinishedNotice:
      'Deze competitie heeft momenteel geen geplande wedstrijden — in plaats daarvan tonen we de meest recente resultaten. Voorspellingen gebruiken de vorm voorafgaand aan elke wedstrijd.',
    vs: 'tegen',
    matchday: (n: number) => ` · SD ${n}`,
    recalculate: 'Herberekenen',
    predict: 'Voorspellen',
    // Errors / notices
    couldNotLoadTeams: 'Kon de ploegen niet laden.',
    pickBothTeams: 'Kies beide ploegen uit de lijst (laad eerst de competitie).',
    pickTwoDifferent: 'Kies twee verschillende ploegen.',
    couldNotCalculate: 'Kon niet berekenen.',
    noMatchesFound: 'Geen wedstrijden gevonden voor die competitie.',
    couldNotLoadFixtures: 'Kon de wedstrijden niet laden.',
    requestFailed: (status: number) => `Aanvraag mislukt (${status})`,
    // PredictionCard
    noDataNotice: (subject: string) =>
      `${subject} geen recente wedstrijden in de data die op het gratis tarief beschikbaar is, dus dit is een competitiegemiddelde als basis — geen echte voorspelling. Probeer ploegen uit een competitie die momenteel in het seizoen zit (bv. de nationale competities).`,
    neitherTeamHas: 'Geen van beide ploegen heeft',
    teamHas: (name: string) => `${name} heeft`,
    mostLikelyScore: 'meest waarschijnlijke uitslag',
    expectedGoals: (home: number, away: number) => `verwachte doelpunten ${home}–${away}`,
    neutralVenueTag: 'neutraal terrein',
    winPct: (pct: number, name: string) => `${pct}% ${name}`,
    drawPct: (pct: number) => `${pct}% gelijkspel`,
    basedOnForm: (
      homeName: string,
      homeMatches: number,
      homeFor: number | null,
      homeAgainst: number | null,
      awayName: string,
      awayMatches: number,
      awayFor: number | null,
      awayAgainst: number | null
    ) =>
      `Op basis van de laatste ${homeMatches} van ${homeName} (${homeFor}–${homeAgainst} doelpunten/wedstrijd) en de laatste ${awayMatches} van ${awayName} (${awayFor}–${awayAgainst})`,
    basedOnLimited: 'Op basis van beperkte recente data',
    h2hSuffix: (n: number) => `, plus ${n} onderlinge ontmoeting${n === 1 ? '' : 'en'}.`,
    noH2hSuffix: ' (geen onderlinge historiek op het gratis tarief).',
  },
}

const FN_BASE = `${functionsBase}/soccer`
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string

// football-data.org competition codes available on the free tier.
const COMPETITIONS: { code: string; name: string }[] = [
  { code: 'PL', name: 'Premier League (England)' },
  { code: 'PD', name: 'La Liga (Spain)' },
  { code: 'SA', name: 'Serie A (Italy)' },
  { code: 'BL1', name: 'Bundesliga (Germany)' },
  { code: 'FL1', name: 'Ligue 1 (France)' },
  { code: 'DED', name: 'Eredivisie (Netherlands)' },
  { code: 'PPL', name: 'Primeira Liga (Portugal)' },
  { code: 'ELC', name: 'Championship (England)' },
  { code: 'BSA', name: 'Série A (Brazil)' },
  { code: 'CL', name: 'UEFA Champions League' },
  { code: 'WC', name: 'FIFA World Cup (national teams)' },
  { code: 'EC', name: 'European Championship (national teams)' },
]

type Mode = 'matchup' | 'upcoming'

interface TeamInfo {
  id: number
  name: string
  shortName: string
  tla: string | null
  crest: string | null
}

interface Fixture {
  id: number
  date: string
  status: string
  competition: string | null
  matchday: number | null
  home: { id: number; name: string; crest: string | null }
  away: { id: number; name: string; crest: string | null }
}

interface Prediction {
  fixture: {
    id?: number
    date?: string
    home: { id: number; name: string; crest?: string | null }
    away: { id: number; name: string; crest?: string | null }
    neutral?: boolean
  }
  probabilities: { home: number; draw: number; away: number }
  likelyScore: { home: number; away: number }
  expectedGoals: { home: number; away: number }
  basis: {
    homeGoalsFor: number | null
    homeGoalsAgainst: number | null
    awayGoalsFor: number | null
    awayGoalsAgainst: number | null
    homeMatches: number
    awayMatches: number
    h2hMeetings: number
    neutral: boolean
  }
}

async function callFn(
  params: Record<string, string>,
  token: string,
  requestFailed: (status: number) => string
) {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${FN_BASE}?${qs}`, {
    headers: {
      Authorization: `Bearer ${ANON_KEY}`,
      apikey: ANON_KEY,
      'x-fd-token': token,
    },
  })
  const body = await res.json()
  if (!res.ok || body.error) throw new Error(body.error ?? requestFailed(res.status))
  return body.data
}

function formatKickoff(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function Crest({ src, size = 20 }: { src?: string | null; size?: number }) {
  if (!src) return null
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      className="inline-block shrink-0 object-contain"
      style={{ width: size, height: size }}
    />
  )
}

function ProbBar({ p }: { p: Prediction['probabilities'] }) {
  return (
    <div className="flex h-2 overflow-hidden rounded-full">
      <span className="bg-indigo-500" style={{ width: `${p.home}%` }} />
      <span className="bg-slate-500" style={{ width: `${p.draw}%` }} />
      <span className="bg-violet-500" style={{ width: `${p.away}%` }} />
    </div>
  )
}

function PredictionCard({ pred }: { pred: Prediction }) {
  const t = useT(STR)
  const { home, away } = pred.fixture
  const b = pred.basis
  const haveForm = b.homeMatches > 0 && b.awayMatches > 0
  // With no recent matches for one or both sides (e.g. national teams out of
  // season on the free tier), the model has nothing to go on and falls back to
  // a league-average baseline — so the numbers are a placeholder, not a read.
  const noData = b.homeMatches === 0 || b.awayMatches === 0
  const missing =
    b.homeMatches === 0 && b.awayMatches === 0
      ? t.neitherTeamHas
      : b.homeMatches === 0
        ? t.teamHas(home.name)
        : t.teamHas(away.name)
  return (
    <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-4">
      {noData && (
        <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          {t.noDataNotice(missing)}
        </p>
      )}
      {/* Most-likely scoreline */}
      <div className="flex items-center justify-center gap-3">
        <span className="flex min-w-0 flex-1 items-center justify-end gap-2 text-sm font-medium text-white">
          <span className="truncate">{home.name}</span>
          <Crest src={home.crest} size={24} />
        </span>
        <span className="shrink-0 whitespace-nowrap rounded-lg bg-white/5 px-3 py-1 text-lg font-bold tabular-nums text-white">
          {pred.likelyScore.home}–{pred.likelyScore.away}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium text-white">
          <Crest src={away.crest} size={24} />
          <span className="truncate">{away.name}</span>
        </span>
      </div>
      <p className="mt-1 text-center text-[11px] text-slate-500">
        {t.mostLikelyScore} · {t.expectedGoals(pred.expectedGoals.home, pred.expectedGoals.away)}
        {pred.fixture.neutral ? ` · ${t.neutralVenueTag}` : ''}
      </p>

      {/* Win probabilities */}
      <div className="mt-4 flex justify-between text-xs font-medium">
        <span className="text-indigo-300">{t.winPct(pred.probabilities.home, home.name)}</span>
        <span className="text-slate-400">{t.drawPct(pred.probabilities.draw)}</span>
        <span className="text-violet-300">{t.winPct(pred.probabilities.away, away.name)}</span>
      </div>
      <div className="mt-1.5">
        <ProbBar p={pred.probabilities} />
      </div>

      <p className="mt-3 text-xs text-slate-500">
        {haveForm
          ? t.basedOnForm(
              home.name,
              b.homeMatches,
              b.homeGoalsFor,
              b.homeGoalsAgainst,
              away.name,
              b.awayMatches,
              b.awayGoalsFor,
              b.awayGoalsAgainst
            )
          : t.basedOnLimited}
        {b.h2hMeetings > 0 ? t.h2hSuffix(b.h2hMeetings) : t.noH2hSuffix}
      </p>
    </div>
  )
}

export function SoccerPredictor() {
  const t = useT(STR)
  const { locale } = useLang()
  const { config, setConfig, loading, saving } = useUtilityConfig('soccer-predictor', {
    apiKey: '',
    competition: 'PL',
    mode: 'matchup' as Mode,
    neutral: false,
  })

  const token = config.apiKey.trim()
  const hasKey = token.length > 0

  // Shared error + matchup state
  const [error, setError] = useState<string | null>(null)
  const [teams, setTeams] = useState<TeamInfo[]>([])
  const [loadingTeams, setLoadingTeams] = useState(false)
  const [homeName, setHomeName] = useState('')
  const [awayName, setAwayName] = useState('')
  const [matchupPred, setMatchupPred] = useState<Prediction | null>(null)
  const [predictingMatchup, setPredictingMatchup] = useState(false)

  // Upcoming-fixtures state
  const [fixtures, setFixtures] = useState<Fixture[]>([])
  const [seasonFinished, setSeasonFinished] = useState(false)
  const [loadingFixtures, setLoadingFixtures] = useState(false)
  const [predictions, setPredictions] = useState<Record<number, Prediction>>({})
  const [predicting, setPredicting] = useState<Record<number, boolean>>({})

  function resolveTeam(name: string): TeamInfo | undefined {
    const q = name.trim().toLowerCase()
    return teams.find(
      (t) =>
        t.name.toLowerCase() === q ||
        t.shortName.toLowerCase() === q ||
        (t.tla && t.tla.toLowerCase() === q)
    )
  }

  async function loadTeams() {
    if (!hasKey) return
    setLoadingTeams(true)
    setError(null)
    try {
      const data = await callFn(
        { action: 'teams', competition: config.competition },
        token,
        t.requestFailed
      )
      setTeams(data as TeamInfo[])
    } catch (e) {
      setError(e instanceof Error ? e.message : t.couldNotLoadTeams)
    } finally {
      setLoadingTeams(false)
    }
  }

  async function predictMatchup() {
    const h = resolveTeam(homeName)
    const a = resolveTeam(awayName)
    if (!h || !a) {
      setError(t.pickBothTeams)
      return
    }
    if (h.id === a.id) {
      setError(t.pickTwoDifferent)
      return
    }
    setPredictingMatchup(true)
    setError(null)
    setMatchupPred(null)
    try {
      const data = (await callFn(
        {
          action: 'matchup',
          home: String(h.id),
          away: String(a.id),
          competition: config.competition,
          neutral: config.neutral ? '1' : '0',
        },
        token,
        t.requestFailed
      )) as Prediction
      // The server can only name teams it found match history for; we already
      // know the real names from the loaded team list, so use those.
      data.fixture.home.name = h.name
      data.fixture.away.name = a.name
      data.fixture.home.crest = h.crest
      data.fixture.away.crest = a.crest
      setMatchupPred(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : t.couldNotCalculate)
    } finally {
      setPredictingMatchup(false)
    }
  }

  async function loadFixtures() {
    if (!hasKey) return
    setLoadingFixtures(true)
    setError(null)
    setPredictions({})
    try {
      const data = (await callFn(
        { action: 'fixtures', competition: config.competition },
        token,
        t.requestFailed
      )) as { seasonFinished: boolean; fixtures: Fixture[] }
      setFixtures(data.fixtures)
      setSeasonFinished(data.seasonFinished)
      if (!data.fixtures.length) setError(t.noMatchesFound)
    } catch (e) {
      setError(e instanceof Error ? e.message : t.couldNotLoadFixtures)
    } finally {
      setLoadingFixtures(false)
    }
  }

  async function predictFixture(id: number) {
    setPredicting((s) => ({ ...s, [id]: true }))
    try {
      const data = await callFn({ action: 'predict', match: String(id) }, token, t.requestFailed)
      setPredictions((s) => ({ ...s, [id]: data as Prediction }))
    } catch (e) {
      setError(e instanceof Error ? e.message : t.couldNotCalculate)
    } finally {
      setPredicting((s) => ({ ...s, [id]: false }))
    }
  }

  if (loading) {
    return <p className="animate-pulse text-slate-400">{t.loadingSettings}</p>
  }

  const tabClass = (m: Mode) =>
    `rounded-xl px-4 py-1.5 text-sm transition-all duration-200 ${
      config.mode === m
        ? 'bg-gradient-to-r from-indigo-500 to-violet-500 text-white shadow-lg shadow-indigo-500/25'
        : 'border border-white/10 bg-white/5 text-slate-300 hover:border-white/20 hover:bg-white/10'
    }`

  return (
    <div className="animate-fade-up">
      <div className="flex items-baseline justify-between">
        <h1 className="text-3xl font-bold tracking-tight">{t.title}</h1>
        <SaveStatus saving={saving} />
      </div>
      <p className="mt-2 text-slate-400">{t.intro}</p>

      {/* API token */}
      <div className="glass mt-8 rounded-2xl p-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">
          {t.tokenLabel}
        </p>
        <input
          type="password"
          value={config.apiKey}
          onChange={(e) => setConfig({ apiKey: e.target.value })}
          placeholder={t.tokenPlaceholder}
          autoComplete="off"
          className="glass mt-2.5 w-full rounded-xl px-3.5 py-2 text-sm text-white placeholder-slate-500 transition-all duration-200 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
        />
        <p className="mt-2 text-xs text-slate-500">
          {t.getTokenPrefix}{' '}
          <a
            href="https://www.football-data.org/client/register"
            target="_blank"
            rel="noreferrer"
            className="text-indigo-300 hover:text-indigo-200"
          >
            football-data.org
          </a>
          {t.tokenHelpSuffix}
        </p>
      </div>

      {/* Competition + mode */}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5 text-xs text-slate-400">
          {t.competition}
          <select
            value={config.competition}
            onChange={(e) => {
              setConfig({ competition: e.target.value })
              setTeams([])
              setFixtures([])
              setMatchupPred(null)
            }}
            className="glass rounded-xl px-3 py-2 text-sm text-white focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          >
            {COMPETITIONS.map((c) => (
              <option key={c.code} value={c.code} className="bg-slate-900">
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex gap-2 pb-0.5">
          <button className={tabClass('matchup')} onClick={() => setConfig({ mode: 'matchup' })}>
            {t.matchupTab}
          </button>
          <button className={tabClass('upcoming')} onClick={() => setConfig({ mode: 'upcoming' })}>
            {t.upcomingTab}
          </button>
        </div>
      </div>

      {!hasKey && (
        <p className="mt-4 text-xs text-amber-300">{t.enterTokenPrompt}</p>
      )}

      {error && (
        <p className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      )}

      {/* ---- Matchup mode ---- */}
      {config.mode === 'matchup' && (
        <div className="mt-6">
          <button
            onClick={loadTeams}
            disabled={!hasKey || loadingTeams}
            className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 transition-all duration-200 hover:border-white/20 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loadingTeams ? t.loadTeamsLoading : teams.length ? t.teamsLoaded(teams.length) : t.loadTeams}
          </button>

          {teams.length > 0 && (
            <>
              <datalist id="team-options">
                {teams.map((t) => (
                  <option key={t.id} value={t.name} />
                ))}
              </datalist>
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5 text-xs text-slate-400">
                  <span className="flex items-center gap-1.5">
                    {t.homeTeam} <Crest src={resolveTeam(homeName)?.crest} size={16} />
                  </span>
                  <input
                    list="team-options"
                    value={homeName}
                    onChange={(e) => setHomeName(e.target.value)}
                    placeholder={t.teamPlaceholder}
                    className="glass rounded-xl px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-xs text-slate-400">
                  <span className="flex items-center gap-1.5">
                    {t.awayTeam} <Crest src={resolveTeam(awayName)?.crest} size={16} />
                  </span>
                  <input
                    list="team-options"
                    value={awayName}
                    onChange={(e) => setAwayName(e.target.value)}
                    placeholder={t.teamPlaceholder}
                    className="glass rounded-xl px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  />
                </label>
              </div>
              <label className="mt-3 flex w-fit cursor-pointer items-center gap-2.5 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={config.neutral}
                  onChange={(e) => setConfig({ neutral: e.target.checked })}
                  className="size-4 accent-indigo-500"
                />
                {t.neutralVenue}
              </label>
              <button
                onClick={predictMatchup}
                disabled={predictingMatchup || !homeName || !awayName}
                className="mt-4 block rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all duration-200 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {predictingMatchup ? t.calculating : t.predictResult}
              </button>
            </>
          )}

          {matchupPred && <PredictionCard pred={matchupPred} />}
        </div>
      )}

      {/* ---- Upcoming mode ---- */}
      {config.mode === 'upcoming' && (
        <div className="mt-6">
          <button
            onClick={loadFixtures}
            disabled={!hasKey || loadingFixtures}
            className="rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all duration-200 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loadingFixtures ? t.loadMatchesLoading : t.loadMatches}
          </button>

          {fixtures.length > 0 && seasonFinished && (
            <p className="mt-5 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-xs text-slate-400">
              {t.seasonFinishedNotice}
            </p>
          )}

          {fixtures.length > 0 && (
            <ul className="mt-6 space-y-3">
              {fixtures.map((fx) => {
                const pred = predictions[fx.id]
                return (
                  <li key={fx.id} className="glass rounded-2xl p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-sm font-medium text-white">
                          <Crest src={fx.home.crest} size={18} />
                          <span className="truncate">{fx.home.name}</span>
                          <span className="text-slate-500">{t.vs}</span>
                          <Crest src={fx.away.crest} size={18} />
                          <span className="truncate">{fx.away.name}</span>
                        </p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {formatKickoff(fx.date, locale)}
                          {fx.matchday ? t.matchday(fx.matchday) : ''}
                        </p>
                      </div>
                      <button
                        onClick={() => predictFixture(fx.id)}
                        disabled={predicting[fx.id]}
                        className="shrink-0 rounded-xl border border-white/10 bg-white/5 px-3.5 py-1.5 text-xs text-slate-200 transition-all duration-200 hover:border-white/20 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {predicting[fx.id] ? t.calculating : pred ? t.recalculate : t.predict}
                      </button>
                    </div>
                    {pred && <PredictionCard pred={pred} />}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
