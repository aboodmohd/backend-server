const { runProviderExtractor } = require('./shared');

const cache = new Map();

function normalizeVidfastUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith('/movie/') || parsed.pathname.startsWith('/tv/')) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      parsed.pathname = `/embed/${parts.slice(1).join('/')}`;
    }

    return parsed.toString();
  } catch {
    return url;
  }
}

module.exports = async function resolveVidfast(url) {
  const targetUrl = normalizeVidfastUrl(url);

  if (cache.has(targetUrl)) {
    return { ...cache.get(targetUrl), cached: true };
  }

  const result = await runProviderExtractor({
    name: 'vidfast',
    url: targetUrl,
  });

  cache.set(targetUrl, result);
  return result;
};
