import { Router } from 'express';
import { createDecipheriv, createHash } from 'node:crypto';
import { createCacheStore } from '../store/results.js';
import { extractVideoUrls } from '../workers/playwright.js';

const router = Router();
const cache = createCacheStore();
const vidfastHintCache = createCacheStore();
const vidzeeKeyCache = createCacheStore();
const ONE_HOUR_MS = 60 * 60 * 1000;
const SIX_HOURS_MS = 6 * ONE_HOUR_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const RESOLVE_TIMEOUT_MS = Number(process.env.RESOLVE_TIMEOUT_MS || 30000);
const VIDZEE_KEY_SECRET = '7c9e2b4a1f6d8a3e5';
const VIDZEE_SERVER_IDS = ['0', '1', '2', '3', '7', '6', '8', '9', '10', '11', '12'];

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

function isVideasyUrl(url) {
  return /player\.videasy\.net/i.test(String(url || ''));
}

function isVidzeeUrl(url) {
  return /player\.vidzee\.wtf\/v2\/embed\//i.test(String(url || ''));
}

function getProviderKeyFromUrl(url) {
  if (isVidfastUrl(url)) return 'vidfast';
  if (isVideasyUrl(url)) return 'videasy';
  if (isVidzeeUrl(url)) return 'vidzee';
  return null;
}

function parseVidzeeEmbedUrl(url) {
  try {
    const { pathname } = new URL(url);
    const parts = pathname.split('/').filter(Boolean);

    if (parts[0] !== 'v2' || parts[1] !== 'embed') {
      return null;
    }

    if (parts[2] === 'movie' && parts[3]) {
      return { type: 'movie', id: parts[3] };
    }

    if (parts[2] === 'tv' && parts[3] && parts[4] && parts[5]) {
      return { type: 'tv', id: parts[3], season: parts[4], episode: parts[5] };
    }
  } catch {
    return null;
  }

  return null;
}

async function getVidzeeApiKey() {
  const cached = vidzeeKeyCache.get('vidzee:api-key');
  if (cached) {
    return cached;
  }

  const response = await fetch('https://core.vidzee.wtf/api-key');
  if (!response.ok) {
    throw new Error('VIDZEE_KEY_FETCH_FAILED');
  }

  const encrypted = (await response.text()).trim();
  const payload = Buffer.from(encrypted.replace(/\s+/g, ''), 'base64');

  if (payload.length <= 28) {
    throw new Error('VIDZEE_KEY_INVALID');
  }

  const iv = payload.subarray(0, 12);
  const authTag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const key = createHash('sha256').update(VIDZEE_KEY_SECRET, 'utf8').digest();
  const decipher = createDecipheriv('aes-256-gcm', key, iv);

  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, undefined, 'utf8');
  decrypted += decipher.final('utf8');

  vidzeeKeyCache.set('vidzee:api-key', decrypted, ONE_DAY_MS);
  return decrypted;
}

function decryptVidzeeStreamLink(encodedLink, apiKey) {
  const decoded = Buffer.from(String(encodedLink || ''), 'base64').toString('utf8');
  const [ivBase64, cipherBase64] = decoded.split(':');

  if (!ivBase64 || !cipherBase64) {
    return null;
  }

  const iv = Buffer.from(ivBase64, 'base64');
  const key = Buffer.from(String(apiKey || '').padEnd(32, '\0').slice(0, 32), 'utf8');
  const decipher = createDecipheriv('aes-256-cbc', key, iv);

  let decrypted = decipher.update(cipherBase64, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted || null;
}

async function tryResolveVidzeeDirect(sourceUrl) {
  const parsed = parseVidzeeEmbedUrl(sourceUrl);
  if (!parsed?.id) {
    return null;
  }

  const apiKey = await getVidzeeApiKey();

  for (const serverId of VIDZEE_SERVER_IDS) {
    const apiUrl = new URL('https://player.vidzee.wtf/api/server');
    apiUrl.searchParams.set('id', parsed.id);
    apiUrl.searchParams.set('sr', serverId);

    if (parsed.type === 'tv') {
      apiUrl.searchParams.set('ss', parsed.season);
      apiUrl.searchParams.set('ep', parsed.episode);
    }

    try {
      const response = await fetch(apiUrl, {
        headers: {
          accept: 'application/json, text/plain, */*',
          origin: 'https://player.vidzee.wtf',
          referer: sourceUrl,
          'user-agent': 'Mozilla/5.0'
        }
      });

      if (!response.ok) {
        continue;
      }

      const payload = await response.json();
      const candidates = Array.isArray(payload?.url) ? payload.url : [];

      for (const candidate of candidates) {
        const streamUrl = decryptVidzeeStreamLink(candidate?.link, apiKey);
        if (!streamUrl) {
          continue;
        }

        return {
          success: true,
          url: streamUrl,
          stream: streamUrl,
          type: String(candidate?.type || '').toUpperCase() === 'HLS' ? 'HLS' : streamUrl.includes('.mp4') ? 'MP4' : 'STREAM',
          headers: normalizeHeaders({
            ...(payload?.headers || {}),
            referer: sourceUrl,
            origin: 'https://player.vidzee.wtf'
          }),
          provider: 'vidzee',
          sourceUrl,
          qualities: []
        };
      }
    } catch {
      // Try the next VidZee server.
    }
  }

  return null;
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
            provider: 'vidfast',
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
          provider: 'vidfast',
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

  if (isVidzeeUrl(url)) {
    const directResult = await tryResolveVidzeeDirect(url).catch(() => null);
    if (directResult) {
      cache.set(cacheKey, directResult, ONE_HOUR_MS);
      console.log(new Date().toISOString(), '[resolve] vidzee direct success', directResult.url);
      return res.json(directResult);
    }
  }

  try {
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('STREAM_NOT_FOUND'));
      }, isVidfastUrl(url) ? 75000 : isVidzeeUrl(url) ? 24000 : isVideasyUrl(url) ? 18000 : RESOLVE_TIMEOUT_MS);

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
            provider: getProviderKeyFromUrl(url),
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
          : isVidzeeUrl(url)
          ? { settleTimeout: 2500, navigationTimeout: 30000, minWaitAfterLoad: 5000, maxWaitAfterLoad: 15000 }
          : isVideasyUrl(url)
          ? { settleTimeout: 2000, navigationTimeout: 30000, minWaitAfterLoad: 6000, maxWaitAfterLoad: 12000 }
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
