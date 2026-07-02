// Server-side video downloader for the "Video Downloader" utility.
//
// Runs yt-dlp ON THIS MACHINE so the user no longer has to copy a command and
// run it themselves. A browser can't do this directly: cross-origin reads of
// YouTube/etc. are blocked by CORS, and yt-dlp needs a real process (+ ffmpeg)
// for merging/extraction/embedding. So this handler spawns yt-dlp into a temp
// dir, streams progress back as NDJSON while it works, then hands the finished
// file to the browser as a normal attachment download.
//
// Two phases over one route (fits index.mjs's single-segment router):
//   POST /functions/v1/video-download        body: { url, ...options }
//        -> streams application/x-ndjson lines: {type:'progress'|'status'|
//           'done'|'error', ...}. On success the final line is
//           {type:'done', jobId, filename, size}.
//   GET  /functions/v1/video-download?job=ID
//        -> streams the finished file (Content-Disposition: attachment),
//           then deletes it. One-shot; the temp dir is removed after send.
//
// SAFETY: yt-dlp is spawned with an ARGUMENT ARRAY (no shell), so nothing the
// user types can be interpreted as a shell command — there is zero injection
// surface. The on-disk filename is fixed and confined to a per-job temp dir
// (--restrict-filenames + -P), so a hostile title can't escape it. Options are
// validated against allow-lists; anything unrecognized is dropped.

import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { json } from './_shared.mjs'

const YT_DLP = process.env.YT_DLP_PATH || 'yt-dlp'
const MAX_CONCURRENT = Number(process.env.VIDEO_MAX_CONCURRENT) || 2
const JOB_TTL_MS = 30 * 60 * 1000 // finished files are collectable for 30 min

// Finished downloads waiting to be fetched: jobId -> { dir, file, filename, size, createdAt }.
// This survives across requests because the backend is a long-running process.
const jobs = new Map()
let active = 0

// Sweep abandoned jobs (browser never came back for the file) so temp dirs
// don't accumulate on disk.
const sweeper = setInterval(() => {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) {
      jobs.delete(id)
      rm(job.dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}, 5 * 60 * 1000)
sweeper.unref?.()

// --- option allow-lists / validation ------------------------------------

const VIDEO_QUALITIES = new Set(['best', '2160', '1440', '1080', '720', '480', '360'])
const AUDIO_FORMATS = new Set(['mp3', 'm4a', 'opus', 'flac', 'wav', 'best'])

// yt-dlp tries these YouTube player clients in order and merges the formats
// each exposes — recovers videos the default client alone calls "not available".
const YOUTUBE_CLIENTS = 'youtube:player_client=default,web,web_safari,android,ios'

/** Build the `-f` format selector for the chosen video quality (mirrors the frontend). */
function videoFormat(quality, forceMp4) {
  if (quality === 'best') {
    return forceMp4
      ? 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'
      : 'bestvideo+bestaudio/best'
  }
  const h = `[height<=${quality}]`
  return forceMp4
    ? `bestvideo${h}[ext=mp4]+bestaudio[ext=m4a]/best${h}[ext=mp4]/best${h}`
    : `bestvideo${h}+bestaudio/best${h}`
}

/**
 * Translate a validated options object into a yt-dlp argument ARRAY. The output
 * path is always confined to `outDir` and we force --restrict-filenames, so the
 * produced file can't escape the temp dir regardless of the video's title.
 *
 * Deliberately ignored server-side:
 *   - cookiesBrowser: --cookies-from-browser reads THIS box's browser profiles,
 *     which don't exist on a headless server, so it's meaningless here.
 *   - playlist 'full': we force --no-playlist so exactly one file is produced
 *     (the download-to-browser flow delivers a single file).
 *   - outputTemplate: the on-disk name is fixed; the browser names the download.
 */
function buildArgs(o, outDir) {
  const args = [
    '--newline', // one progress line at a time, so we can parse it
    '--no-warnings',
    '--no-playlist',
    '--restrict-filenames',
    // Try several YouTube player clients: the default (android_vr) reports some
    // videos as "not available" when their good formats are DRM-locked, but
    // another client often still exposes a downloadable fallback. Namespaced to
    // youtube, so it's ignored for every other site.
    '--extractor-args',
    YOUTUBE_CLIENTS,
    '-P',
    outDir,
    '-o',
    '%(title)s.%(ext)s',
  ]

  if (o.mode === 'audio') {
    args.push('-x')
    if (o.audioFormat !== 'best') args.push('--audio-format', o.audioFormat)
    args.push('--audio-quality', '0')
  } else {
    args.push('-f', videoFormat(o.videoQuality, o.forceMp4))
    if (o.forceMp4) args.push('--merge-output-format', 'mp4')
  }

  if (o.downloadSubs || o.autoSubs) {
    if (o.downloadSubs) args.push('--write-subs')
    if (o.autoSubs) args.push('--write-auto-subs')
    args.push('--sub-langs', o.subLangs)
    if (o.embedSubs) args.push('--embed-subs')
  }

  if (o.embedThumbnail) args.push('--embed-thumbnail')
  if (o.embedMetadata) args.push('--embed-metadata')
  if (o.embedChapters) args.push('--embed-chapters')
  if (o.sponsorblock) args.push('--sponsorblock-remove', 'all')
  if (o.restrictFilenames) args.push('--restrict-filenames') // already added; harmless
  if (o.rateLimit) args.push('--limit-rate', o.rateLimit)

  args.push(o.url)
  return args
}

/** Validate + normalize the raw options from the request body. Throws on bad URL. */
function normalizeOptions(raw) {
  const url = String(raw?.url ?? '').trim()
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('A valid video URL is required.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are supported.')
  }

  const mode = raw?.mode === 'audio' ? 'audio' : 'video'
  const subLangs =
    typeof raw?.subLangs === 'string' && /^[\w,\-* ]+$/.test(raw.subLangs)
      ? raw.subLangs.trim()
      : 'en'
  const rateLimit =
    typeof raw?.rateLimit === 'string' && /^\d+(\.\d+)?[KMG]?$/i.test(raw.rateLimit.trim())
      ? raw.rateLimit.trim()
      : ''

  return {
    url: parsed.toString(),
    mode,
    videoQuality: VIDEO_QUALITIES.has(raw?.videoQuality) ? raw.videoQuality : 'best',
    forceMp4: Boolean(raw?.forceMp4),
    audioFormat: AUDIO_FORMATS.has(raw?.audioFormat) ? raw.audioFormat : 'mp3',
    downloadSubs: Boolean(raw?.downloadSubs),
    autoSubs: Boolean(raw?.autoSubs),
    embedSubs: Boolean(raw?.embedSubs),
    subLangs,
    embedThumbnail: Boolean(raw?.embedThumbnail),
    embedMetadata: Boolean(raw?.embedMetadata),
    embedChapters: Boolean(raw?.embedChapters),
    sponsorblock: Boolean(raw?.sponsorblock),
    restrictFilenames: Boolean(raw?.restrictFilenames),
    rateLimit,
  }
}

// yt-dlp progress line, e.g.
//   [download]  42.7% of ~  12.34MiB at    1.20MiB/s ETA 00:15
const PROGRESS_RE =
  /\[download\]\s+([\d.]+)%(?:\s+of\s+~?\s*([\d.]+\w+))?(?:\s+at\s+([\d.]+\w+\/s))?(?:\s+ETA\s+([\d:]+))?/

// Post-processing stages worth surfacing as a status message.
const STAGE_RE =
  /^\[(Merger|ExtractAudio|EmbedSubtitle|Metadata|SponsorBlock|EmbedThumbnail|ThumbnailsConvertor|VideoConvertor|Fixup\w*)\]/

// --- request handling -----------------------------------------------------

export async function handle({ url, req, res, method, body, cors }) {
  if (method === 'GET') return serveFile({ url, res, cors })
  if (method === 'POST') return runDownload({ req, res, body, cors })
  return json({ error: 'Method not allowed' }, 405)
}

/**
 * GET ?job=ID — serve the finished file, or free it.
 *
 *   ?release=1            delete the temp file (client has all the bytes).
 *   ?offset=N&length=M    return that byte slice as one response.
 *   (no offset/length)    return the whole file (only safe when it's small).
 *
 * The client fetches the file in <100 MB slices and reassembles it in the
 * browser, because the Cloudflare Tunnel caps a single response at 100 MB and
 * videos routinely exceed that. Slices are addressed with explicit query params
 * rather than a Range header so Cloudflare can't reinterpret the request. The
 * file is NOT deleted per slice — the client releases it when done, and the TTL
 * sweeper reclaims anything abandoned.
 */
async function serveFile({ url, res, cors }) {
  const jobId = url.searchParams.get('job')
  const job = jobId && jobs.get(jobId)
  if (!job) return json({ error: 'Download not found or expired.' }, 404)

  if (url.searchParams.get('release')) {
    jobs.delete(jobId)
    await rm(job.dir, { recursive: true, force: true }).catch(() => {})
    return json({ ok: true })
  }

  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
  if (offset >= job.size && job.size > 0) return json({ error: 'Offset past end of file.' }, 416)
  const reqLen = Number(url.searchParams.get('length'))
  const end =
    Number.isFinite(reqLen) && reqLen > 0
      ? Math.min(job.size - 1, offset + reqLen - 1)
      : job.size - 1
  const length = Math.max(0, end - offset + 1)

  res.writeHead(200, {
    ...cors,
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(length),
    'Cache-Control': 'no-store',
  })
  if (length === 0) return res.end()

  const stream = createReadStream(job.file, { start: offset, end })
  stream.on('error', () => {
    if (!res.writableEnded) res.end()
  })
  res.on('close', () => {
    if (!res.writableEnded) stream.destroy()
  })
  stream.pipe(res)
}

/** POST — run yt-dlp, stream NDJSON progress, register the finished file. */
async function runDownload({ req, res, body, cors }) {
  let options
  try {
    options = normalizeOptions(JSON.parse(body || '{}'))
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Invalid request.' }, 400)
  }

  if (active >= MAX_CONCURRENT) {
    return json({ error: 'The server is busy with other downloads. Try again shortly.' }, 429)
  }

  active++
  const dir = await mkdtemp(join(tmpdir(), 'ytdlp-'))
  let settled = false

  // NDJSON stream — start responding immediately so the client shows progress.
  res.writeHead(200, {
    ...cors,
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no', // don't let any proxy buffer the progress stream
  })
  const send = (obj) => {
    if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n')
  }

  // Keep the stream alive during long, quiet post-processing (a big merge emits
  // no progress lines) so Cloudflare's idle-response timeout doesn't cut it.
  // The client ignores unknown message types, so a bare ping is harmless.
  const heartbeat = setInterval(() => send({ type: 'ping' }), 15000)
  heartbeat.unref?.()

  const child = spawn(YT_DLP, buildArgs(options, dir), { stdio: ['ignore', 'pipe', 'pipe'] })

  let lastPercent = -1
  let stderrTail = ''
  let lineBuf = ''
  const onChunk = (chunk) => {
    lineBuf += chunk.toString()
    let idx
    while ((idx = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, idx)
      lineBuf = lineBuf.slice(idx + 1)
      const m = PROGRESS_RE.exec(line)
      if (m) {
        const percent = Math.min(100, parseFloat(m[1]))
        if (percent - lastPercent >= 0.5 || percent >= 100) {
          lastPercent = percent
          send({ type: 'progress', percent, size: m[2] || null, speed: m[3] || null, eta: m[4] || null })
        }
        continue
      }
      const stage = STAGE_RE.exec(line)
      if (stage) send({ type: 'status', stage: stage[1] })
    }
  }
  child.stdout.on('data', onChunk)
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
    onChunk(chunk) // some progress/stage lines arrive on stderr too
  })

  // If the browser disconnects mid-download, stop wasting the box's resources.
  const onClientGone = () => {
    if (!settled) child.kill('SIGKILL')
  }
  req.on('close', onClientGone)

  const finish = async (payload) => {
    if (settled) return
    settled = true
    active--
    clearInterval(heartbeat)
    req.off('close', onClientGone)
    send(payload)
    res.end()
    // On failure (or client gone before 'done') nothing will fetch the file.
    if (payload.type !== 'done') await rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  child.on('error', (err) => {
    const msg =
      err && err.code === 'ENOENT'
        ? 'yt-dlp is not installed on the server.'
        : `Failed to start yt-dlp: ${err.message}`
    finish({ type: 'error', message: msg })
  })

  child.on('close', async (code) => {
    if (settled) return
    if (code !== 0) {
      const detail = stderrTail.trim().split('\n').filter(Boolean).pop() || `exit code ${code}`
      return finish({ type: 'error', message: `Download failed: ${detail}` })
    }
    try {
      const file = await pickOutputFile(dir)
      const { size } = await stat(file)
      const jobId = randomUUID()
      const filename = basename(file)
      jobs.set(jobId, { dir, file, filename, size, createdAt: Date.now() })
      await finishDone({ jobId, filename, size })
    } catch (e) {
      await finish({ type: 'error', message: e instanceof Error ? e.message : 'No output file produced.' })
    }
  })

  // Register the finished job WITHOUT deleting the temp dir (the GET fetches it).
  async function finishDone(done) {
    if (settled) return
    settled = true
    active--
    clearInterval(heartbeat)
    req.off('close', onClientGone)
    send({ type: 'done', ...done })
    res.end()
  }
}

/** After a successful run, find the media file yt-dlp produced (largest non-temp file). */
async function pickOutputFile(dir) {
  const names = await readdir(dir)
  const candidates = []
  for (const name of names) {
    if (name.endsWith('.part') || name.endsWith('.ytdl')) continue
    const full = join(dir, name)
    const s = await stat(full)
    if (s.isFile()) candidates.push({ full, size: s.size })
  }
  if (!candidates.length) throw new Error('No output file produced.')
  candidates.sort((a, b) => b.size - a.size)
  return candidates[0].full
}
