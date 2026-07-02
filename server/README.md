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
