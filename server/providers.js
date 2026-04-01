import CryptoJS from 'crypto-js';
import { detectType } from '../src/interceptors/index.js';
import { decryptVideasyPayload, getVideasySession, resolveVideasyPayloadInBrowser } from '../src/workers/playwright.js';

const VIDEASY_PROVIDERS = [
  { id: 'myflixerzupcloud', endpoint: 'https://api.videasy.net/myflixerzupcloud/sources-with-title' },
  { id: 'moviebox', endpoint: 'https://api.videasy.net/moviebox/sources-with-title' },
  { id: 'primewire', endpoint: 'https://api2.videasy.net/primewire/sources-with-title', needsUserIp: true },
  { id: 'hdmovie', endpoint: 'https://api.videasy.net/cdn/sources-with-title' },
  { id: 'm4uhd', endpoint: 'https://api.videasy.net/primesrcme/sources-with-title' },
  { id: '1movies', endpoint: 'https://api.videasy.net/1movies/sources-with-title' },
];

const REQUEST_TIMEOUT_MS = 5000;
const VIDEASY_ORIGIN = 'https://player.videasy.net';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36';

function withTimeout(ms = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

async function withOperationTimeout(task, ms = REQUEST_TIMEOUT_MS) {
  return await Promise.race([
    task(),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('provider timeout')), ms);
    }),
  ]);
}

async function fetchTextWithTimeout(url, options = {}) {
  const { signal, clear } = withTimeout();

  try {
    const response = await fetch(url, { ...options, signal });
    return {
      ok: response.ok,
      status: response.status,
      text: await response.text(),
    };
  } finally {
    clear();
  }
}

async function fetchJsonWithTimeout(url, options = {}) {
  const { signal, clear } = withTimeout();

  try {
    const response = await fetch(url, { ...options, signal });
    return {
      ok: response.ok,
      status: response.status,
      json: response.ok ? await response.json() : null,
    };
  } finally {
    clear();
  }
}

function buildPlaybackUrl({ mediaType, tmdbId, season, episode }) {
  if (mediaType === 'tv') {
    return `${VIDEASY_ORIGIN}/tv/${tmdbId}/${season}/${episode}`;
  }

  return `${VIDEASY_ORIGIN}/movie/${tmdbId}`;
}

function buildMetadataUrl({ mediaType, tmdbId }) {
  if (mediaType === 'tv') {
    return `https://db.videasy.net/3/tv/${tmdbId}?append_to_response=external_ids&language=en`;
  }

  return `https://db.videasy.net/3/movie/${tmdbId}?append_to_response=external_ids&language=en`;
}

function normalizeTitle(value = '') {
  return String(value || '').trim();
}

function normalizeQualityLabel(value = '') {
  const text = String(value || '').trim();
  if (!text) {
    return 'Auto';
  }

  const match = text.match(/(\d{3,4})/);
  return match?.[1] ? `${match[1]}p` : text;
}

function getQualityRank(value = '') {
  return Number.parseInt(String(value || '').replace(/\D/g, ''), 10) || 0;
}

function decodePayload(stageOne = '') {
  const decrypted = CryptoJS.AES.decrypt(stageOne, '').toString(CryptoJS.enc.Utf8);
  return decrypted ? JSON.parse(decrypted) : null;
}

function buildHeaders(session) {
  const headers = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    origin: VIDEASY_ORIGIN,
    referer: `${VIDEASY_ORIGIN}/`,
    'user-agent': session?.userAgent || DEFAULT_USER_AGENT,
  };

  if (session?.cookieHeader) {
    headers.cookie = session.cookieHeader;
  }

  return headers;
}

function pickBestStream(payload) {
  const sources = Array.isArray(payload?.sources) ? payload.sources : [];

  const ranked = sources
    .filter((entry) => typeof entry?.url === 'string' && /\.m3u8(\?|$)/i.test(entry.url))
    .sort((left, right) => getQualityRank(right.quality) - getQualityRank(left.quality));

  return ranked[0] || null;
}

function buildQualityList(payload) {
  const sources = Array.isArray(payload?.sources) ? payload.sources : [];
  return sources
    .filter((entry) => typeof entry?.url === 'string' && /\.m3u8(\?|$)/i.test(entry.url))
    .sort((left, right) => getQualityRank(right.quality) - getQualityRank(left.quality))
    .map((entry, index) => ({
      id: `${normalizeQualityLabel(entry.quality)}-${index}`,
      label: normalizeQualityLabel(entry.quality),
      quality: normalizeQualityLabel(entry.quality),
      url: entry.url,
      type: detectType(entry.url),
      isDefault: index === 0,
    }));
}

function buildProviderUrl(provider, query, userIp = '') {
  const url = new URL(provider.endpoint);
  url.searchParams.set('title', encodeURIComponent(query.title));
  url.searchParams.set('mediaType', query.mediaType);
  url.searchParams.set('year', String(query.year));
  url.searchParams.set('tmdbId', String(query.tmdbId));

  if (query.imdbId) {
    url.searchParams.set('imdbId', query.imdbId);
  }

  if (query.mediaType === 'tv') {
    url.searchParams.set('season', String(query.season));
    url.searchParams.set('episode', String(query.episode));
    url.searchParams.set('seasonId', String(query.season));
    url.searchParams.set('episodeId', String(query.episode));
  }

  if (provider.needsUserIp && userIp) {
    url.searchParams.set('userIp', userIp);
  }

  return url.toString();
}

async function getUserIp(headers) {
  const response = await fetchTextWithTimeout('https://api4.ipify.org', { headers });
  return response.ok ? String(response.text || '').trim() : '';
}

export async function normalizeVideasyQuery(input) {
  const query = {
    title: normalizeTitle(input.title),
    year: input.year ? Number(input.year) : null,
    tmdbId: Number(input.tmdbId),
    imdbId: String(input.imdbId || '').trim(),
    mediaType: String(input.mediaType || '').trim().toLowerCase(),
    season: input.season ? Number(input.season) : null,
    episode: input.episode ? Number(input.episode) : null,
  };

  if (!Number.isFinite(query.tmdbId) || query.tmdbId <= 0) {
    throw new Error('tmdbId is required');
  }

  if (!['movie', 'tv'].includes(query.mediaType)) {
    throw new Error('mediaType must be movie or tv');
  }

  if (query.mediaType === 'tv' && (!query.season || !query.episode)) {
    throw new Error('season and episode are required for tv');
  }

  if (query.title && query.year) {
    return query;
  }

  const metadataUrl = buildMetadataUrl(query);
  const metadataResponse = await fetchJsonWithTimeout(metadataUrl, {
    headers: {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9',
      origin: VIDEASY_ORIGIN,
      referer: buildPlaybackUrl(query),
    },
  });

  if (!metadataResponse.ok || !metadataResponse.json) {
    throw new Error('failed to fetch Videasy metadata');
  }

  const metadata = metadataResponse.json;
  const releaseDate = metadata.release_date || metadata.first_air_date || '';

  query.title = query.title || metadata.title || metadata.name || metadata.original_title || metadata.original_name || '';
  query.year = query.year || Number.parseInt(String(releaseDate).slice(0, 4), 10) || null;
  query.imdbId = query.imdbId || metadata.external_ids?.imdb_id || '';

  if (!query.title || !query.year) {
    throw new Error('title and year are required');
  }

  return query;
}

export function getVideasyCacheKey(query) {
  return query.mediaType === 'tv'
    ? `${query.tmdbId}:tv:${query.season}:${query.episode}`
    : `${query.tmdbId}:movie`;
}

export async function resolveVideasySource(input) {
  const query = await normalizeVideasyQuery(input);
  const playbackUrl = buildPlaybackUrl(query);
  const session = await getVideasySession(playbackUrl).catch(() => null);
  const headers = buildHeaders(session);
  const userIp = await getUserIp(headers).catch(() => '');

  for (const provider of VIDEASY_PROVIDERS) {
    try {
      const providerUrl = buildProviderUrl(provider, query, userIp);
      const result = await withOperationTimeout(async () => {
        const upstream = await fetchTextWithTimeout(providerUrl, { headers });

        if (!upstream.text) {
          return null;
        }

        let stageOne = '';

        if (upstream.ok) {
          stageOne = await decryptVideasyPayload(upstream.text, query.tmdbId, playbackUrl).catch(() => '');
        } else if (upstream.status === 403) {
          stageOne = await resolveVideasyPayloadInBrowser(providerUrl, query.tmdbId, playbackUrl).catch(() => '');
        }

        if (!stageOne) {
          return null;
        }

        const payload = decodePayload(stageOne);
        const stream = pickBestStream(payload);
        if (!stream?.url) {
          return null;
        }

        return {
          provider: provider.id,
          quality: normalizeQualityLabel(stream.quality),
          stream: stream.url,
          url: stream.url,
          type: detectType(stream.url),
          headers: {
            origin: VIDEASY_ORIGIN,
            referer: `${VIDEASY_ORIGIN}/`,
            'user-agent': headers['user-agent'],
          },
          qualities: buildQualityList(payload),
        };
      });

      if (result?.stream) {
        return result;
      }
    } catch (error) {
      console.log(new Date().toISOString(), '[videasy]', provider.id, error?.message || String(error));
    }
  }

  throw new Error('No stream found from Videasy providers');
}

export const VIDEASY_PROVIDER_IDS = VIDEASY_PROVIDERS.map((provider) => provider.id);
