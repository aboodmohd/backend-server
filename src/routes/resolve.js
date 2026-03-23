import { Router } from 'express';
import { createCacheStore } from '../store/results.js';
import { extractVideoUrls } from '../workers/playwright.js';

const router = Router();
const cache = createCacheStore();
const ONE_HOUR_MS = 60 * 60 * 1000;
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

  try {
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('STREAM_NOT_FOUND'));
      }, isVidfastUrl(url) ? 45000 : RESOLVE_TIMEOUT_MS);

      extractVideoUrls(
        url,
        (found) => {
          if (settled || !found?.url) {
            return;
          }

          console.log(new Date().toISOString(), '[resolve] found', found.type, found.via, found.url);

          settled = true;
          clearTimeout(timeoutId);
          resolve({
            success: true,
            url: found.url,
            stream: found.url,
            type: found.type,
            headers: normalizeHeaders(found.headers || {}),
            provider: null,
            sourceUrl: url,
            qualities: []
          });
        },
        isVidfastUrl(url)
          ? { settleTimeout: 4000, navigationTimeout: 45000, minWaitAfterLoad: 12000, maxWaitAfterLoad: 28000 }
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
