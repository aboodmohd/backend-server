import type { Page, Response, Request } from 'playwright';
import type { DetectorHit, StreamType } from '../types';
import { logger } from '../utils/logger';

const VIDEO_EXTENSION_REGEX = /\.(m3u8|mp4|webm|mkv|mov)(?:$|[?#])/i;
const ANALYTICS_PATTERNS = [
  'google-analytics.com',
  'googletagmanager.com',
  'doubleclick.net',
  'umami.',
  '/cdn-cgi/rum',
];

function detectStreamType(url: string, contentType = ''): StreamType | null {
  const normalizedUrl = url.toLowerCase();
  const normalizedType = contentType.toLowerCase();

  if (normalizedUrl.includes('.m3u8') || normalizedType.includes('application/vnd.apple.mpegurl') || normalizedType.includes('application/x-mpegurl')) {
    return 'hls';
  }
  if (normalizedUrl.includes('.mp4')) return 'mp4';
  if (normalizedUrl.includes('.webm')) return 'webm';
  if (normalizedUrl.includes('.mkv')) return 'mkv';
  if (normalizedUrl.includes('.mov')) return 'mov';
  if (normalizedType.startsWith('video/')) return 'video';

  return null;
}

function normalizeHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  return Object.entries(headers).reduce<Record<string, string>>((acc, [key, value]) => {
    if (value) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function buildHit(url: string, requestHeaders: Record<string, string>, contentType: string, status: number | undefined, via: DetectorHit['via']): DetectorHit | null {
  const streamType = detectStreamType(url, contentType);
  if (!streamType) {
    return null;
  }

  return {
    stream: url,
    type: streamType,
    headers: normalizeHeaders({
      Referer: requestHeaders.referer,
      Origin: requestHeaders.origin,
      Accept: requestHeaders.accept,
      'Accept-Language': requestHeaders['accept-language'],
      'User-Agent': requestHeaders['user-agent'],
      Cookie: requestHeaders.cookie,
    }),
    status,
    contentType,
    via,
  };
}

export async function optimizePage(page: Page): Promise<void> {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    const resourceType = request.resourceType();

    if (['image', 'font', 'stylesheet'].includes(resourceType) || ANALYTICS_PATTERNS.some((pattern) => url.includes(pattern))) {
      await route.abort().catch(() => undefined);
      return;
    }

    await route.continue().catch(() => undefined);
  });
}

export function attachNetworkDetector(page: Page, onDetected: (hit: DetectorHit) => void): () => void {
  const seen = new Set<string>();

  const handleRequest = (request: Request): void => {
    const hit = buildHit(request.url(), request.headers(), '', undefined, 'request');
    if (!hit || seen.has(hit.stream)) {
      return;
    }

    seen.add(hit.stream);
    logger.info('network request', { url: hit.stream, type: hit.type, via: hit.via, resourceType: request.resourceType() });
    onDetected(hit);
  };

  const handleResponse = async (response: Response): Promise<void> => {
    const hit = buildHit(response.url(), response.request().headers(), response.headers()['content-type'] || '', response.status(), 'response');
    if (!hit || seen.has(hit.stream)) {
      return;
    }

    seen.add(hit.stream);
    logger.info('network response', {
      url: hit.stream,
      type: hit.type,
      via: hit.via,
      status: hit.status,
      contentType: hit.contentType,
      resourceType: response.request().resourceType(),
    });
    onDetected(hit);
  };

  page.on('request', handleRequest);
  page.on('response', (response) => {
    void handleResponse(response);
  });

  return () => {
    page.off('request', handleRequest);
    page.off('response', handleResponse);
  };
}

export function isVideoCandidate(url: string): boolean {
  return VIDEO_EXTENSION_REGEX.test(url);
}
