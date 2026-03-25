import { Router } from 'express';
import { createCacheStore } from '../store/results.js';
import { detectType, extractStreamFromPayload } from '../interceptors/index.js';
import { fetchVideasyThroughProxy, shouldUseVideasyProxy } from '../utils/proxyFetch.js';
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

function isVideasyUrl(url) {
  return /player\.videasy\.net/i.test(String(url || ''));
}

function parseVideasySourceUrl(sourceUrl) {
  try {
    const parsed = new URL(sourceUrl);
    if (parsed.hostname !== 'player.videasy.net') {
      return null;
    }

    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts[0] === 'movie' && parts[1]) {
      return {
        mediaType: 'movie',
        tmdbId: parts[1],
        seasonId: '1',
        episodeId: '1'
      };
    }

    if (parts[0] === 'tv' && parts[1] && parts[2] && parts[3]) {
      return {
        mediaType: 'tv',
        tmdbId: parts[1],
        seasonId: parts[2],
        episodeId: parts[3]
      };
    }
  } catch {
    return null;
  }

  return null;
}

function getVideasyMetadataUrl(details) {
  return `https://db.videasy.net/3/${details.mediaType}/${details.tmdbId}?append_to_response=external_ids&language=en`;
}

function buildVideasyResolveParams(details, metadata) {
  const title = metadata?.title || metadata?.name || metadata?.original_title || metadata?.original_name;
  const releaseDate = metadata?.release_date || metadata?.first_air_date || '';
  const year = String(releaseDate).slice(0, 4);
  const imdbId = metadata?.external_ids?.imdb_id || '';

  if (!title || !year) {
    return null;
  }

  const params = new URLSearchParams({
    title,
    mediaType: details.mediaType,
    year,
    seasonId: details.seasonId,
    episodeId: details.episodeId,
    tmdbId: details.tmdbId
  });

  if (imdbId) {
    params.set('imdbId', imdbId);
  }

  return params;
}

function buildVideasyResolveUrls(details, metadata) {
  const params = buildVideasyResolveParams(details, metadata);
  if (!params) {
    return [];
  }

  return [
    `https://api.videasy.net/myflixerzupcloud/sources-with-title?${params.toString()}`,
    `https://api.videasy.net/cdn/sources-with-title?${params.toString()}`
  ];
}

async function tryResolveVideasyDirect(sourceUrl) {
  const details = parseVideasySourceUrl(sourceUrl);
  if (!details) {
    return null;
  }

  try {
    const metadataResponse = await fetch(getVideasyMetadataUrl(details), {
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        referer: sourceUrl,
        origin: 'https://player.videasy.net'
      }
    });

    if (!metadataResponse.ok) {
      console.log(new Date().toISOString(), '[videasy] metadata failed', metadataResponse.status, sourceUrl);
      return null;
    }

    const metadata = await metadataResponse.json();
    const apiUrls = buildVideasyResolveUrls(details, metadata);
    if (!apiUrls.length) {
      console.log(new Date().toISOString(), '[videasy] metadata incomplete', sourceUrl);
      return null;
    }

    for (const apiUrl of apiUrls) {
      const upstream = await fetchVideasyThroughProxy(apiUrl, {
        method: 'GET',
        headers: {
          accept: 'application/json, text/plain, */*',
          'accept-language': 'en-US,en;q=0.9',
          origin: 'https://player.videasy.net',
          referer: sourceUrl,
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/120.0.0.0 Safari/537.36'
        }
      });

      console.log(
        new Date().toISOString(),
        shouldUseVideasyProxy() ? '[videasy] direct api via env proxy' : '[videasy] direct api',
        apiUrl,
        upstream.status,
        upstream.proxyUrl || 'direct',
        upstream.fallbackFromProxyError ? `fallback:${upstream.fallbackFromProxyError}` : 'ok'
      );

      if (upstream.status >= 400) {
        continue;
      }

      const streamUrl = extractStreamFromPayload(upstream.body);
      if (!streamUrl) {
        console.log(new Date().toISOString(), '[videasy] no stream in api payload', apiUrl);
        continue;
      }

      return {
        success: true,
        url: streamUrl,
        stream: streamUrl,
        type: detectType(streamUrl, upstream.headers['content-type'] || ''),
        headers: normalizeHeaders({
          origin: 'https://player.videasy.net',
          referer: 'https://player.videasy.net/',
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/120.0.0.0 Safari/537.36'
        }),
        provider: 'videasy-direct',
        sourceUrl,
        qualities: []
      };
    }

    return null;
  } catch (error) {
    console.log(new Date().toISOString(), '[videasy] direct resolve failed', sourceUrl, error?.message || String(error));
    return null;
  }
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

  if (isVideasyUrl(url)) {
    const directResult = await tryResolveVideasyDirect(url);
    if (directResult) {
      cache.set(cacheKey, directResult, ONE_HOUR_MS);
      console.log(new Date().toISOString(), '[resolve] videasy direct hit', directResult.url);
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
      }, isVidfastUrl(url) ? 75000 : isVideasyUrl(url) ? 18000 : RESOLVE_TIMEOUT_MS);

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
