const VIDEO_PATTERNS = [
  /\.m3u8(\?|$)/i,
  /\.mpd(\?|$)/i,
  /\.mp4(\?|$)/i,
  /\.webm(\?|$)/i,
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
  'video/'
];

const PAYLOAD_URL_REGEX = /https?:\/\/[^"'\s<>()]+/gi;

function normalizeUrlKey(url) {
  return String(url || '').split('?')[0].toLowerCase();
}

export function createDetectorState() {
  return {
    seen: new Set()
  };
}

export function isVideoUrl(url, state) {
  const key = normalizeUrlKey(url);
  if (!key || /\.ts$/i.test(key) || state.seen.has(key)) {
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
  const normalizedType = contentType.toLowerCase();
  if (/\.m3u8/i.test(url) || normalizedType.includes('mpegurl')) return 'HLS';
  if (/\.mpd/i.test(url) || normalizedType.includes('dash+xml')) return 'DASH';
  if (/\.mp4/i.test(url)) return 'MP4';
  if (/\.webm/i.test(url)) return 'WEBM';
  if (/\.mkv/i.test(url)) return 'MKV';
  if (/\.mov/i.test(url)) return 'MOV';
  return 'STREAM';
}

export function extractStreamFromPayload(payload) {
  const text = String(payload || '');
  const matches = text.match(PAYLOAD_URL_REGEX) || [];

  for (const match of matches) {
    const candidate = match.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    if (VIDEO_PATTERNS.some((pattern) => pattern.test(candidate))) {
      return candidate;
    }
  }

  try {
    const parsed = JSON.parse(text);
    const candidate = parsed?.stream?.playlist || parsed?.stream?.url || parsed?.url || parsed?.file;
    if (candidate && VIDEO_PATTERNS.some((pattern) => pattern.test(candidate))) {
      return candidate;
    }
  } catch {
    return null;
  }

  return null;
}
