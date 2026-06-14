import { Router } from 'express';

const router = Router();
const WYZIE_SEARCH_URL = 'https://sub.wyzie.io/search';
const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_LANGUAGES = ['en', 'ar'];

// Phase 8: Cache subtitle search results for 24 hours
const SUBTITLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const subtitleCache = new Map();

function getBaseUrl(req) {
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
  return `${protocol}://${req.get('host')}`;
}

function withTimeout(ms = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    done: () => clearTimeout(timer)
  };
}

function normalizeLanguageCode(code = '') {
  const clean = String(code || '').trim().toLowerCase();
  if (clean.startsWith('en')) return 'en';
  if (clean.startsWith('ar')) return 'ar';
  return clean.slice(0, 2) || 'en';
}

function normalizeLanguageLabel(code = '') {
  const normalized = normalizeLanguageCode(code);
  if (normalized === 'en') return 'English';
  if (normalized === 'ar') return 'Arabic';
  return normalized.toUpperCase();
}

function normalizeLanguages(input) {
  const raw = Array.isArray(input) ? input.join(',') : String(input || '');
  const parts = raw
    .split(/[\s,]+/)
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .map((entry) => normalizeLanguageCode(entry))
    .filter(Boolean);

  return [...new Set(parts.length ? parts : DEFAULT_LANGUAGES)];
}

function toSubtitleEntries(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.subtitles)) {
    return payload.subtitles;
  }

  if (Array.isArray(payload?.results)) {
    return payload.results;
  }

  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  return [];
}

function normalizeSubtitleItem(item, language, index) {
  const url = item?.url || item?.src || item?.download || item?.download_url || item?.file || item?.link || '';
  if (!url) {
    return null;
  }

  const normalizedLanguage = normalizeLanguageCode(item?.lang || item?.language || item?.lang_code || language);
  const label = item?.release || item?.title || item?.filename || item?.label || `Wyzie ${normalizeLanguageLabel(normalizedLanguage)}`;
  const formatSource = `${item?.format || ''} ${url}`.toLowerCase();

  return {
    id: `wyzie:${normalizedLanguage}:${item?.id || label}:${index}`,
    label,
    language: normalizedLanguage,
    languageLabel: normalizeLanguageLabel(normalizedLanguage),
    url,
    provider: 'Wyzie',
    format: formatSource.includes('.srt') ? 'srt' : 'vtt'
  };
}

function dedupeSubtitles(subtitles = []) {
  const seen = new Set();
  return subtitles.filter((entry) => {
    const key = `${entry?.language || ''}:${entry?.url || ''}`;
    if (!entry?.url || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function convertSrtToVtt(text = '') {
  const body = String(text || '').replace(/^\uFEFF/, '').replace(/\r/g, '');
  if (/^WEBVTT\b/i.test(body.trimStart())) {
    return body;
  }

  const cues = body
    .split('\n')
    .map((line) => line.replace(
      /(\d{1,2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}),(\d{3})/g,
      '$1.$2 --> $3.$4'
    ))
    .join('\n');

  return `WEBVTT\n\n${cues}`;
}

router.get('/file', async (req, res) => {
  const targetUrl = String(req.query.url || '').trim();
  if (!targetUrl) {
    return res.status(400).json({ success: false, error: 'url required' });
  }

  const { signal, done } = withTimeout();

  try {
    const response = await fetch(targetUrl, {
      signal,
      headers: {
        'user-agent': 'Mozilla/5.0',
        accept: 'text/plain, text/vtt, application/x-subrip, */*'
      }
    });

    if (!response.ok) {
      return res.status(response.status).send(await response.text());
    }

    const body = await response.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    return res.send(convertSrtToVtt(body));
  } catch (error) {
    return res.status(502).json({ success: false, error: error?.message || 'subtitle proxy failed' });
  } finally {
    done();
  }
});

router.get('/', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('ETag', `"subtitles-${Date.now()}-${Math.random().toString(16).slice(2)}"`);

  const apiKey = String(process.env.WYZIE_API_KEY || '').trim();
  if (!apiKey) {
    return res.status(503).json({ success: false, error: 'WYZIE_API_KEY not configured', subtitles: [] });
  }

  const id = String(req.query.imdbId || req.query.tmdbId || req.query.id || '').trim();
  if (!id) {
    return res.status(400).json({ success: false, error: 'imdbId or tmdbId required', subtitles: [] });
  }

  const season = String(req.query.season || '').trim();
  const episode = String(req.query.episode || '').trim();
  const languages = normalizeLanguages(req.query.languages || req.query.language);

  // Phase 8: Check subtitle cache
  const subtitleCacheKey = `sub:${id}:${season}:${episode}:${languages.join(',')}`;
  const cachedEntry = subtitleCache.get(subtitleCacheKey);
  if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
    return res.json(cachedEntry.data);
  }

  const results = await Promise.allSettled(
    languages.map(async (language) => {
      const params = new URLSearchParams({
        id,
        language,
        format: 'srt',
        source: 'all',
        key: apiKey
      });

      if (season && episode) {
        params.set('season', season);
        params.set('episode', episode);
      }

      const { signal, done } = withTimeout();

      try {
        const response = await fetch(`${WYZIE_SEARCH_URL}?${params}`, { signal });
        if (!response.ok) {
          console.log(new Date().toISOString(), '[subtitles] wyzie failed', response.status, language, id);
          return [];
        }

        const payload = await response.json();
        return toSubtitleEntries(payload)
          .map((entry, index) => normalizeSubtitleItem(entry, language, index))
          .filter(Boolean);
      } catch (error) {
        console.log(new Date().toISOString(), '[subtitles] wyzie error', language, id, error?.message || String(error));
        return [];
      } finally {
        done();
      }
    })
  );

  const subtitles = dedupeSubtitles(
    results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
  );

  const subtitleProxyBaseUrl = new URL('/api/subtitles/file', getBaseUrl(req));
  const proxiedSubtitles = subtitles.map((entry) => {
    const nextUrl = new URL(subtitleProxyBaseUrl);
    nextUrl.searchParams.set('url', entry.url);

    return {
      ...entry,
      url: nextUrl.toString()
    };
  });

  const responseData = {
    success: true,
    subtitles: proxiedSubtitles,
    languages
  };

  // Store in subtitle cache
  subtitleCache.set(subtitleCacheKey, { data: responseData, expiresAt: Date.now() + SUBTITLE_CACHE_TTL_MS });
  // Evict old entries (simple cap)
  if (subtitleCache.size > 500) {
    const firstKey = subtitleCache.keys().next().value;
    subtitleCache.delete(firstKey);
  }

  return res.json(responseData);
});

export default router;
