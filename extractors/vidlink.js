const { createError, runProviderExtractor } = require('./shared');

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

  function buildApiRequests() {
    const origin = descriptor.origin;
    const searchParams = new URLSearchParams({
      type: descriptor.type,
      tmdbId: descriptor.tmdbId || '',
    });

    if (descriptor.season) {
      searchParams.set('season', descriptor.season);
    }

    if (descriptor.episode) {
      searchParams.set('episode', descriptor.episode);
    }

    const candidateUrls = [
      `${origin}/api/source/${descriptor.pathSuffix}`,
      `${origin}/api/source/${descriptor.tmdbId}`,
      `${origin}/api/stream/${descriptor.pathSuffix}`,
      `${origin}/api/stream/${descriptor.tmdbId}`,
      `${origin}/api/video/${descriptor.pathSuffix}`,
      `${origin}/api/video/${descriptor.tmdbId}`,
      `${origin}/api/embed/${descriptor.pathSuffix}`,
      `${origin}/api/embed/${descriptor.tmdbId}`,
      `${origin}/api/source?${searchParams.toString()}`,
      `${origin}/api/stream?${searchParams.toString()}`,
      `${origin}/api/video?${searchParams.toString()}`,
    ].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);

    return candidateUrls.map((endpoint) => ({
      url: endpoint,
      expectJson: true,
      headers: {
        Referer: url,
        Origin: origin,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/plain, */*',
      },
      timeout: 5000,
    }));
  }

  return runProviderExtractor({
    name: 'vidlink',
    url,
    apiRequests: buildApiRequests,
  });
};
