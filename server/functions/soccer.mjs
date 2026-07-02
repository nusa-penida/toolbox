// Soccer match + win-probability proxy for the "Soccer Predictor" utility.
//
// Backed by football-data.org (v4). Each user brings their OWN football-data.org
// API token, passed here per request via the `x-fd-token` header; we never
// persist it. (Ported from the Supabase edge function; CORS headers are added by
// ../index.mjs. Prediction logic is unchanged.)
//
// Actions (?action=):
//   fixtures — upcoming matches for a competition (param: competition)
//   teams    — teams in a competition, for the matchup pickers (param: competition)
//   predict  — win % + likely score for a scheduled match (param: match)
//   matchup  — win % + likely score for any two teams (params: home, away, neutral)

import { json } from './_shared.mjs'

const API_BASE = 'https://api.football-data.org/v4'

// --- football-data.org client -------------------------------------------

function makeClient(token) {
  return async function apiGet(path, params = {}) {
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    ).toString()
    const res = await fetch(`${API_BASE}${path}${qs ? `?${qs}` : ''}`, {
      headers: { 'X-Auth-Token': token },
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data?.message ?? `football-data.org returned ${res.status}`)
    return data
  }
}

// --- Match helpers -------------------------------------------------------

function mapMatch(m) {
  return {
    id: m.id,
    date: m.utcDate,
    status: m.status,
    competition: m.competition?.name ?? null,
    matchday: m.matchday ?? null,
    home: { id: m.homeTeam.id, name: m.homeTeam.name ?? m.homeTeam.shortName, crest: m.homeTeam.crest ?? null },
    away: { id: m.awayTeam.id, name: m.awayTeam.name ?? m.awayTeam.shortName, crest: m.awayTeam.crest ?? null },
  }
}

const ts = (m) => new Date(m?.utcDate).getTime()
const isFinished = (m) => m?.status === 'FINISHED'

// Points a team earned in one finished match (3/1/0), or null if unfinished.
function pointsFor(m, teamId) {
  if (!isFinished(m)) return null
  const isHome = m?.homeTeam?.id === teamId
  const w = m?.score?.winner
  if (w === 'DRAW') return 1
  if (w === 'HOME_TEAM') return isHome ? 3 : 0
  if (w === 'AWAY_TEAM') return isHome ? 0 : 3
  const hg = m?.score?.fullTime?.home
  const ag = m?.score?.fullTime?.away
  if (typeof hg !== 'number' || typeof ag !== 'number') return null
  const gf = isHome ? hg : ag
  const ga = isHome ? ag : hg
  return gf > ga ? 3 : gf === ga ? 1 : 0
}

// Average goals scored / conceded by a team over its finished matches.
function goalsAvg(matches, teamId) {
  let gf = 0
  let ga = 0
  let n = 0
  for (const m of matches) {
    if (!isFinished(m)) continue
    const hg = m?.score?.fullTime?.home
    const ag = m?.score?.fullTime?.away
    if (typeof hg !== 'number' || typeof ag !== 'number') continue
    const isHome = m?.homeTeam?.id === teamId
    gf += isHome ? hg : ag
    ga += isHome ? ag : hg
    n++
  }
  return n ? { gf: gf / n, ga: ga / n, n } : { gf: null, ga: null, n: 0 }
}

// --- Prediction model ----------------------------------------------------
//
// Expected goals for each side come from blending its own recent scoring rate
// with the opponent's recent conceding rate, nudged by home advantage. Feeding
// those into independent Poisson distributions over scorelines yields both the
// 1X2 win probabilities and the single most-likely exact score from one model.
// The 1X2 split is then blended with the head-to-head record.

const LEAGUE_AVG_GOALS = 1.35 // per-team fallback when a side has no recent data
const HOME_ATT_BOOST = 1.1 // home side scores ~10% more
const AWAY_ATT_DAMP = 0.92 // away side scores ~8% less
const MAX_GOALS = 8 // scoreline grid bound for the Poisson sum

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
const round1 = (x) => Math.round(x * 10) / 10
const pct = (n) => Math.round(n * 1000) / 10

function normalize(o) {
  const t = o.home + o.draw + o.away || 1
  return { home: o.home / t, draw: o.draw / t, away: o.away / t }
}

function factorial(n) {
  let r = 1
  for (let i = 2; i <= n; i++) r *= i
  return r
}
const poisson = (k, lambda) => (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k)

function h2hOutcome(meetings, homeId) {
  let h = 0
  let d = 0
  let a = 0
  for (const m of meetings) {
    const p = pointsFor(m, homeId)
    if (p === 3) h++
    else if (p === 1) d++
    else if (p === 0) a++
  }
  const count = h + d + a
  return { outcome: normalize({ home: h + 1, draw: d + 1, away: a + 1 }), count }
}

function blend(a, wa, b, wb) {
  return normalize({
    home: a.home * wa + b.home * wb,
    draw: a.draw * wa + b.draw * wb,
    away: a.away * wa + b.away * wb,
  })
}

function computePrediction(homeRecent, awayRecent, h2hMeetings, homeId, awayId, neutral) {
  const h = goalsAvg(homeRecent, homeId)
  const a = goalsAvg(awayRecent, awayId)
  const hAtt = h.gf ?? LEAGUE_AVG_GOALS
  const hDef = h.ga ?? LEAGUE_AVG_GOALS
  const aAtt = a.gf ?? LEAGUE_AVG_GOALS
  const aDef = a.ga ?? LEAGUE_AVG_GOALS

  let lambdaHome = (hAtt + aDef) / 2
  let lambdaAway = (aAtt + hDef) / 2
  if (!neutral) {
    lambdaHome *= HOME_ATT_BOOST
    lambdaAway *= AWAY_ATT_DAMP
  }
  lambdaHome = clamp(lambdaHome, 0.2, 5)
  lambdaAway = clamp(lambdaAway, 0.2, 5)

  const hP = []
  const aP = []
  for (let i = 0; i <= MAX_GOALS; i++) {
    hP[i] = poisson(i, lambdaHome)
    aP[i] = poisson(i, lambdaAway)
  }
  let pHome = 0
  let pDraw = 0
  let pAway = 0
  let best = { i: 0, j: 0, p: -1 }
  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = hP[i] * aP[j]
      if (i > j) pHome += p
      else if (i === j) pDraw += p
      else pAway += p
      if (p > best.p) best = { i, j, p }
    }
  }

  const goalsOutcome = normalize({ home: pHome, draw: pDraw, away: pAway })
  const { outcome: h2hOut, count: h2hCount } = h2hOutcome(h2hMeetings, homeId)
  const final = h2hCount > 0 ? blend(goalsOutcome, 0.7, h2hOut, 0.3) : goalsOutcome

  return {
    probabilities: { home: pct(final.home), draw: pct(final.draw), away: pct(final.away) },
    likelyScore: { home: best.i, away: best.j },
    expectedGoals: { home: round1(lambdaHome), away: round1(lambdaAway) },
    basis: {
      homeGoalsFor: h.gf === null ? null : round1(h.gf),
      homeGoalsAgainst: h.ga === null ? null : round1(h.ga),
      awayGoalsFor: a.gf === null ? null : round1(a.gf),
      awayGoalsAgainst: a.ga === null ? null : round1(a.ga),
      homeMatches: h.n,
      awayMatches: a.n,
      h2hMeetings: h2hCount,
      neutral,
    },
  }
}

const LAST_N = 10 // recent matches per team used for form/goals

function recentBefore(matches, cutoffTs) {
  return matches
    .filter((m) => isFinished(m) && ts(m) < cutoffTs)
    .sort((a, b) => ts(b) - ts(a))
    .slice(0, LAST_N)
}

// --- Handlers ------------------------------------------------------------

async function handleFixtures(apiGet, p) {
  const competition = p.get('competition')
  if (!competition) throw new Error('Missing competition')

  const scheduled = await apiGet(`/competitions/${competition}/matches`, { status: 'SCHEDULED' })
  const upcoming = scheduled.matches ?? []
  if (upcoming.length) {
    const sorted = [...upcoming].sort((a, b) => ts(a) - ts(b))
    return { seasonFinished: false, fixtures: sorted.slice(0, 20).map(mapMatch) }
  }
  // Between seasons: show recent results so matches are still browsable.
  const finished = await apiGet(`/competitions/${competition}/matches`, { status: 'FINISHED' })
  const recent = (finished.matches ?? []).sort((a, b) => ts(b) - ts(a)).slice(0, 20)
  return { seasonFinished: true, fixtures: recent.map(mapMatch) }
}

async function handleTeams(apiGet, p) {
  const competition = p.get('competition')
  if (!competition) throw new Error('Missing competition')
  const data = await apiGet(`/competitions/${competition}/teams`)
  return (data.teams ?? [])
    .map((t) => ({
      id: t.id,
      name: t.name,
      shortName: t.shortName ?? t.name,
      tla: t.tla ?? null,
      crest: t.crest ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function handlePredict(apiGet, p) {
  const matchId = p.get('match')
  if (!matchId) throw new Error('Missing match')

  const match = await apiGet(`/matches/${matchId}`)
  const m = match?.match ?? match // v4 wraps a single match under `.match`
  const homeId = m.homeTeam.id
  const awayId = m.awayTeam.id
  const kickoff = ts(m)

  const [homeData, awayData, h2h] = await Promise.all([
    apiGet(`/teams/${homeId}/matches`, { status: 'FINISHED' }),
    apiGet(`/teams/${awayId}/matches`, { status: 'FINISHED' }),
    apiGet(`/matches/${matchId}/head2head`, { limit: 10 }),
  ])

  const homeRecent = recentBefore(homeData.matches ?? [], kickoff)
  const awayRecent = recentBefore(awayData.matches ?? [], kickoff)
  const h2hMeetings = (h2h.matches ?? []).filter((x) => isFinished(x) && ts(x) < kickoff)

  const prediction = computePrediction(homeRecent, awayRecent, h2hMeetings, homeId, awayId, false)
  return {
    fixture: {
      id: m.id,
      date: m.utcDate,
      home: { id: homeId, name: m.homeTeam.name, crest: m.homeTeam.crest ?? null },
      away: { id: awayId, name: m.awayTeam.name, crest: m.awayTeam.crest ?? null },
    },
    ...prediction,
  }
}

function teamName(matches, teamId) {
  for (const m of matches) {
    if (m?.homeTeam?.id === teamId) return m.homeTeam.name
    if (m?.awayTeam?.id === teamId) return m.awayTeam.name
  }
  return `Team ${teamId}`
}

const involves = (m, teamId) => m?.homeTeam?.id === teamId || m?.awayTeam?.id === teamId

async function handleMatchup(apiGet, p) {
  const homeId = Number(p.get('home'))
  const awayId = Number(p.get('away'))
  const competition = p.get('competition')
  const neutral = p.get('neutral') === '1'
  if (!homeId || !awayId) throw new Error('Missing home or away team')
  if (homeId === awayId) throw new Error('Pick two different teams')

  // Gather each side's finished matches. `/teams/{id}/matches` defaults to a
  // recent window and returns nothing for national teams outside their
  // tournament, so for a tournament (e.g. the World Cup) we pull the whole
  // competition instead, which holds whatever finished matches the free tier
  // exposes for those teams.
  let homeMatches
  let awayMatches
  if (competition) {
    const comp = await apiGet(`/competitions/${competition}/matches`)
    const all = (comp.matches ?? []).filter(isFinished)
    homeMatches = all.filter((m) => involves(m, homeId))
    awayMatches = all.filter((m) => involves(m, awayId))
  } else {
    const [homeData, awayData] = await Promise.all([
      apiGet(`/teams/${homeId}/matches`, { status: 'FINISHED' }),
      apiGet(`/teams/${awayId}/matches`, { status: 'FINISHED' }),
    ])
    homeMatches = homeData.matches ?? []
    awayMatches = awayData.matches ?? []
  }

  const now = Date.now()
  const homeRecent = recentBefore(homeMatches, now)
  const awayRecent = recentBefore(awayMatches, now)
  const h2hMeetings = homeMatches.filter((m) => isFinished(m) && involves(m, awayId))

  const prediction = computePrediction(homeRecent, awayRecent, h2hMeetings, homeId, awayId, neutral)
  return {
    fixture: {
      home: { id: homeId, name: teamName(homeMatches, homeId) },
      away: { id: awayId, name: teamName(awayMatches, awayId) },
      neutral,
    },
    ...prediction,
  }
}

// --- Entry ---------------------------------------------------------------

export async function handle({ url, header }) {
  const token = header('x-fd-token')
  if (!token) return json({ error: 'Missing football-data.org API token.' }, 400)

  const action = url.searchParams.get('action')
  const apiGet = makeClient(token)

  try {
    if (action === 'fixtures') return json({ data: await handleFixtures(apiGet, url.searchParams) })
    if (action === 'teams') return json({ data: await handleTeams(apiGet, url.searchParams) })
    if (action === 'predict') return json({ data: await handlePredict(apiGet, url.searchParams) })
    if (action === 'matchup') return json({ data: await handleMatchup(apiGet, url.searchParams) })
    return json({ error: `Unknown action: ${action}` }, 400)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Request failed' }, 502)
  }
}
