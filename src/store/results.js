const results = new Map();
const listeners = new Map();

function getJobResults(jobId) {
  if (!results.has(jobId)) {
    results.set(jobId, []);
  }
  return results.get(jobId);
}

export function appendResult(jobId, data) {
  getJobResults(jobId).push(data);
  for (const listener of listeners.get(jobId) || []) {
    listener(data);
  }
}

export function getResults(jobId) {
  return [...getJobResults(jobId)];
}

export function addListener(jobId, fn) {
  if (!listeners.has(jobId)) {
    listeners.set(jobId, []);
  }
  listeners.get(jobId).push(fn);
}

export function removeListener(jobId, fn) {
  const current = listeners.get(jobId) || [];
  listeners.set(jobId, current.filter((listener) => listener !== fn));
}

export function createCacheStore() {
  const cache = new Map();
  return {
    get(key) {
      const entry = cache.get(key);
      if (!entry || entry.expiresAt < Date.now()) {
        cache.delete(key);
        return null;
      }
      return entry.value;
    },
    set(key, value, ttlMs) {
      cache.set(key, {
        value,
        expiresAt: Date.now() + ttlMs
      });
    }
  };
}
