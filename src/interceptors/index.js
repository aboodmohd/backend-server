const VIDEO_PATTERNS = [
  /\.m3u8(\?|$)/i,
  /\.mpd(\?|$)/i,
  /\.mp4(\?|$)/i,
  /\.m4v(\?|$)/i,
  /\.webm(\?|$)/i,
  /\.ogv(\?|$)/i,
  /\.flv(\?|$)/i,
  /\.mkv(\?|$)/i,
  /\.mov(\?|$)/i,
  /\/hls\//i,
  /\/dash\//i,
  /\/stream\//i,
  /manifest/i,
  /playlist\.m3u8/i,
  /master\.m3u8/i,
  /index\.m3u8/i,
  /video\.m3u8/i
];

const VIDEO_CONTENT_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/dash+xml',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'application/ogg',
  'video/quicktime',
  'video/x-flv',
  'video/x-matroska',
  'video/'
];

const NON_STREAM_ASSET_PATTERNS = [
  /(?:^|\/)_(?:build|ssg|middleware)manifest\.js(?:\?|$)/i,
  /\.(?:js|mjs|cjs|css|map|json|txt|svg|png|jpe?g|gif|webp|ico|wasm|woff2?|ttf)(?:\?|$)/i,
  /\/favicon\.ico(?:\?|$)/i
];

function normalizeEscapedPayloadUrl(value = '') {
  return String(value || '')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/&amp;/g, '&')
    .trim();
}

function collectJsonStringValues(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectJsonStringValues(entry, out);
    }
    return out;
  }

  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      collectJsonStringValues(entry, out);
    }
  }

  return out;
}

function extractUrlLikeTokens(text = '') {
  const source = String(text || '');
  const urls = [];
  let index = 0;

  while (index < source.length) {
    const start = source.indexOf('http', index);
    if (start === -1) {
      break;
    }

    let end = start;
    while (end < source.length) {
      const char = source[end];
      const previous = end > start ? source[end - 1] : '';
      if (/\s|[<>()]/.test(char) || char === "'" || (char === '"' && previous !== '\\')) {
        break;
      }
      end += 1;
    }

    urls.push(source.slice(start, end));
    index = Math.max(end, start + 1);
  }

  return urls;
}

function hasValidEmbeddedHeaders(candidate = '') {
  try {
    const parsed = new URL(candidate);
    const embedded = parsed.searchParams.get('__proxy_headers') || parsed.searchParams.get('headers');
    if (!embedded) {
      return true;
    }

    let decoded = embedded;
    try {
      decoded = decodeURIComponent(embedded);
    } catch {}

    decoded = normalizeEscapedPayloadUrl(decoded);
    if (!decoded || decoded === '{' || decoded === '{\\') {
      return false;
    }

    JSON.parse(decoded);
    return true;
  } catch {
    return false;
  }
}

function isStreamCandidate(candidate = '') {
  const value = normalizeEscapedPayloadUrl(candidate);
  return !!value && !isNonStreamAssetUrl(value) && hasValidEmbeddedHeaders(value) && VIDEO_PATTERNS.some((pattern) => pattern.test(value));
}

function getStreamCandidateRank(candidate = '') {
  const value = normalizeEscapedPayloadUrl(candidate).toLowerCase();
  if (/\.m3u8($|[?#])/i.test(value) || /playlist\.m3u8/i.test(value) || /master\.m3u8/i.test(value) || /index\.m3u8/i.test(value)) {
    return 0;
  }
  if (/\.mpd($|[?#])/i.test(value)) {
    return 1;
  }
  if (/\.(mp4|m4v)($|[?#])/i.test(value)) {
    return 2;
  }
  return 3;
}

function pickBestStreamCandidate(candidates = []) {
  const normalized = candidates
    .map((candidate) => normalizeEscapedPayloadUrl(candidate))
    .filter(isStreamCandidate);

  normalized.sort((a, b) => getStreamCandidateRank(a) - getStreamCandidateRank(b));
  return normalized[0] || null;
}

function isMegaplayEmbedPage(url) {
  try {
    const parsed = new URL(url);
    return /(^|\.)megaplay\.buzz$/i.test(parsed.hostname) && /^\/stream\/(ani|mal)\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function normalizeUrlKey(url) {
  return String(url || '').split('?')[0].toLowerCase();
}

function isNonStreamAssetUrl(url) {
  return NON_STREAM_ASSET_PATTERNS.some((pattern) => pattern.test(String(url || '')));
}

export function createDetectorState() {
  return {
    seen: new Set()
  };
}

export function isVideoUrl(url, state) {
  const key = normalizeUrlKey(url);
  if (!key || /\.ts$/i.test(key) || isNonStreamAssetUrl(key) || !hasValidEmbeddedHeaders(url) || state.seen.has(key) || isMegaplayEmbedPage(url)) {
    return false;
  }

  if (VIDEO_PATTERNS.some((pattern) => pattern.test(url))) {
    state.seen.add(key);
    return true;
  }

  return false;
}

export function isVideoContentType(contentType = '') {
  const normalized = contentType.toLowerCase();
  return VIDEO_CONTENT_TYPES.some((type) => normalized.includes(type));
}

export function detectType(url, contentType = '') {
  const normalizedUrl = String(url || '').toLowerCase();
  const normalizedType = contentType.toLowerCase();

  if (/\.m3u8($|[?#])/i.test(normalizedUrl) || normalizedType.includes('mpegurl')) return 'HLS';
  if (/\.mpd($|[?#])/i.test(normalizedUrl) || normalizedType.includes('dash+xml')) return 'DASH';
  if (/\.flv($|[?#])/i.test(normalizedUrl) || normalizedType.includes('x-flv')) return 'FLV';
  if (/\.(mp4|m4v)($|[?#])/i.test(normalizedUrl) || normalizedType.includes('video/mp4')) return 'MP4';
  if (/\.webm($|[?#])/i.test(normalizedUrl) || normalizedType.includes('video/webm')) return 'WEBM';
  if (/\.(ogv|ogg)($|[?#])/i.test(normalizedUrl) || normalizedType.includes('video/ogg') || normalizedType.includes('application/ogg')) return 'OGG';
  if (/\.mkv($|[?#])/i.test(normalizedUrl) || normalizedType.includes('matroska')) return 'MKV';
  if (/\.mov($|[?#])/i.test(normalizedUrl) || normalizedType.includes('quicktime')) return 'MOV';
  if (/\.(m4a|m4b|mp3|wav|weba|aac|oga|flac)($|[?#])/i.test(normalizedUrl) || normalizedType.startsWith('audio/')) return 'AUDIO';

  return 'STREAM';
}

export function extractStreamFromPayload(payload) {
  const text = String(payload || '').trim();

  try {
    const parsed = JSON.parse(text);
    const primaryCandidate = pickBestStreamCandidate([
      parsed?.stream?.playlist ||
      parsed?.stream?.url ||
      parsed?.playlist ||
      parsed?.url ||
      parsed?.file
    ]);

    if (primaryCandidate) {
      return primaryCandidate;
    }

    const nestedCandidate = pickBestStreamCandidate(collectJsonStringValues(parsed));
    if (nestedCandidate) {
      return nestedCandidate;
    }
  } catch {
    // Fall back to scanning non-JSON payloads below.
  }

  return pickBestStreamCandidate(extractUrlLikeTokens(text));
}
