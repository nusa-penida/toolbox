import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/auth-context'

/**
 * Loads and persists a per-user config object for a utility.
 *
 * Configs are stored as JSON in the `utility_configs` table, one row per
 * (user, utility). Saves are debounced so utilities can call `setConfig`
 * on every keystroke without hammering the database.
 *
 * Usage inside a utility component:
 *   const { config, setConfig, loading, saving } = useUtilityConfig('my-utility', defaults)
 */
export function useUtilityConfig<T extends Record<string, unknown>>(
  utilityId: string,
  defaults: T,
  debounceMs = 800
) {
  const { user } = useAuth()
  const [config, setConfigState] = useState<T>(defaults)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const defaultsRef = useRef(defaults)

  useEffect(() => {
    if (!user) return
    let cancelled = false
    supabase
      .from('utility_configs')
      .select('config')
      .eq('utility_id', utilityId)
      .maybeSingle()
      .then(({ data, error: loadError }) => {
        if (cancelled) return
        if (loadError) {
          setError(loadError.message)
        } else if (data?.config) {
          setConfigState({ ...defaultsRef.current, ...(data.config as T) })
        }
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [user, utilityId])

  const persist = useCallback(
    async (next: T) => {
      if (!user) return
      setSaving(true)
      const { error: saveError } = await supabase.from('utility_configs').upsert(
        { user_id: user.id, utility_id: utilityId, config: next },
        { onConflict: 'user_id,utility_id' }
      )
      setError(saveError?.message ?? null)
      setSaving(false)
    },
    [user, utilityId]
  )

  const setConfig = useCallback(
    (updater: Partial<T> | ((prev: T) => T)) => {
      setConfigState((prev) => {
        const next =
          typeof updater === 'function' ? updater(prev) : { ...prev, ...updater }
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => persist(next), debounceMs)
        return next
      })
    },
    [persist, debounceMs]
  )

  // Flush pending save on unmount so a quick navigation doesn't lose changes.
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [])

  // Without a user there is nothing to load, so never report loading.
  return { config, setConfig, loading: user ? loading : false, saving, error }
}
