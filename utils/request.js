const axios = require('axios');

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
};

const client = axios.create({
  timeout: 12000,
  maxRedirects: 5,
  headers: DEFAULT_HEADERS,
});

const MEDIA_EXTENSION_PATTERN = '(?:m3u8|mp4|mpd|mkv|webm|m3u)';
const MEDIA_URL_REGEX = new RegExp(`\\.(${MEDIA_EXTENSION_PATTERN})(?:$|[?#])`, 'i');
const EXTRACT_URLS_REGEX = new RegExp(
  `(https?:\\/\\/[^"'\\s<>()]+|\\/[^"'\\s<>()]+\\.${MEDIA_EXTENSION_PATTERN}(?:\\?[^"'\\s<>()]*)?|\\/[^"'\\s<>()]+\\.(?:vtt|srt|ass)(?:\\?[^"'\\s<>()]*)?)`,
  'gi',
);

function absoluteUrl(baseUrl, candidate) {
  if (!candidate) {
    return null;
  }

  try {
    return new URL(candidate, baseUrl).toString();
  } catch {
    return null;
  }
}

function getHostname(inputUrl) {
  return new URL(inputUrl).hostname.replace(/^www\./, '');
}

function isMediaUrl(candidate) {
  return MEDIA_URL_REGEX.test(candidate || '');
}

function isSubtitleUrl(candidate) {
  return /\.(vtt|srt|ass)(?:$|\?)/i.test(candidate || '');
}

function extractUrls(input, baseUrl) {
  const results = new Set();
  const matches = String(input || '').match(EXTRACT_URLS_REGEX) || [];

  for (const match of matches) {
    const normalized = absoluteUrl(baseUrl, match.replace(/\\u0026/g, '&').replace(/\\\//g, '/'));
    if (normalized) {
      results.add(normalized);
    }
  }

  return [...results];
}

async function request(config) {
  const response = await client.request(config);
  return response.data;
}

async function fetchText(url, config = {}) {
  return request({
    method: 'GET',
    responseType: 'text',
    url,
    ...config,
  });
}

async function fetchJson(url, config = {}) {
  return request({
    method: 'GET',
    responseType: 'json',
    url,
    ...config,
  });
}

module.exports = {
  absoluteUrl,
  client,
  extractUrls,
  fetchJson,
  fetchText,
  getHostname,
  isMediaUrl,
  isSubtitleUrl,
  MEDIA_URL_REGEX,
};
