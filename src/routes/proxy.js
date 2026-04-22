import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import { ProxyAgent } from 'undici';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

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
  const allowed = new Set(['referer', 'origin', 'user-agent', 'range', 'cookie']);
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
    // Handle double-encoded values (e.g. %7B instead of {)
    let decoded = embedded;
    try {
      decoded = decodeURIComponent(embedded);
    } catch {}
    return filterForwardHeaders(JSON.parse(decoded));
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

function shouldPreserveEmbeddedProxyParams(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    return /\/proxy\/file2\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function stripEmbeddedProxyParams(targetUrl) {
  if (shouldPreserveEmbeddedProxyParams(targetUrl)) {
    return targetUrl;
  }

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
  const preserveEmbeddedProxyParams = shouldPreserveEmbeddedProxyParams(targetUrl);
  try {
    upstreamUrl = stripEmbeddedProxyParams(targetUrl);
  } catch {
    setProxyLogMode(res, 'error');
    return res.status(400).json({ error: 'invalid url' });
  }

  const embeddedHeaders = parseEmbeddedHeaders(targetUrl); // reads from targetUrl BEFORE stripping
  const useEmbeddedHeaders = hasEmbeddedProxyParams(targetUrl);

  // FIX: Extract headers embedded in the storm URL from targetUrl (before stripping),
  // not from upstreamUrl (after stripping) where they're already gone.
  let stormUrlHeaders = {};
  try {
    const stormParsed = new URL(targetUrl); // <-- targetUrl, not upstreamUrl
    const headersParam = stormParsed.searchParams.get('headers');
    if (headersParam) {
      let decoded = headersParam;
      try { decoded = decodeURIComponent(headersParam); } catch {}
      stormUrlHeaders = filterForwardHeaders(JSON.parse(decoded));
    }
  } catch {}

  const requestHeaders = filterForwardHeaders({
    range:
      isPlaylistResponse(targetUrl) || isPlaylistResponse(upstreamUrl)
        ? ''
        : (typeof req.headers.range === 'string' ? req.headers.range : '')
  });

  // FIX: Always include parsedHeaders (contains user-agent from client).
  // Previously parsedHeaders was dropped when useEmbeddedHeaders was true.
  const upstreamHeaders = {
    ...parsedHeaders,
    ...stormUrlHeaders,
    ...embeddedHeaders,
    ...requestHeaders,
  };

  const embeddedHost = preserveEmbeddedProxyParams ? '' : parseEmbeddedHost(targetUrl);

  if (!upstreamHeaders['user-agent']) {
    upstreamHeaders['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
  }

  if (!upstreamHeaders.accept) {
    upstreamHeaders.accept = '*/*';
  }

  if (!upstreamHeaders['accept-encoding']) {
    upstreamHeaders['accept-encoding'] = 'identity';
  }

  // Some CDNs now require sec-fetch-* headers to distinguish browser requests
  if (!upstreamHeaders['sec-fetch-site']) {
    upstreamHeaders['sec-fetch-site'] = 'cross-site';
  }
  if (!upstreamHeaders['sec-fetch-mode']) {
    upstreamHeaders['sec-fetch-mode'] = 'no-cors';
  }
  if (!upstreamHeaders['sec-fetch-dest']) {
    upstreamHeaders['sec-fetch-dest'] = 'video';
  }

  if (embeddedHost && !upstreamHeaders.host) {
    upstreamHeaders.host = embeddedHost;
  }

  console.log(new Date().toISOString(), '[proxy] headers:', JSON.stringify(upstreamHeaders));

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
    // If the storm proxy URL specifies a target host, connect directly to it
    // so Node.js sends the correct Host header (fetch() won't let us override Host)
    let effectiveUrl = upstreamUrl;
    if (embeddedHost) {
      try {
        const targetHost = new URL(embeddedHost);
        const originalParsed = new URL(upstreamUrl);
        originalParsed.hostname = targetHost.hostname;
        // Remove storm-specific params that the target CDN doesn't need
        if (!preserveEmbeddedProxyParams) {
          originalParsed.searchParams.delete('headers');
          originalParsed.searchParams.delete('host');
          originalParsed.searchParams.delete(EMBEDDED_HEADERS_PARAM);
          originalParsed.searchParams.delete(EMBEDDED_HOST_PARAM);
        }
        effectiveUrl = originalParsed.toString();
        console.log(new Date().toISOString(), '[proxy] direct host URL:', effectiveUrl);
      } catch {
        // Fall through to original URL
      }
    }

    let upstream = null;

    for (let attempt = 1; attempt <= PROXY_RETRY_ATTEMPTS; attempt += 1) {
      try {
        // Use https.request directly — gives us full control over headers including Host
        const parsedUrl = new URL(effectiveUrl);
        const isHttps = parsedUrl.protocol === 'https:';
        const nodeReq = isHttps ? httpsRequest : httpRequest;

        upstream = await new Promise((resolve, reject) => {
          const req = nodeReq({
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: upstreamHeaders,
            timeout: 30000,
          }, (res) => {
            // Convert IncomingMessage to a fetch-like Response object
            const bodyStream = Readable.from(res);
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              statusText: res.statusMessage,
              headers: res.headers,
              body: bodyStream,
              text: () => new Promise((resolveText) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => resolveText(data));
              }),
              arrayBuffer: () => new Promise((resolveBuf) => {
                const chunks = [];
                res.on('data', (chunk) => { chunks.push(chunk); });
                res.on('end', () => resolveBuf(Buffer.concat(chunks)));
              }),
            });
          });

          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
          req.end();
        });

        // Normalize headers to a Headers-like object for downstream compatibility
        const rawHeaders = upstream.headers;
        upstream.headers = {
          get: (name) => {
            const key = name.toLowerCase();
            // Handle both array and string forms
            const val = rawHeaders[key];
            return Array.isArray(val) ? val.join(', ') : val || null;
          },
        };

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
      const body = await upstream.text();
      console.log(
        new Date().toISOString(),
        '[proxy] upstream',
        upstream.status,
        upstreamUrl,
        embeddedHost ? `target-host=${embeddedHost}` : '',
        `content-type=${upstream.headers.get('content-type') || 'unknown'}`,
        `preview=${body.slice(0, 300).replace(/\s+/g, ' ')}`
      );
      return res.status(upstream.status).send(body);
    }

    const upstreamContentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const contentType =
      !isPlaylistResponse(upstreamUrl, upstreamContentType) && isLikelyTransportSegment(upstreamUrl)
        ? 'video/mp2t'
        : upstreamContentType;
    const isPlaylist = isPlaylistResponse(targetUrl, contentType);
    setProxyLogMode(res, isPlaylist ? 'playlist' : 'asset');

    res.status(upstream.status);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=60');

    // FIX: Build rewritten playlist BEFORE logging its length.
    // Previously `rewritten` was logged before it was defined (ReferenceError).
    if (isPlaylist) {
      const playlistBody = await upstream.text();
      const segmentHeaders = useEmbeddedHeaders ? embeddedHeaders : upstreamHeaders;
      const rewritten = rewritePlaylistBody(
        playlistBody,
        targetUrl,
        getProxyBaseUrl(req),
        segmentHeaders
      );
      console.log(new Date().toISOString(), '[proxy] upstream', upstream.status, upstreamUrl, embeddedHost ? `target-host=${embeddedHost}` : '');
      console.log(new Date().toISOString(), '[proxy] playlist rewritten, length:', rewritten.length);
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

    const upstreamBody =
      typeof upstream.body?.getReader === 'function'
        ? Readable.fromWeb(upstream.body)
        : upstream.body;

    await pipeline(upstreamBody, res);
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
