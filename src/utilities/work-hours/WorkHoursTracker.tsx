import { useEffect, useState, type ReactNode } from 'react'
import { SaveStatus } from '../../components/SaveStatus'
import { useUtilityConfig } from '../../hooks/useUtilityConfig'

/**
 * Work Hours tracker. Answers one question per month: "how many hours do I
 * still need to work?"
 *
 *   required = (scheduled work days − days off) × hours per day
 *   worked   = sum of the hours you logged for each week
 *   left     = required − worked   (negative ⇒ overtime)
 *
 * Settings (hours/day, which weekdays count as work days) and every month you
 * ever fill in are stored in your account config, so past months stay around
 * and the settings carry over. Gated behind sign-in — that's the "password".
 */

// JS getDay(): 0=Sun … 6=Sat. We display the week Monday-first.
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
const WEEKDAY_LABELS: Record<number, string> = {
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
  0: 'Sun',
}

interface MonthData {
  /** ISO dates ("YYYY-MM-DD") that are normally work days but were taken off. */
  offDays: string[]
  /** Hours worked, keyed by the ISO date of that week's Monday. */
  weekHours: Record<string, number>
}

interface WorkConfig extends Record<string, unknown> {
  hoursPerDay: number
  /** getDay() values that count as work days. Default Mon–Fri. */
  workdays: number[]
  /** ISO 3166 country code for public holidays ("" = none). Default Belgium. */
  country: string
  months: Record<string, MonthData>
}

const DEFAULTS: WorkConfig = {
  hoursPerDay: 8,
  workdays: [1, 2, 3, 4, 5],
  country: 'BE',
  months: {},
}

const NAGER_BASE = 'https://date.nager.at/api/v3'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function monthKey(year: number, month: number): string {
  return `${year}-${pad(month + 1)}`
}
function mondayOf(d: Date): Date {
  const out = new Date(d)
  const offset = (out.getDay() + 6) % 7 // days since Monday
  out.setDate(out.getDate() - offset)
  out.setHours(0, 0, 0, 0)
  return out
}
function addDays(d: Date, n: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + n)
  return out
}

interface WeekRow {
  mondayKey: string
  days: Date[] // 7 dates, Mon … Sun
}

/** The weeks (Monday-first) that overlap the given month. */
function weeksOfMonth(year: number, month: number): WeekRow[] {
  const first = new Date(year, month, 1)
  const last = new Date(year, month + 1, 0)
  const rows: WeekRow[] = []
  let cursor = mondayOf(first)
  while (cursor <= last) {
    const days = Array.from({ length: 7 }, (_, i) => addDays(cursor, i))
    rows.push({ mondayKey: ymd(cursor), days })
    cursor = addDays(cursor, 7)
  }
  return rows
}

const fmtHours = (n: number) =>
  Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '')

/**
 * Parse an hours value the user typed. Accepts plain decimals ("7.6", "7,6")
 * and Belgian/Dutch hours-minutes notation ("45h10", "45u10" = 45 h 10 min).
 * Returns decimal hours, or null if it isn't a parseable (in-progress) value.
 */
function parseHours(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(',', '.')
  if (s === '') return 0
  const hm = s.match(/^(\d*)[hu](\d*)$/) // "45h10", "45u", "u10"
  if (hm) {
    const h = hm[1] ? parseInt(hm[1], 10) : 0
    const m = hm[2] ? parseInt(hm[2], 10) : 0
    return h + m / 60
  }
  const n = Number(s)
  return Number.isNaN(n) ? null : n
}

export function WorkHoursTracker() {
  const { config, setConfig, loading, saving } = useUtilityConfig<WorkConfig>(
    'work-hours',
    DEFAULTS
  )

  const today = new Date()
  const [year, setYear] = useState(today.getFullYear())
  const [month, setMonth] = useState(today.getMonth()) // 0-indexed

  const key = monthKey(year, month)
  const monthData: MonthData = config.months[key] ?? { offDays: [], weekHours: {} }
  const offSet = new Set(monthData.offDays)

  const weeks = weeksOfMonth(year, month)

  // ---- Public holidays (Nager.Date — free, no key) ----
  const [countries, setCountries] = useState<{ code: string; name: string }[]>([])
  // ISO date → holiday name, for the displayed country + year.
  const [holidays, setHolidays] = useState<Record<string, string>>({})
  const [holidayError, setHolidayError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`${NAGER_BASE}/AvailableCountries`)
      .then((r) => r.json())
      .then((data: { countryCode: string; name: string }[]) => {
        if (cancelled) return
        setCountries(
          data
            .map((c) => ({ code: c.countryCode, name: c.name }))
            .sort((a, b) => a.name.localeCompare(b.name))
        )
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const country = config.country
    const load = async (): Promise<Record<string, string>> => {
      if (!country) return {}
      const r = await fetch(`${NAGER_BASE}/PublicHolidays/${year}/${country}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data: { date: string; localName: string; name: string; types: string[] }[] =
        await r.json()
      const map: Record<string, string> = {}
      // Only true public holidays count as days off — skip Bank/Optional/School
      // entries (e.g. Good Friday in Belgium is a bank holiday, not official).
      for (const h of data) {
        if (h.types?.includes('Public')) map[h.date] = h.localName || h.name
      }
      return map
    }
    load()
      .then((map) => {
        if (cancelled) return
        setHolidays(map)
        setHolidayError(null)
      })
      .catch(() => {
        if (cancelled) return
        setHolidays({})
        setHolidayError('Could not load public holidays.')
      })
    return () => {
      cancelled = true
    }
  }, [config.country, year])

  const isHoliday = (d: Date) => Boolean(holidays[ymd(d)])

  function updateMonth(mutate: (m: MonthData) => MonthData) {
    setConfig((prev) => {
      const current = prev.months[key] ?? { offDays: [], weekHours: {} }
      return { ...prev, months: { ...prev.months, [key]: mutate(current) } }
    })
  }

  function toggleOff(date: Date) {
    const d = ymd(date)
    updateMonth((m) => {
      const has = m.offDays.includes(d)
      return {
        ...m,
        offDays: has ? m.offDays.filter((x) => x !== d) : [...m.offDays, d],
      }
    })
  }

  function setWeekHours(mondayKey: string, value: number) {
    updateMonth((m) => ({ ...m, weekHours: { ...m.weekHours, [mondayKey]: value } }))
  }

  // ---- Totals for the selected month ----
  const stats = (() => {
    const inMonth = (d: Date) => d.getMonth() === month && d.getFullYear() === year
    const isWorkday = (d: Date) => config.workdays.includes(d.getDay())

    let scheduled = 0
    let off = 0
    let hol = 0
    for (const w of weeks) {
      for (const d of w.days) {
        if (!inMonth(d) || !isWorkday(d)) continue
        scheduled++
        if (offSet.has(ymd(d))) off++
        else if (isHoliday(d)) hol++
      }
    }
    const effectiveDays = scheduled - off - hol
    const required = effectiveDays * config.hoursPerDay
    const worked = weeks.reduce((sum, w) => sum + (monthData.weekHours[w.mondayKey] ?? 0), 0)
    const left = required - worked
    const pct = required > 0 ? Math.min(100, (worked / required) * 100) : worked > 0 ? 100 : 0
    return { scheduled, off, hol, effectiveDays, required, worked, left, pct }
  })()

  // Per-week figures with a running balance: each week's "still needed" carries
  // any surplus/deficit forward from the previous weeks (cumulative required −
  // cumulative worked up to and including that week).
  const weekStats = (() => {
    const rows: (WeekRow & { required: number; worked: number; stillNeeded: number })[] = []
    let cumRequired = 0
    let cumWorked = 0
    for (const w of weeks) {
      let required = 0
      for (const d of w.days) {
        const inMonth = d.getMonth() === month && d.getFullYear() === year
        if (!inMonth || !config.workdays.includes(d.getDay())) continue
        if (offSet.has(ymd(d)) || isHoliday(d)) continue
        required += config.hoursPerDay
      }
      const worked = monthData.weekHours[w.mondayKey] ?? 0
      cumRequired += required
      cumWorked += worked
      rows.push({ ...w, required, worked, stillNeeded: cumRequired - cumWorked })
    }
    return rows
  })()

  const monthLabel = new Date(year, month, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  })

  function shiftMonth(delta: number) {
    const d = new Date(year, month + delta, 1)
    setYear(d.getFullYear())
    setMonth(d.getMonth())
  }
  function toThisMonth() {
    setYear(today.getFullYear())
    setMonth(today.getMonth())
  }

  function toggleWorkday(wd: number) {
    setConfig((prev) => {
      const has = prev.workdays.includes(wd)
      const next = has ? prev.workdays.filter((x) => x !== wd) : [...prev.workdays, wd]
      return { ...prev, workdays: next }
    })
  }

  if (loading) {
    return <p className="animate-pulse text-slate-400">Loading your settings…</p>
  }

  const savedMonths = Object.keys(config.months)
    .filter((k) => k !== key)
    .sort()
    .reverse()

  return (
    <div className="animate-fade-up">
      <div className="flex items-baseline justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Work Hours</h1>
        <SaveStatus saving={saving} />
      </div>
      <p className="mt-2 text-slate-400">
        Log the hours you worked each week and mark the days you took off — see exactly how many
        hours you still owe for the month.
      </p>

      {/* ---- Settings (kept across months) ---- */}
      <div className="glass mt-8 rounded-2xl p-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">
          Settings
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-6">
          <label className="flex flex-col gap-1.5 text-xs text-slate-400">
            Hours per day
            <HoursInput
              value={config.hoursPerDay}
              max={24}
              onChange={(n) => setConfig({ hoursPerDay: n })}
              className="glass w-28 rounded-xl px-3.5 py-2 text-sm text-white focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
          </label>
          <div className="flex flex-col gap-1.5 text-xs text-slate-400">
            Work days
            <div className="flex gap-1.5">
              {WEEKDAY_ORDER.map((wd) => {
                const on = config.workdays.includes(wd)
                return (
                  <button
                    key={wd}
                    onClick={() => toggleWorkday(wd)}
                    className={`rounded-lg px-2.5 py-2 text-xs font-medium transition-all duration-200 ${
                      on
                        ? 'bg-gradient-to-r from-indigo-500 to-violet-500 text-white shadow-lg shadow-indigo-500/25'
                        : 'border border-white/10 bg-white/5 text-slate-400 hover:border-white/20 hover:bg-white/10'
                    }`}
                  >
                    {WEEKDAY_LABELS[wd]}
                  </button>
                )
              })}
            </div>
          </div>
          <label className="flex flex-col gap-1.5 text-xs text-slate-400">
            Public holidays
            <select
              value={config.country}
              onChange={(e) => setConfig({ country: e.target.value })}
              className="glass rounded-xl px-3 py-2 text-sm text-white focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            >
              <option value="" className="bg-slate-900">
                None
              </option>
              {(countries.length
                ? countries
                : [{ code: config.country || 'BE', name: config.country || 'BE' }]
              ).map((c) => (
                <option key={c.code} value={c.code} className="bg-slate-900">
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {holidayError && <p className="mt-2 text-xs text-amber-300">{holidayError}</p>}
      </div>

      {/* ---- Month navigation ---- */}
      <div className="mt-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={() => shiftMonth(-1)}
            className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-slate-300 hover:border-white/20 hover:bg-white/10"
            aria-label="Previous month"
          >
            ←
          </button>
          <span className="min-w-44 text-center text-lg font-semibold text-white">{monthLabel}</span>
          <button
            onClick={() => shiftMonth(1)}
            className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-slate-300 hover:border-white/20 hover:bg-white/10"
            aria-label="Next month"
          >
            →
          </button>
        </div>
        <button
          onClick={toThisMonth}
          className="rounded-xl border border-white/10 bg-white/5 px-3.5 py-1.5 text-xs text-slate-300 hover:border-white/20 hover:bg-white/10"
        >
          This month
        </button>
      </div>

      {/* ---- Summary ---- */}
      <div className="glass mt-4 rounded-2xl p-5">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Required" value={`${fmtHours(stats.required)} h`} />
          <Stat label="Worked" value={`${fmtHours(stats.worked)} h`} />
          <Stat
            label={stats.left >= 0 ? 'Still to work' : 'Overtime'}
            value={`${fmtHours(Math.abs(stats.left))} h`}
            accent={stats.left >= 0 ? 'indigo' : 'emerald'}
          />
          <Stat
            label={
              <>
                Work days
                {(stats.off || stats.hol) && (
                  <span className="ml-1 normal-case tracking-normal text-slate-600">
                    (
                    {[
                      stats.off && `−${stats.off} off`,
                      stats.hol && `−${stats.hol} holiday${stats.hol === 1 ? '' : 's'}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    )
                  </span>
                )}
              </>
            }
            value={String(stats.effectiveDays)}
          />
        </div>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10">
          <span
            className="block h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all duration-300"
            style={{ width: `${stats.pct}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-slate-500">
          {stats.left > 0
            ? `${fmtHours(stats.left)} hour${stats.left === 1 ? '' : 's'} left this month.`
            : stats.left === 0
              ? 'Right on target for this month. 🎉'
              : `You're ${fmtHours(-stats.left)} hour${stats.left === -1 ? '' : 's'} over. 🎉`}
        </p>
      </div>

      {/* ---- Weeks ---- */}
      <div className="mt-6 space-y-3">
        {weekStats.map((w) => {
          const range = `${w.days[0].toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${w.days[6].toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
          const ahead = w.stillNeeded < 0
          const onTarget = Math.abs(w.stillNeeded) < 0.005
          return (
            <div key={w.mondayKey} className="glass rounded-2xl p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="text-xs font-medium text-slate-400">{range}</span>
                  <p
                    className={`mt-0.5 text-sm font-semibold ${
                      onTarget ? 'text-emerald-300' : ahead ? 'text-emerald-300' : 'text-indigo-300'
                    }`}
                  >
                    {onTarget
                      ? 'On track ✓'
                      : ahead
                        ? `${fmtHours(-w.stillNeeded)} h ahead`
                        : `${fmtHours(w.stillNeeded)} h still to work`}
                    <span className="ml-1.5 font-normal text-slate-500">
                      · {fmtHours(w.required)} h target
                    </span>
                  </p>
                </div>
                <label className="flex items-center gap-2 text-xs text-slate-400">
                  Worked
                  <HoursInput
                    value={monthData.weekHours[w.mondayKey] ?? 0}
                    onChange={(n) => setWeekHours(w.mondayKey, n)}
                    placeholder="0"
                    className="glass w-24 rounded-xl px-3 py-1.5 text-right text-sm text-white placeholder-slate-600 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  />
                  <span className="text-slate-500">h</span>
                </label>
              </div>
              <div className="mt-3 grid grid-cols-7 gap-1.5">
                {w.days.map((d) => {
                  const inMonth = d.getMonth() === month && d.getFullYear() === year
                  const workday = config.workdays.includes(d.getDay())
                  const isOff = offSet.has(ymd(d))
                  const holidayName = holidays[ymd(d)]
                  const isHol = workday && Boolean(holidayName) && !isOff
                  const isToday = ymd(d) === ymd(today)
                  const interactive = inMonth && workday && !isHol
                  return (
                    <button
                      key={ymd(d)}
                      disabled={!interactive}
                      onClick={() => interactive && toggleOff(d)}
                      title={
                        isHol
                          ? `${holidayName} — public holiday`
                          : interactive
                            ? isOff
                              ? 'Day off — click to mark as worked'
                              : 'Work day — click to mark as off'
                            : undefined
                      }
                      className={`flex flex-col items-center rounded-lg py-1.5 text-xs transition-all duration-200 ${
                        !inMonth
                          ? 'opacity-25'
                          : !workday
                            ? 'text-slate-600'
                            : isOff
                              ? 'bg-amber-500/15 text-amber-300 line-through hover:bg-amber-500/25'
                              : isHol
                                ? 'bg-violet-500/15 text-violet-300'
                                : 'bg-white/5 text-slate-200 hover:bg-white/10'
                      } ${isToday ? 'ring-1 ring-indigo-400/60' : ''}`}
                    >
                      <span className="text-[10px] text-slate-500">
                        {WEEKDAY_LABELS[d.getDay()]}
                      </span>
                      <span className="font-medium">{d.getDate()}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Tip: click a work day to mark it as off (vacation, sick) — it drops out of the required
        hours. Public holidays (violet) are excluded automatically for the country you pick. Enter
        hours as a decimal (<span className="font-mono">7.6</span>) or as hours-minutes (
        <span className="font-mono">45u10</span> / <span className="font-mono">45h10</span>). Each
        week's “still to work” rolls any surplus or shortfall over from earlier weeks.
      </p>

      {/* ---- Saved months ---- */}
      {savedMonths.length > 0 && (
        <div className="mt-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">
            Saved months
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {savedMonths.map((k) => {
              const [y, m] = k.split('-').map(Number)
              const label = new Date(y, m - 1, 1).toLocaleDateString(undefined, {
                month: 'short',
                year: 'numeric',
              })
              return (
                <button
                  key={k}
                  onClick={() => {
                    setYear(y)
                    setMonth(m - 1)
                  }}
                  className="rounded-xl border border-white/10 bg-white/5 px-3.5 py-1.5 text-xs text-slate-300 hover:border-white/20 hover:bg-white/10"
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Hours field. Accepts decimals ("7.6", "7,6") and hours-minutes notation
 * ("45h10", "45u10"). A real <input type="number"> reports its value as ""
 * mid-typing (e.g. while "7." has a trailing dot) and rejects letters like
 * "h"/"u" outright, so this is a text field that keeps the raw keystrokes in a
 * local draft while focused and commits the parsed decimal hours.
 */
function HoursInput({
  value,
  onChange,
  max,
  placeholder,
  className,
}: {
  value: number
  onChange: (n: number) => void
  max?: number
  placeholder?: string
  className?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const display = draft ?? (value ? fmtHours(value) : '')
  return (
    <input
      type="text"
      inputMode="decimal"
      value={display}
      placeholder={placeholder}
      className={className}
      onChange={(e) => {
        const raw = e.target.value
        // Allow an in-progress decimal ("45.6") or hours-minutes ("45h10").
        if (raw !== '' && !/^\d*([.,]\d*|[hu]\d*)?$/i.test(raw)) return
        setDraft(raw)
        const parsed = parseHours(raw)
        if (parsed !== null) onChange(max != null ? Math.min(max, parsed) : parsed)
      }}
      onBlur={() => setDraft(null)}
    />
  )
}

function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: ReactNode
  value: string
  sub?: string
  accent?: 'indigo' | 'emerald'
}) {
  const color =
    accent === 'indigo' ? 'text-indigo-300' : accent === 'emerald' ? 'text-emerald-300' : 'text-white'
  return (
    <div>
      <p className="truncate text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 whitespace-nowrap text-xl font-bold tabular-nums ${color}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-slate-500">{sub}</p>}
    </div>
  )
}
