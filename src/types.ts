import type { BrowserContext, Page } from 'playwright';

export type StreamType = 'hls' | 'mp4' | 'webm' | 'mkv' | 'mov' | 'video';

export interface ResolveRequestBody {
  url: string;
}

export interface ResolveResponse {
  stream: string;
  type: StreamType;
  headers: Record<string, string>;
  cached?: boolean;
}

export interface DetectorHit {
  stream: string;
  type: StreamType;
  headers: Record<string, string>;
  status?: number;
  contentType?: string;
  via: 'request' | 'response' | 'payload';
}

export interface CacheStore {
  get(key: string): Promise<ResolveResponse | null>;
  set(key: string, value: ResolveResponse, ttlSeconds?: number): Promise<void>;
  disconnect(): Promise<void>;
}

export interface BrowserLease {
  page: Page;
  context: BrowserContext;
  release(): Promise<void>;
}
