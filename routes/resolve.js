const express = require('express');
const { buildProxyUrl } = require('./proxy');
const universal = require('../extractors/universal');
const { extractQualities } = require('../utils/hls');
const { isMediaUrl } = require('../utils/request');

const router = express.Router();

function createError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizeHeaderName(name) {
  return String(name || '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('-');
}

function normalizeHeaders(headers) {
  return Object.entries(headers || {}).reduce((result, [key, value]) => {
    if (value === undefined || value === null || value === '') {
      return result;
    }

    result[normalizeHeaderName(key)] = String(value);
    return result;
  }, {});
}

function parseEmbeddedHeaders(streamUrl) {
  try {
    const parsedUrl = new URL(streamUrl);
    const rawHeaders = parsedUrl.searchParams.get('headers');

    if (!rawHeaders) {
      return {};
    }

    return normalizeHeaders(JSON.parse(rawHeaders));
  } catch {
    return {};
  }
}

async function resolveQualityOptions(req, streamUrl, headers) {
  if (!streamUrl || !streamUrl.toLowerCase().includes('.m3u8')) {
    return [];
  }

  try {
    const qualities = await extractQualities(streamUrl, headers);
    return qualities.map((quality) => ({
      ...quality,
      url: buildProxyUrl(req, quality.url, headers),
    }));
  } catch {
    return [];
  }
}

async function handleResolve(req, res, next) {
  const inputUrl = req.method === 'POST' ? req.body?.url : req.query.url;
  const quality = typeof (req.method === 'POST' ? req.body?.quality : req.query.quality) === 'string'
    ? (req.method === 'POST' ? req.body.quality : req.query.quality)
    : 'auto';

  if (!inputUrl) {
    return next(createError(400, 'MISSING_URL', 'Missing url query parameter'));
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(inputUrl);
  } catch {
    return next(createError(400, 'INVALID_URL', 'The provided url is not a valid absolute URL'));
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return next(createError(400, 'INVALID_PROTOCOL', 'Only HTTP and HTTPS URLs are supported'));
  }

  try {
    const result = await universal.resolve(parsedUrl.toString(), { quality });

    if (!result?.stream || (!isMediaUrl(result.stream) && result.stream === parsedUrl.toString())) {
      throw createError(502, 'INVALID_STREAM_RESULT', 'Resolver returned a page URL instead of a playable media stream');
    }

    const headers = {
      ...parseEmbeddedHeaders(result.stream),
      ...normalizeHeaders(result.headers || {}),
    };
    const proxiedUrl = buildProxyUrl(req, result.stream, headers);
    const qualities = await resolveQualityOptions(req, result.stream, headers);

    return res.json({
      success: true,
      stream: proxiedUrl,
      url: proxiedUrl,
      upstreamStream: result.stream,
      headers,
      qualities,
      subtitles: result.subtitles || [],
      source: result.source,
      provider: result.source,
      sourceUrl: parsedUrl.toString(),
      cached: Boolean(result.cached),
    });
  } catch (error) {
    return next(error);
  }
}

router.get('/', handleResolve);
router.post('/', handleResolve);

module.exports = router;
