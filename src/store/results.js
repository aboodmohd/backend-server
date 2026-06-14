import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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

function loadPersistedEntries(persistPath) {
  if (!persistPath || !existsSync(persistPath)) {
    return [];
  }

  try {
    const payload = JSON.parse(readFileSync(persistPath, 'utf8'));
    return Array.isArray(payload?.entries) ? payload.entries : [];
  } catch (error) {
    console.warn(new Date().toISOString(), '[cache] failed to read persisted cache', persistPath, error?.message || String(error));
    return [];
  }
}

export function createCacheStore(options = {}) {
  const defaultTtlMs =
    typeof options === 'number'
      ? options
      : Number.isFinite(options?.defaultTtlMs)
        ? Number(options.defaultTtlMs)
        : Number.POSITIVE_INFINITY;
  const persistPath = typeof options === 'object' ? String(options?.persistPath || '').trim() : '';
  const cache = new Map();

  const flushToDisk = () => {
    if (!persistPath) {
      return;
    }

    const now = Date.now();
    const entries = [];

    for (const [key, entry] of cache.entries()) {
      if (!entry || entry.expiresAt <= now) {
        cache.delete(key);
        continue;
      }

      entries.push({
        key,
        value: entry.value,
        expiresAt: entry.expiresAt
      });
    }

    mkdirSync(dirname(persistPath), { recursive: true });
    const tempPath = `${persistPath}.tmp`;
    writeFileSync(tempPath, JSON.stringify({ version: 1, entries }, null, 2), 'utf8');
    renameSync(tempPath, persistPath);
  };

  const persistNow = () => {
    if (!persistPath) {
      return;
    }

    try {
      flushToDisk();
    } catch (error) {
      console.warn(new Date().toISOString(), '[cache] failed to persist cache', persistPath, error?.message || String(error));
    }
  };

  const now = Date.now();
  for (const entry of loadPersistedEntries(persistPath)) {
    if (!entry?.key || !Number.isFinite(entry?.expiresAt) || entry.expiresAt <= now) {
      continue;
    }

    cache.set(entry.key, {
      value: entry.value,
      expiresAt: entry.expiresAt
    });
  }

  return {
    get(key) {
      const entry = cache.get(key);
      if (!entry || entry.expiresAt < Date.now()) {
        cache.delete(key);
        if (entry) {
          persistNow();
        }
        return null;
      }
      return entry.value;
    },
    getEntry(key) {
      const entry = cache.get(key);
      if (!entry || entry.expiresAt < Date.now()) {
        cache.delete(key);
        return null;
      }
      return entry;
    },
    set(key, value, ttlMs = defaultTtlMs) {
      const expiresAt = Number.isFinite(ttlMs) ? Date.now() + Number(ttlMs) : Number.MAX_SAFE_INTEGER;

      cache.set(key, {
        value,
        expiresAt
      });

      persistNow();
      return value;
    },
    delete(key) {
      const deleted = cache.delete(key);
      if (deleted) {
        persistNow();
      }
      return deleted;
    }
  };
}
