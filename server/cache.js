const DEFAULT_TTL_MS = 10 * 60 * 1000;

export function createMemoryCache(ttlMs = DEFAULT_TTL_MS) {
  const store = new Map();

  function get(key) {
    const entry = store.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }

    return entry.value;
  }

  function set(key, value) {
    store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });

    return value;
  }

  return { get, set };
}
