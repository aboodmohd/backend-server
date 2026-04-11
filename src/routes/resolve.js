import { Router } from 'express';
import { createDecipheriv, createHash } from 'node:crypto';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import CryptoJS from 'crypto-js';
import PQueue from 'p-queue';
import { ProxyAgent } from 'undici';
import { detectType } from '../interceptors/index.js';
import { createCacheStore } from '../store/results.js';
import { decryptVideasyPayload, decryptVidkingPayload, extractVideoUrls, getVideasySession, getVidkingSession, resolveVideasyPayloadInBrowser } from '../workers/playwright.js';

const router = Router();
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const SIX_HOURS_MS = 6 * ONE_HOUR_MS;
const currentDir = dirname(fileURLToPath(import.meta.url));
const RESOLVE_CACHE_TTL_MS = Math.max(1, Number(process.env.RESOLVE_CACHE_TTL_MS || SIX_HOURS_MS) || SIX_HOURS_MS);
const cache = createCacheStore({
  defaultTtlMs: RESOLVE_CACHE_TTL_MS,
  persistPath: process.env.RESOLVE_CACHE_PATH || resolvePath(currentDir, '../../.cache/resolve-cache.json')
});
const vidfastHintCache = createCacheStore();
const vidzeeKeyCache = createCacheStore();
const vidrockIdCache = createCacheStore({ defaultTtlMs: ONE_DAY_MS });
const inflightResolutions = new Map();
const RESOLVE_TIMEOUT_MS = Number(process.env.RESOLVE_TIMEOUT_MS || 30000);
const PLAYLIST_FETCH_TIMEOUT_MS = Number(process.env.PLAYLIST_FETCH_TIMEOUT_MS || 8000);
const DIRECT_PROVIDER_FETCH_TIMEOUT_MS = Number(process.env.DIRECT_PROVIDER_FETCH_TIMEOUT_MS || 5000);
const VIDNEST_DECRYPT_ALPHABET = 'RB0fpH8ZEyVLkv7c2i6MAJ5u3IKFDxlS1NTsnGaqmXYdUrtzjwObCgQP94hoeW+/';
const VIDZEE_KEY_SECRETS = [
  process.env.VIDZEE_KEY_SECRET || '',
  '4f2a9c7d1e8b3a6f0d5c2e9a7b1f4d8c',
  '7c9e2b4a1f6d8a3e5'
].filter(Boolean);
const VIDZEE_SERVER_IDS = ['0', '1', '2', '3', '7', '6', '8', '9', '10', '11', '12'];
const VIDROCK_ENCRYPTION_KEY = 'x7k9mPqT2rWvY8zA5bC3nF6hJ2lK4mN9';
const VIDROCK_TMDB_API_KEY = process.env.VIDROCK_TMDB_API_KEY || process.env.TMDB_API_KEY || '54e00466a09676df57ba51c4ca30b1a6';
const EMBEDDED_HEADERS_PARAM = '__proxy_headers';
const EMBEDDED_HOST_PARAM = '__proxy_host';
const VIDEASY_UPSTREAM_BLOCKED = 'VIDEASY_UPSTREAM_BLOCKED';
const videasyProxyUrl = process.env.VIDEASY_PROXY_URL || process.env.RESIDENTIAL_PROXY_URL || '';
const videasyProxyAgent = videasyProxyUrl ? new ProxyAgent(videasyProxyUrl) : null;
const playbackProxyUrl = process.env.PLAYBACK_PROXY_URL || process.env.RESIDENTIAL_PROXY_URL || '';
const playbackProxyAgent = playbackProxyUrl ? new ProxyAgent(playbackProxyUrl) : null;
const RESOLVE_CONCURRENCY = Math.max(1, Number(process.env.RESOLVE_CONCURRENCY || process.env.EXTRACTION_CONCURRENCY || 2) || 2);
const resolveQueue = new PQueue({ concurrency: RESOLVE_CONCURRENCY });

function enqueueResolveJob(url, job) {
  const queuedAt = Date.now();
  const queuedDepth = resolveQueue.size;

  if (queuedDepth > 0 || resolveQueue.pending >= RESOLVE_CONCURRENCY) {
    console.log(
      new Date().toISOString(),
      '[resolve] queued',
      url,
      `active=${resolveQueue.pending}`,
      `queued=${queuedDepth + 1}`
    );
  }

  return resolveQueue.add(async () => {
    const waitMs = Date.now() - queuedAt;
    if (waitMs > 25 || queuedDepth > 0) {
      console.log(
        new Date().toISOString(),
        '[resolve] dequeued',
        url,
        `wait=${waitMs}ms`,
        `active=${resolveQueue.pending}`,
        `queued=${resolveQueue.size}`
      );
    }

    return job();
  });
}

function normalizeHeaders(headers = {}) {
  return Object.entries(headers).reduce((acc, [key, value]) => {
    const normalizedKey = String(key || '').trim().toLowerCase();
    if (normalizedKey && typeof value === 'string' && value) {
      acc[normalizedKey] = value;
    }
    return acc;
  }, {});
}

function isCloudflareBlockPage(body = '') {
  const snippet = String(body || '').slice(0, 4000);
  return /attention required! \| cloudflare/i.test(snippet) || /just a moment/i.test(snippet) || /challenge-platform/i.test(snippet);
}

function createStatusError(message, statusCode, code = message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function hasErrorCode(error, code) {
  return error?.code === code || error?.message === code;
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

function getCodecTokens(codecs = '') {
  return String(codecs || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function getPrimaryVideoCodec(codecs = '') {
  return getCodecTokens(codecs).find((entry) => !/^(mp4a|aac|ac-3|ec-3|opus|flac|alac)/i.test(entry)) || '';
}

function getCodecCompatibilityRank(codecs = '') {
  const videoCodec = getPrimaryVideoCodec(codecs);
  if (!videoCodec) {
    return 50;
  }

  if (/^(avc1|avc3)/i.test(videoCodec)) {
    return 400;
  }

  if (/^(vp09|vp9)/i.test(videoCodec)) {
    return 300;
  }

  if (/^(av01|av1)/i.test(videoCodec)) {
    return 250;
  }

  if (/^(hev1|hvc1|dvh1|dvhe)/i.test(videoCodec)) {
    return -1000;
  }

  return 100;
}

function hasKnownUnsupportedVideoCodec(codecs = '') {
  return getCodecCompatibilityRank(codecs) < 0;
}

function pickPreferredQualityEntry(qualities = []) {
  return [...qualities]
    .filter((entry) => entry?.url)
    .sort((left, right) => {
      const codecDelta =
        getCodecCompatibilityRank(right?.codecs || '') -
        getCodecCompatibilityRank(left?.codecs || '');
      if (codecDelta !== 0) {
        return codecDelta;
      }

      return getQualityRank(right?.label || right?.quality) - getQualityRank(left?.label || left?.quality);
    })[0] || null;
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
        codecs: String(entry.codecs || ''),
        type: detectType(entry.url),
        isDefault: false
      }))
      .filter((entry) => entry.label)
  );
}

function buildAbsolutePlaylistUrl(playlistUrl, candidatePath) {
  const resolved = new URL(candidatePath, playlistUrl);
  const base = new URL(playlistUrl);

  for (const key of [EMBEDDED_HEADERS_PARAM, EMBEDDED_HOST_PARAM, 'headers', 'host']) {
    if (!resolved.searchParams.has(key) && base.searchParams.has(key)) {
      resolved.searchParams.set(key, base.searchParams.get(key));
    }
  }

  return resolved.toString();
}

function shouldProxyPlaybackUrl(targetUrl, headers = {}, type = '') {
  const normalizedHeaders = sanitizePlaybackHeaders(headers);
  if (Object.keys(normalizedHeaders).length > 0) {
    return true;
  }

  const normalizedType = String(type || '').toUpperCase();

  return ['HLS', 'FLV'].includes(normalizedType) || /\.(m3u8|flv)(\?|$)/i.test(String(targetUrl || ''));
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
    if (parsedTarget.searchParams.has(EMBEDDED_HEADERS_PARAM) || parsedTarget.searchParams.has('headers')) {
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
  const attributes = {};
  const source = String(line || '').replace(/^#EXT-X-STREAM-INF:/i, '');
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let match = pattern.exec(source);

  while (match) {
    const key = String(match[1] || '').trim().toUpperCase();
    const value = String(match[2] || '').trim().replace(/^"|"$/g, '');

    if (key) {
      attributes[key] = value;
    }

    match = pattern.exec(source);
  }

  return attributes;
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

function getMasterHdrVideoRange(body = '') {
  const match = String(body || '').match(/VIDEO-RANGE\s*=\s*"?([A-Z0-9_-]+)"?/i);
  return String(match?.[1] || '').trim().toUpperCase();
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
      codecs: String(attributes.CODECS || ''),
      isDefault: false
    });
  }

  return dedupeQualities(variants);
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

function extractFirstMediaPlaylistEntry(body = '', playlistUrl = '') {
  const lines = String(body || '').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    try {
      return buildAbsolutePlaylistUrl(playlistUrl, line);
    } catch {
      return null;
    }
  }

  return null;
}

function hasTsSyncByte(buffer) {
  if (!buffer || buffer.length < 1) {
    return false;
  }

  return buffer[0] === 0x47;
}

function hasKnownFmp4Box(buffer) {
  if (!buffer || buffer.length < 8) {
    return false;
  }

  const boxType = buffer.subarray(4, 8).toString('ascii');
  return ['ftyp', 'styp', 'moof', 'moov', 'mdat'].includes(boxType);
}

function hasKnownImageSignature(buffer) {
  if (!buffer || buffer.length < 4) {
    return false;
  }

  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return true;
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return true;
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return true;
  }

  return false;
}

async function fetchTextBody(url, headers = {}, timeoutMs = PLAYLIST_FETCH_TIMEOUT_MS) {
  const { signal, done } = withTimeout(timeoutMs);

  try {
    const response = await fetch(url, {
      headers: sanitizePlaybackHeaders(headers),
      signal,
      dispatcher: playbackProxyAgent || undefined
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

async function fetchBinaryProbe(url, headers = {}, timeoutMs = PLAYLIST_FETCH_TIMEOUT_MS) {
  const { signal, done } = withTimeout(timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        ...sanitizePlaybackHeaders(headers),
        range: 'bytes=0-63'
      },
      signal,
      dispatcher: playbackProxyAgent || undefined
    });

    if (!response.ok) {
      return null;
    }

    const body = Buffer.from(await response.arrayBuffer());
    return {
      body,
      contentType: response.headers.get('content-type') || ''
    };
  } catch {
    return null;
  } finally {
    done();
  }
}

async function validateHlsPlaybackTarget(playlistUrl, headers = {}) {
  const masterBody = await fetchTextBody(playlistUrl, headers);
  if (!masterBody || !/#EXTM3U/i.test(masterBody)) {
    return {
      ok: false,
      reason: 'playlist-missing'
    };
  }

  let mediaPlaylistUrl = playlistUrl;
  let mediaPlaylistBody = masterBody;

  if (/#EXT-X-STREAM-INF/i.test(masterBody)) {
    const hdrVideoRange = getMasterHdrVideoRange(masterBody);
    if (hdrVideoRange === 'PQ' || hdrVideoRange === 'HLG') {
      return {
        ok: false,
        reason: `master-hdr:${hdrVideoRange.toLowerCase()}`
      };
    }

    const masterVariants = parseMasterPlaylist(masterBody, playlistUrl);
    const preferredVariant = pickPreferredQualityEntry(masterVariants);
    const firstVariantUrl = preferredVariant?.url || extractFirstMediaPlaylistEntry(masterBody, playlistUrl);
    if (!firstVariantUrl) {
      return {
        ok: false,
        reason: 'variant-missing'
      };
    }

    if (
      masterVariants.length > 0 &&
      masterVariants.every((entry) => entry?.codecs && hasKnownUnsupportedVideoCodec(entry.codecs))
    ) {
      return {
        ok: false,
        reason: `master-codecs:${getPrimaryVideoCodec(masterVariants[0]?.codecs || '') || 'unknown'}`
      };
    }

    const nextBody = await fetchTextBody(firstVariantUrl, headers);
    if (!nextBody || !/#EXTM3U/i.test(nextBody)) {
      return {
        ok: false,
        reason: 'variant-unreadable'
      };
    }

    mediaPlaylistUrl = firstVariantUrl;
    mediaPlaylistBody = nextBody;
  }

  const firstSegmentUrl = extractFirstMediaPlaylistEntry(mediaPlaylistBody, mediaPlaylistUrl);
  if (!firstSegmentUrl) {
    return {
      ok: false,
      reason: 'segment-missing'
    };
  }

  const probe = await fetchBinaryProbe(firstSegmentUrl, headers);
  if (!probe?.body?.length) {
    return {
      ok: false,
      reason: 'segment-unreadable'
    };
  }

  const contentType = String(probe.contentType || '').toLowerCase();
  if (hasTsSyncByte(probe.body) || hasKnownFmp4Box(probe.body)) {
    return {
      ok: true
    };
  }

  if (contentType.startsWith('image/')) {
    return {
      ok: false,
      reason: `segment-image:${contentType}`
    };
  }

  if (hasKnownImageSignature(probe.body)) {
    return {
      ok: false,
      reason: 'segment-image-signature'
    };
  }

  return {
    ok: false,
    reason: `segment-unknown:${contentType || 'unknown'}`
  };
}

function shouldValidateCachedPlayback(result, sourceUrl = '') {
  if (String(result?.type || '').toUpperCase() !== 'HLS') {
    return false;
  }

  return (
    String(result?.provider || '').toLowerCase() === 'vidzee' ||
    isVidzeeUrl(result?.sourceUrl || '') ||
    isVidzeeUrl(sourceUrl)
  );
}

function applyPreferredPrimaryPlaybackUrl(result) {
  if (!result?.url || !Array.isArray(result?.qualities) || !result.qualities.length) {
    return result;
  }

  const provider = String(result?.provider || '').toLowerCase();
  const sourceUrl = String(result?.sourceUrl || '');
  const preferredQuality = result.qualities.find((entry) => entry?.isDefault) || pickPreferredQualityEntry(result.qualities);
  const shouldPreferPrimary =
    provider === 'vidlink' ||
    provider === 'vidzee' ||
    isVidlinkUrl(sourceUrl) ||
    isVidzeeUrl(sourceUrl);
  const preferredPrimaryUrl =
    shouldPreferPrimary && preferredQuality?.url
      ? preferredQuality.url
      : null;

  if (!preferredPrimaryUrl || preferredPrimaryUrl === result.url) {
    return result;
  }

  return {
    ...result,
    url: preferredPrimaryUrl,
    stream: preferredPrimaryUrl
  };
}

async function attachQualities(result, sourceCandidates = []) {
  if (!result?.url) {
    return result;
  }

  const sourceQualities = buildQualityEntriesFromSources(sourceCandidates);
  const playlistQualities = (await fetchPlaylistQualities(result.url, result.headers || {})).filter((entry) => {
    const label = String(entry?.label || entry?.quality || '').trim().toLowerCase();
    return label !== 'auto';
  });

  const qualities = dedupeQualities([
    ...playlistQualities,
    ...sourceQualities
  ]);

  const normalizedQualities = (qualities.length ? qualities : [{
    label: 'auto',
    quality: 'auto',
    url: result.url,
    codecs: '',
    type: result.type || detectType(result.url),
    isDefault: false
  }]);
  const preferredQuality = pickPreferredQualityEntry(normalizedQualities);
  const finalQualities = normalizedQualities.map((entry, index) => ({
    ...entry,
    isDefault: preferredQuality ? entry.url === preferredQuality.url : index === 0
  }));

  return applyPreferredPrimaryPlaybackUrl({
    ...result,
    qualities: finalQualities
  });
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

function isVidcoreUrl(url) {
  return /(^|\.)vidcore\.net$/i.test(new URL(String(url || 'https://invalid.local')).hostname);
}

function getVidcoreHeaders(sourceUrl, requestHeaders = {}) {
  let origin = 'https://vidcore.net';

  try {
    const parsed = new URL(sourceUrl);
    origin = parsed.origin;
  } catch {
    origin = 'https://vidcore.net';
  }

  return {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    ...requestHeaders,
    origin,
    referer: `${origin}/`
  };
}

function isVideasyUrl(url) {
  return /player\.videasy\.net/i.test(String(url || ''));
}

function isVidlinkUrl(url) {
  return /vidlink\.pro\/(?:movie|tv)\//i.test(String(url || ''));
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

function isVidrockUrl(url) {
  return /vidrock\.net\/(?:embed\/)?(?:movie|tv)\//i.test(String(url || ''));
}

function isVidrockDemoUrl(url) {
  return /vidrock\.net\/demo-video\.mp4(?:\?|$)/i.test(String(url || ''));
}

function isVidkingUrl(url) {
  return /www\.vidking\.net\/embed\//i.test(String(url || ''));
}

function getProviderKeyFromUrl(url) {
  if (isVidfastUrl(url)) return 'vidfast';
  if (isVidcoreUrl(url)) return 'vidcore';
  if (isVidlinkUrl(url)) return 'vidlink';
  if (isVidnestUrl(url)) return 'vidnest';
  if (isVideasyUrl(url)) return 'videasy';
  if (isVidzeeUrl(url)) return 'vidzee';
  if (isVidrockUrl(url)) return 'vidrock';
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

function parseVidrockSourceUrl(sourceUrl) {
  try {
    const parsed = new URL(sourceUrl);
    if (parsed.hostname !== 'vidrock.net') {
      return null;
    }

    const parts = parsed.pathname.split('/').filter(Boolean);
    const offset = parts[0] === 'embed' ? 1 : 0;

    if (parts[offset] === 'movie' && parts[offset + 1]) {
      return {
        mediaType: 'movie',
        tmdbId: parts[offset + 1],
        rawId: parts[offset + 1],
        isEmbed: offset === 1
      };
    }

    if (parts[offset] === 'tv' && parts[offset + 1] && parts[offset + 2] && parts[offset + 3]) {
      return {
        mediaType: 'tv',
        tmdbId: parts[offset + 1],
        seasonId: parts[offset + 2],
        episodeId: parts[offset + 3],
        rawId: parts[offset + 1],
        isEmbed: offset === 1
      };
    }
  } catch {
    return null;
  }

  return null;
}

function buildVidrockSourceUrl(details) {
  const prefix = details?.isEmbed ? '/embed' : '';

  if (details?.mediaType === 'tv') {
    return `https://vidrock.net${prefix}/tv/${details.tmdbId}/${details.seasonId}/${details.episodeId}`;
  }

  return `https://vidrock.net${prefix}/movie/${details.tmdbId}`;
}

async function resolveVidrockCanonicalDetails(details, sourceUrl = '') {
  if (!details?.tmdbId) {
    return details;
  }

  const originalId = String(details.rawId || details.tmdbId || '').trim();
  if (!/^tt\d+$/i.test(originalId)) {
    return {
      ...details,
      rawId: originalId,
      canonicalSourceUrl: sourceUrl || buildVidrockSourceUrl(details)
    };
  }

  const cacheKey = `vidrock:${details.mediaType}:${originalId.toLowerCase()}`;
  const cachedTmdbId = vidrockIdCache.get(cacheKey);
  if (cachedTmdbId) {
    const canonicalDetails = {
      ...details,
      rawId: originalId,
      tmdbId: String(cachedTmdbId)
    };

    return {
      ...canonicalDetails,
      canonicalSourceUrl: buildVidrockSourceUrl(canonicalDetails)
    };
  }

  const lookupUrl = new URL(`https://api.themoviedb.org/3/find/${originalId}`);
  lookupUrl.searchParams.set('api_key', VIDROCK_TMDB_API_KEY);
  lookupUrl.searchParams.set('external_source', 'imdb_id');

  const { signal, done } = withTimeout(DIRECT_PROVIDER_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(lookupUrl, {
      headers: {
        accept: 'application/json',
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/145.0.0.0 Safari/537.36'
      },
      signal
    });

    if (!response.ok) {
      console.log(new Date().toISOString(), '[vidrock] tmdb lookup failed', response.status, lookupUrl.toString());
      return {
        ...details,
        rawId: originalId,
        canonicalSourceUrl: sourceUrl || buildVidrockSourceUrl(details)
      };
    }

    const payload = await response.json().catch(() => null);
    const resultSet = details.mediaType === 'tv' ? payload?.tv_results : payload?.movie_results;
    const resolvedTmdbId = String(resultSet?.[0]?.id || '').trim();

    if (!resolvedTmdbId) {
      console.log(new Date().toISOString(), '[vidrock] tmdb lookup empty', originalId, details.mediaType);
      return {
        ...details,
        rawId: originalId,
        canonicalSourceUrl: sourceUrl || buildVidrockSourceUrl(details)
      };
    }

    vidrockIdCache.set(cacheKey, resolvedTmdbId, ONE_DAY_MS);
    const canonicalDetails = {
      ...details,
      rawId: originalId,
      tmdbId: resolvedTmdbId
    };

    return {
      ...canonicalDetails,
      canonicalSourceUrl: buildVidrockSourceUrl(canonicalDetails)
    };
  } catch (error) {
    console.log(new Date().toISOString(), '[vidrock] tmdb lookup failed', originalId, error?.message || String(error));
    return {
      ...details,
      rawId: originalId,
      canonicalSourceUrl: sourceUrl || buildVidrockSourceUrl(details)
    };
  } finally {
    done();
  }
}

function buildVidrockToken(details) {
  const plaintext = details.mediaType === 'tv'
    ? `${details.tmdbId}_${details.seasonId}_${details.episodeId}`
    : `${details.tmdbId}`;

  const encrypted = CryptoJS.AES.encrypt(
    plaintext,
    CryptoJS.enc.Utf8.parse(VIDROCK_ENCRYPTION_KEY),
    {
      iv: CryptoJS.enc.Utf8.parse(VIDROCK_ENCRYPTION_KEY.slice(0, 16)),
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7
    }
  );

  return encrypted.ciphertext
    .toString(CryptoJS.enc.Base64)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function getVidrockHeaders(sourceUrl) {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    origin: 'https://vidrock.net',
    referer: sourceUrl,
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/145.0.0.0 Safari/537.36'
  };
}

function rankVidrockSource(entry = {}) {
  const url = String(entry.url || '');
  if (/workers\.dev/i.test(url) || /\.m3u8(\?|$)/i.test(url)) return 4;
  if (/playlist/i.test(url)) return 3;
  if (/^https?:\/\//i.test(url)) return 2;
  return 0;
}

function extractVidrockSources(payload = {}) {
  return Object.entries(payload)
    .map(([name, entry]) => ({
      name,
      url: entry?.url || '',
      language: entry?.language || '',
      flag: entry?.flag || ''
    }))
    .filter((entry) => typeof entry.url === 'string' && entry.url.startsWith('http'))
    .sort((left, right) => rankVidrockSource(right) - rankVidrockSource(left));
}

function buildVidrockQualityEntries(entries = []) {
  return dedupeQualities(
    entries
      .filter((entry) => typeof entry?.url === 'string' && entry.url.startsWith('http'))
      .map((entry) => ({
        label: normalizeQualityLabel(entry.resolution || entry.quality || entry.label || entry.name),
        quality: normalizeQualityLabel(entry.resolution || entry.quality || entry.label || entry.name),
        url: entry.url,
        type: detectType(entry.url),
        isDefault: false
      }))
      .filter((entry) => entry.label)
  );
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

export function buildVideasyPlaybackUrl({ mediaType, tmdbId, season, episode }) {
  const normalizedMediaType = String(mediaType || '').trim().toLowerCase();
  const normalizedTmdbId = String(tmdbId || '').trim();

  if (!normalizedTmdbId) {
    throw new Error('tmdbId is required');
  }

  if (normalizedMediaType === 'movie') {
    return `https://player.videasy.net/movie/${normalizedTmdbId}`;
  }

  if (normalizedMediaType === 'tv') {
    const normalizedSeason = String(season || '').trim();
    const normalizedEpisode = String(episode || '').trim();

    if (!normalizedSeason || !normalizedEpisode) {
      throw new Error('season and episode are required for tv');
    }

    return `https://player.videasy.net/tv/${normalizedTmdbId}/${normalizedSeason}/${normalizedEpisode}`;
  }

  throw new Error('mediaType must be movie or tv');
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
  const baseEntries = [
    { endpoint: 'https://api.videasy.net/myflixerzupcloud/sources-with-title' },
    { endpoint: 'https://api.videasy.net/moviebox/sources-with-title' },
    { endpoint: 'https://api.videasy.net/1movies/sources-with-title' },
    { endpoint: 'https://api.videasy.net/cdn/sources-with-title' },
    { endpoint: 'https://api.videasy.net/hdmovie/sources-with-title' },
    { endpoint: 'https://api.videasy.net/primesrcme/sources-with-title' },
    { endpoint: 'https://api.videasy.net/m4uhd/sources-with-title' },
    { endpoint: 'https://api.videasy.net/meine/sources-with-title', extraParams: { language: 'german' } }
  ];

  const candidates = baseEntries.map(({ endpoint, extraParams = {} }) => {
    const url = new URL(endpoint);
    for (const [key, value] of params.entries()) {
      url.searchParams.set(key, value);
    }

    for (const [key, value] of Object.entries(extraParams)) {
      url.searchParams.set(key, value);
    }

    return url.toString();
  });

  if (userIp) {
    const api2Params = new URLSearchParams(params.toString());
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
  const { signal, done } = withTimeout(DIRECT_PROVIDER_FETCH_TIMEOUT_MS);
  const headers = {
    ...(options.headers || {})
  };

  if (session?.userAgent && !headers['user-agent']) {
    headers['user-agent'] = session.userAgent;
  }

  if (session?.cookieHeader && !headers.cookie) {
    headers.cookie = session.cookieHeader;
  }

  try {
    return await fetch(url, {
      ...options,
      headers,
      signal,
      ...(videasyProxyAgent ? { dispatcher: videasyProxyAgent } : {})
    });
  } finally {
    done();
  }
}

async function tryResolveVideasyDirect(sourceUrl) {
  const details = parseVideasySourceUrl(sourceUrl);
  if (!details) {
    return null;
  }

  let attemptedApiCount = 0;
  let blockedApiCount = 0;

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
        const blockedByCloudflare = upstream.status === 403 || isCloudflareBlockPage(encryptedBody);

        attemptedApiCount += 1;
        if (blockedByCloudflare) {
          blockedApiCount += 1;
        }

        console.log(new Date().toISOString(), '[videasy] direct api', upstream.status, apiUrl, isCloudflareBlockPage(encryptedBody) ? 'cloudflare-block' : '');

        let stageOne = '';
        if (upstream.ok && encryptedBody && !isCloudflareBlockPage(encryptedBody)) {
          stageOne = await decryptVideasyPayload(encryptedBody, details.tmdbId, sourceUrl);
        } else if (blockedByCloudflare) {
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
    if (hasErrorCode(error, VIDEASY_UPSTREAM_BLOCKED)) {
      throw error;
    }

    console.log(new Date().toISOString(), '[videasy] direct resolve failed', sourceUrl, error?.message || String(error));
  }

  if (attemptedApiCount > 0 && blockedApiCount === attemptedApiCount) {
    throw createStatusError('Videasy upstream blocked by Cloudflare', 502, VIDEASY_UPSTREAM_BLOCKED);
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

async function tryResolveVidrockDirect(sourceUrl, seedDetails = null) {
  const parsedDetails = seedDetails || parseVidrockSourceUrl(sourceUrl);
  const details = await resolveVidrockCanonicalDetails(parsedDetails, sourceUrl);
  if (!details) {
    return null;
  }

  const requestSourceUrl = details.canonicalSourceUrl || sourceUrl;
  const token = buildVidrockToken(details);
  const endpoint = details.mediaType === 'tv' ? 'tv' : 'movie';
  const apiUrl = `https://vidrock.net/api/${endpoint}/${encodeURIComponent(token)}`;

  try {
    const response = await fetch(apiUrl, {
      headers: getVidrockHeaders(requestSourceUrl)
    });

    if (!response.ok) {
      console.log(new Date().toISOString(), '[vidrock] direct api failed', response.status, apiUrl);
      return null;
    }

    const payload = await response.json();
    const sources = extractVidrockSources(payload);

    for (const source of sources) {
      try {
        if (/\.m3u8(\?|$)/i.test(source.url)) {
          return attachQualities({
            success: true,
            url: source.url,
            stream: source.url,
            type: 'HLS',
            headers: normalizeHeaders(getVidrockHeaders(requestSourceUrl)),
            provider: 'vidrock',
            sourceUrl: requestSourceUrl,
            qualities: []
          });
        }

        const { signal, done } = withTimeout(DIRECT_PROVIDER_FETCH_TIMEOUT_MS * 2);

        try {
          const upstream = await fetch(source.url, {
            headers: getVidrockHeaders(requestSourceUrl),
            signal
          });

          if (!upstream.ok) {
            continue;
          }

          const contentType = upstream.headers.get('content-type') || '';

          if (/json/i.test(contentType)) {
            const qualityPayload = await upstream.json().catch(() => null);
            const sourceCandidates = buildVidrockQualityEntries(Array.isArray(qualityPayload) ? qualityPayload : []);
            if (sourceCandidates.length) {
              return attachQualities({
                success: true,
                url: sourceCandidates[0].url,
                stream: sourceCandidates[0].url,
                type: sourceCandidates[0].type || 'HLS',
                headers: normalizeHeaders(getVidrockHeaders(requestSourceUrl)),
                provider: 'vidrock',
                sourceUrl: requestSourceUrl,
                qualities: []
              }, sourceCandidates);
            }
          }

          if (/mpegurl|application\/x-mpegurl|application\/vnd\.apple\.mpegurl/i.test(contentType)) {
            return attachQualities({
              success: true,
              url: source.url,
              stream: source.url,
              type: 'HLS',
              headers: normalizeHeaders(getVidrockHeaders(requestSourceUrl)),
              provider: 'vidrock',
              sourceUrl: requestSourceUrl,
              qualities: []
            });
          }

          if (/video\//i.test(contentType)) {
            return attachQualities({
              success: true,
              url: source.url,
              stream: source.url,
              type: detectType(source.url, contentType),
              headers: normalizeHeaders(getVidrockHeaders(requestSourceUrl)),
              provider: 'vidrock',
              sourceUrl: requestSourceUrl,
              qualities: []
            });
          }
        } finally {
          done();
        }
      } catch (error) {
        console.log(new Date().toISOString(), '[vidrock] source probe failed', source.name, source.url, error?.message || String(error));
      }
    }
  } catch (error) {
    console.log(new Date().toISOString(), '[vidrock] direct resolve failed', sourceUrl, error?.message || String(error));
  }

  return null;
}

async function getVidzeeApiKey() {
  const cached = vidzeeKeyCache.get('vidzee:api-key');
  if (cached) {
    return cached;
  }

  const { signal, done } = withTimeout(DIRECT_PROVIDER_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch('https://core.vidzee.wtf/api-key', { signal });
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

    for (const secret of VIDZEE_KEY_SECRETS) {
      try {
        const key = createHash('sha256').update(secret, 'utf8').digest();
        const decipher = createDecipheriv('aes-256-gcm', key, iv);

        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(ciphertext, undefined, 'utf8');
        decrypted += decipher.final('utf8');

        if (decrypted) {
          vidzeeKeyCache.set('vidzee:api-key', decrypted, ONE_DAY_MS);
          return decrypted;
        }
      } catch {
        // Try the next known VidZee secret.
      }
    }

    throw new Error('VIDZEE_KEY_INVALID');
  } finally {
    done();
  }
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
      const { signal, done } = withTimeout(DIRECT_PROVIDER_FETCH_TIMEOUT_MS);
      const response = await fetch(apiUrl, {
        signal,
        headers: {
          accept: 'application/json, text/plain, */*',
          'accept-language': 'en-US,en;q=0.9',
          origin: 'https://player.vidzee.wtf',
          referer: sourceUrl,
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/129.0.0.0 Safari/537.36'
        }
      });

      try {
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

          const resolved = await attachQualities({
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

          if (String(resolved?.type || '').toUpperCase() === 'HLS') {
            const validation = await validateHlsPlaybackTarget(resolved.url, resolved.headers || {});
            if (!validation.ok) {
              console.log(new Date().toISOString(), '[resolve] vidzee rejected invalid hls', resolved.url, validation.reason);
              continue;
            }
          }

          return resolved;
        }
      } finally {
        done();
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
      const requestHeaders = getVidfastHeaders(sourceUrl, request.headers || {});
      const response = await fetch(request.url, {
        method: request.method || 'GET',
        headers: requestHeaders
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
            headers: normalizeHeaders(requestHeaders),
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
          headers: normalizeHeaders(requestHeaders),
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

export async function resolveStream(url) {
  let resolvedSourceUrl = url;
  let vidrockDetails = null;

  if (isVidrockUrl(url)) {
    vidrockDetails = await resolveVidrockCanonicalDetails(parseVidrockSourceUrl(url), url).catch(() => null);
    if (vidrockDetails?.canonicalSourceUrl) {
      resolvedSourceUrl = vidrockDetails.canonicalSourceUrl;
      if (resolvedSourceUrl !== url) {
        console.log(new Date().toISOString(), '[vidrock] canonical source', url, '->', resolvedSourceUrl);
      }
    }
  }

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

  if (isVidrockUrl(url)) {
    const directResult = await tryResolveVidrockDirect(resolvedSourceUrl, vidrockDetails).catch(() => null);
    if (directResult) {
      console.log(new Date().toISOString(), '[resolve] vidrock direct success', directResult.url);
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
      resolvedSourceUrl,
      (found) => {
        if (settled || !found?.url) {
          return;
        }

        if (isVidrockUrl(url) && isVidrockDemoUrl(found.url)) {
          console.log(new Date().toISOString(), '[resolve] ignore vidrock demo stream', found.url);
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
          headers: normalizeHeaders(
            isVidfastUrl(url)
              ? getVidfastHeaders(resolvedSourceUrl, found.headers || {})
              : isVidcoreUrl(url)
              ? getVidcoreHeaders(resolvedSourceUrl, found.headers || {})
              : isVidrockUrl(url)
              ? { ...getVidrockHeaders(resolvedSourceUrl), ...(found.headers || {}) }
              : (found.headers || {})
          ),
          provider: getProviderKeyFromUrl(url),
          sourceUrl: resolvedSourceUrl,
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
        ? { settleTimeout: 3000, navigationTimeout: 45000, minWaitAfterLoad: 18000, maxWaitAfterLoad: 35000 }
        : isVidcoreUrl(url)
        ? { settleTimeout: 2500, navigationTimeout: 30000, minWaitAfterLoad: 5000, maxWaitAfterLoad: 18000 }
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
  const shouldRefresh = String(req.query.refresh || req.body?.refresh || '').trim() === '1';

  console.log(new Date().toISOString(), '[resolve] incoming', url);

  if (!url) {
    return res.status(400).json({ success: false, error: 'url required' });
  }

  const cacheKey = `stream:${url}`;
  let cached = shouldRefresh ? null : cache.get(cacheKey);
  if (cached && shouldValidateCachedPlayback(cached, url)) {
    const validation = await validateHlsPlaybackTarget(cached.url, cached.headers || {});
    if (!validation.ok) {
      console.log(new Date().toISOString(), '[resolve] dropped stale cached hls', url, validation.reason);
      cache.delete(cacheKey);
      cached = null;
    }
  }

  if (cached) {
    const normalizedCached = applyPreferredPrimaryPlaybackUrl(cached);
    if (normalizedCached !== cached) {
      cache.set(cacheKey, normalizedCached, RESOLVE_CACHE_TTL_MS);
      cached = normalizedCached;
    }

    console.log(new Date().toISOString(), '[resolve] cache hit', url);
    logResolvedQualities('[resolve] qualities', cached.qualities);
    return res.json({ ...withProxiedPlaybackUrls(cached, req), cached: true });
  }

  let inflight = inflightResolutions.get(cacheKey);
  if (!inflight) {
    inflight = enqueueResolveJob(url, () => resolveStream(url))
      .then((result) => {
        cache.set(cacheKey, result, RESOLVE_CACHE_TTL_MS);
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
    const message = error?.message || 'STREAM_NOT_FOUND';
    const inferredStatusCode = (() => {
      const normalized = String(message || '').toLowerCase();
      if (
        normalized.includes('browser.newcontext') ||
        normalized.includes('browsertype.launch') ||
        normalized.includes('target page, context or browser has been closed')
      ) {
        return 502;
      }

      if (normalized.includes('stream_not_found')) {
        return 404;
      }

      return null;
    })();

    console.log(new Date().toISOString(), '[resolve] failed', message);
    const statusCode = Number(error?.statusCode);
    return res.status(Number.isInteger(statusCode) && statusCode >= 400 ? statusCode : inferredStatusCode || 404).json({
      success: false,
      error: message
    });
  }
});

export default router;
