import { Router } from 'express';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryCache } from '../../server/cache.js';
import { resolveStreamWithCache, withProxiedPlaybackUrls } from './resolve.js';

const router = Router();
const currentDir = dirname(fileURLToPath(import.meta.url));
const ANILIST_API_URL = process.env.ANILIST_API_URL || 'https://graphql.anilist.co';
const ANIZIP_API_URL = (process.env.ANIZIP_API_URL || 'https://api.ani.zip').replace(/\/$/, '');
const MEGAPLAY_BASE = (process.env.MEGAPLAY_BASE || 'https://megaplay.buzz').replace(/\/$/, '');
const VIDNEST_BASE = (process.env.VIDNEST_BASE || 'https://vidnest.fun').replace(/\/$/, '');
const SHOULD_RESOLVE_MEGAPLAY_DIRECT = String(process.env.ANIME_RESOLVE_MEGAPLAY_DIRECT || '0') === '1';
const ANIME_SERIES_CACHE_VERSION = 'v2-episode-images';
const cache = createMemoryCache(30 * 60 * 1000, {
  persistPath: resolvePath(currentDir, '../../.cache/anime-route-cache.json'),
});

const MEDIA_FIELDS = `
  id
  idMal
  title { romaji english native }
  description(asHtml: false)
  coverImage { large extraLarge color }
  bannerImage
  averageScore
  meanScore
  popularity
  episodes
  duration
  status
  season
  seasonYear
  countryOfOrigin
  startDate { year month day }
  genres
  format
  isAdult
  nextAiringEpisode { episode airingAt }
`;

const RECENT_QUERY = `
  query RecentAnime($page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { total currentPage lastPage perPage hasNextPage }
      media(type: ANIME, status: RELEASING, sort: TRENDING_DESC, isAdult: false) {
        ${MEDIA_FIELDS}
      }
    }
  }
`;

const BROWSE_QUERY = `
  query BrowseAnime(
    $page: Int,
    $perPage: Int,
    $sort: [MediaSort],
    $status: MediaStatus,
    $season: MediaSeason,
    $seasonYear: Int,
    $genres: [String],
    $formats: [MediaFormat],
    $search: String
  ) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { total currentPage lastPage perPage hasNextPage }
      media(
        type: ANIME,
        isAdult: false,
        sort: $sort,
        status: $status,
        season: $season,
        seasonYear: $seasonYear,
        genre_in: $genres,
        format_in: $formats,
        search: $search
      ) {
        ${MEDIA_FIELDS}
      }
    }
  }
`;

const SERIES_QUERY = `
  query AnimeSeries($id: Int!) {
    Media(id: $id, type: ANIME) {
      ${MEDIA_FIELDS}
      trailer { id site thumbnail }
      characters(sort: [ROLE, RELEVANCE], perPage: 10) {
        nodes { id name { full } image { medium } }
      }
      recommendations(sort: RATING_DESC, perPage: 12) {
        nodes {
          mediaRecommendation {
            ${MEDIA_FIELDS}
          }
        }
      }
      relations {
        edges {
          relationType(version: 2)
          node {
            ${MEDIA_FIELDS}
          }
        }
      }
    }
  }
`;

const BROWSE_TABS = {
  trending: { sort: ['TRENDING_DESC'] },
  popular: { sort: ['POPULARITY_DESC'] },
  top_rated: { sort: ['SCORE_DESC'] },
  recent: { sort: ['UPDATED_AT_DESC'], status: 'RELEASING' },
};

const VALID_STATUSES = new Set(['RELEASING', 'FINISHED', 'NOT_YET_RELEASED', 'CANCELLED', 'HIATUS']);
const VALID_SEASONS = new Set(['WINTER', 'SPRING', 'SUMMER', 'FALL']);
const VALID_FORMATS = new Set(['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC']);
const WATCH_ORDER_RELATIONS = new Set(['PREQUEL', 'SEQUEL', 'SIDE_STORY', 'SPIN_OFF', 'ALTERNATIVE', 'PARENT', 'SUMMARY']);

function withTimeout(ms = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

async function anilistFetch(query, variables = {}) {
  const { signal, clear } = withTimeout();
  try {
    const response = await fetch(ANILIST_API_URL, {
      method: 'POST',
      signal,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'NOVA/1.0 anime catalog proxy',
      },
      body: JSON.stringify({ query, variables }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.errors?.length) {
      throw new Error(payload?.errors?.[0]?.message || `AniList request failed: ${response.status}`);
    }

    return payload.data || {};
  } finally {
    clear();
  }
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function splitCsv(value = '') {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeEnumValue(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
}

function normalizeEnumList(value = '', allowedValues = new Set()) {
  return splitCsv(value)
    .map(normalizeEnumValue)
    .filter((entry) => allowedValues.has(entry));
}

function stripHtml(value = '') {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function formatDateParts(date = {}) {
  if (!date?.year) return '';
  const month = String(date.month || 1).padStart(2, '0');
  const day = String(date.day || 1).padStart(2, '0');
  return `${date.year}-${month}-${day}`;
}

function normalizeScore(value) {
  const score = Number(value || 0) / 10;
  return Number.isFinite(score) ? Number(score.toFixed(1)) : 0;
}

function normalizeAiringEpisode(airing = {}) {
  const episode = Number.parseInt(String(airing?.episode || '0'), 10) || 0;
  const airingAt = Number.parseInt(String(airing?.airingAt || '0'), 10) || 0;
  if (!episode || !airingAt) return null;

  return {
    episode,
    airingAt,
    airing_at: airingAt,
    iso: new Date(airingAt * 1000).toISOString(),
  };
}

function formatRelationType(value = '') {
  return String(value || '')
    .toLowerCase()
    .split('_')
    .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : '')
    .join(' ');
}

function getAnimeTitle(media = {}) {
  return media.title?.english || media.title?.romaji || media.title?.native || 'Unknown Anime';
}

function getEpisodeMetadataTitle(metadata = {}) {
  return metadata.title?.en || metadata.title?.['x-jat'] || metadata.title?.ja || '';
}

function normalizeEpisodeRating(value) {
  const rating = Number.parseFloat(String(value || '0')) || 0;
  return Number.isFinite(rating) ? Number(rating.toFixed(1)) : 0;
}

async function getAnimeEpisodeMetadata(anilistId) {
  const numericId = clampInt(anilistId, 1, Number.MAX_SAFE_INTEGER, 0);
  if (!numericId) {
    return {};
  }

  const cacheKey = `anizip:episodes:${numericId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const { signal, clear } = withTimeout(10000);
  try {
    const response = await fetch(`${ANIZIP_API_URL}/mappings?anilist_id=${numericId}`, {
      signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'NOVA/1.0 anime episode metadata proxy',
      },
    });

    if (!response.ok) {
      return {};
    }

    const payload = await response.json().catch(() => ({}));
    const episodes = payload?.episodes && typeof payload.episodes === 'object' ? payload.episodes : {};
    cache.set(cacheKey, episodes, 6 * 60 * 60 * 1000);
    return episodes;
  } catch {
    return {};
  } finally {
    clear();
  }
}

function getEpisodeCount(media = {}) {
  const knownEpisodes = Number.parseInt(String(media.episodes || '0'), 10) || 0;
  if (knownEpisodes > 0) return knownEpisodes;

  const nextEpisode = Number.parseInt(String(media.nextAiringEpisode?.episode || '0'), 10) || 0;
  if (nextEpisode > 1) return nextEpisode - 1;

  return media.format === 'MOVIE' ? 1 : 12;
}

function normalizeAnimeListItem(media = {}) {
  const title = getAnimeTitle(media);
  const releaseDate = formatDateParts(media.startDate) || (media.seasonYear ? `${media.seasonYear}-01-01` : '');
  const episodeCount = getEpisodeCount(media);
  const nextAiringEpisode = normalizeAiringEpisode(media.nextAiringEpisode);

  return {
    id: media.id,
    anime_id: media.id,
    mal_id: media.idMal || null,
    anilist_id: media.id,
    media_type: 'anime',
    mediaType: 'anime',
    title,
    name: title,
    original_name: media.title?.native || title,
    overview: stripHtml(media.description),
    poster_path: media.coverImage?.extraLarge || media.coverImage?.large || '',
    backdrop_path: media.bannerImage || media.coverImage?.extraLarge || media.coverImage?.large || '',
    release_date: releaseDate,
    first_air_date: releaseDate,
    vote_average: normalizeScore(media.averageScore),
    mean_score: normalizeScore(media.meanScore),
    popularity: media.popularity || 0,
    original_language: 'ja',
    status: media.status || '',
    rating: '',
    episode_count: episodeCount,
    is_sub: episodeCount,
    is_dub: episodeCount,
    genres: Array.isArray(media.genres) ? media.genres.map((name, index) => ({ id: `anime-genre-${index}-${name}`, name })) : [],
    format: media.format || '',
    season: media.season || '',
    year: media.seasonYear || null,
    country_of_origin: media.countryOfOrigin || '',
    next_airing_episode: nextAiringEpisode,
    next_airing_at: nextAiringEpisode?.airingAt || null,
  };
}

function normalizeEpisodes(media = {}, episodeMetadata = {}) {
  const episodeCount = getEpisodeCount(media);
  const runtime = Number.parseInt(String(media.duration || '0'), 10) || null;
  const stillPath = media.bannerImage || media.coverImage?.extraLarge || media.coverImage?.large || '';
  const releaseDate = formatDateParts(media.startDate) || (media.seasonYear ? `${media.seasonYear}-01-01` : '');

  return Array.from({ length: episodeCount }, (_, index) => {
    const episodeNumber = index + 1;
    const metadata = episodeMetadata[String(episodeNumber)] || {};
    const title = getEpisodeMetadataTitle(metadata) || `Episode ${episodeNumber}`;
    const overview = metadata.overview || metadata.summary || '';
    const metadataRuntime = Number.parseInt(String(metadata.runtime || metadata.length || '0'), 10) || null;
    const image = String(metadata.image || '').trim();

    return {
      id: `${media.id}-${episodeNumber}`,
      tvdb_id: metadata.tvdbId || null,
      name: title,
      title,
      episode_number: episodeNumber,
      absolute_episode_number: metadata.absoluteEpisodeNumber || episodeNumber,
      season_number: 1,
      tvdb_season_number: metadata.seasonNumber || null,
      tvdb_episode_number: metadata.episodeNumber || null,
      overview,
      runtime: metadataRuntime || runtime,
      still_path: image || stillPath,
      image: image || stillPath,
      air_date: metadata.airDate || metadata.airdate || releaseDate,
      vote_average: metadata.rating ? normalizeEpisodeRating(metadata.rating) : normalizeScore(media.averageScore),
      episode_embed_id: '',
      embed_url: {},
    };
  });
}

function normalizeAnimeDetail(media = {}, episodeMetadata = {}) {
  const normalized = normalizeAnimeListItem(media);
  const episodes = normalizeEpisodes(media, episodeMetadata);
  const trailer = media.trailer?.site?.toLowerCase() === 'youtube' && media.trailer?.id
    ? [{ type: 'Trailer', site: 'YouTube', key: media.trailer.id }]
    : [];
  const recommendations = (media.recommendations?.nodes || [])
    .map((node) => node?.mediaRecommendation)
    .filter(Boolean)
    .map(normalizeAnimeListItem);
  const relationItems = (media.relations?.edges || [])
    .map((edge) => {
      if (!edge?.node) return null;
      const relationType = String(edge.relationType || '').trim();
      return {
        ...normalizeAnimeListItem(edge.node),
        relation_type: relationType,
        relation_label: formatRelationType(relationType),
        recommendationReason: formatRelationType(relationType),
      };
    })
    .filter(Boolean);
  const watchOrder = relationItems.filter((entry) => WATCH_ORDER_RELATIONS.has(String(entry.relation_type || '').toUpperCase()));
  const cast = (media.characters?.nodes || []).map((character) => ({
    id: character.id,
    name: character.name?.full || 'Unknown',
    character: 'Character',
    profile_path: character.image?.medium || '',
  }));

  return {
    ...normalized,
    type: 'anime',
    tagline: media.title?.romaji && media.title?.romaji !== normalized.title ? media.title.romaji : '',
    runtime: media.duration || null,
    episode_run_time: media.duration ? [media.duration] : [],
    number_of_seasons: 1,
    number_of_episodes: episodes.length,
    seasons: [
      {
        id: `${media.id}-1`,
        name: 'Episodes',
        season_number: 1,
        episode_count: episodes.length,
      },
    ],
    episodes,
    credits: { cast },
    videos: { results: trailer },
    similar: { results: recommendations.slice(0, 12) },
    recommendations: { results: recommendations.slice(0, 12) },
    relations: { results: relationItems.slice(0, 24) },
    watch_order: watchOrder.slice(0, 18),
    images: { logos: [] },
  };
}

function buildMegaplayUrl({ anilistId = '', malId = '', episodeNumber = 1, language = 'sub' }) {
  const safeLanguage = language === 'dub' ? 'dub' : 'sub';
  const safeEpisode = Math.max(1, Number.parseInt(String(episodeNumber), 10) || 1);
  const cleanAnilistId = String(anilistId || '').trim();
  const cleanMalId = String(malId || '').trim();

  if (cleanAnilistId) {
    return `${MEGAPLAY_BASE}/stream/ani/${encodeURIComponent(cleanAnilistId)}/${safeEpisode}/${safeLanguage}`;
  }

  if (cleanMalId) {
    return `${MEGAPLAY_BASE}/stream/mal/${encodeURIComponent(cleanMalId)}/${safeEpisode}/${safeLanguage}`;
  }

  return '';
}

function normalizeAnimeLanguage(value = 'sub') {
  const language = String(value || 'sub').trim().toLowerCase();
  return ['dub', 'hindi'].includes(language) ? language : 'sub';
}

function normalizeAnimeServerKey(value = '') {
  const key = String(value || '').trim().toLowerCase();
  if (['vidnest-anime', 'vidnest', 'anime'].includes(key)) return 'vidnest-anime';
  if (['vidnest-animepahe', 'vidnest-pahe', 'animepahe'].includes(key)) return 'vidnest-animepahe';
  return 'megaplay';
}

function buildVidnestAnimeUrl({ serverKey, anilistId = '', episodeNumber = 1, language = 'sub' }) {
  const path = serverKey === 'vidnest-animepahe' ? 'animepahe' : 'anime';
  const safeLanguage = normalizeAnimeLanguage(language);
  const safeEpisode = Math.max(1, Number.parseInt(String(episodeNumber), 10) || 1);
  const cleanAnilistId = String(anilistId || '').trim();

  return cleanAnilistId
    ? `${VIDNEST_BASE}/${path}/${encodeURIComponent(cleanAnilistId)}/${safeEpisode}/${safeLanguage}`
    : '';
}

function buildAnimeStreamUrl({ serverKey, anilistId = '', malId = '', episodeNumber = 1, language = 'sub' }) {
  if (serverKey === 'vidnest-anime' || serverKey === 'vidnest-animepahe') {
    return buildVidnestAnimeUrl({ serverKey, anilistId, episodeNumber, language });
  }

  return buildMegaplayUrl({ anilistId, malId, episodeNumber, language });
}

function isMegaplayEmbedPage(url = '') {
  try {
    const parsed = new URL(url);
    return /(^|\.)megaplay\.buzz$/i.test(parsed.hostname) && parsed.pathname.startsWith('/stream/');
  } catch {
    return false;
  }
}

function isWrappedHlsUrl(url = '') {
  try {
    const parsed = new URL(String(url || ''));
    const nestedUrl = parsed.searchParams.get('url') || '';
    return /\.m3u8(?:$|[?#&])/i.test(nestedUrl) || /\.m3u8/i.test(decodeURIComponent(String(url || '')));
  } catch {
    return /\.m3u8/i.test(String(url || ''));
  }
}

function isDirectPlaybackResult(result = {}, embedUrl = '') {
  const url = String(result?.url || result?.stream || '').trim();
  const type = String(result?.type || '').trim().toLowerCase();

  if (!url || url === embedUrl || isMegaplayEmbedPage(url)) {
    return false;
  }

  return (
    type === 'hls' ||
    type === 'mp4' ||
    isWrappedHlsUrl(url) ||
    /\.m3u8(?:\?|$)/i.test(url) ||
    /\.mp4(?:\?|$)/i.test(url)
  );
}

function buildAnimeEmbedResult({ embedUrl, language, episodeNumber, source, provider }) {
  return {
    ok: true,
    type: 'embed',
    url: embedUrl,
    embedUrl,
    provider,
    episodeEmbedId: '',
    language,
    title: '',
    episodeTitle: `Episode ${episodeNumber}`,
    source,
  };
}

async function getSeries(id) {
  const numericId = clampInt(id, 1, Number.MAX_SAFE_INTEGER, 0);
  if (!numericId) {
    throw new Error('AniList id is required');
  }

  const cacheKey = `anilist:series:${ANIME_SERIES_CACHE_VERSION}:${numericId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const data = await anilistFetch(SERIES_QUERY, { id: numericId });
  if (!data.Media) {
    throw new Error('Anime not found');
  }

  const episodeMetadata = await getAnimeEpisodeMetadata(numericId);
  const result = normalizeAnimeDetail(data.Media, episodeMetadata);
  cache.set(cacheKey, result, 6 * 60 * 60 * 1000);
  return result;
}

function buildBrowseVariables(query = {}) {
  const tabKey = String(query.tab || '').trim().toLowerCase();
  const tabConfig = BROWSE_TABS[tabKey] || BROWSE_TABS.trending;
  const page = clampInt(query.page, 1, 10000, 1);
  const perPage = clampInt(query.per_page || query.perPage, 1, 50, 20);
  const status = normalizeEnumValue(query.status || tabConfig.status || '');
  const season = normalizeEnumValue(query.season || '');
  const formats = normalizeEnumList(query.format || query.formats || '', VALID_FORMATS);
  const genres = splitCsv(query.genre || query.genres || '');
  const search = String(query.q || query.query || query.search || '').trim();
  const seasonYear = clampInt(query.year || query.seasonYear, 1900, 2100, 0);

  return {
    page,
    perPage,
    sort: tabConfig.sort,
    status: VALID_STATUSES.has(status) ? status : undefined,
    season: VALID_SEASONS.has(season) ? season : undefined,
    seasonYear: seasonYear || undefined,
    genres: genres.length ? genres : undefined,
    formats: formats.length ? formats : undefined,
    search: search || undefined,
  };
}

async function getBrowseResults(query = {}) {
  const variables = buildBrowseVariables(query);
  const cacheKey = `anilist:browse:${JSON.stringify(variables)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const data = await anilistFetch(BROWSE_QUERY, variables);
  const pageInfo = data.Page?.pageInfo || {};
  const rows = Array.isArray(data.Page?.media) ? data.Page.media : [];
  const result = {
    page: Number(pageInfo.currentPage || variables.page),
    per_page: Number(pageInfo.perPage || variables.perPage),
    total_pages: Number(pageInfo.lastPage || variables.page),
    total_results: Number(pageInfo.total || rows.length),
    results: rows.map(normalizeAnimeListItem),
  };

  cache.set(cacheKey, result, 10 * 60 * 1000);
  return result;
}

router.get('/recent', async (req, res) => {
  try {
    const result = await getBrowseResults({ ...req.query, tab: 'recent' });
    return res.json(result);
  } catch (error) {
    return res.json({
      page: clampInt(req.query.page, 1, 10000, 1),
      per_page: clampInt(req.query.per_page || req.query.perPage, 1, 50, 20),
      total_pages: 0,
      total_results: 0,
      results: [],
      upstreamError: error?.message || 'Anime catalog failed',
    });
  }
});

router.get('/browse', async (req, res) => {
  try {
    return res.json(await getBrowseResults(req.query));
  } catch (error) {
    return res.status(502).json({ error: error?.message || 'Anime browse failed', results: [] });
  }
});

router.get('/search', async (req, res) => {
  try {
    return res.json(await getBrowseResults({ ...req.query, q: req.query.q || req.query.query || req.query.search }));
  } catch (error) {
    return res.status(502).json({ error: error?.message || 'Anime search failed', results: [] });
  }
});

router.get('/series/:id', async (req, res) => {
  try {
    const result = await getSeries(req.params.id);
    return res.json(result);
  } catch (error) {
    return res.status(502).json({ error: error?.message || 'Anime series failed' });
  }
});

router.get('/series/:id/season/:seasonNumber', async (req, res) => {
  try {
    const result = await getSeries(req.params.id);
    return res.json({
      id: `${req.params.id}-${req.params.seasonNumber || 1}`,
      name: 'Episodes',
      season_number: 1,
      overview: result.overview || '',
      episodes: result.episodes || [],
    });
  } catch (error) {
    return res.status(502).json({ error: error?.message || 'Anime episodes failed' });
  }
});

router.get('/stream', async (req, res) => {
  try {
    const id = String(req.query.id || req.query.anilistId || req.query.aniId || req.query.ani_id || '').trim();
    const malId = String(req.query.malId || req.query.mal_id || '').trim();
    const episodeNumber = clampInt(req.query.episode, 1, 10000, 1);
    const language = normalizeAnimeLanguage(req.query.language);
    const serverKey = normalizeAnimeServerKey(req.query.server || req.query.provider || 'megaplay');

    if (!id && !malId) {
      return res.status(400).json({ error: 'id, anilistId, or malId is required' });
    }

    if (serverKey !== 'megaplay' && !id) {
      return res.status(400).json({ error: 'AniList id is required for this anime server' });
    }

    const embedUrl = buildAnimeStreamUrl({ serverKey, anilistId: id, malId, episodeNumber, language });
    if (!embedUrl) {
      return res.status(404).json({ error: 'Embed URL not available' });
    }

    const shouldRefresh = String(req.query.refresh || '').trim() === '1';
    const wantsDirect = String(req.query.direct || req.query.resolve || '').trim() === '1';
    const shouldResolveDirect = serverKey !== 'megaplay' || (
      SHOULD_RESOLVE_MEGAPLAY_DIRECT || wantsDirect
    );
    const embedResult = buildAnimeEmbedResult({
      embedUrl,
      language,
      episodeNumber,
      source: id ? 'anilist' : 'mal',
      provider: serverKey,
    });

    if (!shouldResolveDirect) {
      return res.json(embedResult);
    }

    try {
      const { result, cached } = await resolveStreamWithCache(embedUrl, { refresh: shouldRefresh });
      if (!isDirectPlaybackResult(result, embedUrl)) {
        throw new Error(`${serverKey} returned embed page, not direct video`);
      }

      return res.json({
        ...withProxiedPlaybackUrls({
          ...result,
          ok: true,
          embedUrl,
          language,
          episodeTitle: `Episode ${episodeNumber}`,
          source: id ? 'anilist' : 'mal',
          provider: serverKey,
        }, req),
        ...(cached ? { cached: true } : {}),
      });
    } catch (e) {
      console.log(new Date().toISOString(), '[anime] direct resolution failed', serverKey, embedUrl, e?.message || String(e));
      if (wantsDirect || serverKey !== 'megaplay') {
        return res.status(404).json({ error: e?.message || 'Anime direct stream not found' });
      }

      return res.json({
        ...embedResult,
        ok: true,
        fallback: true,
      });
    }
  } catch (error) {
    return res.status(502).json({ error: error?.message || 'Anime stream failed' });
  }
});

export default router;
