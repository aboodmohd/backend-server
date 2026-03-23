export type StreamType = 'hls' | 'mp4' | 'webm' | 'mkv' | 'mov' | 'video';

export interface ResolveRequestBody {
  url: string;
}

export interface ResolvedStream {
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
  get(key: string): Promise<ResolvedStream | null>;
  set(key: string, value: ResolvedStream, ttlSeconds?: number): Promise<void>;
  disconnect(): Promise<void>;
}

export interface BrowserLease {
  page: import('playwright').Page;
  context: import('playwright').BrowserContext;
  release(): Promise<void>;
}
