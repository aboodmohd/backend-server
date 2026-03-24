import { Router } from 'express';
import { createCacheStore } from '../store/results.js';
import { extractVideoUrls } from '../workers/playwright.js';

const router = Router();
const cache = createCacheStore();
const vidfastHintCache = createCacheStore();
const ONE_HOUR_MS = 60 * 60 * 1000;
const SIX_HOURS_MS = 6 * ONE_HOUR_MS;
const RESOLVE_TIMEOUT_MS = Number(process.env.RESOLVE_TIMEOUT_MS || 30000);

function normalizeHeaders(headers = {}) {
  return Object.entries(headers).reduce((acc, [key, value]) => {
    if (typeof value === 'string' && value) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function isVidfastUrl(url) {
  return String(url || '').includes('vidfast.pro');
}

async function tryResolveVidfastFromHints(sourceUrl) {
  const hintEntry = vidfastHintCache.get(`vidfast:${sourceUrl}`);
  const requests = hintEntry?.vidfastRequests || [];

  if (!requests.length) {
    return null;
  }

  for (const request of requests) {
    try {
      const response = await fetch(request.url, {
        method: request.method || 'GET',
        headers: {
          accept: '*/*',
          'accept-language': 'en-US,en;q=0.9',
          origin: 'https://vidfast.pro',
          referer: 'https://vidfast.pro/',
          ...(request.headers || {})
        }
      });

      const contentType = response.headers.get('content-type') || '';
      const body = await response.text();

      if (!response.ok) {
        continue;
      }

      if (/https?:\/\/[^\s"']+\.m3u8/i.test(body)) {
        const match = body.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/i);
        if (match?.[0]) {
          return {
            success: true,
            url: match[0],
            stream: match[0],
            type: 'HLS',
            headers: normalizeHeaders(request.headers || {}),
            provider: 'vidfast-direct',
            sourceUrl,
            qualities: []
          };
        }
      }

      if (/mpegurl|dash\+xml|video\//i.test(contentType)) {
        return {
          success: true,
          url: request.url,
          stream: request.url,
          type: /dash\+xml/i.test(contentType) ? 'DASH' : 'HLS',
          headers: normalizeHeaders(request.headers || {}),
          provider: 'vidfast-direct',
          sourceUrl,
          qualities: []
        };
      }
    } catch {
      // fall through to browser extraction
    }
  }

  return null;
}

router.post('/', async (req, res) => {
  const { url } = req.body || {};

  console.log(new Date().toISOString(), '[resolve] incoming', url);

  if (!url) {
    return res.status(400).json({ success: false, error: 'url required' });
  }

  const cacheKey = `stream:${url}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    console.log(new Date().toISOString(), '[resolve] cache hit', url);
    return res.json({ ...cached, cached: true });
  }

  if (isVidfastUrl(url)) {
    const directResult = await tryResolveVidfastFromHints(url);
    if (directResult) {
      cache.set(cacheKey, directResult, ONE_HOUR_MS);
      console.log(new Date().toISOString(), '[resolve] vidfast direct cache hit', directResult.url);
      return res.json({ ...directResult, cached: true });
    }
  }

  try {
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('STREAM_NOT_FOUND'));
      }, isVidfastUrl(url) ? 75000 : RESOLVE_TIMEOUT_MS);

      extractVideoUrls(
        url,
        (found) => {
          if (settled || !found?.url) {
            return;
          }

          console.log(new Date().toISOString(), '[resolve] found', found.type, found.via, found.url);

          settled = true;
          clearTimeout(timeoutId);
          const resolved = {
            success: true,
            url: found.url,
            stream: found.url,
            type: found.type,
            headers: normalizeHeaders(found.headers || {}),
            provider: null,
            sourceUrl: url,
            qualities: []
          };

          if (isVidfastUrl(url) && found.resolverHints?.vidfastRequests?.length) {
            vidfastHintCache.set(`vidfast:${url}`, found.resolverHints, SIX_HOURS_MS);
          }

          resolve(resolved);
        },
        isVidfastUrl(url)
          ? { settleTimeout: 3000, navigationTimeout: 45000, minWaitAfterLoad: 4000, maxWaitAfterLoad: 18000 }
          : { settleTimeout: 2000, navigationTimeout: 30000, minWaitAfterLoad: 5000, maxWaitAfterLoad: 10000 }
      ).catch((error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        reject(error);
      });
    });

    cache.set(cacheKey, result, ONE_HOUR_MS);
    console.log(new Date().toISOString(), '[resolve] success', result.url);
    return res.json(result);
  } catch (error) {
    console.log(new Date().toISOString(), '[resolve] failed', error?.message || 'STREAM_NOT_FOUND');
    return res.status(404).json({
      success: false,
      error: error?.message || 'STREAM_NOT_FOUND'
    });
  }
});

export default router;
