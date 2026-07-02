# Toolbox self-hosted backend

A zero-dependency Node server that ports the five Supabase edge functions
(`cors-proxy`, `soccer`, `alphavantage`, `fmp`, `morningstar`) so they run on
this machine and are reachable through the existing Cloudflare Tunnel. Routes
mirror Supabase exactly:

```
GET /functions/v1/cors-proxy
GET /functions/v1/soccer
GET /functions/v1/alphavantage
GET /functions/v1/fmp
GET /functions/v1/morningstar
GET /health        # liveness probe
```

Auth is unchanged: each user still brings their own upstream API key /
credentials, passed per request via headers and never persisted. The
`Authorization` / `apikey` headers the frontend sends (for Supabase's gateway)
are simply ignored here.

## Live deployment (as configured)

This is deployed and running. Concrete values for the current setup:

| What              | Value                                                          |
| ----------------- | -------------------------------------------------------------- |
| Host machine      | the fileserver box (same one running the `filesrv` tunnel)     |
| Repo checkout     | `/mnt/hdd/REPOS/toolbox` (backend lives in `server/`)          |
| Service           | `toolbox-backend.service` (systemd), listens on `127.0.0.1:8787` |
| Public URL        | `https://api.zacsvae.com/functions/v1` (via Cloudflare Tunnel) |
| Frontend wiring   | GitHub Pages build reads repo Variable `VITE_FUNCTIONS_URL`    |

The frontend and backend share **one repo**: the Vite app deploys to GitHub
Pages, and `server/` is checked out and run on the fileserver box. So a push to
`main` both rebuilds the site and is the source the backend pulls from — see
[Updating the backend](#updating-the-backend-cross-machine-workflow) below.

## Requirements

- Node ≥ 18 (uses global `fetch`, `Request`/`Response`, `atob`/`btoa`). This
  machine has Node 26.
- No `npm install` — there are no dependencies.

## Run it

```sh
cd server
cp .env.example .env      # optional; edit PORT / ALLOW_ORIGIN
npm start                 # -> http://127.0.0.1:8787
```

Config (all optional, via env or `.env`):

| Var            | Default     | Meaning                                             |
| -------------- | ----------- | --------------------------------------------------- |
| `PORT`         | `8787`      | Port to listen on (loopback).                       |
| `HOST`         | `127.0.0.1` | Bind address. Keep loopback — the tunnel is local.  |
| `ALLOW_ORIGIN` | `*`         | CORS allow-origin. Set to your site to lock it down.|

## Point the frontend at it

In the repo-root `.env` (the Vite app), set:

```sh
VITE_FUNCTIONS_URL=https://api.your-domain.com/functions/v1
```

No trailing slash. Leave it unset to keep using Supabase edge functions — the
frontend falls back to `${VITE_SUPABASE_URL}/functions/v1` automatically, so this
is a drop-in swap with a safe default. Rebuild the frontend after changing it
(`npm run build`), since Vite inlines env vars at build time.

Auth + config storage still go to Supabase (`utility_configs`, RLS) — only these
proxy/data functions move here.

## Run as a service (systemd)

Create `/etc/systemd/system/toolbox-backend.service` (run the editor with
`sudo`):

```ini
[Unit]
Description=Toolbox self-hosted backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=isaac
WorkingDirectory=/mnt/hdd/REPOS/toolbox/server
ExecStart=/usr/bin/node --env-file-if-exists=.env index.mjs
Restart=on-failure
RestartSec=3
# Hardening (optional but cheap):
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadOnlyPaths=/mnt/hdd/REPOS/toolbox/server

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now toolbox-backend
systemctl status toolbox-backend
curl -s http://127.0.0.1:8787/health   # {"ok":true,...}
```

> `node` path: confirm with `which node`. If you use `fnm`/`nvm`, point
> `ExecStart` at the absolute binary that version resolves to, since systemd has
> no shell profile.

## Expose it through the Cloudflare Tunnel

The `filesrv` tunnel already runs under systemd with a root-owned config at
`/etc/cloudflared/config.yml`. Add an ingress rule for the backend **above** the
catch-all, then a DNS route.

Edit the config (`sudo`):

```yaml
tunnel: c6a4f9e6-36f9-49f2-8274-0a396f107c53
credentials-file: /home/isaac/.cloudflared/c6a4f9e6-36f9-49f2-8274-0a396f107c53.json

ingress:
  - hostname: files.your-domain.com      # your existing fileserver
    service: http://localhost:<its-port>
  - hostname: api.your-domain.com         # NEW — this backend
    service: http://localhost:8787
  - service: http_status:404              # keep the catch-all last
```

Add the DNS record and restart:

```sh
cloudflared tunnel route dns filesrv api.your-domain.com
sudo systemctl restart cloudflared
```

Verify end to end:

```sh
curl -s https://api.your-domain.com/health
```

Then set `VITE_FUNCTIONS_URL=https://api.your-domain.com/functions/v1` in the
frontend `.env`, rebuild, and the utilities call this machine.

## Updating the backend (cross-machine workflow)

The backend runs from a git checkout on the fileserver box, so deploying a
change is **push from anywhere → pull + restart here**. You do NOT need to be
sitting at the fileserver to develop; you only need to apply the change there.

**If you build a new tool on another machine that needs new backend behaviour:**

1. On your dev machine — add/modify the function under `server/functions/`,
   register it (see below), commit, and `git push origin main`.
2. On the fileserver box — apply it:
   ```sh
   /mnt/hdd/REPOS/toolbox/server/deploy.sh
   ```
   That does `git pull --ff-only`, `sudo systemctl restart toolbox-backend`, and
   waits for `/health`. (Equivalent by hand: `cd /mnt/hdd/REPOS/toolbox &&
   git pull && sudo systemctl restart toolbox-backend`.)
3. The new frontend tool calls `${VITE_FUNCTIONS_URL}/<your-function>` — which
   already points at `https://api.zacsvae.com/functions/v1`, so no frontend
   config change is needed for a new endpoint on the existing backend.

> **Fully hands-off restarts (optional):** so `deploy.sh` never prompts for a
> sudo password, allow just that one restart without a password — run
> `sudo visudo -f /etc/sudoers.d/toolbox-backend` and add:
> `isaac ALL=(root) NOPASSWD: /usr/bin/systemctl restart toolbox-backend.service`

> **Remote-trigger (optional):** to redeploy without SSHing in, add a tiny
> authenticated `POST /deploy` route that runs `deploy.sh`, or (simpler/safer) a
> cron/systemd-timer on the box that runs `deploy.sh` every few minutes so
> pushes roll out on their own.

### Adding a new function

1. Create `server/functions/my-func.mjs` exporting
   `export async function handle({ url, header }) { ... }`. Return one of the
   `_shared.mjs` helpers: `json(body, status)` or `text(body, status)`. Read
   query params from `url.searchParams` and any credential headers via
   `header('x-...')`. These handlers are GET-only (no request body parsing).
2. Register it in [`index.mjs`](index.mjs): import the module and add it to the
   `ROUTES` map. If it reads a new credential header, add that header name to
   `ALLOW_HEADERS` so CORS preflight permits it.
3. Deploy with the workflow above. It's then live at
   `https://api.zacsvae.com/functions/v1/my-func`.

Because this is a long-running process (not per-request edge invocations), you
can also keep in-memory state across requests (caches, rate-limiters) — see the
Morningstar token cache for the pattern.

## Security notes

- These functions hold **no secrets** — users supply their own upstream keys per
  request, exactly as before. So a public endpoint mostly just lets a stranger
  spend *their own* API quota, or use `cors-proxy` against a 5-host whitelist
  (Google/Apple Maps). Low risk, same as the current Supabase setup.
- To lock the backend to your own site anyway, set `ALLOW_ORIGIN` to your site's
  origin. Note CORS is browser-enforced only; for a hard gate, add a
  Cloudflare Access policy on `api.your-domain.com`, or a shared-secret header
  check here (would require sending the secret from the frontend).
- Keep `HOST=127.0.0.1` so the server is reachable only via the tunnel, never
  directly on the LAN or a public port.

## Parity with the edge functions

Logic (soccer prediction model, Morningstar payload walking, provider
normalization) is copied verbatim; only the request/response wrapper changed.
One improvement: the Morningstar token cache lives in this long-running process,
so it persists across requests instead of per-invocation as on edge.
