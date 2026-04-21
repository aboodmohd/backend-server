# Render Deploy

This backend is already compatible with the frontend player contract.

The frontend sends:

```http
POST /resolve
Content-Type: application/json
```

Example body:

```json
{
  "url": "https://vidlink.pro/movie/786892"
}
```

The backend returns a resolved stream object and already rewrites header-sensitive playback URLs through `/proxy` when needed.

## Recommended deploy mode

Use Docker on Render.

Reason:

- this backend uses Playwright + Chromium
- Docker is more reliable than Render's native Node runtime for browser dependencies

The repo now includes:

- [Dockerfile](/Users/abdullahmohd/Desktop/backend-server-repo/Dockerfile)
- [render.yaml](/Users/abdullahmohd/Desktop/backend-server-repo/render.yaml)

## Steps

1. Push this repo to GitHub.
2. In Render, create a new `Blueprint` or `Web Service` from the repo.
3. If using Blueprint, Render will pick up `render.yaml`.
4. Set any environment variables you need.

## Important environment variables

Required if you want TMDB-powered helper routes like `/nova/servers`:

- `TMDB_API_KEY`

Optional but often useful for provider stability:

- `RESIDENTIAL_PROXY_URL`
- `PLAYBACK_PROXY_URL`
- `VIDZEE_KEY_SECRET`
- `VIDROCK_TMDB_API_KEY`
- `RESOLVE_TIMEOUT_MS`
- `NOVA_SKIP_BROWSER_WARMUP`

## Health check

Render health check path:

```txt
/health
```

## Frontend setup

In your frontend `.env`:

```bash
VITE_STREAM_API_BASE=https://your-render-service.onrender.com
```

Then restart Vite.

## Test after deploy

Health:

```bash
curl https://your-render-service.onrender.com/health
```

Resolve endpoint:

```bash
curl -X POST https://your-render-service.onrender.com/resolve \
  -H 'content-type: application/json' \
  -d '{"url":"https://vidlink.pro/movie/786892"}'
```

Expected success shape will include fields like:

- `url`
- `stream`
- `type`
- `headers`
- `qualities`

## Frontend compatibility

The frontend player I updated supports:

- direct `mp4`
- `m3u8`
- HLS via `hls.js`

If the backend returns an HLS playlist that needs headers, this backend already proxies it through `/proxy`, which is the correct approach.

If the backend returns a direct MP4 that needs request headers, browsers cannot attach arbitrary headers to a `<video>` tag request. In that case the backend must proxy the MP4 as well or return a playable public URL.
