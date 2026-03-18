const { absoluteUrl, client } = require('./request');

function parseStreamInfAttributes(line) {
  const attributes = {};
  const raw = String(line || '').replace('#EXT-X-STREAM-INF:', '');

  for (const part of raw.split(',')) {
    const [key, ...rest] = part.split('=');
    if (!key || rest.length === 0) {
      continue;
    }

    attributes[key.trim()] = rest.join('=').replace(/^"|"$/g, '').trim();
  }

  return attributes;
}

function normalizeQualityLabel(height, bandwidth) {
  if (height) {
    return `${height}p`;
  }

  if (bandwidth) {
    return `${Math.round(Number(bandwidth) / 1000)} kbps`;
  }

  return 'Unknown';
}

function parseMasterPlaylist(manifestText, manifestUrl) {
  const lines = String(manifestText || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const qualities = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('#EXT-X-STREAM-INF:')) {
      continue;
    }

    const attrs = parseStreamInfAttributes(line);
    const resolution = attrs.RESOLUTION || '';
    const height = resolution.includes('x') ? Number(resolution.split('x')[1]) : null;
    const bandwidth = attrs.BANDWIDTH ? Number(attrs.BANDWIDTH) : null;
    const nextLine = lines[index + 1];

    if (!nextLine || nextLine.startsWith('#')) {
      continue;
    }

    qualities.push({
      label: normalizeQualityLabel(height, bandwidth),
      quality: normalizeQualityLabel(height, bandwidth),
      value: normalizeQualityLabel(height, bandwidth),
      height,
      bandwidth,
      url: absoluteUrl(manifestUrl, nextLine),
      isAuto: false,
    });
  }

  return qualities
    .filter((quality) => quality.url)
    .filter((quality, index, all) => all.findIndex((item) => item.url === quality.url) === index)
    .sort((left, right) => (right.height || 0) - (left.height || 0) || (right.bandwidth || 0) - (left.bandwidth || 0));
}

async function extractQualities(manifestUrl, headers = {}) {
  const response = await client.get(manifestUrl, {
    headers,
    responseType: 'text',
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    throw new Error(`Quality manifest request failed with status ${response.status}`);
  }

  return parseMasterPlaylist(response.data, manifestUrl);
}

module.exports = {
  extractQualities,
  parseMasterPlaylist,
};
