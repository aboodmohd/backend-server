const { runProviderExtractor } = require('./shared');

function buildApiRequests(url) {
  const parsedUrl = new URL(url);
  const id = parsedUrl.pathname.split('/').filter(Boolean).pop();
  const origin = parsedUrl.origin;

  return [
    `${origin}/api/source/${id}`,
    `${origin}/api/player/${id}`,
    `${origin}/api/video/${id}`,
    `${origin}/api/media/${id}`,
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

module.exports = async function vidnest(url) {
  return runProviderExtractor({
    name: 'vidnest',
    url,
    apiRequests: buildApiRequests,
  });
};
