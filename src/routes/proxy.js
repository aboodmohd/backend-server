import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import { gotScraping } from 'got-scraping';
import { ProxyAgent } from 'undici';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { getDefaultUserAgent, getRealisticClientHints } from '../workers/playwright.js';

const router = Router();
const playbackProxyUrl = process.env.PLAYBACK_PROXY_URL || process.env.RESIDENTIAL_PROXY_URL || '';
const playbackProxyAgent = playbackProxyUrl ? new ProxyAgent(playbackProxyUrl) : null;
const EMBEDDED_HEADERS_PARAM = '__proxy_headers';
const EMBEDDED_HOST_PARAM = '__proxy_host';
const LEGACY_HEADERS_PARAM = 'headers';
const LEGACY_HOST_PARAM = 'host';
const PROXY_RETRY_ATTEMPTS = 3;
const PROXY_RETRY_DELAY_MS = 250;
const PROXY_FETCH_TIMEOUT_MS = Math.max(
  3000,
  Number(process.env.PROXY_FETCH_TIMEOUT_MS || 20000) || 20000
);
const PROXY_MEDIA_READ_TIMEOUT_MS = Math.max(
  PROXY_FETCH_TIMEOUT_MS,
  Number(process.env.PROXY_MEDIA_READ_TIMEOUT_MS || 45000) || 45000
);
const PROXY_HTTP2_ENABLED = process.env.PROXY_HTTP2 !== '0';

// Phase 7: Short-lived playlist cache — avoids re-fetching the same rewritten
// HLS playlist from upstream on every request (master + variant both hit here).
const PLAYLIST_CACHE_TTL_MS = Number(process.env.PLAYLIST_CACHE_TTL_MS || 30000);
const PLAYLIST_CACHE_MAX_ENTRIES = 200;
const playlistCache = new Map();
const FAILURE_CACHE_TTL_MS = Math.max(0, Number(process.env.PROXY_FAILURE_CACHE_TTL_MS || 10000) || 10000);
const FAILURE_CACHE_MAX_ENTRIES = 300;
const failureCache = new Map();
const HEADER_TOKEN_TTL_MS = Number(process.env.PROXY_HEADER_TOKEN_TTL_MS || 120000);
const HEADER_TOKEN_MAX_ENTRIES = 500;
const headerTokenCache = new Map();

function getEmbeddedHeadersParam(parsedUrl) {
  return parsedUrl.searchParams.get(EMBEDDED_HEADERS_PARAM) || parsedUrl.searchParams.get(LEGACY_HEADERS_PARAM);
}

function getEmbeddedHostParam(parsedUrl) {
  return parsedUrl.searchParams.get(EMBEDDED_HOST_PARAM) || parsedUrl.searchParams.get(LEGACY_HOST_PARAM);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(statusCode) {
  return Number(statusCode) >= 500;
}

function createAttemptSignal(parentSignal) {
  if (parentSignal?.aborted) {
    return parentSignal;
  }

  const timeoutSignal = AbortSignal.timeout(PROXY_FETCH_TIMEOUT_MS);
  return typeof AbortSignal.any === 'function'
    ? AbortSignal.any([parentSignal, timeoutSignal].filter(Boolean))
    : timeoutSignal;
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

function filterForwardHeaders(headers = {}) {
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

function stableHeaderJson(headers = {}) {
  const normalized = filterForwardHeaders(headers);
  return JSON.stringify(
    Object.keys(normalized)
      .sort()
      .reduce((acc, key) => {
        acc[key] = normalized[key];
        return acc;
      }, {})
  );
}

function rememberHeaderToken(headers = {}) {
  const serialized = stableHeaderJson(headers);
  if (serialized === '{}') {
    return '';
  }

  const token = createHash('sha256').update(serialized).digest('base64url').slice(0, 24);
  headerTokenCache.set(token, {
    headers: JSON.parse(serialized),
    expiresAt: Date.now() + HEADER_TOKEN_TTL_MS
  });

  if (headerTokenCache.size > HEADER_TOKEN_MAX_ENTRIES) {
    const firstKey = headerTokenCache.keys().next().value;
    headerTokenCache.delete(firstKey);
  }

  return token;
}

function getHeaderTokenHeaders(token = '') {
  const key = String(token || '').trim();
  if (!key) {
    return {};
  }

  const entry = headerTokenCache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    headerTokenCache.delete(key);
    return {};
  }

  entry.expiresAt = Date.now() + HEADER_TOKEN_TTL_MS;
  return entry.headers || {};
}

function getPlaylistCacheKey(targetUrl, headers = {}) {
  return `pl:${targetUrl}:${createHash('sha1').update(stableHeaderJson(headers)).digest('base64url')}`;
}

function getFailureCacheKey(targetUrl, headers = {}) {
  return `fail:${targetUrl}:${createHash('sha1').update(stableHeaderJson(headers)).digest('base64url')}`;
}

function getCachedFailure(cacheKey = '') {
  if (!FAILURE_CACHE_TTL_MS || !cacheKey) {
    return null;
  }

  const cached = failureCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    failureCache.delete(cacheKey);
    return null;
  }

  return cached;
}

function rememberProxyFailure(cacheKey = '', status = 502, contentType = 'text/plain; charset=utf-8', body = '') {
  if (!FAILURE_CACHE_TTL_MS || !cacheKey || Number(status) < 400) {
    return;
  }

  failureCache.set(cacheKey, {
    status,
    contentType,
    body: String(body || '').slice(0, 4096),
    expiresAt: Date.now() + FAILURE_CACHE_TTL_MS,
  });

  if (failureCache.size > FAILURE_CACHE_MAX_ENTRIES) {
    const firstKey = failureCache.keys().next().value;
    failureCache.delete(firstKey);
  }
}

function normalizeEmbeddedHeaderParam(value = '') {
  return String(value || '')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .trim();
}

function parseEmbeddedHeaderJson(value = '') {
  let decoded = String(value || '');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {}

  for (const candidate of [decoded.trim(), normalizeEmbeddedHeaderParam(decoded)]) {
    if (!candidate) {
      continue;
    }

    try {
      return JSON.parse(candidate);
    } catch {}
  }

  return null;
}

function parseEmbeddedHeaders(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    const embedded = getEmbeddedHeadersParam(parsed);
    if (!embedded) {
      return {};
    }
    const parsedHeaders = parseEmbeddedHeaderJson(embedded);
    return parsedHeaders ? filterForwardHeaders(parsedHeaders) : {};
  } catch {
    return {};
  }
}

function hasEmbeddedProxyParams(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    return (
      parsed.searchParams.has(EMBEDDED_HEADERS_PARAM) ||
      parsed.searchParams.has(EMBEDDED_HOST_PARAM) ||
      parsed.searchParams.has(LEGACY_HEADERS_PARAM) ||
      parsed.searchParams.has(LEGACY_HOST_PARAM)
    );
  } catch {
    return false;
  }
}

function hasEmbeddedHeaders(targetUrl) {
  try {
    return !!getEmbeddedHeadersParam(new URL(targetUrl));
  } catch {
    return false;
  }
}

function parseEmbeddedHost(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    const embeddedHost = getEmbeddedHostParam(parsed);
    if (!embeddedHost) {
      return '';
    }
    return embeddedHost.includes('://') ? new URL(embeddedHost).host : embeddedHost;
  } catch {
    return '';
  }
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

function unwrapEncodedWorkerUrl(targetUrl = '') {
  try {
    const parsed = new URL(String(targetUrl || ''));
    if (!/(^|\.)workers\.dev$/i.test(parsed.hostname)) {
      return '';
    }

    return decodeMaybeUrl(parsed.pathname.replace(/^\/+/, ''));
  } catch {
    return '';
  }
}

function buildDirectEmbeddedHostUrl(targetUrl, embeddedHost = '') {
  if (!embeddedHost) {
    return '';
  }

  try {
    const parsed = new URL(targetUrl);
    if (!/(^|\.)vodvidl\.site$/i.test(parsed.hostname) || !parsed.pathname.startsWith('/proxy/')) {
      return '';
    }

    const decodedPath = decodeURIComponent(parsed.pathname.slice('/proxy/'.length));
    const normalizedPath = `/${decodedPath.replace(/^\/+/, '')}`;
    return new URL(normalizedPath, `https://${embeddedHost}`).toString();
  } catch {
    return '';
  }
}

function isEmbeddedHostWrapperTarget(targetUrl = '') {
  try {
    const parsed = new URL(targetUrl);
    return /(^|\.)vodvidl\.site$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

function shouldApplyEmbeddedHostOverride(targetUrl, embeddedHost = '', preserveEmbeddedProxyParams = shouldPreserveEmbeddedProxyParams(targetUrl)) {
  if (!embeddedHost) {
    return false;
  }

  if (buildDirectEmbeddedHostUrl(targetUrl, embeddedHost)) {
    return true;
  }

  if (preserveEmbeddedProxyParams) {
    return false;
  }

  return isEmbeddedHostWrapperTarget(targetUrl);
}

function stripUnsafeEmbeddedHostParams(targetUrl) {
  const embeddedHost = parseEmbeddedHost(targetUrl);
  if (!embeddedHost || shouldApplyEmbeddedHostOverride(targetUrl, embeddedHost)) {
    return targetUrl;
  }

  try {
    const parsed = new URL(targetUrl);
    parsed.searchParams.delete(EMBEDDED_HOST_PARAM);
    parsed.searchParams.delete(LEGACY_HOST_PARAM);
    return parsed.toString();
  } catch {
    return targetUrl;
  }
}

function shouldPreserveEmbeddedProxyParams(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    const rawPath = String(parsed.pathname || '');
    const decodedPath = (() => {
      try {
        return decodeURIComponent(rawPath);
      } catch {
        return rawPath;
      }
    })();

    if (/(^|\.)vidplus\.dev$/i.test(parsed.hostname) && getEmbeddedHostParam(parsed)) {
      return true;
    }

    if (/\/(?:mp4-|ts-)?proxy$/i.test(rawPath) && parsed.searchParams.has('url') && getEmbeddedHeadersParam(parsed)) {
      return true;
    }

    return /\/proxy\/file2(?:\/|%2f)/i.test(rawPath) || /\/proxy\/file2\//i.test(decodedPath);
  } catch {
    return false;
  }
}

function stripEmbeddedProxyParams(targetUrl) {
  if (shouldPreserveEmbeddedProxyParams(targetUrl)) {
    return targetUrl;
  }

  const parsed = new URL(targetUrl);
  parsed.searchParams.delete(EMBEDDED_HEADERS_PARAM);
  parsed.searchParams.delete(EMBEDDED_HOST_PARAM);
  parsed.searchParams.delete(LEGACY_HEADERS_PARAM);
  parsed.searchParams.delete(LEGACY_HOST_PARAM);
  return parsed.toString();
}

function stripEmbeddedHeaderParams(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    parsed.searchParams.delete(EMBEDDED_HEADERS_PARAM);
    parsed.searchParams.delete(LEGACY_HEADERS_PARAM);
    return parsed.toString();
  } catch {
    return targetUrl;
  }
}

function isAbsolutePlaylistPath(candidatePath = '') {
  const value = String(candidatePath || '').trim();
  return /^https?:\/\//i.test(value) || /^\/\//.test(value);
}

function buildAbsolutePlaylistUrl(playlistUrl, candidatePath) {
  const isAbsoluteCandidate = isAbsolutePlaylistPath(candidatePath);
  const resolved = new URL(candidatePath, playlistUrl);
  const base = new URL(playlistUrl);

  const inheritedKeys = isAbsoluteCandidate
    ? [EMBEDDED_HEADERS_PARAM, LEGACY_HEADERS_PARAM]
    : [EMBEDDED_HEADERS_PARAM, EMBEDDED_HOST_PARAM, LEGACY_HEADERS_PARAM, LEGACY_HOST_PARAM];

  for (const key of inheritedKeys) {
    if (!resolved.searchParams.has(key) && base.searchParams.has(key)) {
      resolved.searchParams.set(key, base.searchParams.get(key));
    }
  }

  return stripUnsafeEmbeddedHostParams(resolved.toString());
}

function getProxyBaseUrl(req) {
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
  return `${protocol}://${req.get('host')}${req.baseUrl || '/proxy'}`;
}

function buildProxyUrl(proxyBaseUrl, targetUrl, headers = {}) {
  const proxied = new URL(proxyBaseUrl);
  proxied.searchParams.set('url', targetUrl);

  if (hasEmbeddedHeaders(targetUrl)) {
    const embeddedHost = parseEmbeddedHost(targetUrl);
    const canFetchEmbeddedHostDirectly = !!buildDirectEmbeddedHostUrl(targetUrl, embeddedHost);
    if (!canFetchEmbeddedHostDirectly) {
      proxied.searchParams.set('url', stripUnsafeEmbeddedHostParams(targetUrl));
      const headerToken = rememberHeaderToken({
        ...headers,
        ...parseEmbeddedHeaders(targetUrl)
      });
      if (headerToken) {
        proxied.searchParams.set('hid', headerToken);
      }
      return proxied.toString();
    }

    const embeddedHeaders = parseEmbeddedHeaders(targetUrl);
    const headerToken = rememberHeaderToken({
      ...headers,
      ...embeddedHeaders
    });
    proxied.searchParams.set('url', stripEmbeddedHeaderParams(targetUrl));
    if (headerToken) {
      proxied.searchParams.set('hid', headerToken);
    }
    return proxied.toString();
  }

  const normalizedHeaders = filterForwardHeaders(headers);
  if (Object.keys(normalizedHeaders).length) {
    const headerToken = rememberHeaderToken(normalizedHeaders);
    if (headerToken) {
      proxied.searchParams.set('hid', headerToken);
    } else {
      proxied.searchParams.set('headers', JSON.stringify(normalizedHeaders));
    }
  }

  return proxied.toString();
}

function isWorkersContentPlaylistUrl(targetUrl = '') {
  try {
    const parsed = new URL(String(targetUrl || ''));
    return /(^|\.)workers\.dev$/i.test(parsed.hostname) && parsed.pathname === '/content';
  } catch {
    return false;
  }
}

function isPlaylistResponse(targetUrl, contentType = '') {
  return /mpegurl|application\/vnd\.apple\.mpegurl|audio\/mpegurl/i.test(contentType) ||
    /\.m3u8(\?|$)/i.test(String(targetUrl || '')) ||
    isWorkersContentPlaylistUrl(targetUrl);
}

function getUpstreamHeader(upstream, headerName = '') {
  const normalizedName = String(headerName || '').toLowerCase();
  if (!normalizedName) {
    return '';
  }

  if (typeof upstream?.headers?.get === 'function') {
    return upstream.headers.get(normalizedName) || '';
  }

  return upstream?.headers?.[normalizedName] || upstream?.headers?.[headerName] || '';
}

function shouldForwardLengthMetadata(upstream) {
  return !String(getUpstreamHeader(upstream, 'content-encoding') || '').trim();
}

function normalizeFetchResponse(response) {
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body: response.body,
    text: () => response.text(),
    arrayBuffer: () => response.arrayBuffer(),
  };
}

function hasDisguisedTransportExtension(pathname = '') {
  return /\.(?:jpe?g|png|webp|html?|js|css|txt|ico)(?:$|\?)/i.test(pathname);
}

function getNestedPlaybackUrl(targetUrl = '') {
  try {
    const nestedUrl = new URL(String(targetUrl || '')).searchParams.get('url') || '';
    return nestedUrl ? decodeURIComponent(nestedUrl) : '';
  } catch {
    return '';
  }
}

function isHlsSidecarPath(targetUrl = '', contentType = '') {
  try {
    const parsed = new URL(String(targetUrl || ''));
    const pathname = decodeURIComponent(parsed.pathname || '').toLowerCase();
    const normalizedContentType = String(contentType || '').toLowerCase();

    return (
      /\.(?:m3u8|key|vtt|webvtt|srt|ass|ssa|ttml|dfxp|json|xml)(?:$|[?#])/i.test(pathname) ||
      normalizedContentType.includes('text/vtt') ||
      normalizedContentType.includes('application/json') ||
      normalizedContentType.includes('application/xml') ||
      normalizedContentType.includes('text/xml') ||
      (/\b(?:key|license|drm|token)\b/i.test(pathname) && normalizedContentType.includes('application/octet-stream'))
    );
  } catch {
    return false;
  }
}

function isHlsSidecarResource(targetUrl = '', contentType = '') {
  return isHlsSidecarPath(targetUrl, contentType) || isHlsSidecarPath(getNestedPlaybackUrl(targetUrl), contentType);
}

function findTsSyncOffset(buffer) {
  if (!buffer?.length) {
    return -1;
  }

  if (buffer[0] === 0x47) {
    return 0;
  }

  for (let offset = 1; offset < 188 && offset + 376 < buffer.length; offset += 1) {
    if (buffer[offset] === 0x47 && buffer[offset + 188] === 0x47 && buffer[offset + 376] === 0x47) {
      return offset;
    }
  }

  return -1;
}

function hasFmp4BoxAt(buffer, offset = 0) {
  if (!buffer || offset < 0 || offset + 8 > buffer.length) {
    return false;
  }

  const boxType = buffer.subarray(offset + 4, offset + 8).toString('ascii');
  return ['ftyp', 'styp', 'moof', 'moov', 'mdat'].includes(boxType);
}

function findFmp4BoxOffset(buffer) {
  if (!buffer?.length) {
    return -1;
  }

  if (hasFmp4BoxAt(buffer, 0)) {
    return 0;
  }

  const maxOffset = Math.min(buffer.length - 8, 2048);
  for (let offset = 1; offset <= maxOffset; offset += 1) {
    if (hasFmp4BoxAt(buffer, offset)) {
      return offset;
    }
  }

  return -1;
}

function stripDisguisedTransportPreamble(buffer) {
  const syncOffset = findTsSyncOffset(buffer);
  if (syncOffset > 0) {
    return buffer.subarray(syncOffset);
  }

  return buffer;
}

function getNormalizedTransportSegment(buffer) {
  const syncOffset = findTsSyncOffset(buffer);
  if (syncOffset >= 0) {
    return {
      body: syncOffset > 0 ? buffer.subarray(syncOffset) : buffer,
      contentType: 'video/mp2t'
    };
  }

  const fmp4Offset = findFmp4BoxOffset(buffer);
  if (fmp4Offset >= 0) {
    return {
      body: fmp4Offset > 0 ? buffer.subarray(fmp4Offset) : buffer,
      contentType: 'video/mp4'
    };
  }

  return null;
}

function shouldInspectTransportSegment(targetUrl, contentType = '') {
  try {
    if (isHlsSidecarResource(targetUrl, contentType)) {
      return false;
    }

    // AnimePahe's ts-proxy returns segments disguised as .jpg — inspect them
    // to strip any non-video preamble so HLS.js can decode them.
    if (isUpcloudTsProxyUrl(targetUrl)) {
      return true;
    }

    const parsed = new URL(String(targetUrl || ''));
    const pathname = decodeURIComponent(parsed.pathname).toLowerCase();
    const normalizedContentType = String(contentType || '').toLowerCase();

    return (
      isLikelyTransportSegment(targetUrl, contentType) ||
      hasDisguisedTransportExtension(pathname) ||
      pathname.includes('/hls/') ||
      pathname.includes('/cdn2/') ||
      pathname.includes('/stream/') ||
      normalizedContentType.startsWith('image/') ||
      normalizedContentType.includes('text/html') ||
      normalizedContentType.includes('text/css') ||
      normalizedContentType.includes('javascript')
    );
  } catch {
    return false;
  }
}

function isLikelyTransportSegment(targetUrl, contentType = '') {
  try {
    const parsed = new URL(String(targetUrl || ''));
    const pathname = decodeURIComponent(parsed.pathname).toLowerCase();
    const normalizedContentType = String(contentType || '').toLowerCase();

    if (pathname.includes('/hls/') && !/\.m3u8(?:$|[?#])/i.test(pathname) && normalizedContentType.startsWith('image/')) {
      return true;
    }

    if (pathname.includes('/file2/') && hasDisguisedTransportExtension(pathname)) {
      return true;
    }

    if (
      /(^|\.)10017\.workers\.dev$/i.test(parsed.hostname) &&
      pathname.includes('/cdn2/') &&
      hasDisguisedTransportExtension(pathname)
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

function isUpcloudTsProxyUrl(targetUrl = '') {
  try {
    const parsed = new URL(String(targetUrl || ''));
    return /(^|\.)upcloud\.animanga\.fun$/i.test(parsed.hostname) && /\/ts-proxy$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function shouldUseProxyHttp2(effectiveUrl = '', isPlaylistRequest = false, headers = {}) {
  if (!PROXY_HTTP2_ENABLED || headers.host || headers.range) {
    return false;
  }

  if (isPlaylistRequest) {
    return true;
  }

  try {
    const pathname = decodeURIComponent(new URL(String(effectiveUrl || '')).pathname || '').toLowerCase();
    return !(
      pathname.includes('/file2/') ||
      /\.(?:mp4|webm|mkv|mov|ts|m4s|cmfv|cmfa|jpe?g|png|webp|html?|js|css|txt|ico)(?:$|[?#])/i.test(pathname)
    );
  } catch {
    return false;
  }
}

function isStreamingMediaProxyRequest(effectiveUrl = '', isPlaylistRequest = false, isSidecarRequest = false) {
  if (isPlaylistRequest || isSidecarRequest) {
    return false;
  }

  if (isUpcloudTsProxyUrl(effectiveUrl)) {
    return true;
  }

  try {
    const urlText = decodeURIComponent(new URL(String(effectiveUrl || '')).toString()).toLowerCase();
    return (
      /\.(?:ts|m4s|mp4|webm|mkv|mov|cmfv|cmfa|jpe?g)(?:$|[?#&])/i.test(urlText) ||
      urlText.includes('/stream/') ||
      urlText.includes('/hls/') ||
      urlText.includes('/cdn2/') ||
      urlText.includes('/ts-proxy?')
    );
  } catch {
    return false;
  }
}

function getProxyTimeoutOptions(effectiveUrl = '', isPlaylistRequest = false, isSidecarRequest = false) {
  if (isStreamingMediaProxyRequest(effectiveUrl, isPlaylistRequest, isSidecarRequest)) {
    return {
      response: PROXY_FETCH_TIMEOUT_MS,
      read: PROXY_MEDIA_READ_TIMEOUT_MS,
    };
  }

  return { request: PROXY_FETCH_TIMEOUT_MS };
}

function shouldBufferPassthroughMediaSegment(effectiveUrl = '', isPlaylistRequest = false, isSidecarRequest = false) {
  if (isPlaylistRequest || isSidecarRequest) {
    return false;
  }

  // AnimePahe's ts-proxy segments are now handled by shouldInspectTransportSegment
  // which buffers and normalizes them. No additional passthrough buffering needed.
  return false;
}

function setProxyLogMode(res, mode) {
  res.locals.proxyLogMode = mode;
}

function rewritePlaylistDirectiveUris(line, playlistUrl, proxyBaseUrl, forwardedHeaders = {}) {
  if (!/URI="/i.test(line)) {
    return line;
  }

  return line.replace(/URI="([^"]+)"/gi, (_match, uri) => {
    const nextUrl = buildAbsolutePlaylistUrl(playlistUrl, uri);
    return `URI="${buildProxyUrl(proxyBaseUrl, nextUrl, forwardedHeaders)}"`;
  });
}

function isKnownNonVideoPlaylistUrl(targetUrl = '') {
  try {
    const parsed = new URL(String(targetUrl || ''));
    const hostname = parsed.hostname.toLowerCase();
    const pathname = decodeURIComponent(parsed.pathname || '').toLowerCase();

    return (
      /\.(?:apng|avif|bmp|gif|ico|jpe?g|png|svg|webp)(?:$|[?#])/i.test(pathname) ||
      pathname.includes('/ad-site-i18n/') ||
      ((hostname.includes('-ad-') || hostname.startsWith('p16-ad-')) && /(^|\.)ibyteimg\.com$/i.test(hostname))
    );
  } catch {
    return false;
  }
}

function removePendingSegmentMetadata(lines) {
  const segmentMetadataTags = [
    /^#EXTINF\b/i,
    /^#EXT-X-BYTERANGE\b/i,
    /^#EXT-X-PROGRAM-DATE-TIME\b/i,
    /^#EXT-X-DATERANGE\b/i,
    /^#EXT-X-CUE-/i,
    /^#EXT-X-DISCONTINUITY\b/i,
  ];

  while (lines.length) {
    const last = String(lines[lines.length - 1] || '').trim();
    if (!last) {
      lines.pop();
      continue;
    }

    if (!segmentMetadataTags.some((pattern) => pattern.test(last))) {
      break;
    }

    lines.pop();
  }
}

function rewritePlaylistBody(body, playlistUrl, proxyBaseUrl, forwardedHeaders = {}) {
  const rewrittenLines = [];

  for (const line of String(body || '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
      rewrittenLines.push(line);
      continue;
      }

      if (trimmed.startsWith('#')) {
      rewrittenLines.push(rewritePlaylistDirectiveUris(line, playlistUrl, proxyBaseUrl, forwardedHeaders));
      continue;
      }

      const nextUrl = buildAbsolutePlaylistUrl(playlistUrl, trimmed);
    if (isKnownNonVideoPlaylistUrl(nextUrl)) {
      removePendingSegmentMetadata(rewrittenLines);
      console.log(new Date().toISOString(), '[proxy] dropped non-video playlist entry', nextUrl);
      continue;
    }

    rewrittenLines.push(buildProxyUrl(proxyBaseUrl, nextUrl, forwardedHeaders));
  }

  return rewrittenLines.join('\n');
}

router.get('/', async (req, res) => {
  const targetUrl = String(req.query.url || '').trim();
  if (!targetUrl) {
    setProxyLogMode(res, 'error');
    return res.status(400).json({ error: 'url required' });
  }

  let parsedHeaders = getHeaderTokenHeaders(req.query.hid);
  if (req.query.headers) {
    try {
      parsedHeaders = {
        ...parsedHeaders,
        ...filterForwardHeaders(JSON.parse(String(req.query.headers)))
      };
    } catch {
      setProxyLogMode(res, 'error');
      return res.status(400).json({ error: 'invalid headers' });
    }
  }

  let upstreamUrl = targetUrl;
  const preserveEmbeddedProxyParams = shouldPreserveEmbeddedProxyParams(targetUrl);
  try {
    upstreamUrl = stripEmbeddedProxyParams(targetUrl);
  } catch {
    setProxyLogMode(res, 'error');
    return res.status(400).json({ error: 'invalid url' });
  }

  const embeddedHeaders = parseEmbeddedHeaders(targetUrl); // reads from targetUrl BEFORE stripping
  const useEmbeddedHeaders = hasEmbeddedProxyParams(targetUrl);

  // FIX: Extract headers embedded in the storm URL from targetUrl (before stripping),
  // not from upstreamUrl (after stripping) where they're already gone.
  let stormUrlHeaders = {};
  try {
    const stormParsed = new URL(targetUrl); // <-- targetUrl, not upstreamUrl
    const headersParam = stormParsed.searchParams.get('headers');
    if (headersParam) {
      stormUrlHeaders = filterForwardHeaders(parseEmbeddedHeaderJson(headersParam) || {});
    }
  } catch {}

  const isPlaylistRequest = isPlaylistResponse(targetUrl) || isPlaylistResponse(upstreamUrl);
  const isSidecarRequest = isHlsSidecarResource(targetUrl) || isHlsSidecarResource(upstreamUrl);
  const requestHeaders = filterForwardHeaders({
    ...req.headers,
    range:
      isPlaylistRequest || isSidecarRequest
        ? ''
        : (typeof req.headers.range === 'string' ? req.headers.range : '')
  });

  // FIX: Always include parsedHeaders (contains user-agent from client).
  // Previously parsedHeaders was dropped when useEmbeddedHeaders was true.
  const upstreamHeaders = {
    ...requestHeaders,
    ...parsedHeaders,
    ...stormUrlHeaders,
    ...embeddedHeaders,
  };

  if (isSidecarRequest) {
    delete upstreamHeaders.range;
  }

  const embeddedHost = parseEmbeddedHost(targetUrl);
  const shouldUseEmbeddedHost = shouldApplyEmbeddedHostOverride(targetUrl, embeddedHost, preserveEmbeddedProxyParams);
  const activeEmbeddedHost = shouldUseEmbeddedHost ? embeddedHost : '';
  const directEmbeddedHostUrl = activeEmbeddedHost ? buildDirectEmbeddedHostUrl(targetUrl, activeEmbeddedHost) : '';

  if (!upstreamHeaders['user-agent']) {
    upstreamHeaders['user-agent'] = getDefaultUserAgent();
  }

  // Inject realistic client hints if not already present
  const clientHints = getRealisticClientHints();
  for (const [key, value] of Object.entries(clientHints)) {
    if (!upstreamHeaders[key]) {
      upstreamHeaders[key] = value;
    }
  }

  if (!upstreamHeaders.accept) {
    upstreamHeaders.accept = '*/*';
  }

  if (!upstreamHeaders['accept-language']) {
    upstreamHeaders['accept-language'] = 'en-US,en;q=0.9';
  }

  if (!upstreamHeaders['accept-encoding']) {
    upstreamHeaders['accept-encoding'] = preserveEmbeddedProxyParams ? 'gzip, deflate, br' : 'identity';
  }

  // Match the browser-style fetch profile seen in vidlink/storm captures.
  if (!upstreamHeaders['sec-fetch-site']) {
    upstreamHeaders['sec-fetch-site'] = 'cross-site';
  }

  if (!upstreamHeaders['sec-fetch-mode']) {
    upstreamHeaders['sec-fetch-mode'] = 'cors';
  }

  if (!upstreamHeaders['sec-fetch-dest'] || isSidecarRequest) {
    upstreamHeaders['sec-fetch-dest'] = isPlaylistRequest || isSidecarRequest ? 'empty' : 'video';
  }

  // Force 'video' dest for non-playlist media to satisfy CDN checks.
  if (!isPlaylistRequest && !isSidecarRequest && /\.(mp4|ts|m4s|mkv|webm|mov|cmfv|cmfa)(\?|$)/i.test(upstreamUrl)) {
    upstreamHeaders['sec-fetch-dest'] = 'video';
  }
  // Ensure sec-fetch-site is set for all requests
  if (!upstreamHeaders['sec-fetch-site']) {
    upstreamHeaders['sec-fetch-site'] = 'cross-site';
  }

  if (useEmbeddedHeaders) {
    const resolvedCookie = stormUrlHeaders.cookie || embeddedHeaders.cookie || parsedHeaders.cookie || '';
    if (resolvedCookie) {
      upstreamHeaders.cookie = resolvedCookie;
    } else {
      delete upstreamHeaders.cookie;
    }
  }

  if (activeEmbeddedHost && !directEmbeddedHostUrl && !preserveEmbeddedProxyParams && !upstreamHeaders.host) {
    upstreamHeaders.host = activeEmbeddedHost;
  }

  const playbackHeaders = upstreamHeaders;
  const playlistCacheKey = isPlaylistRequest ? getPlaylistCacheKey(targetUrl, playbackHeaders) : '';
  const failureCacheKey = getFailureCacheKey(targetUrl, playbackHeaders);

  if (playlistCacheKey) {
    const cachedPlaylist = playlistCache.get(playlistCacheKey);
    if (cachedPlaylist && cachedPlaylist.expiresAt > Date.now()) {
      setProxyLogMode(res, 'playlist');
      res.status(200);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=60');
      console.log(new Date().toISOString(), '[proxy] playlist cache hit', upstreamUrl);
      return res.send(cachedPlaylist.body);
    }
  }

  const cachedFailure = getCachedFailure(failureCacheKey);
  if (cachedFailure) {
    setProxyLogMode(res, 'error');
    res.status(cachedFailure.status);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', cachedFailure.contentType || 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    console.log(new Date().toISOString(), '[proxy] failure cache hit', cachedFailure.status, upstreamUrl);
    return res.send(cachedFailure.body);
  }

  if (process.env.PROXY_DEBUG_HEADERS === '1') {
    console.log(new Date().toISOString(), '[proxy] headers:', JSON.stringify(upstreamHeaders));
  }

  const abortController = new AbortController();
  const abortUpstream = () => {
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
  };

  req.once('aborted', abortUpstream);
  res.once('close', () => {
    if (!res.writableEnded) {
      abortUpstream();
    }
  });

  try {
    // If the storm proxy URL specifies a target host, connect directly to it
    // so Node.js sends the correct Host header (fetch() won't let us override Host)
    let effectiveUrl = upstreamUrl;
    const unwrappedWorkerUrl = unwrapEncodedWorkerUrl(upstreamUrl);
    if (unwrappedWorkerUrl) {
      effectiveUrl = unwrappedWorkerUrl;
      console.log(new Date().toISOString(), '[proxy] direct worker target URL:', effectiveUrl);
    } else if (directEmbeddedHostUrl) {
      effectiveUrl = directEmbeddedHostUrl;
      console.log(new Date().toISOString(), '[proxy] direct embedded host URL:', effectiveUrl);
    } else if (activeEmbeddedHost && !preserveEmbeddedProxyParams) {
      try {
        const originalParsed = new URL(upstreamUrl);
        const targetHost = activeEmbeddedHost.includes('://') ? new URL(activeEmbeddedHost).host : activeEmbeddedHost;
        originalParsed.host = targetHost;
        
        if (!preserveEmbeddedProxyParams) {
          originalParsed.searchParams.delete('headers');
          originalParsed.searchParams.delete('host');
          originalParsed.searchParams.delete(EMBEDDED_HEADERS_PARAM);
          originalParsed.searchParams.delete(EMBEDDED_HOST_PARAM);
        }
        effectiveUrl = originalParsed.toString();
        console.log(new Date().toISOString(), '[proxy] direct host URL:', effectiveUrl);
      } catch {
        // Fall through to original URL
      }
    }

    let upstreamResponse = null;
    let upstreamError = null;

    for (let attempt = 1; attempt <= PROXY_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const stream = gotScraping.stream({
          url: effectiveUrl,
          method: 'GET',
          headers: upstreamHeaders,
          proxyUrl: playbackProxyUrl || undefined,
          timeout: getProxyTimeoutOptions(effectiveUrl, isPlaylistRequest, isSidecarRequest),
          retry: { limit: 0 },
          throwHttpErrors: false,
          followRedirect: true,
          http2: shouldUseProxyHttp2(effectiveUrl, isPlaylistRequest, upstreamHeaders)
        });

        const responsePromise = new Promise((resolve, reject) => {
          stream.on('response', (resp) => resolve(resp));
          stream.on('error', (err) => reject(err));
        });

        const response = await responsePromise;
        if (response.statusCode >= 200 && response.statusCode < 300) {
          upstreamResponse = response;
          upstreamResponse.stream = stream;
          break;
        }

        if (!isRetryableStatus(response.statusCode) || attempt === PROXY_RETRY_ATTEMPTS) {
          upstreamResponse = response;
          upstreamResponse.stream = stream;
          break;
        }

        console.log(new Date().toISOString(), '[proxy] retry', response.statusCode, upstreamUrl, `attempt=${attempt + 1}/${PROXY_RETRY_ATTEMPTS}`);
        stream.destroy();
      } catch (error) {
        if (abortController.signal.aborted || error?.name === 'AbortError') {
          throw error;
        }

        if (attempt === PROXY_RETRY_ATTEMPTS) {
          upstreamError = error;
          break;
        }

        console.log(new Date().toISOString(), '[proxy] retry', upstreamUrl, error?.message || String(error), `attempt=${attempt + 1}/${PROXY_RETRY_ATTEMPTS}`);
      }

      await sleep(PROXY_RETRY_DELAY_MS * attempt);
    }

    if (upstreamError) {
      throw upstreamError;
    }

    if (upstreamResponse.statusCode >= 400) {
      setProxyLogMode(res, 'error');
      const body = await new Promise((resolve) => {
        const chunks = [];
        upstreamResponse.stream.on('data', (chunk) => chunks.push(chunk));
        upstreamResponse.stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        upstreamResponse.stream.on('error', () => resolve(''));
      });

      rememberProxyFailure(failureCacheKey, upstreamResponse.statusCode, upstreamResponse.headers['content-type'] || 'text/plain; charset=utf-8', body);
      console.log(
        new Date().toISOString(),
        '[proxy] upstream error',
        upstreamResponse.statusCode,
        upstreamUrl,
        `target-host=${activeEmbeddedHost || new URL(effectiveUrl).host}`,
        `headers=${JSON.stringify(filterForwardHeaders(upstreamHeaders))}`,
        `preview=${body.slice(0, 300).replace(/\s+/g, ' ')}`
      );
      return res.status(upstreamResponse.statusCode).send(body);
    }

    const upstreamContentType = upstreamResponse.headers['content-type'] || 'application/octet-stream';
    const isPlaylist = isPlaylistResponse(targetUrl, upstreamContentType) ||
      isPlaylistResponse(upstreamUrl, upstreamContentType) ||
      isPlaylistResponse(effectiveUrl, upstreamContentType);
    const shouldInspectSegment = !isPlaylist && shouldInspectTransportSegment(effectiveUrl || upstreamUrl, upstreamContentType);
    const shouldBufferPassthroughSegment = !shouldInspectSegment && shouldBufferPassthroughMediaSegment(effectiveUrl || upstreamUrl, isPlaylist, isSidecarRequest);
    let bufferedSegmentBody = null;
    let normalizedSegment = null;

    if (shouldInspectSegment) {
      const chunks = [];
      for await (const chunk of upstreamResponse.stream) {
        chunks.push(chunk);
      }
      bufferedSegmentBody = Buffer.concat(chunks);
      normalizedSegment = getNormalizedTransportSegment(bufferedSegmentBody);

      if (!normalizedSegment) {
        // For upcloud ts-proxy URLs, the upstream proxy may already return clean
        // video data without recognisable TS/fMP4 preamble markers.  Fall back to
        // buffered passthrough with video/mp2t instead of returning a hard 502.
        if (isUpcloudTsProxyUrl(effectiveUrl || upstreamUrl)) {
          console.log(
            new Date().toISOString(),
            '[proxy] upcloud segment passthrough (no preamble detected)',
            upstreamUrl,
            `content-type=${upstreamContentType}`,
            `bytes=${bufferedSegmentBody.length}`
          );
        } else {
          const body = JSON.stringify({ error: 'invalid media segment' });
          rememberProxyFailure(failureCacheKey, 502, 'application/json; charset=utf-8', body);
          setProxyLogMode(res, 'error');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          console.log(
            new Date().toISOString(),
            '[proxy] invalid media segment',
            upstreamUrl,
            `content-type=${upstreamContentType}`,
            `bytes=${bufferedSegmentBody.length}`
          );
          return res.status(502).send(body);
        }
      }
    } else if (shouldBufferPassthroughSegment) {
      const chunks = [];
      for await (const chunk of upstreamResponse.stream) {
        chunks.push(chunk);
      }
      bufferedSegmentBody = Buffer.concat(chunks);
    }

    const contentType =
      isPlaylist
        ? 'application/vnd.apple.mpegurl; charset=utf-8'
        : normalizedSegment?.contentType
        ? normalizedSegment.contentType
        : !isSidecarRequest && isUpcloudTsProxyUrl(effectiveUrl || upstreamUrl)
        ? 'video/mp2t'
        : upstreamContentType;
    setProxyLogMode(res, isPlaylist ? 'playlist' : 'asset');

    const normalizedSegmentStatus = normalizedSegment && bufferedSegmentBody && normalizedSegment.body.length !== bufferedSegmentBody.length
      ? 200
      : upstreamResponse.statusCode;
    res.status(isPlaylist ? 200 : normalizedSegmentStatus);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=60');

    // FIX: Build rewritten playlist BEFORE logging its length.
    // Previously `rewritten` was logged before it was defined (ReferenceError).
    if (isPlaylist) {
      // Phase 7: Check playlist cache first
      const finalPlaylistCacheKey = playlistCacheKey || getPlaylistCacheKey(targetUrl, playbackHeaders);
      const cachedPlaylist = playlistCache.get(finalPlaylistCacheKey);
      if (cachedPlaylist && cachedPlaylist.expiresAt > Date.now()) {
        console.log(new Date().toISOString(), '[proxy] playlist cache hit', upstreamUrl);
        return res.send(cachedPlaylist.body);
      }

      const playlistBody = bufferedSegmentBody 
        ? bufferedSegmentBody.toString('utf8') 
        : await new Promise((resolve) => {
            const chunks = [];
            upstreamResponse.stream.on('data', (chunk) => chunks.push(chunk));
            upstreamResponse.stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          });
      const rewritten = rewritePlaylistBody(
        playlistBody,
        effectiveUrl || targetUrl,
        getProxyBaseUrl(req),
        playbackHeaders
      );

      // Store in playlist cache
      playlistCache.set(finalPlaylistCacheKey, { body: rewritten, expiresAt: Date.now() + PLAYLIST_CACHE_TTL_MS });
      // Evict oldest entries when cache grows too large
      if (playlistCache.size > PLAYLIST_CACHE_MAX_ENTRIES) {
        const firstKey = playlistCache.keys().next().value;
        playlistCache.delete(firstKey);
      }

      console.log(new Date().toISOString(), '[proxy] upstream', upstreamResponse.statusCode, upstreamUrl, activeEmbeddedHost ? `target-host=${activeEmbeddedHost}` : '');
      console.log(new Date().toISOString(), '[proxy] playlist rewritten, length:', rewritten.length);
      return res.send(rewritten);
    }

    if (normalizedSegment) {
      const normalizedBody = normalizedSegment.body;
      if (normalizedSegmentStatus === 206) {
        for (const headerName of ['accept-ranges', 'content-range']) {
          const headerValue = upstreamResponse.headers[headerName];
          if (headerValue) {
            res.setHeader(headerName, headerValue);
          }
        }
      }
      res.setHeader('Content-Length', normalizedBody.length);
      return res.end(normalizedBody);
    }

    if (bufferedSegmentBody) {
      res.setHeader('Content-Length', bufferedSegmentBody.length);
      return res.end(bufferedSegmentBody);
    }

    for (const headerName of ['accept-ranges', 'etag', 'last-modified']) {
      const headerValue = upstreamResponse.headers[headerName];
      if (headerValue) {
        res.setHeader(headerName, headerValue);
      }
    }

    if (shouldForwardLengthMetadata(upstreamResponse)) {
      for (const headerName of ['content-length', 'content-range']) {
        const headerValue = upstreamResponse.headers[headerName];
        if (headerValue) {
          res.setHeader(headerName, headerValue);
        }
      }
    }

    try {
      await pipeline(upstreamResponse.stream, res);
    } catch (error) {
      if (error?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.log(new Date().toISOString(), '[proxy] pipeline error', upstreamUrl, error?.message || String(error));
      }
    }
    return;
  } catch (error) {
    if (req.aborted || res.destroyed || abortController.signal.aborted) {
      return;
    }

    setProxyLogMode(res, 'error');
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : undefined);
      return;
    }

    const body = JSON.stringify({ error: error?.message || 'proxy failed' });
    rememberProxyFailure(failureCacheKey, 502, 'application/json; charset=utf-8', body);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(502).send(body);
  }
});

export default router;
