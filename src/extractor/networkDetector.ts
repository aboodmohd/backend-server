import type { Page, Request, Response } from 'playwright';
import type { DetectorHit, StreamType } from '../types';
import { logger } from '../utils/logger';

const VIDEO_URL_REGEX = /\.(m3u8|mp4|webm|mkv|mov)(?:$|[?#])/i;
const URL_IN_PAYLOAD_REGEX = /https?:\/\/[^"'\s<>()]+/gi;
const ANALYTICS_PATTERNS = [
  'google-analytics.com',
  'googletagmanager.com',
  'doubleclick.net',
  'umami.',
  '/cdn-cgi/rum',
];

function detectType(url: string, contentType = ''): StreamType | null {
  const normalizedUrl = url.toLowerCase();
  const normalizedType = contentType.toLowerCase();

  if (
    normalizedUrl.includes('.m3u8') ||
    normalizedType.includes('application/vnd.apple.mpegurl') ||
    normalizedType.includes('application/x-mpegurl')
  ) {
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

function createHit(
  url: string,
  requestHeaders: Record<string, string>,
  contentType: string,
  status: number | undefined,
  via: DetectorHit['via'],
): DetectorHit | null {
  const type = detectType(url, contentType);
  if (!type) {
    return null;
  }

  return {
    stream: url,
    type,
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

function extractPayloadHit(payload: string, requestHeaders: Record<string, string>): DetectorHit | null {
  const matches = payload.match(URL_IN_PAYLOAD_REGEX) || [];
  for (const match of matches) {
    const cleaned = match.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    const hit = createHit(cleaned, requestHeaders, '', undefined, 'payload');
    if (hit) {
      return hit;
    }
  }

  try {
    const parsed = JSON.parse(payload) as { stream?: { playlist?: string; url?: string; type?: string } };
    const candidate = parsed?.stream?.playlist || parsed?.stream?.url;
    if (!candidate) {
      return null;
    }

    const contentType = parsed?.stream?.type === 'hls' ? 'application/vnd.apple.mpegurl' : '';
    return createHit(candidate, requestHeaders, contentType, undefined, 'payload');
  } catch {
    return null;
  }
}

export async function optimizePage(page: Page): Promise<void> {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    const resourceType = request.resourceType();

    if (
      ['image', 'font', 'stylesheet'].includes(resourceType) ||
      ANALYTICS_PATTERNS.some((pattern) => url.includes(pattern))
    ) {
      await route.abort().catch(() => undefined);
      return;
    }

    await route.continue().catch(() => undefined);
  });
}

export function attachNetworkDetector(page: Page, onDetected: (hit: DetectorHit) => void): () => void {
  const seen = new Set<string>();

  const emit = (hit: DetectorHit): void => {
    if (seen.has(hit.stream)) {
      return;
    }
    seen.add(hit.stream);
    logger.info('detected stream candidate', {
      url: hit.stream,
      type: hit.type,
      via: hit.via,
      status: hit.status,
      contentType: hit.contentType,
    });
    onDetected(hit);
  };

  const handleRequest = (request: Request): void => {
    const hit = createHit(request.url(), request.headers(), '', undefined, 'request');
    if (hit) {
      logger.info('network request', { url: request.url(), resourceType: request.resourceType() });
      emit(hit);
    }
  };

  const handleResponse = async (response: Response): Promise<void> => {
    const contentType = response.headers()['content-type'] || '';
    const hit = createHit(response.url(), response.request().headers(), contentType, response.status(), 'response');
    if (hit) {
      logger.info('network response', {
        url: response.url(),
        status: response.status(),
        contentType,
        resourceType: response.request().resourceType(),
      });
      emit(hit);
      return;
    }

    if (!/json|javascript|text/i.test(contentType)) {
      return;
    }

    try {
      const text = await response.text();
      const payloadHit = extractPayloadHit(text, response.request().headers());
      if (payloadHit) {
        logger.info('payload stream candidate', { sourceUrl: response.url(), stream: payloadHit.stream });
        emit(payloadHit);
      }
    } catch {
      logger.warn('response body inspection failed', { url: response.url() });
    }
  };

  const responseListener = (response: Response): void => {
    void handleResponse(response);
  };

  page.on('request', handleRequest);
  page.on('response', responseListener);

  return () => {
    page.off('request', handleRequest);
    page.off('response', responseListener);
  };
}

export function isVideoCandidate(url: string): boolean {
  return VIDEO_URL_REGEX.test(url);
}
