import { createCacheStore } from '../src/store/results.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export function createMemoryCache(ttlMs = DEFAULT_TTL_MS, options = {}) {
  return createCacheStore({
    defaultTtlMs: ttlMs,
    persistPath: options.persistPath
  });
}
