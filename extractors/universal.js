const { createCacheKey, getCache, resolveCacheTtl, setCache } = require('../utils/cache');
const { absoluteUrl, getHostname } = require('../utils/request');
const filemoon = require('./filemoon');
const { browserFallback, createError, ensureResolved, extractDirectMedia, logStep } = require('./shared');
const vidfast = require('./vidfast');
const videasy = require('./videasy');
const vidlink = require('./vidlink');
const vidnest = require('./vidnest');

const PROVIDERS = {
  vidfast,
  videasy,
  vidlink,
  vidnest,
  filemoon,
  mixdrop: async (url) => {
    const mixdrop = require('./videasy');
    return mixdrop(url, 'mixdrop');
  },
};

function detectProvider(inputUrl) {
  const hostname = getHostname(inputUrl);
  return Object.keys(PROVIDERS).find((provider) => hostname.includes(provider)) || null;
}

async function inspectIframe(iframeUrl, depth = 0) {
  const provider = detectProvider(iframeUrl);

  if (provider) {
    logStep('universal', 'dispatching iframe to provider', { provider, iframeUrl });
    return PROVIDERS[provider](iframeUrl);
  }

  if (depth >= 1) {
    throw createError(404, 'PROVIDER_NOT_SUPPORTED', `Unsupported iframe provider: ${getHostname(iframeUrl)}`);
  }

  const directResult = await extractDirectMedia(iframeUrl, 'universal');

  if (directResult.stream) {
    return {
      stream: directResult.stream,
      subtitles: directResult.subtitles,
      source: getHostname(iframeUrl),
    };
  }

  if (!directResult.iframes.length) {
    throw createError(404, 'NO_IFRAME_STREAM', `No stream found in nested iframe: ${iframeUrl}`);
  }

  return resolveIframes(iframeUrl, directResult.iframes, depth + 1);
}

async function resolveIframes(baseUrl, iframes, depth = 0) {
  const iframeTasks = iframes
    .map((iframeUrl) => absoluteUrl(baseUrl, iframeUrl))
    .filter(Boolean)
    .map((iframeUrl) =>
      inspectIframe(iframeUrl, depth).then((result) => {
        if (!result || !result.stream) {
          throw createError(404, 'IFRAME_RESOLVE_FAILED', `No stream found for iframe: ${iframeUrl}`);
        }

        return result;
      }),
    );

  if (!iframeTasks.length) {
    return null;
  }

  try {
    return await Promise.any(iframeTasks);
  } catch {
    return null;
  }
}

async function resolve(url, options = {}) {
  const cacheKey = createCacheKey(url, options.quality);
  const cached = getCache(cacheKey);

  if (cached) {
    return { ...cached, cached: true };
  }

  const provider = detectProvider(url);

  if (provider) {
    const providerResult = ensureResolved(await PROVIDERS[provider](url), provider);
    setCache(cacheKey, providerResult, resolveCacheTtl(options.quality));
    return providerResult;
  }

  const directResult = await extractDirectMedia(url, 'universal');

  if (directResult.stream) {
    const result = ensureResolved(
      {
        stream: directResult.stream,
        subtitles: directResult.subtitles,
        source: getHostname(url),
      },
      getHostname(url),
    );
    setCache(cacheKey, result, resolveCacheTtl(options.quality));
    return result;
  }

  if (directResult.iframes.length > 0) {
    const iframeResult = await resolveIframes(url, directResult.iframes);

    if (iframeResult) {
      const result = ensureResolved(
        {
          ...iframeResult,
          subtitles: [...directResult.subtitles, ...(iframeResult.subtitles || [])],
        },
        iframeResult.source,
      );
      setCache(cacheKey, result, resolveCacheTtl(options.quality));
      return result;
    }
  }

  logStep('universal', 'falling back to browser extraction');
  const browserResult = await browserFallback(url, 'universal');
  const finalResult = ensureResolved(
    {
      stream: browserResult.stream,
      headers: browserResult.headers,
      subtitles: browserResult.subtitles,
      source: getHostname(url),
    },
    getHostname(url),
  );

  if (!finalResult.stream) {
    throw createError(404, 'STREAM_NOT_FOUND', 'No playable stream was detected');
  }

  setCache(cacheKey, finalResult, resolveCacheTtl(options.quality));
  return finalResult;
}

module.exports = { resolve };
