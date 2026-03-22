const { runProviderExtractor } = require('./shared');

function buildApiRequests(url) {
  const parsedUrl = new URL(url);
  const id = parsedUrl.pathname.split('/').filter(Boolean).pop();
  const origin = parsedUrl.origin;

  return [
    `${origin}/api/source/${id}`,
    `${origin}/api/pass_md5/${id}`,
    `${origin}/api/stream/${id}`,
    `${origin}/api/file/${id}`,
  ].map((endpoint) => ({
    url: endpoint,
    expectJson: false,
    headers: {
      Referer: url,
      Origin: origin,
    },
    timeout: 5000,
  }));
}

module.exports = async function filemoon(url) {
  return runProviderExtractor({
    name: 'filemoon',
    url,
    apiRequests: buildApiRequests,
  });
};