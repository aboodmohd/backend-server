import type { Cookie, Page } from 'playwright';
import { createCacheKey, redisCache } from '../cache/redisCache';
import type { DetectorHit, ResolvedStream } from '../types';
import { logger } from '../utils/logger';
import { browserPool } from './browserPool';
import { attachNetworkDetector } from './networkDetector';

const EXTRACTION_TIMEOUT_MS = Number(process.env.EXTRACTION_TIMEOUT_MS || 8000);
const CLICK_SELECTORS = ['button', '.play', '.vjs-play-control', '[data-play]'];

function withCookies(headers: Record<string, string>, cookies: Cookie[]): Record<string, string> {
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  if (!cookieHeader) {
    return headers;
  }

  return {
    ...headers,
    Cookie: cookieHeader,
  };
}

async function triggerPlayback(page: Page): Promise<void> {
  await page.waitForTimeout(1000);

  for (const frame of page.frames()) {
    for (const selector of CLICK_SELECTORS) {
      try {
        const locator = frame.locator(selector).first();
        if (await locator.count()) {
          await locator.click({ timeout: 400 }).catch(() => undefined);
        }
      } catch {
        continue;
      }
    }

    await frame.evaluate(() => {
      const media = document.querySelector('video, audio') as HTMLMediaElement | null;
      if (media && typeof media.play === 'function') {
        media.muted = true;
        void media.play().catch(() => undefined);
      }
    }).catch(() => undefined);
  }
}

export async function resolveStream(url: string): Promise<ResolvedStream> {
  const cacheKey = createCacheKey(url);
  const cached = await redisCache.get(cacheKey);
  if (cached) {
    logger.info('cache hit', { key: cacheKey });
    return { ...cached, cached: true };
  }

  logger.info('cache miss', { key: cacheKey });

  const lease = await browserPool.acquire();
  let resolved = false;
  let timeoutId: NodeJS.Timeout | undefined;
  let stopDetector: (() => void) | undefined;

  try {
    logger.info('page navigation', { url });

    const detected = new Promise<ResolvedStream>((resolve) => {
      timeoutId = setTimeout(() => {
        if (resolved) {
          return;
        }

        resolved = true;
        stopDetector?.();
        resolve({
          stream: '',
          type: 'video',
          headers: {},
        });
      }, EXTRACTION_TIMEOUT_MS);

      stopDetector = attachNetworkDetector(lease.page, async (hit: DetectorHit) => {
        if (resolved) {
          return;
        }

        resolved = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        stopDetector?.();

        const cookies = await lease.context.cookies().catch(() => []);
        const payload: ResolvedStream = {
          stream: hit.stream,
          type: hit.type,
          headers: withCookies(hit.headers, cookies),
        };

        logger.info('stream detected', {
          url: hit.stream,
          type: hit.type,
          via: hit.via,
          status: hit.status,
          contentType: hit.contentType,
        });

        await lease.page.close().catch(() => undefined);
        resolve(payload);
      });
    });

    await lease.page.goto(url, { waitUntil: 'domcontentloaded', timeout: EXTRACTION_TIMEOUT_MS });
    await triggerPlayback(lease.page);

    const result = await detected;
    if (!result.stream) {
      throw new Error('STREAM_NOT_FOUND');
    }

    await redisCache.set(cacheKey, result);
    logger.info('cache set', { key: cacheKey });
    return result;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    stopDetector?.();
    await lease.release();
  }
}
