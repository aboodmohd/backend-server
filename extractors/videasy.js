const { runProviderExtractor } = require('./shared');

function buildApiRequests(url) {
  const parsedUrl = new URL(url);
  const id = parsedUrl.pathname.split('/').filter(Boolean).pop();
  const origin = parsedUrl.origin;

  return [
    `${origin}/api/source/${id}`,
    `${origin}/api/embed/${id}`,
    `${origin}/api/stream/${id}`,
    `${origin}/api/video/${id}`,
  ].map((endpoint) => ({
    url: endpoint,
    expectJson: true,
    headers: {
      Referer: url,
      Origin: origin,
    },
    timeout: 5000,
  }));
}

module.exports = async function videasy(url, sourceName = 'videasy') {
  return runProviderExtractor({
    name: sourceName,
    url,
    apiRequests: buildApiRequests,
  });
};
