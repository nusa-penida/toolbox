// Self-hosted backend for the Toolbox website.
//
// A zero-dependency Node HTTP server that ports the five Supabase edge
// functions so they can run on this machine and be exposed through the existing
// Cloudflare Tunnel. Routes mirror Supabase's layout exactly:
//
//   /functions/v1/cors-proxy
//   /functions/v1/soccer
//   /functions/v1/alphavantage
//   /functions/v1/fmp
//   /functions/v1/morningstar
//
// so the frontend only needs its functions base URL repointed here (see
// VITE_FUNCTIONS_URL in the repo root .env). Auth is unchanged: each user still
// brings their own upstream API key/credentials, passed per request via headers
// and never persisted. The `Authorization`/`apikey` headers the client still
// sends (for Supabase's gateway) are simply ignored here.
//
// Run: node server/index.mjs   (see server/README.md for systemd + tunnel setup)

import { createServer } from 'node:http'

import * as corsProxy from './functions/cors-proxy.mjs'
import * as soccer from './functions/soccer.mjs'
import * as alphavantage from './functions/alphavantage.mjs'
import * as fmp from './functions/fmp.mjs'
import * as morningstar from './functions/morningstar.mjs'

const PORT = Number(process.env.PORT) || 8787
const HOST = process.env.HOST || '127.0.0.1' // bind loopback; the tunnel reaches it locally
// Match the edge functions' permissive default. Set to your site origin to lock down.
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*'

const ROUTES = {
  'cors-proxy': corsProxy,
  soccer,
  alphavantage,
  fmp,
  morningstar,
}

// Superset of every credential/passthrough header the functions read, so a
// single preflight response covers all routes.
const ALLOW_HEADERS =
  'authorization, x-client-info, apikey, content-type, ' +
  'x-fd-token, x-av-key, x-fmp-key, x-ms-user, x-ms-pass, x-ms-region'

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

  // Preflight — one response for every route.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders())
    res.end()
    return
  }

  // Lightweight liveness probe for monitoring / the tunnel health.
  if (url.pathname === '/health' || url.pathname === '/') {
    res.writeHead(200, { ...corsHeaders(), 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, service: 'toolbox-backend' }))
    return
  }

  const match = url.pathname.match(/^\/functions\/v1\/([^/]+)\/?$/)
  const mod = match && ROUTES[match[1]]
  if (!mod) {
    res.writeHead(404, { ...corsHeaders(), 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `Unknown function: ${match ? match[1] : url.pathname}` }))
    return
  }

  const header = (name) => {
    const v = req.headers[name.toLowerCase()]
    return Array.isArray(v) ? v[0] : (v ?? null)
  }

  try {
    const result = await mod.handle({ url, header })
    const { status = 200, contentType = 'application/json', body = '', extraHeaders = {} } = result
    res.writeHead(status, { ...corsHeaders(), ...extraHeaders, 'Content-Type': contentType })
    res.end(body)
  } catch (e) {
    // Handlers catch their own upstream errors; this is the last-resort net.
    const msg = e instanceof Error ? e.message : 'Request failed'
    res.writeHead(500, { ...corsHeaders(), 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: msg }))
  }
})

server.listen(PORT, HOST, () => {
  console.log(`toolbox-backend listening on http://${HOST}:${PORT}`)
  console.log(`  routes: ${Object.keys(ROUTES).map((r) => `/functions/v1/${r}`).join(', ')}`)
})
