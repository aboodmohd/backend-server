import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import { ProxyAgent } from 'undici';

const router = Router();
const playbackProxyUrl = process.env.PLAYBACK_PROXY_URL || process.env.RESIDENTIAL_PROXY_URL || '';
const playbackProxyAgent = playbackProxyUrl ? new ProxyAgent(playbackProxyUrl) : null;
const EMBEDDED_HEADERS_PARAM = '__proxy_headers';
const EMBEDDED_HOST_PARAM = '__proxy_host';
const LEGACY_HEADERS_PARAM = 'headers';
const LEGACY_HOST_PARAM = 'host';
const PROXY_RETRY_ATTEMPTS = 3;
const PROXY_RETRY_DELAY_MS = 250;

function getEmbeddedHeadersParam(parsedUrl) {
  return parsedUrl.searchParams.get(EMBEDDED_HEADERS_PARAM) || parsedUrl.searchParams.get(LEGACY_HEADERS_PARAM);
}

function getEmbeddedHostParam(parsedUrl) {
  return parsedUrl.searchParams.get(EMBEDDED_HOST_PARAM) || parsedUrl.searchParams.get(LEGACY_HOST_PARAM);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(statusCode) {
  return Number(statusCode) >= 500;
}

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
    const embedded = getEmbeddedHeadersParam(parsed);
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
    return (
      parsed.searchParams.has(EMBEDDED_HEADERS_PARAM) ||
      parsed.searchParams.has(EMBEDDED_HOST_PARAM) ||
      parsed.searchParams.has(LEGACY_HEADERS_PARAM) ||
      parsed.searchParams.has(LEGACY_HOST_PARAM)
    );
  } catch {
    return false;
  }
}

function parseEmbeddedHost(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    const embeddedHost = getEmbeddedHostParam(parsed);
    if (!embeddedHost) {
      return '';
    }

    return embeddedHost.includes('://') ? new URL(embeddedHost).host : embeddedHost;
  } catch {
    return '';
  }
}

function stripEmbeddedProxyParams(targetUrl) {
  const parsed = new URL(targetUrl);
  parsed.searchParams.delete(EMBEDDED_HEADERS_PARAM);
  parsed.searchParams.delete(EMBEDDED_HOST_PARAM);
  parsed.searchParams.delete(LEGACY_HEADERS_PARAM);
  parsed.searchParams.delete(LEGACY_HOST_PARAM);
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

function shouldForwardLengthMetadata(upstream) {
  return !String(upstream.headers.get('content-encoding') || '').trim();
}

function isLikelyTransportSegment(targetUrl) {
  try {
    const parsed = new URL(String(targetUrl || ''));
    const pathname = decodeURIComponent(parsed.pathname).toLowerCase();

    if (!pathname.includes('/file2/')) {
      return false;
    }

    return /\.(?:jpg|jpeg|png|webp|html|js|css|txt|ico)(?:$|\?)/i.test(pathname);
  } catch {
    return false;
  }
}

function setProxyLogMode(res, mode) {
  res.locals.proxyLogMode = mode;
}

function rewritePlaylistDirectiveUris(line, playlistUrl, proxyBaseUrl, forwardedHeaders = {}) {
  if (!/URI="/i.test(line)) {
    return line;
  }

  return line.replace(/URI="([^"]+)"/gi, (_match, uri) => {
    const nextUrl = buildAbsolutePlaylistUrl(playlistUrl, uri);
    return `URI="${buildProxyUrl(proxyBaseUrl, nextUrl, forwardedHeaders)}"`;
  });
}

function rewritePlaylistBody(body, playlistUrl, proxyBaseUrl, forwardedHeaders = {}) {
  return String(body || '')
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return line;
      }

      if (trimmed.startsWith('#')) {
        return rewritePlaylistDirectiveUris(line, playlistUrl, proxyBaseUrl, forwardedHeaders);
      }

      const nextUrl = buildAbsolutePlaylistUrl(playlistUrl, trimmed);
      return buildProxyUrl(proxyBaseUrl, nextUrl, forwardedHeaders);
    })
    .join('\n');
}

router.get('/', async (req, res) => {
  const targetUrl = String(req.query.url || '').trim();
  if (!targetUrl) {
    setProxyLogMode(res, 'error');
    return res.status(400).json({ error: 'url required' });
  }

  let parsedHeaders = {};
  if (req.query.headers) {
    try {
      parsedHeaders = filterForwardHeaders(JSON.parse(String(req.query.headers)));
    } catch {
      setProxyLogMode(res, 'error');
      return res.status(400).json({ error: 'invalid headers' });
    }
  }

  let upstreamUrl = targetUrl;
  try {
    upstreamUrl = stripEmbeddedProxyParams(targetUrl);
  } catch {
    setProxyLogMode(res, 'error');
    return res.status(400).json({ error: 'invalid url' });
  }

  const embeddedHeaders = parseEmbeddedHeaders(targetUrl);
  const useEmbeddedHeaders = hasEmbeddedProxyParams(targetUrl);
  const requestHeaders = filterForwardHeaders({
    range: typeof req.headers.range === 'string' ? req.headers.range : ''
  });
  const upstreamHeaders = useEmbeddedHeaders
    ? { ...embeddedHeaders, ...requestHeaders }
    : {
        ...parsedHeaders,
        ...embeddedHeaders,
        ...requestHeaders,
      };
  const embeddedHost = parseEmbeddedHost(targetUrl);

  if (!upstreamHeaders['user-agent']) {
    upstreamHeaders['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
  }

  if (!upstreamHeaders.accept) {
    upstreamHeaders.accept = '*/*';
  }

  if (!upstreamHeaders['accept-encoding']) {
    upstreamHeaders['accept-encoding'] = 'identity';
  }

  if (embeddedHost && !upstreamHeaders.host) {
    upstreamHeaders.host = embeddedHost;
  }

  const abortController = new AbortController();
  const abortUpstream = () => {
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
  };

  req.once('aborted', abortUpstream);
  res.once('close', () => {
    if (!res.writableEnded) {
      abortUpstream();
    }
  });

  try {
    let upstream = null;

    for (let attempt = 1; attempt <= PROXY_RETRY_ATTEMPTS; attempt += 1) {
      try {
        upstream = await fetch(upstreamUrl, {
          redirect: 'follow',
          headers: upstreamHeaders,
          dispatcher: playbackProxyAgent || undefined,
          signal: abortController.signal,
        });

        if (!isRetryableStatus(upstream.status) || attempt === PROXY_RETRY_ATTEMPTS) {
          break;
        }

        console.log(new Date().toISOString(), '[proxy] retry', upstream.status, upstreamUrl, `attempt=${attempt + 1}/${PROXY_RETRY_ATTEMPTS}`);
      } catch (error) {
        if (attempt === PROXY_RETRY_ATTEMPTS) {
          throw error;
        }

        console.log(new Date().toISOString(), '[proxy] retry', upstreamUrl, error?.message || String(error), `attempt=${attempt + 1}/${PROXY_RETRY_ATTEMPTS}`);
      }

      await sleep(PROXY_RETRY_DELAY_MS * attempt);
    }

    if (!upstream.ok) {
      setProxyLogMode(res, 'error');
      console.log(new Date().toISOString(), '[proxy] upstream', upstream.status, upstreamUrl, embeddedHost ? `target-host=${embeddedHost}` : '');
      return res.status(upstream.status).send(await upstream.text());
    }

    const upstreamContentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const contentType =
      !isPlaylistResponse(upstreamUrl, upstreamContentType) && isLikelyTransportSegment(upstreamUrl)
        ? 'video/mp2t'
        : upstreamContentType;
    const isPlaylist = isPlaylistResponse(targetUrl, contentType);
    setProxyLogMode(res, isPlaylist ? 'playlist' : 'asset');

    if (isPlaylist) {
      console.log(new Date().toISOString(), '[proxy] upstream', upstream.status, upstreamUrl, embeddedHost ? `target-host=${embeddedHost}` : '');
    }

    res.status(upstream.status);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=60');

    if (isPlaylist) {
      const playlistBody = await upstream.text();
      const rewritten = rewritePlaylistBody(
        playlistBody,
        targetUrl,
        getProxyBaseUrl(req),
        useEmbeddedHeaders ? {} : upstreamHeaders
      );
      return res.send(rewritten);
    }

    for (const headerName of ['accept-ranges', 'etag', 'last-modified']) {
      const headerValue = upstream.headers.get(headerName);
      if (headerValue) {
        res.setHeader(headerName, headerValue);
      }
    }

    if (shouldForwardLengthMetadata(upstream)) {
      for (const headerName of ['content-length', 'content-range']) {
        const headerValue = upstream.headers.get(headerName);
        if (headerValue) {
          res.setHeader(headerName, headerValue);
        }
      }
    }

    if (!upstream.body) {
      return res.end();
    }

    await pipeline(Readable.fromWeb(upstream.body), res);
    return;
  } catch (error) {
    if (req.aborted || res.destroyed || abortController.signal.aborted) {
      return;
    }

    setProxyLogMode(res, 'error');
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : undefined);
      return;
    }

    return res.status(502).json({ error: error?.message || 'proxy failed' });
  }
});

export default router;
