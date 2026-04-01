import { Router } from 'express';
import { createMemoryCache } from './cache.js';
import { getVideasyCacheKey, resolveVideasySource } from './providers.js';

const router = Router();
const cache = createMemoryCache();

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

    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const result = await resolveVideasySource(query);
    const proxiedResult = proxyVideasyResult(req, result);
    cache.set(cacheKey, proxiedResult);
    return res.json(proxiedResult);
  } catch (error) {
    const message = error?.message || 'Videasy resolve failed';
    const status = /required|must be/i.test(message) ? 400 : 404;
    return res.status(status).json({ error: message });
  }
});

export default router;
