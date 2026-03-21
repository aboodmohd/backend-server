const cheerio = require('cheerio');
const { chromium } = require('playwright');
const { absoluteUrl, extractUrls, fetchJson, fetchText, isMediaUrl, isSubtitleUrl, MEDIA_URL_REGEX } = require('../utils/request');

const STREAM_EXTENSIONS = ['.m3u8', '.mp4', '.m3u', '.mpd', '.mkv', '.webm'];
const SUBTITLE_EXTENSIONS = ['.vtt', '.srt', '.ass'];
const PLAYER_CONFIG_PATTERNS = [
  /(?:file|src)\s*[:=]\s*["'](https?:\/\/[^"']+|\/[^"']+)["']/gi,
  /(?:sources|source)\s*[:=]\s*\[[^\]]*(https?:\/\/[^"']+|\/[^"']+)[^\]]*\]/gi,
  /(?:hls|dash|stream|video)\s*[:=]\s*["'](https?:\/\/[^"']+|\/[^"']+)["']/gi,
];

let browserPromise = null;

function createError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function logStep(scope, message, extra) {
  if (extra === undefined) {
    console.log(`${new Date().toISOString()} [${scope}] ${message}`);
    return;
  }

  console.log(`${new Date().toISOString()} [${scope}] ${message}`, extra);
}

function normalizeSubtitle(url, index) {
  return {
    lang: `track-${index + 1}`,
    url,
  };
}

function inferSubtitleLabel(url, fallback) {
  const match = url.match(/(?:lang|label|srclang)=([a-zA-Z-]+)/i) || url.match(/\.([a-z]{2,3})(?:\.|\?|$)/i);
  return match ? match[1].toLowerCase() : fallback;
}

function dedupeSubtitles(subtitles) {
  const seen = new Set();
  const normalized = [];

  for (const subtitle of subtitles) {
    if (!subtitle || !subtitle.url || seen.has(subtitle.url)) {
      continue;
    }

    seen.add(subtitle.url);
    normalized.push({
      lang: subtitle.lang || inferSubtitleLabel(subtitle.url, `track-${normalized.length + 1}`),
      url: subtitle.url,
    });
  }

  return normalized;
}

function pickBestStream(candidates) {
  const uniqueCandidates = [...new Set(candidates.filter(Boolean))];

  uniqueCandidates.sort((left, right) => {
    const scoreCandidate = (candidate) => {
      if (candidate.includes('.m3u8')) return 0;
      if (candidate.includes('.mpd')) return 1;
      if (candidate.includes('.mp4')) return 2;
      if (candidate.includes('.webm')) return 3;
      if (candidate.includes('.mkv')) return 4;
      return 5;
    };
    const leftScore = scoreCandidate(left);
    const rightScore = scoreCandidate(right);
    return leftScore - rightScore;
  });

  return uniqueCandidates[0] || null;
}

function collectPlayerConfigCandidates(input, baseUrl) {
  const html = String(input || '');
  const streamCandidates = [];

  for (const pattern of PLAYER_CONFIG_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(html);

    while (match) {
      const candidate = absoluteUrl(baseUrl, match[1]);
      if (candidate && isMediaUrl(candidate)) {
        streamCandidates.push(candidate);
      }
      match = pattern.exec(html);
    }
  }

  return streamCandidates;
}

function shouldTraceNetworkCandidate(source, candidate, resourceType) {
  if (source !== 'vidlink') {
    return false;
  }

  if (!candidate || candidate.startsWith('data:')) {
    return false;
  }

  if (isMediaUrl(candidate)) {
    return true;
  }

  if (resourceType && ['fetch', 'xhr', 'document', 'script'].includes(resourceType)) {
    return /(?:api|embed|source|stream|playlist|manifest|m3u8|videostr|vodvidl)/i.test(candidate);
  }

  return false;
}

function parseVidlinkDescriptor(targetUrl) {
  try {
    const parsedUrl = new URL(targetUrl);
    const segments = parsedUrl.pathname.split('/').filter(Boolean);
    const [type, tmdbId, season, episode] = segments;

    if (!tmdbId || !['movie', 'tv'].includes(type)) {
      return null;
    }

    if (type === 'tv' && (!season || !episode)) {
      return null;
    }

    return {
      origin: parsedUrl.origin,
      type,
      tmdbId,
      season: season || null,
      episode: episode || null,
    };
  } catch {
    return null;
  }
}

async function tryVidlinkBrowserApi(page, targetUrl) {
  const descriptor = parseVidlinkDescriptor(targetUrl);

  if (!descriptor) {
    return null;
  }

  try {
    await page.waitForFunction(() => typeof window.getAdv === 'function', { timeout: 4000 });

    const response = await page.evaluate(async ({ type, tmdbId, season, episode }) => {
      const rawToken = typeof window.getAdv === 'function' ? window.getAdv(String(tmdbId)) : null;

      if (!rawToken) {
        return null;
      }

      const tokenData = Array.isArray(rawToken) ? rawToken : [rawToken, null, false];
      const multiLang = tokenData[2] === true ? 1 : 0;
      const apiPaths = type === 'tv'
        ? [
          `/api/b/${type}/${tokenData[0]}/${season}/${episode}?multiLang=${multiLang}`,
          `/api/b/${type}/${tokenData[0]}?multiLang=${multiLang}`,
        ]
        : [`/api/b/${type}/${tokenData[0]}?multiLang=${multiLang}`];

      for (const apiPath of apiPaths) {
        const apiResponse = await fetch(apiPath, {
          headers: {
            Accept: 'application/json, text/plain, */*',
            'X-Requested-With': 'XMLHttpRequest',
          },
        });

        const payload = await apiResponse.text();

        if (apiResponse.ok) {
          return {
            apiPath,
            ok: true,
            status: apiResponse.status,
            payload,
          };
        }
      }

      return {
        apiPath: apiPaths[apiPaths.length - 1],
        ok: false,
        status: 404,
        payload: null,
      };
    }, descriptor);

    if (!response) {
      return null;
    }

    const endpoint = new URL(response.apiPath, descriptor.origin).toString();

    if (!response.ok) {
      logStep('vidlink', 'browser bootstrap API failed', {
        endpoint,
        status: response.status,
      });
      return null;
    }

    const result = scanPayloadForMedia(response.payload, endpoint);

    if (!result) {
      return null;
    }

    logStep('vidlink', 'provider API returned media', { endpoint, via: 'browser-bootstrap' });
    return result;
  } catch (error) {
    logStep('vidlink', 'browser bootstrap API failed', {
      message: error.message,
    });
    return null;
  }
}

function buildCookieHeader(cookies = []) {
  return cookies
    .filter((cookie) => cookie && cookie.name)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function collectFrameUrls(page, currentUrl) {
  const discovered = new Set();

  for (const frame of page.frames()) {
    try {
      const frameUrl = frame.url();
      if (frameUrl && frameUrl !== currentUrl && !frameUrl.startsWith('about:')) {
        discovered.add(frameUrl);
      }
    } catch {
      continue;
    }
  }

  return [...discovered];
}

function collectDomCandidates(html, baseUrl) {
  const $ = cheerio.load(html);
  const streamCandidates = collectPlayerConfigCandidates(html, baseUrl);
  const subtitleCandidates = [];
  const iframeCandidates = [];

  $('video source, source').each((_, element) => {
    const src = $(element).attr('src');
    if (src) {
      streamCandidates.push(absoluteUrl(baseUrl, src));
    }
  });

  $('track').each((_, element) => {
    const src = $(element).attr('src');
    if (!src) {
      return;
    }

    subtitleCandidates.push({
      lang: ($(element).attr('srclang') || $(element).attr('label') || '').toLowerCase(),
      url: absoluteUrl(baseUrl, src),
    });
  });

  $('iframe').each((_, element) => {
    const src = $(element).attr('src');
    if (src) {
      iframeCandidates.push(absoluteUrl(baseUrl, src));
    }
  });

  const inlineUrls = extractUrls(html, baseUrl);

  for (const url of inlineUrls) {
    if (isMediaUrl(url)) {
      streamCandidates.push(url);
    }

    if (isSubtitleUrl(url)) {
      subtitleCandidates.push({
        lang: inferSubtitleLabel(url, ''),
        url,
      });
    }
  }

  return {
    stream: pickBestStream(streamCandidates.filter(isMediaUrl)),
    subtitles: dedupeSubtitles(subtitleCandidates),
    iframes: [...new Set(iframeCandidates.filter(Boolean))],
  };
}

function scanPayloadForMedia(payload, baseUrl) {
  const textPayload = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const urls = [...extractUrls(textPayload, baseUrl), ...collectPlayerConfigCandidates(textPayload, baseUrl)];
  const stream = pickBestStream(urls.filter(isMediaUrl));
  const subtitles = dedupeSubtitles(
    urls.filter(isSubtitleUrl).map((url, index) => ({
      lang: inferSubtitleLabel(url, `track-${index + 1}`),
      url,
    })),
  );

  if (!stream) {
    return null;
  }

  return { stream, subtitles };
}

async function extractDirectMedia(url, scope) {
  if (MEDIA_URL_REGEX.test(url)) {
    logStep(scope, 'input URL is already a direct media stream');
    return {
      stream: url,
      subtitles: [],
      iframes: [],
    };
  }

  const html = await fetchText(url, { headers: { Referer: url } });

  if (/sorry, you have been blocked|cloudflare ray id|access denied/i.test(html)) {
    throw createError(403, 'PROVIDER_BLOCKED', `Provider page is blocked by anti-bot protection for ${scope}`);
  }

  const domResult = collectDomCandidates(html, url);

  if (domResult.stream) {
    logStep(scope, 'direct media found in HTML');
    return {
      stream: domResult.stream,
      subtitles: domResult.subtitles,
      iframes: domResult.iframes,
    };
  }

  return {
    stream: null,
    subtitles: domResult.subtitles,
    iframes: domResult.iframes,
  };
}

async function tryApiRequest(requestConfig, scope) {
  try {
    const payload = requestConfig.expectJson
      ? await fetchJson(requestConfig.url, requestConfig)
      : await fetchText(requestConfig.url, requestConfig);
    const result = scanPayloadForMedia(payload, requestConfig.url);

    if (!result) {
      return null;
    }

    logStep(scope, 'provider API returned media', { endpoint: requestConfig.url });
    return result;
  } catch (error) {
    logStep(scope, 'provider API request failed', {
      endpoint: requestConfig.url,
      message: error.message,
    });
    return null;
  }
}

async function getBrowser() {
  if (!browserPromise) {
    const headless = process.env.PLAYWRIGHT_HEADLESS !== 'false';

    browserPromise = chromium.launch({
      headless,
      args: ['--disable-dev-shm-usage', '--disable-setuid-sandbox', '--no-sandbox'],
    });
  }

  return browserPromise;
}

async function browserFallback(url, source) {
  logStep(source, 'browser fallback started');

  const browser = await getBrowser();
  const browserUserAgent =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
  const context = await browser.newContext({
    userAgent: browserUserAgent,
  });
  const page = await context.newPage();
  const streamCandidates = new Set();
  const mediaRequestHeaders = new Map();
  const subtitles = [];
  const visitedUrls = new Set();
  const tracedNetworkUrls = new Set();
  let resolveStreamDetected;
  const streamDetected = new Promise((resolve) => {
    resolveStreamDetected = resolve;
  });

  const signalStreamDetected = () => {
    if (pickBestStream([...streamCandidates])) {
      resolveStreamDetected();
    }
  };

  const waitForStream = async (timeoutMs) => {
    if (pickBestStream([...streamCandidates])) {
      return;
    }

    await Promise.race([
      streamDetected,
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  };

  const captureUrl = (candidate) => {
    if (!candidate) {
      return;
    }

    if (isMediaUrl(candidate)) {
      streamCandidates.add(candidate);
      signalStreamDetected();
    }

    if (isSubtitleUrl(candidate)) {
      subtitles.push({
        lang: inferSubtitleLabel(candidate, `track-${subtitles.length + 1}`),
        url: candidate,
      });
    }
  };

  const captureRequest = (request) => {
    const candidate = request.url();
    const resourceType = request.resourceType();

    if (shouldTraceNetworkCandidate(source, candidate, resourceType) && !tracedNetworkUrls.has(`request:${candidate}`)) {
      tracedNetworkUrls.add(`request:${candidate}`);
      logStep(source, 'browser network request', {
        resourceType,
        method: request.method(),
        url: candidate,
      });
    }

    if (!isMediaUrl(candidate)) {
      return;
    }

    mediaRequestHeaders.set(candidate, request.headers());
    streamCandidates.add(candidate);
    signalStreamDetected();
  };

  const captureResponse = async (response) => {
    const candidate = response.url();
    captureUrl(candidate);

    const request = response.request();
    const resourceType = request.resourceType();

    if (!shouldTraceNetworkCandidate(source, candidate, resourceType) || tracedNetworkUrls.has(`response:${candidate}`)) {
      return;
    }

    tracedNetworkUrls.add(`response:${candidate}`);

    const contentType = response.headers()['content-type'] || '';
    const details = {
      resourceType,
      status: response.status(),
      contentType,
      url: candidate,
    };

    if ((resourceType === 'fetch' || resourceType === 'xhr') && /json|javascript|text/i.test(contentType)) {
      try {
        const text = await response.text();
        const preview = text.replace(/\s+/g, ' ').slice(0, 220);
        if (preview) {
          details.preview = preview;
        }
      } catch {
        // Ignore preview failures for traced responses.
      }
    }

    logStep(source, 'browser network response', details);
  };

  page.on('request', captureRequest);
  page.on('response', (response) => {
    captureResponse(response).catch(() => {});
  });

  const attemptPlayback = async (targetPage) => {
    const selectors = [
      'button[aria-label*="Play"]',
      'button[title*="Play"]',
      'button',
      '[role="button"]',
      '.jw-icon-playback',
      '.vjs-big-play-button',
      '.plyr__control--overlaid',
      '[data-plyr="play"]',
      'video',
    ];

    for (const selector of selectors) {
      try {
        const element = targetPage.locator(selector).first();
        if (await element.count()) {
          await element.click({ timeout: 1500 });
        }
      } catch {
        continue;
      }
    }

    try {
      await targetPage.evaluate(() => {
        for (const media of document.querySelectorAll('video, audio')) {
          if (typeof media.play === 'function') {
            media.muted = true;
            media.play().catch(() => {});
          }
        }
      });
    } catch {
      return;
    }
  };

  const clickHotspots = async (targetPage) => {
    const points = [
      { x: 500, y: 400 },
      { x: 640, y: 360 },
      { x: 320, y: 180 },
    ];

    for (const point of points) {
      try {
        await targetPage.mouse.click(point.x, point.y, { delay: 80 });
      } catch {
        continue;
      }
    }
  };

  const interactWithFrames = async () => {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) {
        continue;
      }

      try {
        await attemptPlayback(frame);
      } catch {
        continue;
      }
    }
  };

  const collectIframeUrls = async (baseUrl) => {
    try {
      return await page.$$eval(
        'iframe',
        (elements, currentBase) => elements
          .map((element) => element.getAttribute('src'))
          .filter(Boolean)
          .map((src) => {
            try {
              return new URL(src, currentBase).toString();
            } catch {
              return null;
            }
          })
          .filter(Boolean),
        baseUrl,
      );
    } catch {
      return [];
    }
  };

  const navigateRecursive = async (targetUrl, depth = 0) => {
    if (depth > 5 || visitedUrls.has(targetUrl)) {
      return;
    }

    visitedUrls.add(targetUrl);
    logStep(source, 'browser navigating', { depth, url: targetUrl });

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

    if (source === 'vidlink') {
      const vidlinkApiResult = await tryVidlinkBrowserApi(page, targetUrl);

      if (vidlinkApiResult?.stream) {
        streamCandidates.add(vidlinkApiResult.stream);
        for (const subtitle of vidlinkApiResult.subtitles || []) {
          subtitles.push(subtitle);
        }
        signalStreamDetected();
        return;
      }
    }

    await waitForStream(1500);
    await attemptPlayback(page);
    await waitForStream(1500);
    await clickHotspots(page);
    await interactWithFrames();
    await waitForStream(2500);

    if (pickBestStream([...streamCandidates])) {
      return;
    }

    const nextUrls = [
      ...(await collectIframeUrls(targetUrl)),
      ...collectFrameUrls(page, targetUrl),
    ].filter(Boolean);

    for (const nextUrl of [...new Set(nextUrls)]) {
      if (visitedUrls.has(nextUrl)) {
        continue;
      }

      logStep(source, 'browser following nested frame', { depth: depth + 1, url: nextUrl });
      await navigateRecursive(nextUrl, depth + 1);

      if (pickBestStream([...streamCandidates])) {
        return;
      }
    }
  };

  try {
    await navigateRecursive(url);
    await waitForStream(2000);

    const stream = pickBestStream([...streamCandidates]);

    if (!stream) {
      throw createError(504, 'BROWSER_NO_STREAM', 'Browser fallback did not detect a valid media stream');
    }

    const relevantCookies = await context.cookies([...visitedUrls, stream]);
    const cookieHeader = buildCookieHeader(relevantCookies);
    const capturedHeaders = mediaRequestHeaders.get(stream) || {};

    return {
      stream,
      subtitles: dedupeSubtitles(subtitles),
      headers: {
        Referer: capturedHeaders.referer || capturedHeaders.Referer,
        Origin: capturedHeaders.origin || capturedHeaders.Origin,
        Accept: capturedHeaders.accept || capturedHeaders.Accept,
        'Accept-Language': capturedHeaders['accept-language'] || capturedHeaders['Accept-Language'],
        'Sec-Fetch-Dest': capturedHeaders['sec-fetch-dest'] || capturedHeaders['Sec-Fetch-Dest'],
        'Sec-Fetch-Mode': capturedHeaders['sec-fetch-mode'] || capturedHeaders['Sec-Fetch-Mode'],
        'Sec-Fetch-Site': capturedHeaders['sec-fetch-site'] || capturedHeaders['Sec-Fetch-Site'],
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        'User-Agent': capturedHeaders['user-agent'] || capturedHeaders['User-Agent'] || browserUserAgent,
      },
    };
  } finally {
    await context.close();
  }
}

async function runProviderExtractor({ name, url, apiRequests }) {
  const directResult = await extractDirectMedia(url, name);

  if (directResult.stream) {
    return {
      stream: directResult.stream,
      subtitles: directResult.subtitles,
      source: name,
    };
  }

  const apiCandidates = typeof apiRequests === 'function' ? apiRequests(url) : [];

  if (apiCandidates.length > 0) {
    const apiResults = await Promise.all(apiCandidates.map((candidate) => tryApiRequest(candidate, name)));
    const firstApiResult = apiResults.find(Boolean);

    if (firstApiResult) {
      return {
        stream: firstApiResult.stream,
        subtitles: dedupeSubtitles([...directResult.subtitles, ...firstApiResult.subtitles]),
        source: name,
      };
    }
  }

  const browserResult = await browserFallback(url, name);

  return {
    stream: browserResult.stream,
    subtitles: dedupeSubtitles([...directResult.subtitles, ...browserResult.subtitles]),
    headers: browserResult.headers,
    source: name,
  };
}

function ensureResolved(result, fallbackSource) {
  if (!result || !result.stream) {
    throw createError(404, 'STREAM_NOT_FOUND', 'Unable to extract a playable stream from the provided URL');
  }

  return {
    stream: result.stream,
    headers: result.headers || {},
    subtitles: dedupeSubtitles(result.subtitles || []),
    source: result.source || fallbackSource,
  };
}

process.on('exit', async () => {
  if (!browserPromise) {
    return;
  }

  try {
    const browser = await browserPromise;
    await browser.close();
  } catch {
    return;
  }
});

module.exports = {
  STREAM_EXTENSIONS,
  SUBTITLE_EXTENSIONS,
  browserFallback,
  collectDomCandidates,
  createError,
  ensureResolved,
  extractDirectMedia,
  logStep,
  normalizeSubtitle,
  runProviderExtractor,
  scanPayloadForMedia,
};
