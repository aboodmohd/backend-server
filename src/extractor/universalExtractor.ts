import type { Cookie, Page } from 'playwright';
import { createCacheKey, redisCache } from '../cache/redisCache';
import type { DetectorHit, ResolveResponse } from '../types';
import { logger } from '../utils/logger';
import { browserPool } from './browserPool';
import { attachNetworkDetector, extractPayloadHit } from './networkDetector';

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

async function tryPlaybackInteractions(page: Page): Promise<void> {
  await page.waitForTimeout(1000);

  for (const frame of page.frames()) {
    for (const selector of CLICK_SELECTORS) {
      try {
        const locator = frame.locator(selector).first();
        if (await locator.count()) {
          await locator.click({ timeout: 500 }).catch(() => undefined);
        }
      } catch {
        continue;
      }
    }

    await frame
      .evaluate(() => {
        const media = document.querySelector('video, audio') as HTMLMediaElement | null;
        if (media && typeof media.play === 'function') {
          media.muted = true;
          void media.play().catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }
}

async function scanPageForEmbeddedStream(page: Page): Promise<DetectorHit | null> {
  try {
    const content = await page.content();
    const contentHit = extractPayloadHit(content, {});
    if (contentHit) {
      return contentHit;
    }
  } catch {
    logger.warn('page content inspection failed');
  }

  try {
    const scriptText = await page.evaluate(() => {
      return Array.from(document.scripts)
        .map((script) => script.textContent || '')
        .join('\n');
    });
    return extractPayloadHit(scriptText, {});
  } catch {
    logger.warn('script inspection failed');
    return null;
  }
}

export async function resolveStream(url: string): Promise<ResolveResponse> {
  const cacheKey = createCacheKey(url);
  const cached = await redisCache.get(cacheKey);
  if (cached) {
    logger.info('cache hit', { key: cacheKey });
    return { ...cached, cached: true };
  }

  logger.info('cache miss', { key: cacheKey });
  const lease = await browserPool.acquire();
  let settled = false;
  let timeoutId: NodeJS.Timeout | undefined;
  let detachDetector: (() => void) | undefined;

  try {
    logger.info('page navigation', { url });

    const detected = new Promise<ResolveResponse>((resolve) => {
      timeoutId = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        detachDetector?.();
        logger.warn('extraction timeout', { url, timeoutMs: EXTRACTION_TIMEOUT_MS });
        resolve({ stream: '', type: 'video', headers: {} });
      }, EXTRACTION_TIMEOUT_MS);

      detachDetector = attachNetworkDetector(lease.page, async (hit: DetectorHit) => {
        if (settled) {
          return;
        }

        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        detachDetector?.();

        const cookies = await lease.context.cookies().catch(() => []);
        const payload: ResolveResponse = {
          stream: hit.stream,
          type: hit.type,
          headers: withCookies(hit.headers, cookies),
        };

        logger.info('stream resolved', {
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
    await tryPlaybackInteractions(lease.page);

    if (!settled) {
      const embeddedHit = await scanPageForEmbeddedStream(lease.page);
      if (embeddedHit) {
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        detachDetector?.();

        const cookies = await lease.context.cookies().catch(() => []);
        const payload: ResolveResponse = {
          stream: embeddedHit.stream,
          type: embeddedHit.type,
          headers: withCookies(embeddedHit.headers, cookies),
        };

        logger.info('embedded stream resolved', {
          url: embeddedHit.stream,
          type: embeddedHit.type,
          via: embeddedHit.via,
        });

        await lease.page.close().catch(() => undefined);
        await redisCache.set(cacheKey, payload);
        logger.info('cache set', { key: cacheKey });
        return payload;
      }
    }

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
    detachDetector?.();
    await lease.release();
  }
}
