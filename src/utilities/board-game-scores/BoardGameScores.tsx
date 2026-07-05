import { useState } from 'react'
import { Crown, Plus, Trash2, X } from 'lucide-react'
import { SaveStatus } from '../../components/SaveStatus'
import { useUtilityConfig } from '../../hooks/useUtilityConfig'
import { useT } from '../../i18n/LanguageContext'

/**
 * Board game score counter. Keeps a scoreboard per game: add players, add a
 * round per hand/turn, and type each player's score for that round — running
 * totals update live and the leader gets a crown. Toggle "lowest wins" for
 * golf-style games. Every game you start is kept in your account config, so
 * you can flip between an ongoing Catan campaign and last night's Uno tally.
 *
 * Gated behind sign-in (availableWithoutAccount: false) — that's the "password".
 */

const STR = {
  en: {
    loading: 'Loading your games…',
    title: 'Board Game Scores',
    intro:
      'Keep score for any board game. Add your players, add a round for each turn, and totals update as you type — the leader gets a crown.',
    newGame: 'New game',
    noGames: 'No games yet.',
    noGamesHint: 'Start your first scoreboard to begin counting.',
    startGame: 'Start a game',
    gameNamePlaceholder: 'Game name',
    defaultGameName: 'New game',
    lowestWins: 'Lowest wins',
    lowestWinsHint: 'Lowest total wins (golf-style)',
    deleteGame: 'Delete this game',
    deleteGameConfirm: 'Delete this game and its scores?',
    player: 'Player',
    playerPlaceholder: 'Player name',
    addPlayer: 'Add player',
    removePlayer: 'Remove player',
    round: 'Round',
    roundShort: (n: number) => `R${n}`,
    addRound: 'Add round',
    removeRound: 'Remove this round',
    total: 'Total',
    reset: 'Reset scores',
    resetConfirm: 'Clear all scores in this game? Players stay.',
    noPlayers: 'Add a player to start scoring.',
    noRounds: 'Add a round to start entering scores.',
    leads: (name: string) => `${name} leads`,
    tied: 'Tied',
    savedGames: 'Games',
  },
  nl: {
    loading: 'Je spellen laden…',
    title: 'Bordspel Scores',
    intro:
      'Houd de score bij voor elk bordspel. Voeg spelers toe, voeg een ronde toe per beurt, en de totalen updaten terwijl je typt — de leider krijgt een kroon.',
    newGame: 'Nieuw spel',
    noGames: 'Nog geen spellen.',
    noGamesHint: 'Start je eerste scorebord om te beginnen tellen.',
    startGame: 'Start een spel',
    gameNamePlaceholder: 'Naam van het spel',
    defaultGameName: 'Nieuw spel',
    lowestWins: 'Laagste wint',
    lowestWinsHint: 'Laagste totaal wint (golf-stijl)',
    deleteGame: 'Verwijder dit spel',
    deleteGameConfirm: 'Dit spel en de scores verwijderen?',
    player: 'Speler',
    playerPlaceholder: 'Naam speler',
    addPlayer: 'Speler toevoegen',
    removePlayer: 'Speler verwijderen',
    round: 'Ronde',
    roundShort: (n: number) => `R${n}`,
    addRound: 'Ronde toevoegen',
    removeRound: 'Deze ronde verwijderen',
    total: 'Totaal',
    reset: 'Scores wissen',
    resetConfirm: 'Alle scores in dit spel wissen? Spelers blijven.',
    noPlayers: 'Voeg een speler toe om te beginnen scoren.',
    noRounds: 'Voeg een ronde toe om scores in te vullen.',
    leads: (name: string) => `${name} leidt`,
    tied: 'Gelijk',
    savedGames: 'Spellen',
  },
}

interface Player {
  id: string
  name: string
}

interface Game {
  id: string
  name: string
  players: Player[]
  /** One entry per round: playerId → score for that round. */
  rounds: Record<string, number>[]
  /** When true the lowest total wins (golf, Hearts, …). */
  lowestWins: boolean
}

interface ScoresConfig extends Record<string, unknown> {
  games: Game[]
  activeId: string | null
}

const DEFAULTS: ScoresConfig = { games: [], activeId: null }

const uid = () => Math.random().toString(36).slice(2, 9)

function totalFor(game: Game, playerId: string): number {
  return game.rounds.reduce((sum, r) => sum + (r[playerId] ?? 0), 0)
}

export function BoardGameScores() {
  const { config, setConfig, loading, saving } = useUtilityConfig<ScoresConfig>(
    'board-game-scores',
    DEFAULTS
  )
  const t = useT(STR)

  const active = config.games.find((g) => g.id === config.activeId) ?? config.games[0] ?? null

  // ---- Mutations ----
  function updateGame(id: string, mutate: (g: Game) => Game) {
    setConfig((prev) => ({
      ...prev,
      games: prev.games.map((g) => (g.id === id ? mutate(g) : g)),
    }))
  }

  function addGame() {
    const game: Game = { id: uid(), name: '', players: [], rounds: [], lowestWins: false }
    setConfig((prev) => ({ ...prev, games: [...prev.games, game], activeId: game.id }))
  }

  function deleteGame(id: string) {
    if (!confirm(t.deleteGameConfirm)) return
    setConfig((prev) => {
      const games = prev.games.filter((g) => g.id !== id)
      const activeId = prev.activeId === id ? (games[0]?.id ?? null) : prev.activeId
      return { ...prev, games, activeId }
    })
  }

  function addPlayer(g: Game) {
    updateGame(g.id, (game) => ({
      ...game,
      players: [...game.players, { id: uid(), name: '' }],
    }))
  }

  function removePlayer(g: Game, playerId: string) {
    updateGame(g.id, (game) => ({
      ...game,
      players: game.players.filter((p) => p.id !== playerId),
      // Drop that player's scores from every round so totals stay clean.
      rounds: game.rounds.map((r) => {
        const { [playerId]: _drop, ...rest } = r
        return rest
      }),
    }))
  }

  function renamePlayer(g: Game, playerId: string, name: string) {
    updateGame(g.id, (game) => ({
      ...game,
      players: game.players.map((p) => (p.id === playerId ? { ...p, name } : p)),
    }))
  }

  function addRound(g: Game) {
    updateGame(g.id, (game) => ({ ...game, rounds: [...game.rounds, {}] }))
  }

  function removeRound(g: Game, index: number) {
    updateGame(g.id, (game) => ({
      ...game,
      rounds: game.rounds.filter((_, i) => i !== index),
    }))
  }

  function setScore(g: Game, roundIndex: number, playerId: string, value: number | null) {
    updateGame(g.id, (game) => ({
      ...game,
      rounds: game.rounds.map((r, i) => {
        if (i !== roundIndex) return r
        if (value === null) {
          const { [playerId]: _drop, ...rest } = r
          return rest
        }
        return { ...r, [playerId]: value }
      }),
    }))
  }

  function resetScores(g: Game) {
    if (!confirm(t.resetConfirm)) return
    updateGame(g.id, (game) => ({ ...game, rounds: [] }))
  }

  if (loading) {
    return <p className="animate-pulse text-slate-400">{t.loading}</p>
  }

  return (
    <div className="animate-fade-up">
      <div className="flex items-baseline justify-between">
        <h1 className="text-3xl font-bold tracking-tight">{t.title}</h1>
        <SaveStatus saving={saving} />
      </div>
      <p className="mt-2 text-slate-400">{t.intro}</p>

      {/* ---- Game tabs ---- */}
      <div className="mt-8 flex flex-wrap items-center gap-2">
        {config.games.map((g) => {
          const isActive = active?.id === g.id
          return (
            <button
              key={g.id}
              onClick={() => setConfig({ activeId: g.id })}
              className={`rounded-xl px-3.5 py-1.5 text-sm font-medium transition-all duration-200 ${
                isActive
                  ? 'bg-gradient-to-r from-indigo-500 to-violet-500 text-white shadow-lg shadow-indigo-500/25'
                  : 'border border-white/10 bg-white/5 text-slate-300 hover:border-white/20 hover:bg-white/10'
              }`}
            >
              {g.name.trim() || t.defaultGameName}
            </button>
          )
        })}
        <button
          onClick={addGame}
          className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3.5 py-1.5 text-sm text-slate-300 hover:border-white/20 hover:bg-white/10"
        >
          <Plus className="size-4" />
          {t.newGame}
        </button>
      </div>

      {/* ---- Empty state ---- */}
      {!active && (
        <div className="glass mt-6 rounded-2xl p-10 text-center">
          <p className="text-lg font-semibold text-white">{t.noGames}</p>
          <p className="mt-1 text-sm text-slate-400">{t.noGamesHint}</p>
          <button
            onClick={addGame}
            className="mt-5 inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-indigo-500/25 transition-transform hover:scale-[1.02]"
          >
            <Plus className="size-4" />
            {t.startGame}
          </button>
        </div>
      )}

      {active && <Scoreboard key={active.id} game={active} t={t} handlers={{
        renameGame: (name) => updateGame(active.id, (g) => ({ ...g, name })),
        toggleLowest: () => updateGame(active.id, (g) => ({ ...g, lowestWins: !g.lowestWins })),
        deleteGame: () => deleteGame(active.id),
        addPlayer: () => addPlayer(active),
        removePlayer: (pid) => removePlayer(active, pid),
        renamePlayer: (pid, name) => renamePlayer(active, pid, name),
        addRound: () => addRound(active),
        removeRound: (i) => removeRound(active, i),
        setScore: (ri, pid, v) => setScore(active, ri, pid, v),
        resetScores: () => resetScores(active),
      }} />}
    </div>
  )
}

interface Handlers {
  renameGame: (name: string) => void
  toggleLowest: () => void
  deleteGame: () => void
  addPlayer: () => void
  removePlayer: (playerId: string) => void
  renamePlayer: (playerId: string, name: string) => void
  addRound: () => void
  removeRound: (index: number) => void
  setScore: (roundIndex: number, playerId: string, value: number | null) => void
  resetScores: () => void
}

function Scoreboard({
  game,
  t,
  handlers,
}: {
  game: Game
  t: (typeof STR)['en']
  handlers: Handlers
}) {
  const totals = new Map(game.players.map((p) => [p.id, totalFor(game, p.id)]))

  // Leader(s): only once at least one score has been entered and there's a
  // meaningful gap (not everyone on zero). Ties share the crown.
  const anyScore = game.rounds.some((r) => Object.keys(r).length > 0)
  const values = game.players.map((p) => totals.get(p.id) ?? 0)
  const best = game.players.length
    ? game.lowestWins
      ? Math.min(...values)
      : Math.max(...values)
    : 0
  const allEqual = values.every((v) => v === values[0])
  const leaders = new Set(
    anyScore && game.players.length > 1 && !allEqual
      ? game.players.filter((p) => (totals.get(p.id) ?? 0) === best).map((p) => p.id)
      : []
  )

  const leaderNames = game.players
    .filter((p) => leaders.has(p.id))
    .map((p) => p.name.trim() || t.player)

  return (
    <div className="glass mt-6 rounded-2xl p-4 sm:p-5">
      {/* ---- Game header ---- */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          value={game.name}
          onChange={(e) => handlers.renameGame(e.target.value)}
          placeholder={t.gameNamePlaceholder}
          className="min-w-0 flex-1 bg-transparent text-xl font-bold text-white placeholder-slate-600 focus:outline-none"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={handlers.toggleLowest}
            title={t.lowestWinsHint}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-200 ${
              game.lowestWins
                ? 'bg-gradient-to-r from-indigo-500 to-violet-500 text-white shadow-lg shadow-indigo-500/25'
                : 'border border-white/10 bg-white/5 text-slate-400 hover:border-white/20 hover:bg-white/10'
            }`}
          >
            {t.lowestWins}
          </button>
          <button
            onClick={handlers.deleteGame}
            title={t.deleteGame}
            aria-label={t.deleteGame}
            className="rounded-lg border border-white/10 bg-white/5 p-2 text-slate-400 transition-colors hover:border-rose-400/40 hover:bg-rose-500/10 hover:text-rose-300"
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      </div>

      {leaderNames.length > 0 && (
        <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-amber-300">
          <Crown className="size-4" />
          {leaderNames.length === 1 ? t.leads(leaderNames[0]) : `${t.tied}: ${leaderNames.join(', ')}`}
        </p>
      )}

      {game.players.length === 0 ? (
        <p className="mt-5 text-sm text-slate-400">{t.noPlayers}</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="sticky left-0 z-10 bg-transparent py-2 pr-3 font-semibold">
                  {t.player}
                </th>
                {game.rounds.map((_, i) => (
                  <th key={i} className="px-2 py-2 text-center font-semibold">
                    <span className="group inline-flex items-center gap-1">
                      {t.roundShort(i + 1)}
                      <button
                        onClick={() => handlers.removeRound(i)}
                        title={t.removeRound}
                        aria-label={t.removeRound}
                        className="text-slate-600 opacity-0 transition-opacity hover:text-rose-300 group-hover:opacity-100"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  </th>
                ))}
                <th className="px-2 py-2 text-right font-semibold text-slate-400">{t.total}</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {game.players.map((p) => {
                const isLeader = leaders.has(p.id)
                return (
                  <tr key={p.id} className="border-t border-white/5">
                    <td className="sticky left-0 z-10 py-1.5 pr-3">
                      <div className="flex items-center gap-1.5">
                        {isLeader && <Crown className="size-3.5 shrink-0 text-amber-300" />}
                        <input
                          value={p.name}
                          onChange={(e) => handlers.renamePlayer(p.id, e.target.value)}
                          placeholder={t.playerPlaceholder}
                          className="w-28 min-w-24 rounded-lg bg-white/5 px-2.5 py-1.5 text-white placeholder-slate-600 focus:bg-white/10 focus:outline-none focus:ring-1 focus:ring-indigo-400/40"
                        />
                      </div>
                    </td>
                    {game.rounds.map((r, i) => (
                      <td key={i} className="px-1 py-1.5 text-center">
                        <ScoreInput
                          value={r[p.id]}
                          onChange={(v) => handlers.setScore(i, p.id, v)}
                        />
                      </td>
                    ))}
                    <td
                      className={`px-2 py-1.5 text-right text-base font-bold tabular-nums ${
                        isLeader ? 'text-amber-300' : 'text-white'
                      }`}
                    >
                      {totals.get(p.id) ?? 0}
                    </td>
                    <td className="pl-1 text-right">
                      <button
                        onClick={() => handlers.removePlayer(p.id)}
                        title={t.removePlayer}
                        aria-label={t.removePlayer}
                        className="text-slate-600 transition-colors hover:text-rose-300"
                      >
                        <X className="size-4" />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {game.rounds.length === 0 && (
            <p className="mt-3 text-sm text-slate-400">{t.noRounds}</p>
          )}
        </div>
      )}

      {/* ---- Actions ---- */}
      <div className="mt-5 flex flex-wrap gap-2">
        <button
          onClick={handlers.addPlayer}
          className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3.5 py-1.5 text-sm text-slate-300 hover:border-white/20 hover:bg-white/10"
        >
          <Plus className="size-4" />
          {t.addPlayer}
        </button>
        <button
          onClick={handlers.addRound}
          disabled={game.players.length === 0}
          className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-3.5 py-1.5 text-sm font-medium text-white shadow-lg shadow-indigo-500/25 transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
        >
          <Plus className="size-4" />
          {t.addRound}
        </button>
        {game.rounds.length > 0 && (
          <button
            onClick={handlers.resetScores}
            className="ml-auto rounded-xl border border-white/10 bg-white/5 px-3.5 py-1.5 text-sm text-slate-400 hover:border-rose-400/40 hover:bg-rose-500/10 hover:text-rose-300"
          >
            {t.reset}
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * A single round/player score cell. Board game scores can be negative and are
 * often left blank mid-game, so this is a text field that keeps raw keystrokes
 * while focused (allowing a lone "-" or "") and commits an integer, or null
 * when cleared so the cell doesn't count toward the total.
 */
function ScoreInput({
  value,
  onChange,
}: {
  value: number | undefined
  onChange: (value: number | null) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const display = draft ?? (value === undefined ? '' : String(value))
  return (
    <input
      type="text"
      inputMode="numeric"
      value={display}
      onChange={(e) => {
        const raw = e.target.value
        if (raw !== '' && !/^-?\d*$/.test(raw)) return
        setDraft(raw)
        if (raw === '' || raw === '-') {
          onChange(null)
          return
        }
        onChange(parseInt(raw, 10))
      }}
      onBlur={() => setDraft(null)}
      className="w-12 rounded-lg bg-white/5 px-1.5 py-1.5 text-center tabular-nums text-white placeholder-slate-600 focus:bg-white/10 focus:outline-none focus:ring-1 focus:ring-indigo-400/40"
    />
  )
}
