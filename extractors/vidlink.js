const { browserFallback, createError, extractDirectMedia } = require('./shared');

function parseVidlinkPath(url) {
  const parsedUrl = new URL(url);
  const segments = parsedUrl.pathname.split('/').filter(Boolean);
  const [type, tmdbId, season, episode] = segments;

  if (type === 'movie' && tmdbId) {
    return {
      origin: parsedUrl.origin,
      type,
      tmdbId,
      pathSuffix: tmdbId,
      searchParams: { tmdbId },
    };
  }

  if (type === 'tv' && tmdbId && season && episode) {
    return {
      origin: parsedUrl.origin,
      type,
      tmdbId,
      season,
      episode,
      pathSuffix: `${tmdbId}/${season}/${episode}`,
      searchParams: { tmdbId, season, episode },
    };
  }

  return {
    origin: parsedUrl.origin,
    type: type || 'unknown',
    tmdbId: tmdbId || null,
    season: season || null,
    episode: episode || null,
    pathSuffix: segments.join('/'),
    searchParams: { tmdbId, season, episode },
  };
}

module.exports = async function vidlink(url) {
  const descriptor = parseVidlinkPath(url);

  if (descriptor.type === 'tv' && (!descriptor.tmdbId || !descriptor.season || !descriptor.episode)) {
    throw createError(400, 'INVALID_VIDLINK_TV_URL', 'Vidlink TV URLs must include tmdbId, season, and episode');
  }

  const directResult = await extractDirectMedia(url, 'vidlink');

  if (directResult.stream) {
    return {
      stream: directResult.stream,
      subtitles: directResult.subtitles,
      source: 'vidlink',
    };
  }

  const browserResult = await browserFallback(url, 'vidlink');

  return {
    stream: browserResult.stream,
    headers: browserResult.headers,
    subtitles: [...(directResult.subtitles || []), ...(browserResult.subtitles || [])],
    source: 'vidlink',
  };
};
