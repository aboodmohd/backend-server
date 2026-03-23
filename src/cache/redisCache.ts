import Redis from 'ioredis';
import type { CacheStore, ResolvedStream } from '../types';
import { logger } from '../utils/logger';

const DEFAULT_TTL_SECONDS = Number(process.env.STREAM_CACHE_TTL_SECONDS || 3600);

type MemoryEntry = {
  value: ResolvedStream;
  expiresAt: number;
};

class RedisCache implements CacheStore {
  private readonly client: Redis | null;
  private readonly memory = new Map<string, MemoryEntry>();

  constructor() {
    const redisUrl = process.env.REDIS_URL;

    if (!redisUrl) {
      this.client = null;
      logger.warn('REDIS_URL is not configured, using in-memory cache fallback');
      return;
    }

    this.client = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });

    this.client.on('error', (error) => {
      logger.error('redis error', { message: error.message });
    });
  }

  async get(key: string): Promise<ResolvedStream | null> {
    if (!this.client) {
      const entry = this.memory.get(key);
      if (!entry || entry.expiresAt < Date.now()) {
        this.memory.delete(key);
        return null;
      }

      return entry.value;
    }

    await this.client.connect().catch(() => undefined);
    const raw = await this.client.get(key);
    return raw ? (JSON.parse(raw) as ResolvedStream) : null;
  }

  async set(key: string, value: ResolvedStream, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<void> {
    if (!this.client) {
      this.memory.set(key, {
        value,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
      return;
    }

    await this.client.connect().catch(() => undefined);
    await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async disconnect(): Promise<void> {
    if (!this.client || this.client.status === 'end') {
      return;
    }

    await this.client.quit().catch(() => undefined);
  }
}

export const redisCache = new RedisCache();
export const createCacheKey = (url: string): string => `stream:${url}`;
