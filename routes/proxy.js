const express = require('express');
const { absoluteUrl, client } = require('../utils/request');

const router = express.Router();

function createError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function encodeHeaders(headers = {}) {
  return Buffer.from(JSON.stringify(headers), 'utf8').toString('base64url');
}

function decodeHeaders(value) {
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function normalizeHeaderName(name) {
  return String(name || '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('-');
}

function normalizeHeaders(headers = {}) {
  return Object.entries(headers || {}).reduce((result, [key, value]) => {
    if (value === undefined || value === null || value === '') {
      return result;
    }

    result[normalizeHeaderName(key)] = String(value);
    return result;
  }, {});
}

function decodeTargetUrl(value) {
  let current = String(value || '');

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) {
        break;
      }
      current = decoded;
    } catch {
      break;
    }
  }

  return current;
}

function extractEmbeddedTargetHeaders(parsedUrl) {
  try {
    const rawHeaders = parsedUrl.searchParams.get('headers');
    return rawHeaders ? normalizeHeaders(JSON.parse(rawHeaders)) : {};
  } catch {
    return {};
  }
}

function buildProxyUrl(req, targetUrl, headers) {
  let proxyPath = '/proxy/media';

  try {
    const parsedTarget = new URL(targetUrl);
    const pathname = parsedTarget.pathname || '';
    const lastSegment = pathname.split('/').filter(Boolean).pop() || 'media';
    proxyPath = `/proxy/${lastSegment}`;
  } catch {
    proxyPath = '/proxy/media';
  }

  const url = new URL(`${req.protocol}://${req.get('host')}${proxyPath}`);
  url.searchParams.set('url', targetUrl);

  if (headers && Object.keys(headers).length > 0) {
    url.searchParams.set('headers', encodeHeaders(headers));
  }

  return url.toString();
}

function rewriteManifestLine(line, baseUrl, req, headers) {
  const trimmed = line.trim();

  if (!trimmed) {
    return line;
  }

  if (trimmed.startsWith('#')) {
    return line.replace(/URI="([^"]+)"/g, (_match, uri) => {
      const absolute = absoluteUrl(baseUrl, uri);
      return absolute ? `URI="${buildProxyUrl(req, absolute, headers)}"` : `URI="${uri}"`;
    });
  }

  const absolute = absoluteUrl(baseUrl, trimmed);
  return absolute ? buildProxyUrl(req, absolute, headers) : line;
}

async function handleProxy(req, res, next) {
  const targetUrl = decodeTargetUrl(req.query.url);

  if (!targetUrl) {
    return next(createError(400, 'MISSING_PROXY_URL', 'Missing url query parameter'));
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(String(targetUrl));
  } catch {
    return next(createError(400, 'INVALID_PROXY_URL', 'The provided proxy url is not valid'));
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return next(createError(400, 'INVALID_PROXY_PROTOCOL', 'Only HTTP and HTTPS proxy targets are supported'));
  }

  const forwardedHeaders = normalizeHeaders(decodeHeaders(req.query.headers));
  const embeddedHeaders = extractEmbeddedTargetHeaders(parsedUrl);
  const referer = forwardedHeaders.Referer || embeddedHeaders.Referer || 'https://videostr.net/';
  const origin = forwardedHeaders.Origin || embeddedHeaders.Origin || 'https://videostr.net';
  const upstreamHeaders = {
    ...embeddedHeaders,
    ...forwardedHeaders,
    Referer: referer,
    Origin: origin,
    'User-Agent':
      forwardedHeaders['User-Agent'] ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: forwardedHeaders.Accept || '*/*',
    'Accept-Language': forwardedHeaders['Accept-Language'] || embeddedHeaders['Accept-Language'] || 'en-US,en;q=0.9',
    Connection: forwardedHeaders.Connection || 'keep-alive',
    'Sec-Fetch-Dest': forwardedHeaders['Sec-Fetch-Dest'] || embeddedHeaders['Sec-Fetch-Dest'] || undefined,
    'Sec-Fetch-Mode': forwardedHeaders['Sec-Fetch-Mode'] || embeddedHeaders['Sec-Fetch-Mode'] || undefined,
    'Sec-Fetch-Site': forwardedHeaders['Sec-Fetch-Site'] || embeddedHeaders['Sec-Fetch-Site'] || undefined,
    Range: req.get('range') || undefined,
  };

  try {
    const response = await client.get(parsedUrl.toString(), {
      headers: upstreamHeaders,
      responseType: 'stream',
      validateStatus: () => true,
    });

    const contentType = String(response.headers['content-type'] || '');
    const isManifest = parsedUrl.pathname.includes('.m3u8') || contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegurl');

    if (isManifest) {
      const chunks = [];

      response.data.on('data', (chunk) => chunks.push(chunk));
      response.data.on('error', next);
      response.data.on('end', () => {
        const manifest = Buffer.concat(chunks).toString('utf8');
        const trimmedManifest = manifest.trim();

        if (!trimmedManifest.startsWith('#EXTM3U')) {
          console.warn(`${new Date().toISOString()} [proxy] non-hls-manifest`, {
            target: parsedUrl.toString(),
            preview: trimmedManifest.slice(0, 180),
          });
        }

        const rewritten = manifest
          .split('\n')
          .map((line) => rewriteManifestLine(line, parsedUrl.toString(), req, upstreamHeaders))
          .join('\n');

        res.status(response.status);
        res.setHeader('content-type', 'application/vnd.apple.mpegurl');
        res.setHeader('cache-control', 'public, max-age=60');
        res.setHeader('access-control-allow-origin', '*');
        res.send(rewritten);
      });
      return;
    }

    res.status(response.status);

    for (const [headerName, headerValue] of Object.entries(response.headers)) {
      if (['transfer-encoding', 'content-encoding', 'connection'].includes(headerName.toLowerCase())) {
        continue;
      }

      if (headerValue !== undefined) {
        res.setHeader(headerName, headerValue);
      }
    }

    response.data.pipe(res);
  } catch (error) {
    return next(createError(502, 'PROXY_REQUEST_FAILED', error.message || 'Proxy request failed'));
  }
}

router.get('/', handleProxy);
router.get('/:filename', handleProxy);

module.exports = {
  router,
  buildProxyUrl,
  decodeHeaders,
  encodeHeaders,
};
