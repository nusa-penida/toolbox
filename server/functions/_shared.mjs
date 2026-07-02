// Shared helpers for the self-hosted toolbox backend.
//
// Each function module exports `handle({ url, header })` and returns a plain
// result object `{ status, contentType, body, extraHeaders? }`. The server
// (../index.mjs) attaches CORS headers and writes the response, so the modules
// stay runtime-agnostic and close to the original Supabase edge functions.
//
// All five functions are GET-only (they read query params + credential headers,
// never a request body), so `header(name)` is all the request context a handler
// needs. `header` is case-insensitive, mirroring Deno's `req.headers.get()`.

export function json(body, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}

export function text(body, status = 200, contentType = 'text/plain; charset=utf-8') {
  return { status, contentType, body }
}
