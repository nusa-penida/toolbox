import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

/**
 * Whether real Supabase credentials are present. When false the app renders a
 * setup screen (see App.tsx) instead of crashing — the client below is still
 * created against placeholders so modules can import `supabase` safely, but no
 * calls are ever made against it.
 */
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

export const supabase = createClient(
  supabaseUrl ?? 'https://placeholder.supabase.co',
  supabaseAnonKey ?? 'placeholder-anon-key'
)

/**
 * Base URL for the backend "functions" (cors-proxy, soccer, stock providers).
 *
 * Defaults to Supabase's edge-function URL so nothing changes when unset. Set
 * `VITE_FUNCTIONS_URL` (e.g. https://api.example.com/functions/v1) to route
 * these calls to the self-hosted Node backend (the toolbox-backend repo)
 * instead — auth and
 * per-request credential headers are unchanged, so it's a drop-in swap. No
 * trailing slash.
 */
export const functionsBase =
  (import.meta.env.VITE_FUNCTIONS_URL as string | undefined)?.replace(/\/$/, '') ||
  `${supabaseUrl ?? ''}/functions/v1`
