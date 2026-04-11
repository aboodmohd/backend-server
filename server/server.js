import { Router } from 'express';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryCache } from './cache.js';
import { getVideasyCacheKey } from './providers.js';
import { buildVideasyPlaybackUrl, resolveStream } from '../src/routes/resolve.js';

const router = Router();
const currentDir = dirname(fileURLToPath(import.meta.url));
const VIDEASY_CACHE_TTL_MS = Math.max(1, Number(process.env.RESOLVE_CACHE_TTL_MS || 6 * 60 * 60 * 1000) || 6 * 60 * 60 * 1000);
const cache = createMemoryCache(VIDEASY_CACHE_TTL_MS, {
  persistPath: process.env.VIDEASY_CACHE_PATH || resolvePath(currentDir, '../.cache/videasy-cache.json')
});

function getProxyBaseUrl(req) {
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
  return `${protocol}://${req.get('host')}/proxy`;
}

function buildProxyUrl(req, targetUrl, headers = {}) {
  const url = new URL(getProxyBaseUrl(req));
  url.searchParams.set('url', targetUrl);

  const normalizedHeaders = Object.entries(headers).reduce((acc, [key, value]) => {
    if (typeof value === 'string' && value) {
      acc[String(key).toLowerCase()] = value;
    }
    return acc;
  }, {});

  if (Object.keys(normalizedHeaders).length) {
    url.searchParams.set('headers', JSON.stringify(normalizedHeaders));
  }

  return url.toString();
}

function proxyVideasyResult(req, result) {
  const rewriteEntry = (entry = {}) => {
    if (!entry?.url) {
      return entry;
    }

    return {
      ...entry,
      url: buildProxyUrl(req, entry.url, entry.headers || result.headers || {}),
    };
  };

  return {
    ...result,
    stream: result.stream ? buildProxyUrl(req, result.stream, result.headers || {}) : result.stream,
    url: result.url ? buildProxyUrl(req, result.url, result.headers || {}) : result.url,
    qualities: Array.isArray(result.qualities) ? result.qualities.map(rewriteEntry) : [],
  };
}

router.get('/', async (req, res) => {
  try {
    const shouldRefresh = String(req.query.refresh || '').trim() === '1';
    const query = {
      title: req.query.title,
      year: req.query.year,
      tmdbId: req.query.tmdbId,
      imdbId: req.query.imdbId,
      mediaType: req.query.mediaType,
      season: req.query.season,
      episode: req.query.episode,
    };

    const cacheKey = getVideasyCacheKey({
      tmdbId: Number(query.tmdbId),
      mediaType: String(query.mediaType || '').toLowerCase(),
      season: query.season ? Number(query.season) : null,
      episode: query.episode ? Number(query.episode) : null,
    });

    const cached = shouldRefresh ? null : cache.get(cacheKey);
    if (cached) {
      return res.json({ ...proxyVideasyResult(req, cached), cached: true });
    }

    const playbackUrl = buildVideasyPlaybackUrl(query);
    const result = await resolveStream(playbackUrl);
    cache.set(cacheKey, result, VIDEASY_CACHE_TTL_MS);
    return res.json(proxyVideasyResult(req, result));
  } catch (error) {
    const message = error?.message || 'Videasy resolve failed';
    const statusCode = Number(error?.statusCode);
    const status = Number.isInteger(statusCode) && statusCode >= 400
      ? statusCode
      : (/required|must be/i.test(message) ? 400 : 404);
    return res.status(status).json({ error: message });
  }
});

export default router;
