import { Router } from 'express';
import { gotScraping } from 'got-scraping';
import { createDecipheriv, createHash } from 'node:crypto';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import CryptoJS from 'crypto-js';
import PQueue from 'p-queue';
import { ProxyAgent } from 'undici';
import { detectType } from '../interceptors/index.js';
import { createCacheStore } from '../store/results.js';
import { decryptVideasyPayload, decryptVidkingPayload, extractVideoUrls, getDefaultUserAgent, getRealisticClientHints, getVideasySession, getVidkingSession, resolveVideasyPayloadInBrowser } from '../workers/playwright.js';

const router = Router();
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const SIX_HOURS_MS = 6 * ONE_HOUR_MS;
const currentDir = dirname(fileURLToPath(import.meta.url));
const THIRTY_MIN_MS = 30 * 60 * 1000;
const RESOLVE_CACHE_TTL_MS = Math.max(1, Number(process.env.RESOLVE_CACHE_TTL_MS || THIRTY_MIN_MS) || THIRTY_MIN_MS);
const RESOLVE_CACHE_VERSION = 'v14-vidnest-animepahe-source-labels';
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
const VIDROCK_SOURCE_PRIORITY = new Map([
  ['atlas', 1000],
  ['nova', 0]
]);
const EMBEDDED_HEADERS_PARAM = '__proxy_headers';
const EMBEDDED_HOST_PARAM = '__proxy_host';
const VIDEASY_UPSTREAM_BLOCKED = 'VIDEASY_UPSTREAM_BLOCKED';
const videasyProxyUrl = process.env.VIDEASY_PROXY_URL || process.env.RESIDENTIAL_PROXY_URL || '';
const videasyProxyAgent = videasyProxyUrl ? new ProxyAgent(videasyProxyUrl) : null;
const playbackProxyUrl = process.env.PLAYBACK_PROXY_URL || process.env.RESIDENTIAL_PROXY_URL || '';
const RESOLVE_CONCURRENCY = Math.max(1, Number(process.env.RESOLVE_CONCURRENCY || process.env.EXTRACTION_CONCURRENCY || 3) || 3);
const resolveQueue = new PQueue({ concurrency: RESOLVE_CONCURRENCY });
const VIDEASY_CACHE_TTL_MS = Math.max(1, Number(process.env.VIDEASY_CACHE_TTL_MS || 10 * 60 * 1000) || 10 * 60 * 1000);
const CACHE_VALIDATION_SKIP_RATIO = 0.5;
const VIDFAST_RESOLVE_TIMEOUT_MS = Math.max(45000, Number(process.env.VIDFAST_RESOLVE_TIMEOUT_MS || 85000) || 85000);
const VIDCORE_RESOLVE_TIMEOUT_MS = Math.max(45000, Number(process.env.VIDCORE_RESOLVE_TIMEOUT_MS || 85000) || 85000);
const SIGNED_PLAYBACK_EXPIRY_SKEW_MS = Math.max(
  15000,
  Number(process.env.SIGNED_PLAYBACK_EXPIRY_SKEW_MS || 120000) || 120000
);

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
  const allowed = new Set([
    'referer',
    'origin',
    'user-agent',
    'range',
    'cookie',
    'accept',
    'accept-language',
    'sec-fetch-site',
    'sec-fetch-mode',
    'sec-fetch-dest',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform'
  ]);
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

  if (/^4k$/i.test(text)) {
    return '2160p';
  }

  if (/^2k$/i.test(text)) {
    return '1440p';
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

function getAudioCodecCompatibilityRank(codecs = '') {
  const audioCodec = getCodecTokens(codecs).find((entry) => /^(mp4a|aac|ac-3|ec-3|opus|flac|alac)/i.test(entry)) || '';
  if (!audioCodec) {
    return 0;
  }

  if (/^(mp4a|aac)/i.test(audioCodec)) {
    return 400;
  }

  if (/^opus/i.test(audioCodec)) {
    return 200;
  }

  if (/^(ac-3|ec-3)/i.test(audioCodec)) {
    return -200;
  }

  return 50;
}

function sortQualities(qualities = []) {
  return [...qualities].sort((left, right) => {
    const qualityDelta = getQualityRank(right.label) - getQualityRank(left.label);
    if (qualityDelta !== 0) {
      return qualityDelta;
    }

    const codecDelta = getCodecCompatibilityRank(right?.codecs || '') - getCodecCompatibilityRank(left?.codecs || '');
    if (codecDelta !== 0) {
      return codecDelta;
    }

    return getAudioCodecCompatibilityRank(right?.codecs || '') - getAudioCodecCompatibilityRank(left?.codecs || '');
  });
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

      const audioDelta =
        getAudioCodecCompatibilityRank(right?.codecs || '') -
        getAudioCodecCompatibilityRank(left?.codecs || '');
      if (audioDelta !== 0) {
        return audioDelta;
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
      .map((entry) => {
        const normalizedQuality = normalizeQualityLabel(entry.quality || entry.label || entry.name || entry.resolution);
        return {
          label: String(entry.displayLabel || '').trim() || normalizedQuality,
          quality: normalizedQuality,
          url: entry.url,
          codecs: String(entry.codecs || ''),
          type: entry.type || detectType(entry.url),
          isDefault: false
        };
      })
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

function decodeMaybeUrl(value = '') {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  for (const candidate of [text, decodeURIComponentSafe(text)]) {
    if (/^https?:\/\//i.test(candidate)) {
      return candidate;
    }
  }

  return '';
}

function decodeURIComponentSafe(value = '') {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return String(value || '');
  }
}

function unwrapEncodedWorkerPlaybackUrl(targetUrl = '') {
  try {
    const parsed = new URL(String(targetUrl || ''));
    if (!/(^|\.)workers\.dev$/i.test(parsed.hostname)) {
      return '';
    }

    const decodedPathUrl = decodeMaybeUrl(parsed.pathname.replace(/^\/+/, ''));
    if (!decodedPathUrl) {
      return '';
    }

    return decodedPathUrl;
  } catch {
    return '';
  }
}

function getSignedExpiryMsFromUrl(targetUrl = '', seen = new Set()) {
  const rawUrl = String(targetUrl || '').trim();
  if (!rawUrl || seen.has(rawUrl)) {
    return null;
  }

  seen.add(rawUrl);

  try {
    const parsed = new URL(rawUrl);
    const expirySeconds = Number.parseInt(parsed.searchParams.get('t') || '', 10);
    const ownExpiry = Number.isFinite(expirySeconds) && expirySeconds > 1_000_000_000
      ? expirySeconds * 1000
      : null;
    const nestedCandidates = [
      parsed.searchParams.get('url') || '',
      parsed.pathname.replace(/^\/+/, ''),
      unwrapEncodedWorkerPlaybackUrl(rawUrl)
    ].map(decodeMaybeUrl).filter(Boolean);

    const nestedExpiries = nestedCandidates
      .map((candidate) => getSignedExpiryMsFromUrl(candidate, seen))
      .filter((value) => Number.isFinite(value));
    const expiries = [ownExpiry, ...nestedExpiries].filter((value) => Number.isFinite(value));

    return expiries.length ? Math.min(...expiries) : null;
  } catch {
    return null;
  }
}

function isExpiredSignedPlaybackUrl(targetUrl = '') {
  const expiresAt = getSignedExpiryMsFromUrl(targetUrl);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now() + SIGNED_PLAYBACK_EXPIRY_SKEW_MS;
}

function getResultSignedExpiryMs(result = {}) {
  const urls = [
    result?.url,
    result?.stream,
    ...(Array.isArray(result?.qualities) ? result.qualities.map((entry) => entry?.url) : [])
  ].filter(Boolean);
  const expiries = urls
    .map((url) => getSignedExpiryMsFromUrl(url))
    .filter((value) => Number.isFinite(value));

  return expiries.length ? Math.min(...expiries) : null;
}

function hasExpiredSignedPlayback(result = {}) {
  const urls = [
    result?.url,
    result?.stream,
    ...(Array.isArray(result?.qualities) ? result.qualities.map((entry) => entry?.url) : [])
  ].filter(Boolean);

  return urls.some((url) => isExpiredSignedPlaybackUrl(url));
}

function normalizeProxyHostParam(value = '') {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  try {
    return text.includes('://') ? new URL(text).host : text.replace(/^\/+|\/+$/g, '');
  } catch {
    return text.replace(/^https?:\/\//i, '').replace(/^\/+|\/+$/g, '');
  }
}

function isStormProxyPlaybackUrl(parsed) {
  return /(^|\.)vodvidl\.site$/i.test(parsed.hostname) && parsed.pathname.startsWith('/proxy/');
}

function buildDirectEmbeddedHostPlaybackUrl(parsed, hostParam = '') {
  if (!hostParam || !parsed?.pathname?.startsWith('/proxy/')) {
    return '';
  }

  try {
    const decodedPath = decodeURIComponent(parsed.pathname.slice('/proxy/'.length));
    const normalizedPath = `/${decodedPath.replace(/^\/+/, '')}`;
    return new URL(normalizedPath, `https://${hostParam}`).toString();
  } catch {
    return '';
  }
}

function isVidplusPlaybackUrl(parsed) {
  return /(^|\.)vidplus\.dev$/i.test(parsed.hostname) && /\/file2\//i.test(parsed.pathname);
}

function isLikelyHlsSegmentCandidate(targetUrl = '') {
  try {
    const parsed = new URL(String(targetUrl || ''));
    const pathname = decodeURIComponent(parsed.pathname || '').toLowerCase();
    if (/\.m3u8(?:$|[?#])/i.test(pathname)) {
      return false;
    }

    return (
      /\.(?:ts|m4s|cmfv|cmfa)(?:$|[?#])/i.test(pathname) ||
      /\/(?:seg|segment|frag|fragment|chunk|part)[-_]?\d/i.test(pathname) ||
      pathname.includes('/hls/')
    );
  } catch {
    return false;
  }
}

function getPlaybackHostParam(parsed) {
  return normalizeProxyHostParam(
    parsed.searchParams.get(EMBEDDED_HOST_PARAM) ||
    parsed.searchParams.get('host') ||
    ''
  );
}

function normalizeEmbeddedHeaderParam(value = '') {
  return String(value || '')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .trim();
}

function parsePlaybackHeaderParams(parsed) {
  const encodedHeaders = parsed.searchParams.get(EMBEDDED_HEADERS_PARAM) || parsed.searchParams.get('headers') || '';
  if (!encodedHeaders) {
    return {};
  }

  try {
    let decoded = encodedHeaders;
    try {
      decoded = decodeURIComponent(encodedHeaders);
    } catch {}

    return normalizeHeaders(JSON.parse(normalizeEmbeddedHeaderParam(decoded)));
  } catch {
    return {};
  }
}

function hasMalformedEmbeddedPlaybackHeaders(targetUrl = '') {
  try {
    const parsed = new URL(String(targetUrl || ''));
    const encodedHeaders = parsed.searchParams.get(EMBEDDED_HEADERS_PARAM) || parsed.searchParams.get('headers');
    if (!encodedHeaders) {
      return false;
    }

    let decoded = encodedHeaders;
    try {
      decoded = decodeURIComponent(encodedHeaders);
    } catch {}

    decoded = normalizeEmbeddedHeaderParam(decoded);
    if (!decoded || decoded === '{' || decoded === '{\\') {
      return true;
    }

    JSON.parse(decoded);
    return false;
  } catch {
    return true;
  }
}

function getVideasyPlaybackHeaders(headers = {}) {
  const normalizedHeaders = normalizeHeaders(headers);
  const useVideostr = true; // Force use of the newer videostr.net domain
  
  return normalizeHeaders({
    origin: useVideostr ? 'https://videostr.net' : 'https://player.videasy.net',
    referer: useVideostr ? 'https://videostr.net/' : 'https://player.videasy.net/',
    ...normalizedHeaders,
    'user-agent': normalizedHeaders['user-agent'] || getDefaultUserAgent(),
    ...getRealisticClientHints()
  });
}

function canonicalizePlaybackTarget(targetUrl, headers = {}) {
  try {
    const parsed = new URL(String(targetUrl || ''));
    const hostParam = getPlaybackHostParam(parsed);
    const unwrappedWorkerUrl = unwrapEncodedWorkerPlaybackUrl(targetUrl);

    if (unwrappedWorkerUrl) {
      return {
        url: unwrappedWorkerUrl,
        headers
      };
    }

    if (isStormProxyPlaybackUrl(parsed) && hostParam) {
      const embeddedHeaders = parsePlaybackHeaderParams(parsed);
      const baseHeaders = { ...headers };
      const hasPlaybackCookie = normalizeHeaders(baseHeaders)['x-playback-cookie-source'] === 'playwright';

      if (!embeddedHeaders.cookie && !hasPlaybackCookie) {
        delete baseHeaders.cookie;
      }

      return {
        url: targetUrl,
        headers: getVideasyPlaybackHeaders({
          ...baseHeaders,
          ...embeddedHeaders
        })
      };
    }

    if (isVidplusPlaybackUrl(parsed) && hostParam) {
      return {
        url: targetUrl,
        headers: getVideasyPlaybackHeaders(headers)
      };
    }
  } catch {
    // Keep the original URL when it cannot be parsed.
  }

  return {
    url: targetUrl,
    headers
  };
}

export function withProxiedPlaybackUrls(result, req) {
  const proxyBaseUrl = getProxyBaseUrl(req);
  const headers = result?.headers || {};
  const primaryUrl = result.stream || result.url;

  const nextQualities = Array.isArray(result?.qualities)
    ? result.qualities.map((entry) => {
        const playbackTarget = canonicalizePlaybackTarget(entry?.url, headers);
        if (!shouldProxyPlaybackUrl(playbackTarget.url, playbackTarget.headers, entry?.type || result?.type, req)) {
          return {
            ...entry,
            url: playbackTarget.url
          };
        }
        return {
          ...entry,
          url: buildProxyPlaybackUrl(proxyBaseUrl, playbackTarget.url, playbackTarget.headers)
        };
      })
    : [];

  const primaryTarget = canonicalizePlaybackTarget(primaryUrl, headers);
  let finalUrl = primaryTarget.url;
  if (shouldProxyPlaybackUrl(primaryTarget.url, primaryTarget.headers, result?.type, req)) {
    finalUrl = buildProxyPlaybackUrl(proxyBaseUrl, primaryTarget.url, primaryTarget.headers);
  }

  return {
    ...result,
    url: finalUrl,
    stream: finalUrl,
    qualities: nextQualities
  };
}

function shouldProxyPlaybackUrl(targetUrl, headers = {}, type = '', req) {
  if (/^(embed|iframe)$/i.test(String(type || '').trim())) {
    return false;
  }


  const target = String(targetUrl || '').trim();
  if (!target) {
    return false;
  }

  try {
    const parsed = new URL(target);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }

    const requestHost = String(req?.get?.('host') || '').trim().toLowerCase();
    if (requestHost && parsed.host.toLowerCase() === requestHost && parsed.pathname.startsWith('/proxy')) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}


function getProxyBaseUrl(req) {
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
  return `${protocol}://${req.get('host')}/proxy`;
}

function buildProxyPlaybackUrl(proxyBaseUrl, targetUrl, headers = {}) {
  const proxied = new URL(proxyBaseUrl);
  proxied.searchParams.set('url', targetUrl);

  const rawHeaderOverrides = normalizeHeaders(headers);
  const hasPlaybackCookie = rawHeaderOverrides['x-playback-cookie-source'] === 'playwright';
  let headerOverrides = sanitizePlaybackHeaders(headers);

  try {
    const parsedTarget = new URL(targetUrl);
    if (parsedTarget.searchParams.has(EMBEDDED_HEADERS_PARAM) || parsedTarget.searchParams.has('headers')) {
      const embeddedHeaders = parsePlaybackHeaderParams(parsedTarget);
      delete headerOverrides.referer;
      delete headerOverrides.origin;
      if (!embeddedHeaders.cookie && !hasPlaybackCookie) {
        delete headerOverrides.cookie;
      }
    }
  } catch {
    // Fall through and attach sanitized headers when URL parsing fails.
  }

  delete headerOverrides.range;
  if (Object.keys(headerOverrides).length) {
    proxied.searchParams.set('headers', JSON.stringify(headerOverrides));
  }

  return proxied.toString();
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
      videoRange: String(attributes['VIDEO-RANGE'] || '').trim().toUpperCase(),
      isDefault: false
    });
  }

  return dedupeQualities(variants);
}

async function fetchPlaylistQualities(playlistUrl, headers = {}, resultType = '') {
  const target = String(playlistUrl || '');
  const shouldFetchPlaylist =
    /\.m3u8(\?|$)/i.test(target) ||
    String(resultType || '').toUpperCase() === 'HLS' ||
    /workers\.dev\/content\?/i.test(target);

  if (!shouldFetchPlaylist) {
    return [];
  }

  const playlistHeaders = sanitizePlaybackHeaders(headers);

  async function fetchPlaylistBody(url) {
    try {
      const response = await gotScraping({
        url,
        headers: {
          ...getRealisticClientHints(),
          'user-agent': getDefaultUserAgent(),
          ...playlistHeaders
        },
        proxyUrl: playbackProxyUrl || undefined,
        timeout: { request: PLAYLIST_FETCH_TIMEOUT_MS },
        retry: { limit: 0 },
        throwHttpErrors: false,
        followRedirect: true,
        responseType: 'text',
        http2: true
      });

      if (response.statusCode < 200 || response.statusCode >= 300) {
        return null;
      }

      return response.body;
    } catch (error) {
      console.log(new Date().toISOString(), '[resolve] playlist fetch error', url, error?.message || String(error));
      return null;
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

function isUpcloudAnimePaheTsProxyUrl(targetUrl = '') {
  try {
    const parsed = new URL(String(targetUrl || ''));
    return /(^|\.)upcloud\.animanga\.fun$/i.test(parsed.hostname) && /\/ts-proxy$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function hasTsSyncByte(buffer) {
  if (!buffer || buffer.length < 1) {
    return false;
  }

  if (buffer[0] === 0x47) {
    return true;
  }

  for (let offset = 1; offset < 188 && offset + 376 < buffer.length; offset += 1) {
    if (buffer[offset] === 0x47 && buffer[offset + 188] === 0x47 && buffer[offset + 376] === 0x47) {
      return true;
    }
  }

  return false;
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
  try {
    const response = await gotScraping({
      url,
      headers: sanitizePlaybackHeaders(headers),
      proxyUrl: playbackProxyUrl || undefined,
      timeout: { request: timeoutMs },
      retry: { limit: 0 },
      throwHttpErrors: false,
      followRedirect: true,
      responseType: 'text',
      http2: true
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      return null;
    }

    return response.body;
  } catch {
    return null;
  }
}

async function fetchBinaryProbe(url, headers = {}, timeoutMs = PLAYLIST_FETCH_TIMEOUT_MS) {
  try {
    const response = await gotScraping({
      url,
      headers: {
        ...sanitizePlaybackHeaders(headers),
        range: 'bytes=0-1023'
      },
      proxyUrl: playbackProxyUrl || undefined,
      timeout: { request: timeoutMs },
      retry: { limit: 0 },
      throwHttpErrors: false,
      followRedirect: true,
      responseType: 'buffer',
      http2: true
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      return null;
    }

    const body = Buffer.from(response.body || []);
    return {
      body,
      contentType: response.headers['content-type'] || ''
    };
  } catch {
    return null;
  }
}

async function validateHlsPlaybackTarget(playlistUrl, headers = {}) {
  const originalUrl = playlistUrl;
  const originalHeaders = { ...headers };
  const playbackTarget = canonicalizePlaybackTarget(playlistUrl, headers);
  playlistUrl = playbackTarget.url;
  headers = playbackTarget.headers;

  let masterBody = await fetchTextBody(playlistUrl, headers);

  // If the canonicalized URL fails, try the original proxy URL as fallback
  if ((!masterBody || !/#EXTM3U/i.test(masterBody)) && playlistUrl !== originalUrl) {
    const originalWithHeaders = (() => {
      try {
        return { ...originalHeaders, ...parsePlaybackHeaderParams(new URL(originalUrl)) };
      } catch {
        return originalHeaders;
      }
    })();
    const fallbackBody = await fetchTextBody(originalUrl, originalWithHeaders);
    if (fallbackBody && /#EXTM3U/i.test(fallbackBody)) {
      masterBody = fallbackBody;
      playlistUrl = originalUrl;
      headers = originalWithHeaders;
    }
  }

  if (!masterBody || !/#EXTM3U/i.test(masterBody)) {
    return {
      ok: false,
      reason: 'playlist-missing'
    };
  }

  let mediaPlaylistUrl = playlistUrl;
  let mediaPlaylistBody = masterBody;

  if (/#EXT-X-STREAM-INF/i.test(masterBody)) {
    const masterVariants = parseMasterPlaylist(masterBody, playlistUrl);
    const nonHdrVariants = masterVariants.filter((entry) => !['PQ', 'HLG'].includes(String(entry?.videoRange || '').toUpperCase()));
    if (masterVariants.length > 0 && !nonHdrVariants.length) {
      return {
        ok: false,
        reason: `master-hdr:${String(masterVariants[0]?.videoRange || 'unknown').toLowerCase()}`
      };
    }

    const preferredVariant = pickPreferredQualityEntry(nonHdrVariants.length ? nonHdrVariants : masterVariants);
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

  if (isUpcloudAnimePaheTsProxyUrl(firstSegmentUrl)) {
    return {
      ok: true
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

async function isUsableResolvedPlayback(result, logLabel = '[resolve]', options = {}) {
  if (String(result?.type || '').toUpperCase() !== 'HLS') {
    return true;
  }

  // When the browser already confirmed a valid HLS response (200 with correct
  // content-type), trust it and skip the server-side revalidation that often
  // fails due to CDN geo-blocks, IP restrictions, or session requirements.
  if (options.browserVerified) {
    console.log(new Date().toISOString(), logLabel, 'trusting browser-verified hls', result.url);
    return true;
  }

  const validation = await validateHlsPlaybackTarget(result.url, result.headers || {});
  if (validation.ok) {
    return true;
  }

  console.log(new Date().toISOString(), logLabel, 'rejected invalid hls', result.url, validation.reason);
  return false;
}

function shouldValidateCachedPlayback(result, sourceUrl = '') {
  const playbackUrl = String(result?.url || result?.stream || '');
  const isHlsPlayback = String(result?.type || '').toUpperCase() === 'HLS' || /\.m3u8(?:$|[?#])/i.test(playbackUrl);
  if (!isHlsPlayback) {
    return false;
  }

  return (
    String(result?.provider || '').toLowerCase() === 'vidfast' ||
    String(result?.provider || '').toLowerCase() === 'videasy' ||
    String(result?.provider || '').toLowerCase() === 'vidlink' ||
    String(result?.provider || '').toLowerCase() === 'vidnest' ||
    String(result?.provider || '').toLowerCase() === 'vidrock' ||
    String(result?.provider || '').toLowerCase() === 'vidzee' ||
    String(result?.provider || '').toLowerCase() === 'vidfun' ||
    isVidfastUrl(result?.sourceUrl || '') ||
    isVidfastUrl(sourceUrl) ||
    isVideasyUrl(result?.sourceUrl || '') ||
    isVideasyUrl(sourceUrl) ||
    isVidlinkUrl(result?.sourceUrl || '') ||
    isVidlinkUrl(sourceUrl) ||
    isVidnestUrl(result?.sourceUrl || '') ||
    isVidnestUrl(sourceUrl) ||
    isVidrockUrl(result?.sourceUrl || '') ||
    isVidrockUrl(sourceUrl) ||
    isVidzeeUrl(result?.sourceUrl || '') ||
    isVidzeeUrl(sourceUrl) ||
    isVidfunUrl(result?.sourceUrl || '') ||
    isVidfunUrl(sourceUrl)
  );
}

function getResolveCacheKey(url) {
  return `stream:${RESOLVE_CACHE_VERSION}:${url}`;
}

function getResolveCacheTtl(url) {
  return isVideasyUrl(url) ? VIDEASY_CACHE_TTL_MS : RESOLVE_CACHE_TTL_MS;
}

function getResolveResultCacheTtl(url, result = {}) {
  const defaultTtl = getResolveCacheTtl(url);
  const signedExpiry = getResultSignedExpiryMs(result);

  if (!Number.isFinite(signedExpiry)) {
    return defaultTtl;
  }

  const signedTtl = signedExpiry - Date.now() - SIGNED_PLAYBACK_EXPIRY_SKEW_MS;
  return Math.min(defaultTtl, signedTtl);
}

async function getCachedResolvedStream(url, refresh = false) {
  if (refresh) {
    return null;
  }

  const cacheKey = getResolveCacheKey(url);
  let cached = cache.get(cacheKey);

  if (cached && (isVidlinkUrl(url) || isVidnestUrl(url)) && isLikelyHlsSegmentCandidate(cached.url || cached.stream || '')) {
    console.log(new Date().toISOString(), '[resolve] dropped cached hls segment', url);
    cache.delete(cacheKey);
    cached = null;
  }

  if (cached && isVidlinkUrl(url) && hasMalformedEmbeddedPlaybackHeaders(cached.url || cached.stream || '')) {
    console.log(new Date().toISOString(), '[resolve] dropped cached vidlink malformed playback url', url);
    cache.delete(cacheKey);
    cached = null;
  }

  if (cached && hasExpiredSignedPlayback(cached)) {
    console.log(new Date().toISOString(), '[resolve] dropped expired signed playback cache', url);
    cache.delete(cacheKey);
    cached = null;
  }

  if (cached && shouldValidateCachedPlayback(cached, url)) {
    const cacheEntry = cache.getEntry ? cache.getEntry(cacheKey) : null;
    const ttl = getResolveCacheTtl(url);
    const cacheAge = cacheEntry ? Date.now() - (cacheEntry.expiresAt - ttl) : Infinity;
    const skipValidation = cacheAge < ttl * CACHE_VALIDATION_SKIP_RATIO;

    if (skipValidation) {
      console.log(new Date().toISOString(), '[resolve] cache fresh, skipping revalidation', url, `age=${Math.round(cacheAge / 1000)}s`);
    } else {
      const validation = await validateHlsPlaybackTarget(cached.url, cached.headers || {});
      if (!validation.ok) {
        console.log(new Date().toISOString(), '[resolve] dropped stale cached hls', url, validation.reason);
        cache.delete(cacheKey);
        cached = null;
      }
    }
  }

  if (!cached) {
    return null;
  }

  const normalizedCached = applyPreferredPrimaryPlaybackUrl(cached);
  if (normalizedCached !== cached) {
    const ttl = getResolveResultCacheTtl(url, normalizedCached);
    if (ttl > 0) {
      cache.set(cacheKey, normalizedCached, ttl);
    } else {
      cache.delete(cacheKey);
    }
    return normalizedCached;
  }

  return cached;
}

export async function resolveStreamWithCache(url, options = {}) {
  const refresh = String(options?.refresh || '').trim() === '1' || options?.refresh === true;
  const cached = await getCachedResolvedStream(url, refresh);
  const cacheKey = getResolveCacheKey(url);

  if (cached) {
    console.log(new Date().toISOString(), '[resolve] cache hit', url);
    return { result: cached, cached: true };
  }

  let inflight = inflightResolutions.get(cacheKey);
  if (!inflight) {
    inflight = enqueueResolveJob(url, () => resolveStream(url))
      .then((result) => {
        const ttl = getResolveResultCacheTtl(url, result);
        if (ttl > 0) {
          cache.set(cacheKey, result, ttl);
        } else {
          console.log(new Date().toISOString(), '[resolve] skipped cache for expiring signed playback', url);
        }
        return result;
      })
      .finally(() => {
        inflightResolutions.delete(cacheKey);
      });

    inflightResolutions.set(cacheKey, inflight);
  } else {
    console.log(new Date().toISOString(), '[resolve] joining inflight', url);
  }

  return { result: await inflight, cached: false };
}

export async function resolveStreamCached(url, options = {}) {
  const { result } = await resolveStreamWithCache(url, options);
  return result;
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

  const playbackTarget = canonicalizePlaybackTarget(result.url, result.headers || {});
  const normalizedResult = {
    ...result,
    url: playbackTarget.url,
    stream: playbackTarget.url,
    headers: playbackTarget.headers
  };
  const sourceQualities = buildQualityEntriesFromSources(sourceCandidates).map((entry) => ({
    ...entry,
    url: canonicalizePlaybackTarget(entry.url, normalizedResult.headers || {}).url
  }));
  const provider = String(normalizedResult.provider || '').toLowerCase();
  const sourceUrl = String(normalizedResult.sourceUrl || '');
  const shouldPreferCapturedQualities =
    sourceQualities.length > 0 &&
    (provider === 'vidfun' || isVidfunUrl(sourceUrl));
  const playlistQualities = (shouldPreferCapturedQualities
    ? []
    : await fetchPlaylistQualities(normalizedResult.url, normalizedResult.headers || {}, normalizedResult.type)).map((entry) => ({
    ...entry,
    url: canonicalizePlaybackTarget(entry.url, normalizedResult.headers || {}).url
  })).filter((entry) => {
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
    url: normalizedResult.url,
    codecs: '',
    type: normalizedResult.type || detectType(normalizedResult.url),
    isDefault: false
  }]);
  const preferredQuality = pickPreferredQualityEntry(normalizedQualities);
  const finalQualities = normalizedQualities.map((entry, index) => ({
    ...entry,
    isDefault: preferredQuality ? entry.url === preferredQuality.url : index === 0
  }));

  return applyPreferredPrimaryPlaybackUrl({
    ...normalizedResult,
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

function isVidfunUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return /(^|\.)vidfun\.pro$/i.test(parsed.hostname) && /\/(?:movie|tv)\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function getVidfunHeaders(sourceUrl, requestHeaders = {}) {
  let origin = 'https://vidfun.pro';

  try {
    origin = new URL(sourceUrl).origin;
  } catch {
    origin = 'https://vidfun.pro';
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
  return /player\.videasy\.net|videostr\.net/i.test(String(url || ''));
}

function isVideasyTvUrl(url) {
  return /player\.videasy\.net\/tv\//i.test(String(url || ''));
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
  return /player\.vidzee\.wtf\/(?:v2\/)?embed\//i.test(String(url || ''));
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

function isMegaplayUrl(url) {
  try {
    return /(^|\.)megaplay\.buzz$/i.test(new URL(String(url || 'https://invalid.local')).hostname);
  } catch {
    return false;
  }
}

function getProviderKeyFromUrl(url) {
  if (isVidfastUrl(url)) return 'vidfast';
  if (isVidcoreUrl(url)) return 'vidcore';
  if (isVidlinkUrl(url)) return 'vidlink';
  if (isVidnestUrl(url)) return 'vidnest';
  if (isVidfunUrl(url)) return 'vidfun';
  if (isVideasyUrl(url)) return 'videasy';
  if (isVidzeeUrl(url)) return 'vidzee';
  if (isVidrockUrl(url)) return 'vidrock';
  if (isVidkingUrl(url)) return 'vidking';
  if (isMegaplayUrl(url)) return 'megaplay';
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

    if (parts[0] === 'anime' && parts[1] && parts[2] && parts[3]) {
      return {
        mediaType: 'anime',
        anilistId: parts[1],
        episodeId: parts[2],
        language: parts[3]
      };
    }

    if (parts[0] === 'animepahe' && parts[1] && parts[2] && parts[3]) {
      return {
        mediaType: 'animepahe',
        anilistId: parts[1],
        episodeId: parts[2],
        language: parts[3]
      };
    }
  } catch {
    return null;
  }

  return null;
}

function buildVidnestApiCandidates(details) {
  if (details.mediaType === 'anime') {
    return [`https://new.vidnest.fun/anitaku/${details.anilistId}/${details.episodeId}/${details.language}`];
  }

  if (details.mediaType === 'animepahe') {
    return [`https://new.vidnest.fun/animepahe/${details.anilistId}/${details.episodeId}/${details.language}`];
  }

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

function normalizePlaybackReferer(value = '') {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  try {
    return new URL(text).toString();
  } catch {
    return text.endsWith('/') ? text : `${text}/`;
  }
}

function isUpcloudAnimePaheProxyUrl(targetUrl = '') {
  try {
    const parsed = new URL(String(targetUrl || ''));
    return /(^|\.)upcloud\.animanga\.fun$/i.test(parsed.hostname) && /\/proxy$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function buildVidnestAnimePaheProxyUrl(sourceUrl = '', referer = 'https://kwik.cx/') {
  const target = String(sourceUrl || '').trim();
  if (!target || isUpcloudAnimePaheProxyUrl(target)) {
    return target;
  }

  const proxied = new URL('https://upcloud.animanga.fun/proxy');
  proxied.searchParams.set('url', target);
  proxied.searchParams.set('headers', JSON.stringify({
    Referer: normalizePlaybackReferer(referer) || 'https://kwik.cx/'
  }));
  return proxied.toString();
}

function getVidnestAnimePaheProxyHeaders() {
  return normalizeHeaders({
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    origin: 'https://vidnest.fun',
    referer: 'https://vidnest.fun/',
    'user-agent': getDefaultUserAgent(),
    ...getRealisticClientHints()
  });
}

function formatVidnestAnimePaheQualityLabel(value = '') {
  const text = String(value || '')
    .replace(/\s*·\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) {
    return '';
  }

  const normalizedQuality = normalizeQualityLabel(text);
  if (!/\d{3,4}p/i.test(normalizedQuality)) {
    return text;
  }

  return text
    .replace(/\b(\d{3,4})p?\b/i, normalizedQuality)
    .replace(/\s+/g, ' ')
    .trim();
}

function withVidnestAnimePahePlayback(candidate = {}) {
  const headers = normalizeHeaders(candidate.headers || {});
  const referer = normalizePlaybackReferer(headers.referer || 'https://kwik.cx/');
  const url = buildVidnestAnimePaheProxyUrl(candidate.url, referer);
  const displayLabel = formatVidnestAnimePaheQualityLabel(candidate.quality || candidate.label || candidate.name || '');

  if (!url) {
    return candidate;
  }

  return {
    ...candidate,
    url,
    displayLabel,
    type: 'HLS',
    headers: getVidnestAnimePaheProxyHeaders(),
    sources: Array.isArray(candidate.sources)
      ? candidate.sources.map((entry) => ({
          ...entry,
          url: buildVidnestAnimePaheProxyUrl(entry?.url || candidate.url, referer),
          displayLabel: formatVidnestAnimePaheQualityLabel(entry?.quality || entry?.label || entry?.name || displayLabel),
          type: 'HLS'
        }))
      : candidate.sources
  };
}

function normalizeVidnestSourceEntry(entry = {}, fallbackHeaders = {}) {
  const normalizeSourceHeaders = (entry = {}, fallbackHeaders = {}) => {
    const headers = normalizeHeaders({
      ...fallbackHeaders,
      ...(entry.headers || {})
    });
    const referer = normalizePlaybackReferer(entry.referer || entry.referrer || '');

    if (referer) {
      headers.referer = referer;
      try {
        headers.origin = new URL(referer).origin;
      } catch {}
    }

    return headers;
  };

  if (typeof entry?.url !== 'string' || !entry.url.startsWith('http')) {
    return null;
  }

  const subtitles = Array.isArray(entry.subtitles)
    ? entry.subtitles.filter((url) => typeof url === 'string' && url.startsWith('http')).map((url, index) => ({
        url,
        language: 'en',
        label: index === 0 ? 'English' : `English ${index + 1}`,
      }))
    : [];

  return {
    url: entry.url,
    headers: normalizeSourceHeaders(entry, fallbackHeaders),
    sources: [entry],
    subtitles,
    server: entry.server || '',
    quality: entry.quality || '',
  };
}

function getVidnestSourceRank(entry = {}) {
  const url = String(entry.url || '').toLowerCase();
  const server = String(entry.server || '').toLowerCase();
  let score = 0;

  if (/\.m3u8(?:$|[?#])/i.test(url)) score += 100;
  if (/\.mp4(?:$|[?#])/i.test(url)) score += 80;
  if (/workers\.dev/i.test(url)) score += 40;
  if (server === 'hd-2') score += 30;
  if (server === 'hd-1' && /vibeplayer\.site/i.test(url)) score -= 80;
  if (/\/embed\/|\/e\//i.test(url)) score -= 100;
  score += Number.parseInt(String(entry.quality || '').replace(/\D/g, ''), 10) || 0;

  return score;
}

function getVidnestSourceCandidates(payload) {
  const candidates = [];
  const seen = new Set();
  const addCandidate = (entry, fallbackHeaders = {}) => {
    const normalized = normalizeVidnestSourceEntry(entry, fallbackHeaders);
    if (!normalized || seen.has(normalized.url)) {
      return;
    }

    seen.add(normalized.url);
    candidates.push(normalized);
  };

  if (typeof payload?.url === 'string') {
    addCandidate(payload, payload.headers || {});
  }

  for (const entry of [
    ...(Array.isArray(payload?.streams) ? payload.streams : []),
    ...(Array.isArray(payload?.sources) ? payload.sources : []),
    ...(Array.isArray(payload?.multiSrc) ? payload.multiSrc : []),
  ]) {
    addCandidate(entry, payload?.headers || {});
  }

  const selectedSource = pickVideasySource(payload);
  if (selectedSource?.url) {
    addCandidate(selectedSource, payload?.headers || {});
  }

  return candidates.sort((left, right) => getVidnestSourceRank(right) - getVidnestSourceRank(left));
}

function parseVidzeeEmbedUrl(url) {
  try {
    const { pathname } = new URL(url);
    const parts = pathname.split('/').filter(Boolean);
    const offset = parts[0] === 'v2' ? 1 : 0;

    if (parts[offset] !== 'embed') {
      return null;
    }

    if (parts[offset + 1] === 'movie' && parts[offset + 2]) {
      return { type: 'movie', id: parts[offset + 2] };
    }

    if (parts[offset + 1] === 'tv' && parts[offset + 2] && parts[offset + 3] && parts[offset + 4]) {
      return { type: 'tv', id: parts[offset + 2], season: parts[offset + 3], episode: parts[offset + 4] };
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
    'user-agent': getDefaultUserAgent(),
    ...getRealisticClientHints()
  };
}

function getMegaplayHeaders(sourceUrl) {
  return {
    referer: 'https://megaplay.buzz/',
    origin: 'https://megaplay.buzz',
  };
}

function rankVidrockSource(entry = {}) {
  const url = String(entry.url || '');
  const sourceRank = VIDROCK_SOURCE_PRIORITY.get(String(entry.name || '').trim().toLowerCase()) || 0;
  if (/workers\.dev/i.test(url) || /\.m3u8(\?|$)/i.test(url)) return sourceRank + 4;
  if (/playlist/i.test(url)) return sourceRank + 3;
  if (/^https?:\/\//i.test(url)) return sourceRank + 2;
  return sourceRank;
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
      .filter((entry) => !isExpiredSignedPlaybackUrl(entry.url))
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
    title,
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
        const candidateSources = Array.isArray(payload?.sources)
          ? [...payload.sources]
              .filter((entry) => typeof entry?.url === 'string' && entry.url.startsWith('http'))
              .sort((left, right) => {
                const leftScore = Number.parseInt(String(left.quality || '').replace(/\D/g, ''), 10) || 0;
                const rightScore = Number.parseInt(String(right.quality || '').replace(/\D/g, ''), 10) || 0;
                return rightScore - leftScore;
              })
          : [];

        for (const selectedSource of candidateSources) {
          const resolved = await attachQualities({
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
          }, [selectedSource]);

          if (await isUsableResolvedPlayback(resolved, '[videasy]')) {
            return resolved;
          }
        }
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
        }, [selectedSource]);
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
      const sourceCandidates = getVidnestSourceCandidates(decrypted);
      if (!sourceCandidates.length) {
        continue;
      }

      const playableSourceCandidates = details.mediaType === 'animepahe'
        ? sourceCandidates.map((candidate) => withVidnestAnimePahePlayback(candidate))
        : sourceCandidates;

      for (const selectedSource of playableSourceCandidates) {
        const unwrapped = unwrapVidnestStream(selectedSource.url, selectedSource.headers);
        if (!unwrapped.url) {
          continue;
        }

        const qualitySources = details.mediaType === 'animepahe'
          ? playableSourceCandidates
          : selectedSource.sources;

        const resolved = await attachQualities({
          success: true,
          url: unwrapped.url,
          stream: unwrapped.url,
          type: details.mediaType === 'animepahe' ? 'HLS' : detectType(unwrapped.url),
          headers: unwrapped.headers,
          provider: 'vidnest',
          sourceUrl,
          qualities: [],
          subtitles: selectedSource.subtitles || []
        }, qualitySources);

        if (await isUsableResolvedPlayback(resolved, '[vidnest]')) {
          return resolved;
        }

        console.log(new Date().toISOString(), '[vidnest] rejected source', selectedSource.server || selectedSource.url, selectedSource.url);
      }
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
          const resolved = await attachQualities({
            success: true,
            url: source.url,
            stream: source.url,
            type: 'HLS',
            headers: normalizeHeaders(getVidrockHeaders(requestSourceUrl)),
            provider: 'vidrock',
            sourceUrl: requestSourceUrl,
            qualities: []
          });

          if (await isUsableResolvedPlayback(resolved, '[vidrock]')) {
            return resolved;
          }

          continue;
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
            const resolved = await attachQualities({
              success: true,
              url: source.url,
              stream: source.url,
              type: 'HLS',
              headers: normalizeHeaders(getVidrockHeaders(requestSourceUrl)),
              provider: 'vidrock',
              sourceUrl: requestSourceUrl,
              qualities: []
            });

            if (await isUsableResolvedPlayback(resolved, '[vidrock]')) {
              return resolved;
            }

            continue;
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

  // Prepare vidrock canonical URL (needed for both direct and browser paths)
  if (isVidrockUrl(url)) {
    vidrockDetails = await resolveVidrockCanonicalDetails(parseVidrockSourceUrl(url), url).catch(() => null);
    if (vidrockDetails?.canonicalSourceUrl) {
      resolvedSourceUrl = vidrockDetails.canonicalSourceUrl;
      if (resolvedSourceUrl !== url) {
        console.log(new Date().toISOString(), '[vidrock] canonical source', url, '->', resolvedSourceUrl);
      }
    }
  }

  // Phase 1: Race all applicable direct resolvers in parallel.
  // First successful result wins — resolution time = fastest provider, not sum of all.
  const directRaceCandidates = [];

  if (isVidfastUrl(url)) {
    directRaceCandidates.push(
      tryResolveVidfastFromHints(url).then((r) => {
        if (!r) throw new Error('vidfast-hints-miss');
        console.log(new Date().toISOString(), '[resolve] vidfast direct cache hit', r.url);
        return r;
      })
    );
  }

  if (isVidzeeUrl(url)) {
    directRaceCandidates.push(
      tryResolveVidzeeDirect(url).then((r) => {
        if (!r) throw new Error('vidzee-direct-miss');
        console.log(new Date().toISOString(), '[resolve] vidzee direct success', r.url);
        return r;
      })
    );
  }

  if (isVidnestUrl(url)) {
    directRaceCandidates.push(
      tryResolveVidnestDirect(url).then((r) => {
        if (!r) throw new Error('vidnest-direct-miss');
        console.log(new Date().toISOString(), '[resolve] vidnest direct success', r.url);
        return r;
      })
    );
  }

  if (isVidrockUrl(url)) {
    directRaceCandidates.push(
      tryResolveVidrockDirect(resolvedSourceUrl, vidrockDetails).then((r) => {
        if (!r) throw new Error('vidrock-direct-miss');
        console.log(new Date().toISOString(), '[resolve] vidrock direct success', r.url);
        return r;
      })
    );
  }

  if (isVidkingUrl(url)) {
    directRaceCandidates.push(
      tryResolveVidkingDirect(url).then((r) => {
        if (!r) throw new Error('vidking-direct-miss');
        console.log(new Date().toISOString(), '[resolve] vidking direct success', r.url);
        return r;
      })
    );
  }

  // Videasy skips direct API (title mismatch risk) — browser extraction only.
  if (isVideasyUrl(url)) {
    console.log(new Date().toISOString(), '[resolve] videasy — skipping direct api, using browser extraction');
  }

  // Race all direct resolvers; if any wins, return immediately
  if (directRaceCandidates.length > 0) {
    try {
      const startedAt = Date.now();
      const directResult = await Promise.any(directRaceCandidates);
      console.log(new Date().toISOString(), '[resolve] parallel direct resolved in', Date.now() - startedAt, 'ms');
      return directResult;
    } catch {
      // All direct resolvers failed — fall through to browser extraction
      console.log(new Date().toISOString(), '[resolve] all direct resolvers failed, falling back to browser');
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('STREAM_NOT_FOUND'));
    }, isVidfastUrl(url) ? VIDFAST_RESOLVE_TIMEOUT_MS : isVidcoreUrl(url) ? VIDCORE_RESOLVE_TIMEOUT_MS : isVidlinkUrl(url) ? 45000 : isVidkingUrl(url) ? 30000 : isVidzeeUrl(url) ? 24000 : isVidfunUrl(url) ? 45000 : isVideasyUrl(url) ? (isVideasyTvUrl(url) ? 45000 : 36000) : isMegaplayUrl(url) ? 30000 : RESOLVE_TIMEOUT_MS);

    extractVideoUrls(
      resolvedSourceUrl,
      async (found) => {
        if (settled || !found?.url) {
          return false;
        }

        if (isVidrockUrl(url) && isVidrockDemoUrl(found.url)) {
          console.log(new Date().toISOString(), '[resolve] ignore vidrock demo stream', found.url);
          return false;
        }

        if ((isVidlinkUrl(url) || isVidnestUrl(url)) && String(found.type || '').toUpperCase() === 'STREAM' && isLikelyHlsSegmentCandidate(found.url)) {
          console.log(new Date().toISOString(), '[resolve] ignore hls segment', found.url);
          return false;
        }

        if (isVidlinkUrl(url) && hasMalformedEmbeddedPlaybackHeaders(found.url)) {
          console.log(new Date().toISOString(), '[resolve] ignore vidlink malformed playback url', found.url);
          return false;
        }

        if (isExpiredSignedPlaybackUrl(found.url)) {
          console.log(new Date().toISOString(), '[resolve] ignore expired signed playback', found.url);
          return false;
        }

        if (isVideasyUrl(url) && isLikelyHlsSegmentCandidate(found.url)) {
          console.log(new Date().toISOString(), '[resolve] ignore videasy hls segment', found.url);
          return false;
        }

        if (isVidfunUrl(url) && String(found.type || '').toUpperCase() !== 'HLS') {
          console.log(new Date().toISOString(), '[resolve] ignore vidfun non-hls stream', found.url);
          return false;
        }

        console.log(new Date().toISOString(), '[resolve] found', found.type, found.via, found.url);
        const foundQualities = Array.isArray(found.qualities) ? found.qualities : [];
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
              : isVidfunUrl(url)
              ? getVidfunHeaders(resolvedSourceUrl, found.headers || {})
              : isVidrockUrl(url)
              ? { ...getVidrockHeaders(resolvedSourceUrl), ...(found.headers || {}) }
              : isMegaplayUrl(url)
              ? { ...getMegaplayHeaders(resolvedSourceUrl), ...(found.headers || {}) }
              : (found.headers || {})
          ),
          provider: getProviderKeyFromUrl(url),
          sourceUrl: resolvedSourceUrl,
          qualities: foundQualities
        };

        if (isVidfastUrl(url) && found.resolverHints?.vidfastRequests?.length) {
          vidfastHintCache.set(`vidfast:${url}`, found.resolverHints, SIX_HOURS_MS);
        }

        // Trust only actual browser HLS responses. Payload links still need
        // validation because they may point at a CDN URL that later returns 403.
        // MegaPlay is an exception: the JSON API response is served by the same
        // origin with proper auth — trust it.
        const foundVia = String(found.via || '').toLowerCase();
        const isMegaplayApiVerified = isMegaplayUrl(url) && foundVia === 'payload';
        const isBrowserVerifiedHls =
          String(found.type || '').toUpperCase() === 'HLS' &&
          (foundVia === 'response' || foundVia.endsWith('-response') || isMegaplayApiVerified);
        const validationOptions = { browserVerified: isBrowserVerifiedHls };

        if ((isVidlinkUrl(url) || isVideasyUrl(url)) && isBrowserVerifiedHls) {
          const fastResolved = applyPreferredPrimaryPlaybackUrl({
            ...resolved,
            qualities: foundQualities.length ? foundQualities : [{
              label: 'auto',
              quality: 'auto',
              url: resolved.url,
              codecs: '',
              type: resolved.type || detectType(resolved.url),
              isDefault: true
            }]
          });

          settled = true;
          clearTimeout(timeoutId);
          resolve(fastResolved);
          return true;
        }

        try {
          const resolvedWithQualities = await attachQualities(resolved, foundQualities);
          if (!(await isUsableResolvedPlayback(resolvedWithQualities, '[resolve]', validationOptions))) {
            return false;
          }

          settled = true;
          clearTimeout(timeoutId);
          resolve(resolvedWithQualities);
          return true;
        } catch {
          if (!(await isUsableResolvedPlayback(resolved, '[resolve]', validationOptions))) {
            return false;
          }

          settled = true;
          clearTimeout(timeoutId);
          resolve(resolved);
          return true;
        }
      },
      isVidfastUrl(url)
        ? { settleTimeout: 2500, navigationTimeout: 30000, minWaitAfterLoad: 12000, maxWaitAfterLoad: 24000 }
        : isVidcoreUrl(url)
        ? { settleTimeout: 2500, navigationTimeout: 30000, minWaitAfterLoad: 5000, maxWaitAfterLoad: 18000 }
        : isVidkingUrl(url)
        ? { settleTimeout: 2500, navigationTimeout: 30000, minWaitAfterLoad: 5000, maxWaitAfterLoad: 14000 }
        : isVidzeeUrl(url)
        ? { settleTimeout: 2500, navigationTimeout: 30000, minWaitAfterLoad: 5000, maxWaitAfterLoad: 15000 }
        : isVidfunUrl(url)
        ? { settleTimeout: 2500, navigationTimeout: 30000, minWaitAfterLoad: 8000, maxWaitAfterLoad: 24000 }
        : isVidnestUrl(url)
        ? { settleTimeout: 2000, navigationTimeout: 20000, minWaitAfterLoad: 3000, maxWaitAfterLoad: 8000 }
        : isVideasyUrl(url)
        ? { settleTimeout: 2000, navigationTimeout: 30000, minWaitAfterLoad: 6000, maxWaitAfterLoad: 12000 }
        : isMegaplayUrl(url)
        ? { settleTimeout: 3000, navigationTimeout: 35000, minWaitAfterLoad: 6000, maxWaitAfterLoad: 18000 }
        : { settleTimeout: 2000, navigationTimeout: 30000, minWaitAfterLoad: 5000, maxWaitAfterLoad: 10000 }
    ).then(() => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      reject(new Error('STREAM_NOT_FOUND'));
    }).catch((error) => {
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

  try {
    const { result, cached } = await resolveStreamWithCache(url, { refresh: shouldRefresh });
    logResolvedQualities('[resolve] qualities', result.qualities);
    console.log(new Date().toISOString(), '[resolve] success', result.url);
    return res.json({ ...withProxiedPlaybackUrls(result, req), ...(cached ? { cached: true } : {}) });
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

      if (
        normalized.includes('net::err_internet_disconnected') ||
        normalized.includes('fetch failed') ||
        normalized.includes('timeout') ||
        normalized.includes('timed out')
      ) {
        return 503;
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
