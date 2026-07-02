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
import * as videoDownload from './functions/video-download.mjs'

const PORT = Number(process.env.PORT) || 8787
const HOST = process.env.HOST || '127.0.0.1' // bind loopback; the tunnel reaches it locally
// Allowed browser origins. Comma-separated list (e.g. the site's apex + www +
// its Pages URL), or `*` to allow any. When it's a list, the request's Origin
// is reflected back if it's on the list — a browser can't send `*` credentials
// and CORS only allows one origin per response, so reflecting is how you support
// more than one site. Defaults to `*` to match the old Supabase edge functions.
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGIN || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const ALLOW_ANY_ORIGIN = ALLOW_ORIGINS.includes('*')

const ROUTES = {
  'cors-proxy': corsProxy,
  soccer,
  alphavantage,
  fmp,
  morningstar,
  'video-download': videoDownload,
}

// POST bodies are small JSON option payloads. Cap the size so a runaway upload
// can't exhaust memory (the GET-only functions never read a body at all).
const MAX_BODY_BYTES = 1_000_000

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// Superset of every credential/passthrough header the functions read, so a
// single preflight response covers all routes.
const ALLOW_HEADERS =
  'authorization, x-client-info, apikey, content-type, ' +
  'x-fd-token, x-av-key, x-fmp-key, x-ms-user, x-ms-pass, x-ms-region'

function corsHeaders(reqOrigin) {
  let allow
  if (ALLOW_ANY_ORIGIN) allow = '*'
  else if (reqOrigin && ALLOW_ORIGINS.includes(reqOrigin)) allow = reqOrigin
  else allow = ALLOW_ORIGINS[0] // a non-allowed origin gets a mismatch → browser blocks it
  const headers = {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  }
  // When the allowed origin depends on the request, caches must key on Origin.
  if (!ALLOW_ANY_ORIGIN) headers['Vary'] = 'Origin'
  return headers
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const cors = corsHeaders(req.headers.origin)

  // Preflight — one response for every route.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    res.end()
    return
  }

  // Lightweight liveness probe for monitoring / the tunnel health.
  if (url.pathname === '/health' || url.pathname === '/') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, service: 'toolbox-backend' }))
    return
  }

  const match = url.pathname.match(/^\/functions\/v1\/([^/]+)\/?$/)
  const mod = match && ROUTES[match[1]]
  if (!mod) {
    res.writeHead(404, { ...cors, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `Unknown function: ${match ? match[1] : url.pathname}` }))
    return
  }

  const header = (name) => {
    const v = req.headers[name.toLowerCase()]
    return Array.isArray(v) ? v[0] : (v ?? null)
  }

  let body = ''
  if (req.method === 'POST') {
    try {
      body = await readBody(req)
    } catch (e) {
      res.writeHead(413, { ...cors, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'Body read failed' }))
      return
    }
  }

  try {
    // Handlers either return a `{ status, contentType, body }` result for the
    // server to write, OR take over `res` themselves (streaming) and return
    // nothing — video-download streams progress + files that way.
    const result = await mod.handle({
      url,
      header,
      req,
      res,
      method: req.method,
      body,
      cors,
    })
    if (res.writableEnded || res.headersSent) return
    const { status = 200, contentType = 'application/json', body: out = '', extraHeaders = {} } =
      result || {}
    res.writeHead(status, { ...cors, ...extraHeaders, 'Content-Type': contentType })
    res.end(out)
  } catch (e) {
    // Handlers catch their own upstream errors; this is the last-resort net.
    const msg = e instanceof Error ? e.message : 'Request failed'
    if (!res.headersSent) {
      res.writeHead(500, { ...cors, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: msg }))
    } else if (!res.writableEnded) {
      res.end()
    }
  }
})

server.listen(PORT, HOST, () => {
  console.log(`toolbox-backend listening on http://${HOST}:${PORT}`)
  console.log(`  routes: ${Object.keys(ROUTES).map((r) => `/functions/v1/${r}`).join(', ')}`)
})
