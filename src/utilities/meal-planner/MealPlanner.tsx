import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ExternalLink, Plus, Search, Sparkles, Trash2, UtensilsCrossed, X } from 'lucide-react'
import { SaveStatus } from '../../components/SaveStatus'
import { useUtilityConfig } from '../../hooks/useUtilityConfig'

/**
 * Weekly Meal Planner. Two tabs:
 *
 *   • Weekly Plan — pick a lunch and a dinner for each day of the week,
 *     chosen from your own list of meals. Navigate week to week; every week
 *     you fill in is kept in your account config.
 *   • My Meals    — add / edit / remove the meals you cook, each tagged as a
 *     lunch, a dinner, or both. The plan's dropdowns are filtered by that tag.
 *
 * Meals and week plans both live in the per-user utility config (synced to your
 * account, RLS-protected). Gated behind sign-in — that's the "password".
 */

type MealType = 'lunch' | 'dinner' | 'both'

interface Meal {
  id: string
  name: string
  type: MealType
  /** Optional link to the recipe — a webpage or an app deep-link. */
  recipe?: string
}

/** One day's choices, by meal id (undefined ⇒ nothing planned for that slot). */
interface DayPlan {
  lunch?: string
  dinner?: string
}

interface MealConfig extends Record<string, unknown> {
  meals: Meal[]
  /** Week plans keyed by the ISO date of that week's Monday → day index (0=Mon … 6=Sun). */
  weeks: Record<string, Record<number, DayPlan>>
}

const DEFAULTS: MealConfig = {
  meals: [],
  weeks: {},
}

const DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** How many weeks before the displayed week to weigh recommendations by. */
const WEEKS_LOOKBACK = 4
/** How many suggestion chips to show per slot. */
const MAX_SUGGESTIONS = 3
/** sessionStorage key for "don't ask before removing a meal again this session". */
const SKIP_CONFIRM_KEY = 'meal-planner:skip-remove-confirm'

const MEAL_TYPES: { value: MealType; label: string }[] = [
  { value: 'lunch', label: 'Lunch' },
  { value: 'dinner', label: 'Dinner' },
  { value: 'both', label: 'Both' },
]

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
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

/** A short, stable id for a new meal. */
function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `m_${Date.now().toString(36)}`
}

/**
 * Turn whatever the user typed into something openable. URLs with an explicit
 * scheme (https://…, or an app deep-link like "paprika://…") are kept as-is;
 * a bare host like "example.com/recipe" gets https:// prepended.
 */
function normalizeUrl(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  return /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`
}

/**
 * How many times each meal was planned (in any slot) across the WEEKS_LOOKBACK
 * weeks immediately before `weekStart`. Used to bias suggestions toward meals
 * you've cooked the least lately.
 */
function recentUsage(
  weeks: MealConfig['weeks'],
  weekStart: Date
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (let i = 1; i <= WEEKS_LOOKBACK; i++) {
    const plan = weeks[ymd(addDays(weekStart, -7 * i))]
    if (!plan) continue
    for (const day of Object.values(plan)) {
      for (const id of [day.lunch, day.dinner]) {
        if (id) counts[id] = (counts[id] ?? 0) + 1
      }
    }
  }
  return counts
}

export function MealPlanner() {
  const { config, setConfig, loading, saving } = useUtilityConfig<MealConfig>(
    'meal-planner',
    DEFAULTS
  )

  const [tab, setTab] = useState<'plan' | 'meals'>('plan')

  const today = new Date()
  const [weekStart, setWeekStart] = useState<Date>(mondayOf(today))
  const weekKey = ymd(weekStart)
  const weekPlan = useMemo(() => config.weeks[weekKey] ?? {}, [config.weeks, weekKey])
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))

  // Recommendation score: how often a meal was planned over the previous few
  // weeks PLUS what's already on this week's plan. Lower = suggested sooner, so
  // meals you've had recently (or already picked this week) sink down the list.
  const pastUsage = useMemo(() => recentUsage(config.weeks, weekStart), [config.weeks, weekStart])
  const thisWeekUsage = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const day of Object.values(weekPlan)) {
      for (const id of [day.lunch, day.dinner]) {
        if (id) counts[id] = (counts[id] ?? 0) + 1
      }
    }
    return counts
  }, [weekPlan])
  const score = (id: string) => (pastUsage[id] ?? 0) + (thisWeekUsage[id] ?? 0)

  // ---- Meal mutations ----
  function addMeal(name: string, type: MealType, recipe: string) {
    const trimmed = name.trim()
    if (!trimmed) return
    const link = recipe.trim()
    setConfig((prev) => ({
      ...prev,
      meals: [...prev.meals, { id: newId(), name: trimmed, type, recipe: link || undefined }],
    }))
  }
  function updateMeal(id: string, patch: Partial<Meal>) {
    setConfig((prev) => ({
      ...prev,
      meals: prev.meals.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    }))
  }
  function removeMeal(id: string) {
    setConfig((prev) => {
      // Drop the meal and clear it from any day it was planned for.
      const weeks: MealConfig['weeks'] = {}
      for (const [wk, plan] of Object.entries(prev.weeks)) {
        const next: Record<number, DayPlan> = {}
        for (const [d, slots] of Object.entries(plan)) {
          next[Number(d)] = {
            lunch: slots.lunch === id ? undefined : slots.lunch,
            dinner: slots.dinner === id ? undefined : slots.dinner,
          }
        }
        weeks[wk] = next
      }
      return { ...prev, meals: prev.meals.filter((m) => m.id !== id), weeks }
    })
  }

  // ---- Plan mutations ----
  function setSlot(dayIndex: number, slot: 'lunch' | 'dinner', mealId: string) {
    setConfig((prev) => {
      const week = prev.weeks[weekKey] ?? {}
      const day = week[dayIndex] ?? {}
      return {
        ...prev,
        weeks: {
          ...prev.weeks,
          [weekKey]: {
            ...week,
            [dayIndex]: { ...day, [slot]: mealId || undefined },
          },
        },
      }
    })
  }

  const mealsFor = (slot: 'lunch' | 'dinner') =>
    config.meals.filter((m) => m.type === slot || m.type === 'both')
  const mealById = (id?: string) => config.meals.find((m) => m.id === id)

  function shiftWeek(delta: number) {
    setWeekStart((w) => addDays(w, delta * 7))
  }

  const rangeLabel = `${weekStart.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${days[6].toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`

  // Planning progress for the visible week (out of 14 slots).
  const filledSlots = days.reduce((sum, _d, i) => {
    const day = weekPlan[i] ?? {}
    return sum + (day.lunch ? 1 : 0) + (day.dinner ? 1 : 0)
  }, 0)
  const pct = (filledSlots / 14) * 100

  const tabClass = (active: boolean) =>
    `rounded-xl px-4 py-1.5 text-sm transition-all duration-200 ${
      active
        ? 'bg-gradient-to-r from-indigo-500 to-violet-500 text-white shadow-lg shadow-indigo-500/25'
        : 'border border-white/10 bg-white/5 text-slate-300 hover:border-white/20 hover:bg-white/10'
    }`

  const selectClass =
    'glass w-full rounded-xl px-3 py-2 text-sm text-white focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20'

  if (loading) {
    return <p className="animate-pulse text-slate-400">Loading your meals…</p>
  }

  return (
    <div className="animate-fade-up">
      <div className="flex items-baseline justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Meal Planner</h1>
        <SaveStatus saving={saving} />
      </div>
      <p className="mt-2 text-slate-400">
        Plan a lunch and a dinner for every day of the week from your own list of meals. Meals and
        week plans are saved to your account.
      </p>

      {/* ---- Tabs ---- */}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <button className={tabClass(tab === 'plan')} onClick={() => setTab('plan')}>
          Weekly Plan
        </button>
        <button className={tabClass(tab === 'meals')} onClick={() => setTab('meals')}>
          <span className="inline-flex items-center gap-1.5">
            <UtensilsCrossed className="size-4" /> My Meals
            {config.meals.length > 0 && (
              <span className="text-xs opacity-70">{config.meals.length}</span>
            )}
          </span>
        </button>
      </div>

      {tab === 'plan' ? (
        <PlanTab
          rangeLabel={rangeLabel}
          shiftWeek={shiftWeek}
          toThisWeek={() => setWeekStart(mondayOf(new Date()))}
          days={days}
          today={today}
          weekPlan={weekPlan}
          mealsFor={mealsFor}
          mealById={mealById}
          score={score}
          setSlot={setSlot}
          selectClass={selectClass}
          filledSlots={filledSlots}
          pct={pct}
          hasMeals={config.meals.length > 0}
          goToMeals={() => setTab('meals')}
        />
      ) : (
        <MealsTab
          meals={config.meals}
          addMeal={addMeal}
          updateMeal={updateMeal}
          removeMeal={removeMeal}
          selectClass={selectClass}
        />
      )}
    </div>
  )
}

function PlanTab({
  rangeLabel,
  shiftWeek,
  toThisWeek,
  days,
  today,
  weekPlan,
  mealsFor,
  mealById,
  score,
  setSlot,
  selectClass,
  filledSlots,
  pct,
  hasMeals,
  goToMeals,
}: {
  rangeLabel: string
  shiftWeek: (delta: number) => void
  toThisWeek: () => void
  days: Date[]
  today: Date
  weekPlan: Record<number, DayPlan>
  mealsFor: (slot: 'lunch' | 'dinner') => Meal[]
  mealById: (id?: string) => Meal | undefined
  score: (id: string) => number
  setSlot: (dayIndex: number, slot: 'lunch' | 'dinner', mealId: string) => void
  selectClass: string
  filledSlots: number
  pct: number
  hasMeals: boolean
  goToMeals: () => void
}) {
  return (
    <>
      {/* ---- Week navigation ---- */}
      <div className="mt-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={() => shiftWeek(-1)}
            className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-slate-300 hover:border-white/20 hover:bg-white/10"
            aria-label="Previous week"
          >
            ←
          </button>
          <span className="min-w-52 text-center text-lg font-semibold text-white">{rangeLabel}</span>
          <button
            onClick={() => shiftWeek(1)}
            className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-slate-300 hover:border-white/20 hover:bg-white/10"
            aria-label="Next week"
          >
            →
          </button>
        </div>
        <button
          onClick={toThisWeek}
          className="rounded-xl border border-white/10 bg-white/5 px-3.5 py-1.5 text-xs text-slate-300 hover:border-white/20 hover:bg-white/10"
        >
          This week
        </button>
      </div>

      {/* ---- Planning progress ---- */}
      <div className="glass mt-4 rounded-2xl p-5">
        <div className="flex items-baseline justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">
            Planned this week
          </p>
          <p className="text-sm font-bold tabular-nums text-white">{filledSlots} / 14</p>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
          <span
            className="block h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {!hasMeals ? (
        <div className="glass mt-6 rounded-2xl p-8 text-center">
          <UtensilsCrossed className="mx-auto size-8 text-slate-500" />
          <p className="mt-3 text-sm text-slate-300">You haven't added any meals yet.</p>
          <p className="mt-1 text-xs text-slate-500">
            Add the meals you cook first, then plan them across the week.
          </p>
          <button
            onClick={goToMeals}
            className="mt-4 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-indigo-500/25 transition-all hover:brightness-110"
          >
            Add meals →
          </button>
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {days.map((d, i) => {
            const day = weekPlan[i] ?? {}
            const isToday = ymd(d) === ymd(today)
            return (
              <div
                key={i}
                className={`glass rounded-2xl p-4 ${isToday ? 'ring-1 ring-indigo-400/60' : ''}`}
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold text-white">{DAY_LABELS[i]}</span>
                  <span className="text-xs text-slate-500">
                    {d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                  </span>
                  {isToday && (
                    <span className="rounded-full bg-indigo-500/20 px-2 py-0.5 text-[10px] font-medium text-indigo-300">
                      Today
                    </span>
                  )}
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <SlotPicker
                    label="Lunch"
                    dayLabel={DAY_LABELS[i]}
                    value={day.lunch}
                    meal={mealById(day.lunch)}
                    meals={mealsFor('lunch')}
                    score={score}
                    onChange={(id) => setSlot(i, 'lunch', id)}
                    triggerClass={selectClass}
                  />
                  <SlotPicker
                    label="Dinner"
                    dayLabel={DAY_LABELS[i]}
                    value={day.dinner}
                    meal={mealById(day.dinner)}
                    meals={mealsFor('dinner')}
                    score={score}
                    onChange={(id) => setSlot(i, 'dinner', id)}
                    triggerClass={selectClass}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

/**
 * A meal slot: a button showing the current pick that opens a searchable popup
 * card to change it. The picker carries the search box, the full meal list and
 * the frequency-based suggestions.
 */
function SlotPicker({
  label,
  dayLabel,
  value,
  meal,
  meals,
  score,
  onChange,
  triggerClass,
}: {
  label: string
  dayLabel: string
  value?: string
  meal: Meal | undefined
  meals: Meal[]
  score: (id: string) => number
  onChange: (id: string) => void
  triggerClass: string
}) {
  const [open, setOpen] = useState(false)
  // A meal that was deleted but is still referenced on this day.
  const missing = Boolean(value) && !meal

  function choose(id: string) {
    onChange(id)
    setOpen(false)
  }

  return (
    <div className="flex flex-col gap-1.5 text-xs text-slate-400">
      <span className="flex items-center justify-between">
        {label}
        {meal?.recipe && <RecipeLink url={meal.recipe} />}
      </span>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`flex items-center justify-between gap-2 text-left ${triggerClass}`}
      >
        <span className={`truncate ${meal ? 'text-white' : missing ? 'text-amber-300' : 'text-slate-500'}`}>
          {meal ? meal.name : missing ? '(deleted meal)' : 'Nothing planned'}
        </span>
        <ChevronDown className="size-4 shrink-0 text-slate-500" />
      </button>
      {open && (
        <SlotPickerPopup
          title={`${dayLabel} · ${label}`}
          value={value}
          meals={meals}
          score={score}
          onPick={choose}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

function SlotPickerPopup({
  title,
  value,
  meals,
  score,
  onPick,
  onClose,
}: {
  title: string
  value?: string
  meals: Meal[]
  score: (id: string) => number
  onPick: (id: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const q = query.trim().toLowerCase()
  const filtered = q ? meals.filter((m) => m.name.toLowerCase().includes(q)) : meals

  // Suggestions: least-planned meals (over recent weeks + this week), current
  // pick excluded. Only shown when not searching.
  const suggestions = q
    ? []
    : [...meals]
        .filter((m) => m.id !== value)
        .sort((a, b) => score(a.id) - score(b.id) || a.name.localeCompare(b.name))
        .slice(0, MAX_SUGGESTIONS)

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Choose ${title}`}
    >
      <div
        className="glass flex max-h-[80vh] w-full max-w-md flex-col rounded-2xl p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-white">{title}</p>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Search */}
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search meals…"
            className="glass w-full rounded-xl py-2 pl-9 pr-3 text-sm text-white placeholder-slate-600 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          />
        </div>

        {/* Suggestions */}
        {suggestions.length > 0 && (
          <div className="mt-3">
            <p className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-slate-500">
              <Sparkles className="size-3" /> Suggested · cooked least lately
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {suggestions.map((m) => {
                const n = score(m.id)
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => onPick(m.id)}
                    title={n === 0 ? 'Not planned recently' : `Planned ${n}× recently`}
                    className="rounded-lg border border-indigo-400/30 bg-indigo-500/10 px-2.5 py-1 text-[11px] text-indigo-200 transition-all hover:border-indigo-400/60 hover:bg-indigo-500/20"
                  >
                    {m.name}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Meal list */}
        <div className="mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
          <button
            type="button"
            onClick={() => onPick('')}
            className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm transition-colors ${
              !value
                ? 'bg-indigo-500/15 text-indigo-200'
                : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
            }`}
          >
            Nothing planned
          </button>
          {filtered.map((m) => {
            const selected = m.id === value
            const n = score(m.id)
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => onPick(m.id)}
                className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                  selected ? 'bg-indigo-500/15 text-white' : 'text-slate-200 hover:bg-white/5'
                }`}
              >
                <span className="truncate">{m.name}</span>
                <span className="shrink-0 text-[11px] text-slate-500">
                  {n === 0 ? 'not lately' : `${n}× lately`}
                </span>
              </button>
            )
          })}
          {filtered.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-slate-500">
              No meals match “{query}”.
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

/** Small "Recipe" link that opens the URL (webpage or app deep-link) in a new tab. */
function RecipeLink({ url }: { url: string }) {
  return (
    <a
      href={normalizeUrl(url)}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-300 transition-colors hover:text-indigo-200"
      title={url}
    >
      <ExternalLink className="size-3" /> Recipe
    </a>
  )
}

/**
 * Text input with a styled autocomplete dropdown of existing meal names —
 * a glassy replacement for the browser's native <datalist> popup. Matches are
 * substring, case-insensitive, and exclude what's already fully typed.
 */
function NameAutocomplete({
  value,
  onChange,
  options,
  placeholder,
  wrapperClassName,
  inputClassName,
}: {
  value: string
  onChange: (v: string) => void
  options: string[]
  placeholder?: string
  wrapperClassName?: string
  inputClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null)

  const q = value.trim().toLowerCase()
  const matches = q
    ? options.filter((o) => o.toLowerCase().includes(q) && o.toLowerCase() !== q).slice(0, 6)
    : []
  const show = open && matches.length > 0

  // Track the input's viewport position so the portalled list stays anchored
  // to it through scrolling and resizing.
  useLayoutEffect(() => {
    if (!show) return
    const measure = () => {
      const el = inputRef.current
      if (el) {
        const r = el.getBoundingClientRect()
        setRect({ left: r.left, top: r.bottom + 4, width: r.width })
      }
    }
    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [show, value])

  return (
    <div className={wrapperClassName}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        // Delay so a click on an option lands before the list unmounts.
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        placeholder={placeholder}
        autoComplete="off"
        className={inputClassName}
      />
      {show &&
        rect &&
        createPortal(
          <ul
            className="fixed z-50 max-h-48 overflow-y-auto rounded-xl border border-white/10 bg-slate-900/95 p-1 shadow-2xl backdrop-blur"
            style={{ left: rect.left, top: rect.top, width: rect.width }}
          >
            {matches.map((o) => (
              <li key={o}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    onChange(o)
                    setOpen(false)
                  }}
                  className="block w-full truncate rounded-lg px-3 py-1.5 text-left text-sm text-slate-200 transition-colors hover:bg-white/10"
                >
                  {o}
                </button>
              </li>
            ))}
          </ul>,
          document.body
        )}
    </div>
  )
}

const typeLabel = (t: MealType) => MEAL_TYPES.find((x) => x.value === t)?.label ?? ''

/** The three-way Lunch / Dinner / Both segmented toggle. */
function TypeToggle({ value, onChange }: { value: MealType; onChange: (t: MealType) => void }) {
  return (
    <div className="inline-flex rounded-xl border border-white/10 bg-white/5 p-1">
      {MEAL_TYPES.map((t) => (
        <button
          key={t.value}
          type="button"
          onClick={() => onChange(t.value)}
          className={`rounded-lg px-3 py-1 text-xs font-medium transition-all duration-200 ${
            value === t.value ? 'bg-white/10 text-white shadow-sm' : 'text-slate-400 hover:text-white'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

/** Recipe-link input paired with an "open" button (greyed out when empty). */
function RecipeField({
  value,
  name,
  onChange,
  className,
}: {
  value?: string
  name: string
  onChange: (v: string | undefined) => void
  className?: string
}) {
  return (
    <div className={`flex items-center gap-1.5 ${className ?? ''}`}>
      <input
        type="text"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value.trim() || undefined)}
        placeholder="Recipe link (optional)"
        aria-label="Recipe link"
        className="glass min-w-0 flex-1 rounded-xl px-3.5 py-2 text-sm text-white placeholder-slate-600 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
      />
      {value ? (
        <a
          href={normalizeUrl(value)}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded-xl border border-white/10 bg-white/5 p-2 text-slate-400 transition-all hover:border-indigo-400/40 hover:bg-indigo-500/10 hover:text-indigo-300"
          aria-label={`Open recipe for ${name}`}
          title="Open recipe"
        >
          <ExternalLink className="size-4" />
        </a>
      ) : (
        <span className="shrink-0 p-2 text-slate-700" aria-hidden>
          <ExternalLink className="size-4" />
        </span>
      )}
    </div>
  )
}

function RemoveButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="shrink-0 rounded-xl border border-white/10 bg-white/5 p-2 text-slate-400 transition-all hover:border-rose-400/40 hover:bg-rose-500/10 hover:text-rose-300"
      aria-label={`Remove ${name}`}
      title="Remove meal"
    >
      <Trash2 className="size-4" />
    </button>
  )
}

/** Popup card for editing a meal — used on mobile, where rows are tap-to-edit. */
function MealEditModal({
  meal,
  updateMeal,
  onRemove,
  onClose,
}: {
  meal: Meal
  updateMeal: (id: string, patch: Partial<Meal>) => void
  onRemove: () => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Edit meal"
    >
      <div
        className="glass flex w-full max-w-md flex-col gap-4 rounded-2xl p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-white">Edit meal</p>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        <label className="flex flex-col gap-1.5 text-xs text-slate-400">
          Name
          <input
            type="text"
            value={meal.name}
            onChange={(e) => updateMeal(meal.id, { name: e.target.value })}
            autoFocus
            className="glass rounded-xl px-3.5 py-2 text-sm text-white focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          />
        </label>

        <label className="flex flex-col gap-1.5 text-xs text-slate-400">
          Recipe link <span className="text-slate-600">(optional)</span>
          <RecipeField
            value={meal.recipe}
            name={meal.name}
            onChange={(v) => updateMeal(meal.id, { recipe: v })}
          />
        </label>

        <div className="flex flex-col gap-1.5 text-xs text-slate-400">
          Suitable for
          <TypeToggle value={meal.type} onChange={(t) => updateMeal(meal.id, { type: t })} />
        </div>

        <div className="mt-1 flex items-center justify-between">
          <button
            onClick={onRemove}
            className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-rose-300 transition-all hover:border-rose-400/40 hover:bg-rose-500/10"
          >
            <Trash2 className="size-4" /> Remove
          </button>
          <button
            onClick={onClose}
            className="rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-indigo-500/25 transition-all hover:brightness-110"
          >
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/** Confirmation before deleting a meal, with a "don't ask again" opt-out. */
function ConfirmRemoveDialog({
  name,
  onConfirm,
  onCancel,
}: {
  name: string
  onConfirm: (dontAskAgain: boolean) => void
  onCancel: () => void
}) {
  const [dontAsk, setDontAsk] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onCancel}
      role="alertdialog"
      aria-modal="true"
      aria-label="Confirm remove"
    >
      <div
        className="glass flex w-full max-w-sm flex-col gap-4 rounded-2xl p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <p className="text-sm font-semibold text-white">Remove this meal?</p>
          <p className="mt-1 text-sm text-slate-400">
            “{name}” will be deleted and cleared from any days it was planned for.
          </p>
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={dontAsk}
            onChange={(e) => setDontAsk(e.target.checked)}
            className="size-4 rounded border-white/20 bg-white/5 text-indigo-500 focus:ring-indigo-500/30"
          />
          Don't ask again this session
        </label>

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-300 transition-all hover:border-white/20 hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(dontAsk)}
            className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-rose-500 to-red-500 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-rose-500/25 transition-all hover:brightness-110"
          >
            <Trash2 className="size-4" /> Remove
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function MealsTab({
  meals,
  addMeal,
  updateMeal,
  removeMeal,
  selectClass,
}: {
  meals: Meal[]
  addMeal: (name: string, type: MealType, recipe: string) => void
  updateMeal: (id: string, patch: Partial<Meal>) => void
  removeMeal: (id: string) => void
  selectClass: string
}) {
  const [draftName, setDraftName] = useState('')
  const [draftType, setDraftType] = useState<MealType>('both')
  const [draftRecipe, setDraftRecipe] = useState('')
  // Mobile: which meal's edit popup is open. Confirm: which meal awaits a
  // delete confirmation.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  // "Don't ask again" lives in sessionStorage so it lasts the browser-tab
  // session but resets next visit.
  const [skipConfirm, setSkipConfirm] = useState(
    () => typeof sessionStorage !== 'undefined' && sessionStorage.getItem(SKIP_CONFIRM_KEY) === '1'
  )

  function submit() {
    addMeal(draftName, draftType, draftRecipe)
    setDraftName('')
    setDraftType('both')
    setDraftRecipe('')
  }

  function doRemove(id: string) {
    removeMeal(id)
    setConfirmId(null)
    setEditingId((cur) => (cur === id ? null : cur))
  }
  function requestRemove(id: string) {
    if (skipConfirm) doRemove(id)
    else setConfirmId(id)
  }

  const sorted = [...meals].sort((a, b) => a.name.localeCompare(b.name))
  // Unique meal names power the Excel-style autocomplete on the name fields.
  const nameOptions = [...new Set(meals.map((m) => m.name))].sort((a, b) => a.localeCompare(b))
  const editing = editingId ? meals.find((m) => m.id === editingId) : undefined
  const confirming = confirmId ? meals.find((m) => m.id === confirmId) : undefined

  return (
    <>
      {/* ---- Add a meal ---- */}
      <div className="glass mt-6 rounded-2xl p-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">
          Add a meal
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          className="mt-3 flex flex-wrap items-end gap-3"
        >
          <label className="flex flex-1 flex-col gap-1.5 text-xs text-slate-400">
            Name
            <NameAutocomplete
              value={draftName}
              onChange={setDraftName}
              options={nameOptions}
              placeholder="e.g. Spaghetti bolognese"
              wrapperClassName="relative"
              inputClassName="glass w-full min-w-48 rounded-xl px-3.5 py-2 text-sm text-white placeholder-slate-600 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1.5 text-xs text-slate-400">
            Recipe link <span className="text-slate-600">(optional)</span>
            <input
              type="text"
              value={draftRecipe}
              onChange={(e) => setDraftRecipe(e.target.value)}
              placeholder="https://… or an app link"
              className="glass min-w-48 rounded-xl px-3.5 py-2 text-sm text-white placeholder-slate-600 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-slate-400">
            Suitable for
            <select
              value={draftType}
              onChange={(e) => setDraftType(e.target.value as MealType)}
              className={`${selectClass} w-32`}
            >
              {MEAL_TYPES.map((t) => (
                <option key={t.value} value={t.value} className="bg-slate-900">
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={!draftName.trim()}
            className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-indigo-500/25 transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus className="size-4" /> Add
          </button>
        </form>
      </div>

      {/* ---- Meal list ---- */}
      {sorted.length === 0 ? (
        <div className="glass mt-6 rounded-2xl p-8 text-center">
          <UtensilsCrossed className="mx-auto size-8 text-slate-500" />
          <p className="mt-3 text-sm text-slate-300">No meals yet.</p>
          <p className="mt-1 text-xs text-slate-500">
            Add the meals you cook above — they'll show up in the weekly plan's dropdowns.
          </p>
        </div>
      ) : (
        <div className="mt-6 space-y-2">
          {sorted.map((m) => (
            <div key={m.id} className="glass rounded-2xl p-3">
              {/* Desktop: edit everything inline. */}
              <div className="hidden items-center gap-3 sm:flex">
                <input
                  type="text"
                  value={m.name}
                  onChange={(e) => updateMeal(m.id, { name: e.target.value })}
                  aria-label="Meal name"
                  className="glass min-w-48 flex-1 rounded-xl px-3.5 py-2 text-sm text-white focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
                <RecipeField
                  value={m.recipe}
                  name={m.name}
                  onChange={(v) => updateMeal(m.id, { recipe: v })}
                  className="min-w-48 flex-1"
                />
                <TypeToggle value={m.type} onChange={(t) => updateMeal(m.id, { type: t })} />
                <RemoveButton name={m.name} onClick={() => requestRemove(m.id)} />
              </div>

              {/* Mobile: a compact row — tap to edit, with the remove button kept. */}
              <div className="flex items-center gap-3 sm:hidden">
                <button
                  type="button"
                  onClick={() => setEditingId(m.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span className="truncate text-sm text-white">{m.name}</span>
                  {m.recipe && <ExternalLink className="size-3.5 shrink-0 text-indigo-300" />}
                  <span className="ml-auto shrink-0 rounded-md bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                    {typeLabel(m.type)}
                  </span>
                </button>
                <RemoveButton name={m.name} onClick={() => requestRemove(m.id)} />
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <MealEditModal
          meal={editing}
          updateMeal={updateMeal}
          onRemove={() => requestRemove(editing.id)}
          onClose={() => setEditingId(null)}
        />
      )}

      {confirming && (
        <ConfirmRemoveDialog
          name={confirming.name}
          onCancel={() => setConfirmId(null)}
          onConfirm={(dontAskAgain) => {
            if (dontAskAgain) {
              setSkipConfirm(true)
              try {
                sessionStorage.setItem(SKIP_CONFIRM_KEY, '1')
              } catch {
                /* sessionStorage unavailable — skip lasts only in memory */
              }
            }
            doRemove(confirming.id)
          }}
        />
      )}
    </>
  )
}
