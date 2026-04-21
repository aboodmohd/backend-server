import { Router } from 'express';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryCache } from '../../server/cache.js';
import { resolveStream, withProxiedPlaybackUrls } from './resolve.js';

const router = Router();
const currentDir = dirname(fileURLToPath(import.meta.url));
const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/original';
const TMDB_API_KEY = process.env.TMDB_API_KEY || 'baa58d49a882daa37425c98142b065df';
const cache = createMemoryCache(6 * 60 * 60 * 1000, {
  persistPath: resolvePath(currentDir, '../../.cache/nova-route-cache.json'),
});
const SERVER_OPTIONS = [
  { id: 'vidlink', label: 'VidLink', accent: '#58d2ff', description: 'Fast direct embed' },
  { id: 'videasy', label: 'Videasy', accent: '#ff7b72', description: 'Player.videasy resolver' },
  { id: 'vidrock', label: 'Vidrock', accent: '#8bff94', description: 'Direct resolver path' },
  { id: 'vidfast', label: 'VidFast', accent: '#ffd257', description: 'Playwright-backed extraction' },
  { id: 'vidcore', label: 'VidCore', accent: '#c8a2ff', description: 'AutoPlay embed source' },
  { id: 'vidzee', label: 'VidZee', accent: '#ff95d0', description: 'Protected HLS source' },
  { id: '111movies', label: '111Movies', accent: '#ffffff', description: 'Browser extraction fallback' },
];

function withTimeout(ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

async function tmdbFetch(pathname, query = {}) {
  const url = new URL(`${TMDB_API_BASE}${pathname}`);
  url.searchParams.set('api_key', TMDB_API_KEY);
  url.searchParams.set('language', 'en-US');
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const { signal, clear } = withTimeout();
  try {
    const response = await fetch(url, { signal });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.status_message || 'TMDB request failed');
    }
    return payload;
  } finally {
    clear();
  }
}

function normalizeListing(item = {}, mediaType = '') {
  const type = mediaType || item.media_type || 'movie';
  const title = item.title || item.name || 'Unknown';
  const releaseDate = item.release_date || item.first_air_date || '';
  return {
    id: item.id,
    tmdb_id: item.id,
    title,
    year: String(releaseDate).slice(0, 4),
    rating: Number(Number(item.vote_average || 0).toFixed(1)),
    type: type === 'tv' ? 'tv' : 'movie',
    overview: item.overview || '',
    poster_path: item.poster_path || '',
    backdrop_path: item.backdrop_path || '',
    image_url: item.backdrop_path ? `${TMDB_IMAGE_BASE}${item.backdrop_path}` : '',
  };
}

function normalizeDetail(item = {}, mediaType = '') {
  const type = mediaType === 'tv' ? 'tv' : 'movie';
  const title = item.title || item.name || 'Unknown';
  const releaseDate = item.release_date || item.first_air_date || '';
  return {
    id: item.id,
    tmdb_id: item.id,
    title,
    year: String(releaseDate).slice(0, 4),
    rating: Number(Number(item.vote_average || 0).toFixed(1)),
    genres: Array.isArray(item.genres) ? item.genres.map((genre) => genre?.name).filter(Boolean) : [],
    overview: item.overview || '',
    runtime: item.runtime || item.episode_run_time?.[0] || null,
    type,
    seasons: Number(item.number_of_seasons || 1),
    episodes: Number(item.number_of_episodes || 1),
    poster_path: item.poster_path || '',
    backdrop_path: item.backdrop_path || '',
    image_url: item.backdrop_path ? `${TMDB_IMAGE_BASE}${item.backdrop_path}` : '',
  };
}

function parseMediaQuery(input = {}) {
  const mediaType = String(input.mediaType || input.type || 'movie').trim().toLowerCase() === 'tv' ? 'tv' : 'movie';
  const tmdbId = String(input.tmdbId || input.id || '').trim();
  const season = Math.max(1, Number.parseInt(String(input.season || input.s || '1'), 10) || 1);
  const episode = Math.max(1, Number.parseInt(String(input.episode || input.e || '1'), 10) || 1);
  if (!tmdbId) {
    throw new Error('tmdbId is required');
  }
  return { mediaType, tmdbId, season, episode };
}

function buildServerUrl(serverId, query) {
  const { mediaType, tmdbId, season, episode } = query;

  if (serverId === 'videasy') {
    return mediaType === 'tv'
      ? `https://player.videasy.net/tv/${tmdbId}/${season}/${episode}`
      : `https://player.videasy.net/movie/${tmdbId}`;
  }

  if (serverId === 'vidlink') {
    return mediaType === 'tv'
      ? `https://vidlink.pro/tv/${tmdbId}/${season}/${episode}`
      : `https://vidlink.pro/movie/${tmdbId}`;
  }

  if (serverId === 'vidrock') {
    return mediaType === 'tv'
      ? `https://vidrock.net/tv/${tmdbId}/${season}/${episode}`
      : `https://vidrock.net/movie/${tmdbId}`;
  }

  if (serverId === '111movies') {
    return mediaType === 'tv'
      ? `https://111movies.net/tv/${tmdbId}/${season}/${episode}`
      : `https://111movies.net/movie/${tmdbId}`;
  }

  if (serverId === 'vidcore') {
    return mediaType === 'tv'
      ? `https://vidcore.net/tv/${tmdbId}/${season}/${episode}?autoPlay=true`
      : `https://vidcore.net/movie/${tmdbId}?autoPlay=true`;
  }

  if (serverId === 'vidfast') {
    return mediaType === 'tv'
      ? `https://vidfast.pro/tv/${tmdbId}/${season}/${episode}?autoPlay=true`
      : `https://vidfast.pro/movie/${tmdbId}?autoPlay=true`;
  }

  if (serverId === 'vidzee') {
    return mediaType === 'tv'
      ? `https://player.vidzee.wtf/embed/tv/${tmdbId}/${season}/${episode}`
      : `https://player.vidzee.wtf/embed/movie/${tmdbId}`;
  }

  throw new Error(`Unsupported server: ${serverId}`);
}

function getServerList(query) {
  return SERVER_OPTIONS.map((server, index) => ({
    ...server,
    sourceUrl: buildServerUrl(server.id, query),
    isDefault: index === 0,
  }));
}

router.get('/trending/movies', async (_req, res) => {
  try {
    const payload = await tmdbFetch('/trending/movie/week');
    res.json({ results: (payload.results || []).map((item) => normalizeListing(item, 'movie')) });
  } catch (error) {
    res.status(502).json({ error: error?.message || 'Trending movies failed' });
  }
});

router.get('/trending/tv', async (_req, res) => {
  try {
    const payload = await tmdbFetch('/trending/tv/week');
    res.json({ results: (payload.results || []).map((item) => normalizeListing(item, 'tv')) });
  } catch (error) {
    res.status(502).json({ error: error?.message || 'Trending tv failed' });
  }
});

router.get('/search', async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    const type = String(req.query.type || 'multi').trim().toLowerCase();
    if (!query) {
      return res.json({ results: [], query, type });
    }
    const searchType = ['movie', 'tv', 'multi'].includes(type) ? type : 'multi';
    const payload = await tmdbFetch(`/search/${searchType}`, {
      query,
      include_adult: 'false',
    });
    const results = (payload.results || [])
      .filter((item) => ['movie', 'tv'].includes(item.media_type || searchType))
      .map((item) => normalizeListing(item, item.media_type || searchType));
    return res.json({ results, query, type: searchType });
  } catch (error) {
    return res.status(502).json({ error: error?.message || 'Search failed' });
  }
});

router.get('/detail', async (req, res) => {
  try {
    const tmdbId = String(req.query.id || '').trim();
    const mediaType = String(req.query.type || 'movie').trim().toLowerCase() === 'tv' ? 'tv' : 'movie';
    if (!tmdbId) {
      return res.status(400).json({ error: 'id is required' });
    }
    const payload = await tmdbFetch(`/${mediaType}/${tmdbId}`);
    return res.json(normalizeDetail(payload, mediaType));
  } catch (error) {
    return res.status(502).json({ error: error?.message || 'Detail failed' });
  }
});

router.get('/nova/servers', (req, res) => {
  try {
    const query = parseMediaQuery(req.query);
    return res.json({
      ...query,
      defaultServer: SERVER_OPTIONS[0].id,
      servers: getServerList(query),
    });
  } catch (error) {
    return res.status(400).json({ error: error?.message || 'Servers failed' });
  }
});

router.post('/nova/resolve-server', async (req, res) => {
  try {
    const shouldRefresh = String(req.query.refresh || req.body?.refresh || '').trim() === '1';
    const server = String(req.body?.server || req.query.server || '').trim().toLowerCase();
    const query = parseMediaQuery(req.body || req.query || {});
    const sourceUrl = buildServerUrl(server, query);
    const cacheKey = `nova:${server}:${sourceUrl}`;
    const cached = shouldRefresh ? null : cache.get(cacheKey);
    if (cached) {
      return res.json({
        server,
        sourceUrl,
        cached: true,
        ...withProxiedPlaybackUrls(cached, req),
      });
    }
    const resolved = await resolveStream(sourceUrl);
    const normalized = { ...resolved, sourceUrl };
    cache.set(cacheKey, normalized);
    return res.json({
      server,
      sourceUrl,
      ...withProxiedPlaybackUrls(normalized, req),
    });
  } catch (error) {
    const message = error?.message || 'Server resolve failed';
    const statusCode = Number(error?.statusCode);
    return res.status(Number.isInteger(statusCode) && statusCode >= 400 ? statusCode : 404).json({
      error: message,
      success: false,
    });
  }
});

export default router;
