const { browserFallback, createError, extractDirectMedia } = require('./shared');

function parseVidfastPath(url) {
  const parsedUrl = new URL(url);
  const segments = parsedUrl.pathname.split('/').filter(Boolean);
  const [type, tmdbId, season, episode] = segments;

  if (type === 'movie' && tmdbId) {
    return {
      type,
      tmdbId,
    };
  }

  if (type === 'tv' && tmdbId && season && episode) {
    return {
      type,
      tmdbId,
      season,
      episode,
    };
  }

  return {
    type: type || 'unknown',
    tmdbId: tmdbId || null,
    season: season || null,
    episode: episode || null,
  };
}

module.exports = async function vidfast(url) {
  const descriptor = parseVidfastPath(url);

  if (descriptor.type === 'tv' && (!descriptor.tmdbId || !descriptor.season || !descriptor.episode)) {
    throw createError(400, 'INVALID_VIDFAST_TV_URL', 'Vidfast TV URLs must include tmdbId, season, and episode');
  }

  if (descriptor.type !== 'movie' && descriptor.type !== 'tv') {
    throw createError(400, 'INVALID_VIDFAST_URL', 'Vidfast URLs must use /movie/{id} or /tv/{id}/{season}/{episode}');
  }

  let directResult;

  try {
    directResult = await extractDirectMedia(url, 'vidfast');
  } catch (error) {
    if (error.code === 'PROVIDER_BLOCKED') {
      throw createError(503, 'VIDFAST_BLOCKED', 'Vidfast is currently blocked by Cloudflare from this server/IP');
    }

    throw error;
  }

  if (directResult.stream) {
    return {
      stream: directResult.stream,
      subtitles: directResult.subtitles,
      source: 'vidfast',
    };
  }

  let browserResult;

  try {
    browserResult = await browserFallback(url, 'vidfast');
  } catch (error) {
    if (error.code === 'BROWSER_NO_STREAM') {
      throw createError(504, 'VIDFAST_NO_STREAM', 'Vidfast did not expose a playable stream from this environment');
    }

    throw error;
  }

  return {
    stream: browserResult.stream,
    headers: browserResult.headers,
    subtitles: [...(directResult.subtitles || []), ...(browserResult.subtitles || [])],
    source: 'vidfast',
  };
};
