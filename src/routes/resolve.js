import { Router } from 'express';
import { createDecipheriv, createHash } from 'node:crypto';
import CryptoJS from 'crypto-js';
import { ProxyAgent } from 'undici';
import { detectType } from '../interceptors/index.js';
import { createCacheStore } from '../store/results.js';
import { decryptVideasyPayload, decryptVidkingPayload, extractVideoUrls, getVideasySession, getVidkingSession, resolveVideasyPayloadInBrowser } from '../workers/playwright.js';

const router = Router();
const cache = createCacheStore();
const vidfastHintCache = createCacheStore();
const vidzeeKeyCache = createCacheStore();
const inflightResolutions = new Map();
const ONE_HOUR_MS = 60 * 60 * 1000;
const SIX_HOURS_MS = 6 * ONE_HOUR_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const RESOLVE_TIMEOUT_MS = Number(process.env.RESOLVE_TIMEOUT_MS || 30000);
const PLAYLIST_FETCH_TIMEOUT_MS = Number(process.env.PLAYLIST_FETCH_TIMEOUT_MS || 8000);
const VIDNEST_DECRYPT_ALPHABET = 'RB0fpH8ZEyVLkv7c2i6MAJ5u3IKFDxlS1NTsnGaqmXYdUrtzjwObCgQP94hoeW+/';
const VIDZEE_KEY_SECRET = '7c9e2b4a1f6d8a3e5';
const VIDZEE_SERVER_IDS = ['0', '1', '2', '3', '7', '6', '8', '9', '10', '11', '12'];
const videasyProxyUrl = process.env.VIDEASY_PROXY_URL || process.env.RESIDENTIAL_PROXY_URL || '';
const videasyProxyAgent = videasyProxyUrl ? new ProxyAgent(videasyProxyUrl) : null;
const playbackProxyUrl = process.env.PLAYBACK_PROXY_URL || process.env.RESIDENTIAL_PROXY_URL || '';
const playbackProxyAgent = playbackProxyUrl ? new ProxyAgent(playbackProxyUrl) : null;

function normalizeHeaders(headers = {}) {
  return Object.entries(headers).reduce((acc, [key, value]) => {
    if (typeof value === 'string' && value) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function sanitizePlaybackHeaders(headers = {}) {
  const allowed = new Set(['referer', 'origin', 'user-agent', 'range']);
  return Object.entries(normalizeHeaders(headers)).reduce((acc, [key, value]) => {
    if (allowed.has(key)) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function logResolvedQualities(label, qualities = []) {
  if (!Array.isArray(qualities) || !qualities.length) {
    console.log(new Date().toISOString(), label, 'none');
    return;
  }

  console.log(
    new Date().toISOString(),
    label,
    qualities.map((entry) => entry?.label || entry?.quality || 'unknown').join(', ')
  );
}

function normalizeQualityLabel(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  const numberMatch = text.match(/(\d{3,4})/);
  if (numberMatch?.[1]) {
    return `${numberMatch[1]}p`;
  }

  if (/auto/i.test(text)) {
    return 'auto';
  }

  return text;
}

function getQualityRank(label) {
  if (String(label || '').toLowerCase() === 'auto') {
    return Number.MAX_SAFE_INTEGER;
  }

  return Number.parseInt(String(label || '').replace(/\D/g, ''), 10) || 0;
}

function sortQualities(qualities = []) {
  return [...qualities].sort((left, right) => getQualityRank(right.label) - getQualityRank(left.label));
}

function dedupeQualities(qualities = []) {
  const seen = new Set();

  return sortQualities(qualities).filter((entry) => {
    if (!entry?.url) {
      return false;
    }

    const key = `${String(entry.label || '').toLowerCase()}::${entry.url}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function withTimeout(signalTimeoutMs = PLAYLIST_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), signalTimeoutMs);
  return {
    signal: controller.signal,
    done: () => clearTimeout(timer)
  };
}

function buildQualityEntriesFromSources(sources = []) {
  return dedupeQualities(
    sources
      .filter((entry) => typeof entry?.url === 'string' && entry.url.startsWith('http'))
      .map((entry) => ({
        label: normalizeQualityLabel(entry.quality || entry.label || entry.name || entry.resolution),
        quality: normalizeQualityLabel(entry.quality || entry.label || entry.name || entry.resolution),
        url: entry.url,
        type: detectType(entry.url),
        isDefault: false
      }))
      .filter((entry) => entry.label)
  );
}

function buildAbsolutePlaylistUrl(playlistUrl, candidatePath) {
  const resolved = new URL(candidatePath, playlistUrl);
  const base = new URL(playlistUrl);

  for (const key of ['headers', 'host']) {
    if (!resolved.searchParams.has(key) && base.searchParams.has(key)) {
      resolved.searchParams.set(key, base.searchParams.get(key));
    }
  }

  return resolved.toString();
}

function shouldProxyPlaybackUrl(targetUrl, headers = {}, type = '') {
  const normalizedType = String(type || '').toUpperCase();
  const normalizedHeaders = normalizeHeaders(headers);

  if (normalizedType !== 'HLS' && !/\.m3u8(\?|$)/i.test(String(targetUrl || ''))) {
    return false;
  }

  try {
    const parsed = new URL(String(targetUrl || ''));
    return Boolean(Object.keys(normalizedHeaders).length || parsed.searchParams.has('headers') || parsed.searchParams.has('host'));
  } catch {
    return Boolean(Object.keys(normalizedHeaders).length);
  }
}

function getProxyBaseUrl(req) {
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
  return `${protocol}://${req.get('host')}/proxy`;
}

function buildProxyPlaybackUrl(proxyBaseUrl, targetUrl, headers = {}) {
  const proxied = new URL(proxyBaseUrl);
  proxied.searchParams.set('url', targetUrl);

  let headerOverrides = sanitizePlaybackHeaders(headers);

  try {
    const parsedTarget = new URL(targetUrl);
    if (parsedTarget.searchParams.has('headers')) {
      delete headerOverrides.referer;
      delete headerOverrides.origin;
    }
  } catch {
    // Fall through and attach sanitized headers when URL parsing fails.
  }

  if (Object.keys(headerOverrides).length) {
    proxied.searchParams.set('headers', JSON.stringify(headerOverrides));
  }

  return proxied.toString();
}

function withProxiedPlaybackUrls(result, req) {
  const proxyBaseUrl = getProxyBaseUrl(req);

  const nextQualities = Array.isArray(result?.qualities)
    ? result.qualities.map((entry) => {
        if (!shouldProxyPlaybackUrl(entry?.url, result?.headers || {}, entry?.type || result?.type)) {
          return entry;
        }

        return {
          ...entry,
          url: buildProxyPlaybackUrl(proxyBaseUrl, entry.url, result.headers || {})
        };
      })
    : [];

  const shouldProxyPrimary = shouldProxyPlaybackUrl(result?.url, result?.headers || {}, result?.type);

  return {
    ...result,
    url: shouldProxyPrimary ? buildProxyPlaybackUrl(proxyBaseUrl, result.url, result.headers || {}) : result.url,
    stream: shouldProxyPrimary ? buildProxyPlaybackUrl(proxyBaseUrl, result.stream || result.url, result.headers || {}) : (result.stream || result.url),
    qualities: nextQualities
  };
}

function buildFallbackMasterPlaylistUrls(playlistUrl) {
  const parsed = new URL(playlistUrl);
  const pathname = parsed.pathname || '';
  if (!/\.m3u8$/i.test(pathname)) {
    return [];
  }

  const fileName = pathname.split('/').pop() || '';
  const commonNames = ['master.m3u8', 'index.m3u8', 'video.m3u8'];

  return commonNames
    .filter((name) => name.toLowerCase() !== fileName.toLowerCase())
    .map((name) => {
      const nextUrl = new URL(playlistUrl);
      nextUrl.pathname = pathname.replace(/[^/]+$/, name);
      return nextUrl.toString();
    });
}

function parseVariantAttributes(line) {
  return line
    .replace(/^#EXT-X-STREAM-INF:/i, '')
    .split(',')
    .reduce((acc, part) => {
      const [rawKey, ...rawValueParts] = part.split('=');
      const key = String(rawKey || '').trim().toUpperCase();
      const value = rawValueParts.join('=').trim().replace(/^"|"$/g, '');

      if (key) {
        acc[key] = value;
      }

      return acc;
    }, {});
}

function deriveQualityLabelFromVariant(attributes = {}) {
  const resolution = String(attributes.RESOLUTION || '').trim();
  const height = resolution.split('x')[1];
  if (height) {
    return normalizeQualityLabel(height);
  }

  const bandwidth = Number.parseInt(String(attributes.BANDWIDTH || '').replace(/\D/g, ''), 10);
  if (bandwidth >= 7_500_000) return '2160p';
  if (bandwidth >= 4_500_000) return '1440p';
  if (bandwidth >= 2_500_000) return '1080p';
  if (bandwidth >= 1_400_000) return '720p';
  if (bandwidth >= 800_000) return '480p';
  if (bandwidth >= 400_000) return '360p';
  if (bandwidth > 0) return '240p';
  return '';
}

async function fetchPlaylistQualities(playlistUrl, headers = {}) {
  if (!/\.m3u8(\?|$)/i.test(String(playlistUrl || ''))) {
    return [];
  }

  const playlistHeaders = sanitizePlaybackHeaders(headers);

  async function fetchPlaylistBody(url) {
    const { signal, done } = withTimeout();

    try {
      const response = await fetch(url, {
        headers: playlistHeaders,
        signal,
        dispatcher: playbackProxyAgent || undefined,
      });

      if (!response.ok) {
        return null;
      }

      return await response.text();
    } catch {
      return null;
    } finally {
      done();
    }
  }

  function parseMasterPlaylist(body, baseUrl) {
    if (!/#EXTM3U/i.test(body) || !/#EXT-X-STREAM-INF/i.test(body)) {
      return [];
    }

    const lines = body.split(/\r?\n/);
    const variants = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim();
      if (!line || !line.startsWith('#EXT-X-STREAM-INF')) {
        continue;
      }

      const nextLine = lines[index + 1]?.trim();
      if (!nextLine || nextLine.startsWith('#')) {
        continue;
      }

      const attributes = parseVariantAttributes(line);
      const label = deriveQualityLabelFromVariant(attributes);
      if (!label) {
        continue;
      }

      variants.push({
        label,
        quality: label,
        url: buildAbsolutePlaylistUrl(baseUrl, nextLine),
        type: 'HLS',
        bandwidth: attributes.BANDWIDTH || '',
        resolution: attributes.RESOLUTION || '',
        isDefault: false
      });
    }

    return dedupeQualities(variants);
  }

  const primaryBody = await fetchPlaylistBody(playlistUrl);
  if (!primaryBody) {
    return [];
  }

  const primaryVariants = parseMasterPlaylist(primaryBody, playlistUrl);
  if (primaryVariants.length) {
    return primaryVariants;
  }

  const fallbackUrls = buildFallbackMasterPlaylistUrls(playlistUrl);
  for (const fallbackUrl of fallbackUrls) {
    const fallbackBody = await fetchPlaylistBody(fallbackUrl);
    if (!fallbackBody) {
      continue;
    }

    const fallbackVariants = parseMasterPlaylist(fallbackBody, fallbackUrl);
    if (fallbackVariants.length) {
      console.log(new Date().toISOString(), '[resolve] master playlist fallback', fallbackUrl);
      return fallbackVariants;
    }
  }

  return [{
    label: 'auto',
    quality: 'auto',
    url: playlistUrl,
    type: 'HLS',
    isDefault: false
  }];
}

async function attachQualities(result, sourceCandidates = []) {
  if (!result?.url) {
    return result;
  }

  const sourceQualities = buildQualityEntriesFromSources(sourceCandidates);
  const playlistQualities = sourceQualities.length
    ? []
    : await fetchPlaylistQualities(result.url, result.headers || {});

  const qualities = dedupeQualities([
    ...playlistQualities,
    ...sourceQualities
  ]);

  const normalizedQualities = (qualities.length ? qualities : [{
    label: 'auto',
    quality: 'auto',
    url: result.url,
    type: result.type || detectType(result.url),
    isDefault: false
  }]).map((entry, index) => ({
    ...entry,
    isDefault: index === 0
  }));

  return {
    ...result,
    qualities: normalizedQualities
  };
}

function isVidfastUrl(url) {
  return /(^|\.)vidfast\.(pro|in|io|me|net|pm|xyz)$/i.test(new URL(String(url || 'https://invalid.local')).hostname);
}

function getVidfastHeaders(sourceUrl, requestHeaders = {}) {
  let origin = 'https://vidfast.pro';

  try {
    const parsed = new URL(sourceUrl);
    origin = parsed.origin;
  } catch {
    origin = 'https://vidfast.pro';
  }

  return {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    origin,
    referer: `${origin}/`,
    ...requestHeaders
  };
}

function isVideasyUrl(url) {
  return /player\.videasy\.net/i.test(String(url || ''));
}

function isVidnestUrl(url) {
  try {
    return /(^|\.)vidnest\.fun$/i.test(new URL(String(url || '')).hostname);
  } catch {
    return false;
  }
}

function isVidzeeUrl(url) {
  return /player\.vidzee\.wtf\/v2\/embed\//i.test(String(url || ''));
}

function isVidkingUrl(url) {
  return /www\.vidking\.net\/embed\//i.test(String(url || ''));
}

function getProviderKeyFromUrl(url) {
  if (isVidfastUrl(url)) return 'vidfast';
  if (isVidnestUrl(url)) return 'vidnest';
  if (isVideasyUrl(url)) return 'videasy';
  if (isVidzeeUrl(url)) return 'vidzee';
  if (isVidkingUrl(url)) return 'vidking';
  return null;
}

function parseVidnestSourceUrl(sourceUrl) {
  try {
    const parsed = new URL(sourceUrl);
    if (!/(^|\.)vidnest\.fun$/i.test(parsed.hostname)) {
      return null;
    }

    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts[0] === 'movie' && parts[1]) {
      return {
        mediaType: 'movie',
        tmdbId: parts[1]
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

function buildVidnestApiCandidates(details) {
  const variants = ['allmovies', 'moviebox', 'primesrc'];
  const path = details.mediaType === 'movie'
    ? `movie/${details.tmdbId}`
    : `tv/${details.tmdbId}/${details.seasonId}/${details.episodeId}`;

  const candidates = variants.map((variant) => `https://new.vidnest.fun/${variant}/${path}`);
  candidates.push(`https://new.vidnest.fun/onehd/${path}?server=upcloud`);
  return candidates;
}

function decodeVidnestPayload(cipherText) {
  const customAlphabet = VIDNEST_DECRYPT_ALPHABET;
  const standardAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const translation = new Map(customAlphabet.split('').map((char, index) => [char, standardAlphabet[index]]));
  const translated = String(cipherText || '')
    .trim()
    .split('')
    .map((char) => translation.get(char) || char)
    .join('');
  const paddingLength = translated.length % 4;
  const padded = paddingLength ? translated + '='.repeat(4 - paddingLength) : translated;
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

function unwrapVidnestStream(rawUrl, payloadHeaders = {}) {
  const normalizedPayloadHeaders = normalizeHeaders(payloadHeaders);

  try {
    const parsed = new URL(rawUrl);
    const nestedUrl = parsed.searchParams.get('url');
    const encodedHeaders = parsed.searchParams.get('headers');

    if (!nestedUrl || !/\/mp4-proxy$/i.test(parsed.pathname)) {
      return {
        url: rawUrl,
        headers: normalizedPayloadHeaders
      };
    }

    let proxyHeaders = {};
    if (encodedHeaders) {
      try {
        proxyHeaders = JSON.parse(encodedHeaders);
      } catch {
        proxyHeaders = {};
      }
    }

    return {
      url: nestedUrl,
      headers: normalizeHeaders({
        ...proxyHeaders,
        ...normalizedPayloadHeaders
      })
    };
  } catch {
    return {
      url: rawUrl,
      headers: normalizedPayloadHeaders
    };
  }
}

function pickVidnestSource(payload) {
  if (typeof payload?.url === 'string' && payload.url.startsWith('http')) {
    return {
      url: payload.url,
      headers: payload.headers || {},
      sources: payload.sources || payload.streams || []
    };
  }

  const streams = Array.isArray(payload?.streams) ? payload.streams : [];
  const streamEntry = streams.find((entry) => typeof entry?.url === 'string' && entry.url.startsWith('http'));
  if (streamEntry?.url) {
    return {
      url: streamEntry.url,
      headers: streamEntry.headers || payload?.headers || {},
      sources: streams
    };
  }

  const selectedSource = pickVideasySource(payload);
  if (!selectedSource?.url) {
    return null;
  }

  return {
    url: selectedSource.url,
    headers: selectedSource.headers || payload?.headers || {},
    sources: payload?.sources || []
  };
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
        tmdbId: parts[1]
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

function parseVidkingSourceUrl(sourceUrl) {
  try {
    const parsed = new URL(sourceUrl);
    if (parsed.hostname !== 'www.vidking.net') {
      return null;
    }

    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts[0] === 'embed' && parts[1] === 'movie' && parts[2]) {
      return { mediaType: 'movie', tmdbId: parts[2] };
    }

    if (parts[0] === 'embed' && parts[1] === 'tv' && parts[2] && parts[3] && parts[4]) {
      return { mediaType: 'tv', tmdbId: parts[2], seasonId: parts[3], episodeId: parts[4] };
    }
  } catch {
    return null;
  }

  return null;
}

function getVideasyMetadataUrl(details) {
  if (details.mediaType === 'movie') {
    return `https://db.videasy.net/3/movie/${details.tmdbId}?append_to_response=external_ids&language=en`;
  }

  return `https://db.videasy.net/3/tv/${details.tmdbId}?append_to_response=external_ids&language=en`;
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
    title: encodeURIComponent(title),
    mediaType: details.mediaType,
    year,
    tmdbId: details.tmdbId,
    seasonId: details.seasonId || '1',
    episodeId: details.episodeId || '1'
  });

  if (imdbId) {
    params.set('imdbId', imdbId);
  }

  return params;
}

function buildVideasyApiCandidates(details, params, userIp = '') {
  const serialized = params.toString();
  const candidates = [
    `https://api.videasy.net/myflixerzupcloud/sources-with-title?${serialized}`,
    `https://api.videasy.net/moviebox/sources-with-title?${serialized}`,
    `https://api.videasy.net/1movies/sources-with-title?${serialized}`,
    `https://api.videasy.net/cdn/sources-with-title?${serialized}`,
    `https://api.videasy.net/primesrcme/sources-with-title?${serialized}`
  ];

  if (userIp) {
    const api2Params = new URLSearchParams(serialized);
    api2Params.set('userIp', userIp);
    candidates.push(`https://api2.videasy.net/primewire/sources-with-title?${api2Params.toString()}`);
  }

  return candidates;
}

function pickVideasySource(payload) {
  const sources = Array.isArray(payload?.sources) ? payload.sources : [];

  const ranked = sources
    .filter((entry) => typeof entry?.url === 'string' && entry.url.startsWith('http'))
    .sort((left, right) => {
      const leftScore = Number.parseInt(String(left.quality || '').replace(/\D/g, ''), 10) || 0;
      const rightScore = Number.parseInt(String(right.quality || '').replace(/\D/g, ''), 10) || 0;
      return rightScore - leftScore;
    });

  return ranked[0] || null;
}

async function fetchVideasyUrl(url, options = {}, session = null) {
  const headers = {
    ...(options.headers || {})
  };

  if (session?.userAgent && !headers['user-agent']) {
    headers['user-agent'] = session.userAgent;
  }

  if (session?.cookieHeader && !headers.cookie) {
    headers.cookie = session.cookieHeader;
  }

  return fetch(url, {
    ...options,
    headers,
    ...(videasyProxyAgent ? { dispatcher: videasyProxyAgent } : {})
  });
}

async function tryResolveVideasyDirect(sourceUrl) {
  const details = parseVideasySourceUrl(sourceUrl);
  if (!details) {
    return null;
  }

  try {
    const videasySession = await getVideasySession(sourceUrl).catch(() => null);

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
    const params = buildVideasyResolveParams(details, metadata);
    if (!params) {
      console.log(new Date().toISOString(), '[videasy] metadata incomplete', sourceUrl);
      return null;
    }

    let userIp = '';
    try {
      userIp = (await fetchVideasyUrl('https://api4.ipify.org', {}, videasySession).then((response) => response.text())).trim();
    } catch {
      userIp = '';
    }

    for (const apiUrl of buildVideasyApiCandidates(details, params, userIp)) {
      try {
        const upstream = await fetchVideasyUrl(apiUrl, {
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
        }, videasySession);

        const encryptedBody = await upstream.text();
        console.log(new Date().toISOString(), '[videasy] direct api', upstream.status, apiUrl);

        let stageOne = '';
        if (upstream.ok && encryptedBody) {
          stageOne = await decryptVideasyPayload(encryptedBody, details.tmdbId, sourceUrl);
        } else if (upstream.status === 403) {
          stageOne = await resolveVideasyPayloadInBrowser(apiUrl, details.tmdbId, sourceUrl);
        } else {
          continue;
        }

        if (!stageOne) {
          continue;
        }

        const decrypted = CryptoJS.AES.decrypt(stageOne, '').toString(CryptoJS.enc.Utf8);
        if (!decrypted) {
          continue;
        }

        const payload = JSON.parse(decrypted);
        const selectedSource = pickVideasySource(payload);
        if (!selectedSource?.url) {
          continue;
        }

        return attachQualities({
          success: true,
          url: selectedSource.url,
          stream: selectedSource.url,
          type: detectType(selectedSource.url),
          headers: normalizeHeaders({
            origin: 'https://player.videasy.net',
            referer: 'https://player.videasy.net/',
            'user-agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
              'AppleWebKit/537.36 (KHTML, like Gecko) ' +
              'Chrome/120.0.0.0 Safari/537.36'
          }),
          provider: 'videasy',
          sourceUrl,
          qualities: []
        }, payload?.sources || []);
      } catch (error) {
        console.log(new Date().toISOString(), '[videasy] direct api failed', apiUrl, error?.message || String(error));
      }
    }
  } catch (error) {
    console.log(new Date().toISOString(), '[videasy] direct resolve failed', sourceUrl, error?.message || String(error));
  }

  return null;
}

async function tryResolveVidkingDirect(sourceUrl) {
  const details = parseVidkingSourceUrl(sourceUrl);
  if (!details) {
    return null;
  }

  try {
    const vidkingSession = await getVidkingSession(sourceUrl).catch(() => null);
    const metadataResponse = await fetch(getVideasyMetadataUrl(details), {
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        referer: sourceUrl,
        origin: 'https://www.vidking.net'
      }
    });

    if (!metadataResponse.ok) {
      return null;
    }

    const metadata = await metadataResponse.json();
    const params = buildVideasyResolveParams(details, metadata);
    if (!params) {
      return null;
    }

    const candidates = [
      'https://api.videasy.net/myflixerzupcloud/sources-with-title',
      'https://api.videasy.net/cdn/sources-with-title',
      'https://api.videasy.net/moviebox/sources-with-title',
      'https://api.videasy.net/1movies/sources-with-title',
      'https://api.videasy.net/primesrcme/sources-with-title'
    ];

    for (const candidateBase of candidates) {
      const apiUrl = new URL(candidateBase);
      for (const [key, value] of params.entries()) {
        apiUrl.searchParams.append(key, value);
      }
      apiUrl.searchParams.set('_t', String(Date.now()));

      try {
        const upstream = await fetchVideasyUrl(apiUrl, {
          headers: {
            accept: 'application/json, text/plain, */*',
            'accept-language': 'en-US,en;q=0.9',
            origin: 'https://www.vidking.net',
            referer: sourceUrl,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            Pragma: 'no-cache',
            Expires: '0'
          }
        }, vidkingSession);

        if (!upstream.ok) {
          continue;
        }

        const encryptedBody = await upstream.text();
        if (!encryptedBody) {
          continue;
        }

        const stageOne = await decryptVidkingPayload(encryptedBody, details.tmdbId, sourceUrl);
        if (!stageOne) {
          continue;
        }

        const decrypted = CryptoJS.AES.decrypt(stageOne, '').toString(CryptoJS.enc.Utf8);
        if (!decrypted) {
          continue;
        }

        const payload = JSON.parse(decrypted);
        const selectedSource = pickVideasySource(payload);
        if (!selectedSource?.url) {
          continue;
        }

        return attachQualities({
          success: true,
          url: selectedSource.url,
          stream: selectedSource.url,
          type: detectType(selectedSource.url),
          headers: normalizeHeaders({
            origin: 'https://www.vidking.net',
            referer: sourceUrl,
            'user-agent': vidkingSession?.userAgent || 'Mozilla/5.0'
          }),
          provider: 'vidking',
          sourceUrl,
          qualities: []
        }, payload?.sources || []);
      } catch {
        // Try the next candidate.
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function tryResolveVidnestDirect(sourceUrl) {
  const details = parseVidnestSourceUrl(sourceUrl);
  if (!details) {
    return null;
  }

  for (const apiUrl of buildVidnestApiCandidates(details)) {
    try {
      const response = await fetch(apiUrl, {
        headers: {
          accept: 'application/json, text/plain, */*',
          'accept-language': 'en-US,en;q=0.9',
          origin: 'https://vidnest.fun',
          referer: sourceUrl,
          'user-agent': 'Mozilla/5.0'
        }
      });

      if (!response.ok) {
        continue;
      }

      const payload = await response.json();
      if (!payload?.data) {
        continue;
      }

      const decrypted = decodeVidnestPayload(payload.data);
      const selectedSource = pickVidnestSource(decrypted);
      if (!selectedSource?.url) {
        continue;
      }

      const unwrapped = unwrapVidnestStream(selectedSource.url, selectedSource.headers);
      if (!unwrapped.url) {
        continue;
      }

      return attachQualities({
        success: true,
        url: unwrapped.url,
        stream: unwrapped.url,
        type: detectType(unwrapped.url),
        headers: unwrapped.headers,
        provider: 'Videasy',
        sourceUrl,
        qualities: []
      }, selectedSource.sources);
    } catch (error) {
      console.log(new Date().toISOString(), '[vidnest] direct api failed', apiUrl, error?.message || String(error));
    }
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

        return attachQualities({
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
        }, payload?.url || []);
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
        headers: getVidfastHeaders(sourceUrl, request.headers || {})
      });

      const contentType = response.headers.get('content-type') || '';
      const body = await response.text();

      if (!response.ok) {
        continue;
      }

      if (/https?:\/\/[^\s"']+\.m3u8/i.test(body)) {
        const match = body.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/i);
        if (match?.[0]) {
          return attachQualities({
            success: true,
            url: match[0],
            stream: match[0],
            type: 'HLS',
            headers: normalizeHeaders(request.headers || {}),
            provider: 'vidfast',
            sourceUrl,
            qualities: []
          });
        }
      }

      if (/mpegurl|dash\+xml|video\//i.test(contentType)) {
        return attachQualities({
          success: true,
          url: request.url,
          stream: request.url,
          type: /dash\+xml/i.test(contentType) ? 'DASH' : 'HLS',
          headers: normalizeHeaders(request.headers || {}),
          provider: 'vidfast',
          sourceUrl,
          qualities: []
        });
      }
    } catch {
      // fall through to browser extraction
    }
  }

  return null;
}

async function resolveStream(url) {
  if (isVidfastUrl(url)) {
    const directResult = await tryResolveVidfastFromHints(url);
    if (directResult) {
      console.log(new Date().toISOString(), '[resolve] vidfast direct cache hit', directResult.url);
      return directResult;
    }
  }

  if (isVidzeeUrl(url)) {
    const directResult = await tryResolveVidzeeDirect(url).catch(() => null);
    if (directResult) {
      console.log(new Date().toISOString(), '[resolve] vidzee direct success', directResult.url);
      return directResult;
    }
  }

  if (isVidnestUrl(url)) {
    const directResult = await tryResolveVidnestDirect(url).catch(() => null);
    if (directResult) {
      console.log(new Date().toISOString(), '[resolve] vidnest direct success', directResult.url);
      return directResult;
    }
  }

  if (isVideasyUrl(url)) {
    const directResult = await tryResolveVideasyDirect(url);
    if (directResult) {
      console.log(new Date().toISOString(), '[resolve] videasy direct success', directResult.url);
      return directResult;
    }
  }

  if (isVidkingUrl(url)) {
    const directResult = await tryResolveVidkingDirect(url);
    if (directResult) {
      console.log(new Date().toISOString(), '[resolve] vidking direct success', directResult.url);
      return directResult;
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('STREAM_NOT_FOUND'));
    }, isVidfastUrl(url) ? 75000 : isVidkingUrl(url) ? 30000 : isVidzeeUrl(url) ? 24000 : isVideasyUrl(url) ? 18000 : RESOLVE_TIMEOUT_MS);

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

        attachQualities(resolved)
          .then(resolve)
          .catch(() => resolve(resolved));
      },
      isVidfastUrl(url)
        ? { settleTimeout: 3000, navigationTimeout: 45000, minWaitAfterLoad: 4000, maxWaitAfterLoad: 18000 }
        : isVidkingUrl(url)
        ? { settleTimeout: 2500, navigationTimeout: 30000, minWaitAfterLoad: 5000, maxWaitAfterLoad: 14000 }
        : isVidzeeUrl(url)
        ? { settleTimeout: 2500, navigationTimeout: 30000, minWaitAfterLoad: 5000, maxWaitAfterLoad: 15000 }
        : isVidnestUrl(url)
        ? { settleTimeout: 2000, navigationTimeout: 20000, minWaitAfterLoad: 3000, maxWaitAfterLoad: 8000 }
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
    logResolvedQualities('[resolve] qualities', cached.qualities);
    return res.json({ ...withProxiedPlaybackUrls(cached, req), cached: true });
  }

  let inflight = inflightResolutions.get(cacheKey);
  if (!inflight) {
    inflight = resolveStream(url)
      .then((result) => {
        cache.set(cacheKey, result, ONE_DAY_MS);
        return result;
      })
      .finally(() => {
        inflightResolutions.delete(cacheKey);
      });

    inflightResolutions.set(cacheKey, inflight);
  } else {
    console.log(new Date().toISOString(), '[resolve] joining inflight', url);
  }

  try {
    const result = await inflight;
    logResolvedQualities('[resolve] qualities', result.qualities);
    console.log(new Date().toISOString(), '[resolve] success', result.url);
    return res.json(withProxiedPlaybackUrls(result, req));
  } catch (error) {
    console.log(new Date().toISOString(), '[resolve] failed', error?.message || 'STREAM_NOT_FOUND');
    return res.status(404).json({
      success: false,
      error: error?.message || 'STREAM_NOT_FOUND'
    });
  }
});

export default router;
