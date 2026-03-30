import { Router } from 'express';

const router = Router();

function normalizeHeaders(headers = {}) {
  return Object.entries(headers).reduce((acc, [key, value]) => {
    if (typeof value === 'string' && value) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function filterForwardHeaders(headers = {}) {
  const allowed = new Set(['referer', 'origin', 'user-agent', 'cookie', 'range', 'accept', 'accept-language']);
  return Object.entries(normalizeHeaders(headers)).reduce((acc, [key, value]) => {
    if (allowed.has(key)) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function parseEmbeddedHeaders(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    const embedded = parsed.searchParams.get('headers');
    if (!embedded) {
      return {};
    }

    return filterForwardHeaders(JSON.parse(embedded));
  } catch {
    return {};
  }
}

function buildAbsolutePlaylistUrl(playlistUrl, candidatePath) {
  const resolved = new URL(candidatePath, playlistUrl);
  const base = new URL(playlistUrl);

  for (const key of ['headers', 'host']) {
    if (!resolved.searchParams.has(key) && base.searchParams.has(key)) {
      resolved.searchParams.set(key, base.searchParams.get(key));
    }
  }

  return resolved.toString();
}

function getProxyBaseUrl(req) {
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
  return `${protocol}://${req.get('host')}${req.baseUrl || '/proxy'}`;
}

function buildProxyUrl(proxyBaseUrl, targetUrl, headers = {}) {
  const proxied = new URL(proxyBaseUrl);
  proxied.searchParams.set('url', targetUrl);

  const normalizedHeaders = normalizeHeaders(headers);
  if (Object.keys(normalizedHeaders).length) {
    proxied.searchParams.set('headers', JSON.stringify(normalizedHeaders));
  }

  return proxied.toString();
}

function isPlaylistResponse(targetUrl, contentType = '') {
  return /mpegurl|application\/vnd\.apple\.mpegurl|audio\/mpegurl/i.test(contentType) || /\.m3u8(\?|$)/i.test(String(targetUrl || ''));
}

function rewritePlaylistBody(body, playlistUrl, proxyBaseUrl, forwardedHeaders = {}) {
  return String(body || '')
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        return line;
      }

      const nextUrl = buildAbsolutePlaylistUrl(playlistUrl, trimmed);
      return buildProxyUrl(proxyBaseUrl, nextUrl, forwardedHeaders);
    })
    .join('\n');
}

router.get('/', async (req, res) => {
  const targetUrl = String(req.query.url || '').trim();
  if (!targetUrl) {
    return res.status(400).json({ error: 'url required' });
  }

  let parsedHeaders = {};
  if (req.query.headers) {
    try {
      parsedHeaders = filterForwardHeaders(JSON.parse(String(req.query.headers)));
    } catch {
      return res.status(400).json({ error: 'invalid headers' });
    }
  }

  const upstreamHeaders = {
    ...parsedHeaders,
    ...parseEmbeddedHeaders(targetUrl),
  };

  try {
    const upstream = await fetch(targetUrl, {
      headers: upstreamHeaders,
    });

    if (!upstream.ok) {
      return res.status(upstream.status).send(await upstream.text());
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=60');

    if (isPlaylistResponse(targetUrl, contentType)) {
      const playlistBody = await upstream.text();
      const rewritten = rewritePlaylistBody(playlistBody, targetUrl, getProxyBaseUrl(req), upstreamHeaders);
      return res.send(rewritten);
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    return res.send(buffer);
  } catch (error) {
    return res.status(502).json({ error: error?.message || 'proxy failed' });
  }
});

export default router;
