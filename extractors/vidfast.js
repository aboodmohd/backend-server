const { runProviderExtractor } = require('./shared');

const cache = new Map();

function normalizeVidfastUrl(url) {
  try {
    const parsed = new URL(url);
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
