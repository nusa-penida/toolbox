// CORS proxy for the Shortest Route utility's shared-list import.
//
// Browsers can't fetch google.com / apple.com pages directly (no CORS headers),
// and public proxies like allorigins are unreliable. This fetches a whitelisted
// set of map hosts server-side and returns the body. (Ported from the Supabase
// edge function; CORS headers are added by ../index.mjs.)

import { text } from './_shared.mjs'

const ALLOWED_HOSTS = new Set([
  'www.google.com',
  'google.com',
  'maps.app.goo.gl',
  'maps.apple.com',
  'guides.apple.com',
])

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

export async function handle({ url }) {
  const target = url.searchParams.get('url')
  let parsed
  try {
    parsed = new URL(target ?? '')
  } catch {
    return text('Missing or invalid ?url= parameter', 400)
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
    return text(`Host not allowed: ${parsed.hostname}`, 403)
  }

  const upstream = await fetch(parsed, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en' },
    redirect: 'follow',
  })
  const body = await upstream.text()
  return text(body, upstream.status)
}
