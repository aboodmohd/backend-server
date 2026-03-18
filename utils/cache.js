const NodeCache = require('node-cache');

const DEFAULT_TTL = Number(process.env.CACHE_TTL_SECONDS) || 12 * 60 * 60;
const cache = new NodeCache({
  stdTTL: DEFAULT_TTL,
  checkperiod: 120,
  useClones: false,
});

function createCacheKey(url, quality = 'auto') {
  return `${quality}:${url}`;
}

function getCache(key) {
  const value = cache.get(key);
  console.log(`${new Date().toISOString()} [cache] ${value ? 'hit' : 'miss'} ${key}`);
  return value;
}

function setCache(key, value, ttl = DEFAULT_TTL) {
  console.log(`${new Date().toISOString()} [cache] set ${key} ttl=${ttl}`);
  cache.set(key, value, ttl);
}

function resolveCacheTtl(quality = 'auto') {
  if (quality === 'auto') {
    return DEFAULT_TTL;
  }

  return Math.max(6 * 60 * 60, Math.min(24 * 60 * 60, DEFAULT_TTL));
}

module.exports = {
  createCacheKey,
  getCache,
  resolveCacheTtl,
  setCache,
};
