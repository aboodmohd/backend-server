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
  /\.(?:js|mjs|cjs|css|map|json|txt|svg|png|jpe?g|gif|webp|ico|woff2?|ttf)(?:\?|$)/i,
  /\/favicon\.ico(?:\?|$)/i
];

const PAYLOAD_URL_REGEX = /https?:\/\/[^"'\s<>()]+/gi;

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
  if (!key || /\.ts$/i.test(key) || isNonStreamAssetUrl(key) || state.seen.has(key)) {
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
    const candidate =
      parsed?.stream?.playlist ||
      parsed?.stream?.url ||
      parsed?.playlist ||
      parsed?.url ||
      parsed?.file;

    if (candidate && !isNonStreamAssetUrl(candidate) && VIDEO_PATTERNS.some((pattern) => pattern.test(candidate))) {
      return candidate;
    }
  } catch {
    // Fall back to regex extraction below.
  }

  const matches = text.match(PAYLOAD_URL_REGEX) || [];

  for (const match of matches) {
    const candidate = match
      .replace(/\\u0026/g, '&')
      .replace(/\\\//g, '/')
      .replace(/\\"/g, '"');

    if (!isNonStreamAssetUrl(candidate) && VIDEO_PATTERNS.some((pattern) => pattern.test(candidate))) {
      return candidate;
    }
  }

  return null;
}
