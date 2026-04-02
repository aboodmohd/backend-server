import { Router } from 'express';
import { ProxyAgent } from 'undici';

const router = Router();
const playbackProxyUrl = process.env.PLAYBACK_PROXY_URL || process.env.RESIDENTIAL_PROXY_URL || '';
const playbackProxyAgent = playbackProxyUrl ? new ProxyAgent(playbackProxyUrl) : null;
const EMBEDDED_HEADERS_PARAM = '__proxy_headers';
const EMBEDDED_HOST_PARAM = '__proxy_host';

function normalizeHeaders(headers = {}) {
  return Object.entries(headers).reduce((acc, [key, value]) => {
    if (typeof value === 'string' && value) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function filterForwardHeaders(headers = {}) {
  const allowed = new Set(['referer', 'origin', 'user-agent', 'range']);
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
    const embedded = parsed.searchParams.get(EMBEDDED_HEADERS_PARAM);
    if (!embedded) {
      return {};
    }

    return filterForwardHeaders(JSON.parse(embedded));
  } catch {
    return {};
  }
}

function hasEmbeddedProxyParams(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    return parsed.searchParams.has(EMBEDDED_HEADERS_PARAM) || parsed.searchParams.has(EMBEDDED_HOST_PARAM);
  } catch {
    return false;
  }
}

function parseEmbeddedHost(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    const embeddedHost = parsed.searchParams.get(EMBEDDED_HOST_PARAM);
    if (!embeddedHost) {
      return '';
    }

    return embeddedHost.includes('://') ? new URL(embeddedHost).host : embeddedHost;
  } catch {
    return '';
  }
}

function parseEmbeddedHostUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    const embeddedHost = parsed.searchParams.get(EMBEDDED_HOST_PARAM);
    if (!embeddedHost) {
      return null;
    }

    return new URL(embeddedHost.includes('://') ? embeddedHost : `https://${embeddedHost}`);
  } catch {
    return null;
  }
}

function stripEmbeddedProxyParams(targetUrl) {
  const parsed = new URL(targetUrl);
  parsed.searchParams.delete(EMBEDDED_HEADERS_PARAM);
  parsed.searchParams.delete(EMBEDDED_HOST_PARAM);
  return parsed.toString();
}

function applyEmbeddedHost(targetUrl, embeddedHostUrl) {
  if (!embeddedHostUrl) {
    return targetUrl;
  }

  const parsed = new URL(targetUrl);
  parsed.protocol = embeddedHostUrl.protocol;
  parsed.host = embeddedHostUrl.host;
  return parsed.toString();
}

function buildAbsolutePlaylistUrl(playlistUrl, candidatePath) {
  const resolved = new URL(candidatePath, playlistUrl);
  const base = new URL(playlistUrl);

  for (const key of [EMBEDDED_HEADERS_PARAM, EMBEDDED_HOST_PARAM, 'headers', 'host']) {
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

  if (hasEmbeddedProxyParams(targetUrl)) {
    return proxied.toString();
  }

  const normalizedHeaders = filterForwardHeaders(headers);
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

  let upstreamUrl = targetUrl;
  try {
    upstreamUrl = stripEmbeddedProxyParams(targetUrl);
  } catch {
    return res.status(400).json({ error: 'invalid url' });
  }

  const embeddedHostUrl = parseEmbeddedHostUrl(targetUrl);
  if (embeddedHostUrl) {
    upstreamUrl = applyEmbeddedHost(upstreamUrl, embeddedHostUrl);
  }

  const embeddedHeaders = parseEmbeddedHeaders(targetUrl);
  const useEmbeddedHeaders = hasEmbeddedProxyParams(targetUrl);
  const upstreamHeaders = useEmbeddedHeaders
    ? { ...embeddedHeaders }
    : {
        ...parsedHeaders,
        ...embeddedHeaders,
      };
  const embeddedHost = parseEmbeddedHost(targetUrl);

  if (!upstreamHeaders['user-agent']) {
    upstreamHeaders['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
  }

  if (!upstreamHeaders.accept) {
    upstreamHeaders.accept = '*/*';
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      redirect: 'follow',
      headers: upstreamHeaders,
      dispatcher: playbackProxyAgent || undefined,
    });

    console.log(new Date().toISOString(), '[proxy] upstream', upstream.status, upstreamUrl, embeddedHost ? `target-host=${embeddedHost}` : '');

    if (!upstream.ok) {
      return res.status(upstream.status).send(await upstream.text());
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=60');

    if (isPlaylistResponse(targetUrl, contentType)) {
      const playlistBody = await upstream.text();
      const rewritten = rewritePlaylistBody(
        playlistBody,
        targetUrl,
        getProxyBaseUrl(req),
        useEmbeddedHeaders ? {} : upstreamHeaders
      );
      return res.send(rewritten);
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    return res.send(buffer);
  } catch (error) {
    return res.status(502).json({ error: error?.message || 'proxy failed' });
  }
});

export default router;
