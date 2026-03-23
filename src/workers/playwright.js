import { chromium } from 'playwright';
import { setupInterceptors } from '../interceptors/interceptSetup.js';

let browserPromise;

function getBrowser(options = {}) {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      channel: 'chromium',
      headless: options.headless ?? true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
  }

  return browserPromise;
}

function isExpectedCloseError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('target page, context or browser has been closed');
}

function shouldTrackActivity(url, resourceType) {
  if (!['document', 'fetch', 'xhr', 'media'].includes(resourceType)) {
    return false;
  }

  return ![
    'google-analytics.com',
    'googletagmanager.com',
    'doubleclick.net',
    'umami.',
    '/cdn-cgi/rum',
    'mc.yandex.ru',
    'f.clarity.ms'
  ].some((pattern) => url.includes(pattern));
}

function isVidfastUrl(url) {
  return String(url || '').includes('vidfast.pro');
}

async function clickFirstVisible(frame, selectors) {
  for (const selector of selectors) {
    try {
      const locator = frame.locator(selector).first();
      if (await locator.isVisible({ timeout: 400 }).catch(() => false)) {
        await locator.click({ timeout: 500 }).catch(() => undefined);
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

async function pokePlayers(page, targetUrl) {
  const isVidfast = isVidfastUrl(targetUrl);
  const selectors = [
    'button',
    '.play',
    '.vjs-play-control',
    '[data-play]',
    '[class*="play"]',
    '[aria-label*="play" i]',
    'video',
    'iframe'
  ];

  for (const frame of page.frames()) {
    await clickFirstVisible(frame, selectors);

    await frame.evaluate((shouldBeAggressive) => {
      const video = document.querySelector('video');
      if (video && typeof video.play === 'function') {
        video.muted = true;
        void video.play().catch(() => undefined);
      }

      if (!shouldBeAggressive) {
        return;
      }

      const centerX = Math.floor(window.innerWidth / 2);
      const centerY = Math.floor(window.innerHeight / 2);
      const target = document.elementFromPoint(centerX, centerY) || document.body;

      ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((eventName) => {
        target?.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: centerX,
          clientY: centerY
        }));
      });
    }, isVidfast).catch(() => undefined);
  }

  if (isVidfast) {
    await page.keyboard.press('Space').catch(() => undefined);
    await page.keyboard.press('Enter').catch(() => undefined);
  }
}

export async function extractVideoUrls(targetUrl, onFound, options = {}) {
  console.log(new Date().toISOString(), '[extractor] starting', targetUrl);
  const browser = await getBrowser(options);

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 }
  });

  const page = await context.newPage();
  let firstResultResolved = false;
  let lastRelevantActivityAt = Date.now();

  const stopIfResolved = () => firstResultResolved || page.isClosed();

  const safeWait = async (ms) => {
    if (stopIfResolved()) {
      return;
    }

    try {
      await page.waitForTimeout(ms);
    } catch (error) {
      if (!isExpectedCloseError(error)) {
        throw error;
      }
    }
  };

  const markActivity = (url, resourceType) => {
    if (shouldTrackActivity(url, resourceType)) {
      lastRelevantActivityAt = Date.now();
    }
  };

  const waitForNetworkSettle = async (quietWindowMs, maxWaitMs, minWaitMs = 0) => {
    const startedAt = Date.now();

    while (!stopIfResolved()) {
      const quietForMs = Date.now() - lastRelevantActivityAt;
      const elapsedMs = Date.now() - startedAt;

      if ((elapsedMs >= minWaitMs && quietForMs >= quietWindowMs) || elapsedMs >= maxWaitMs) {
        return;
      }

      await safeWait(Math.min(250, quietWindowMs));
    }
  };

  page.on('request', (request) => {
    markActivity(request.url(), request.resourceType());
  });

  page.on('response', (response) => {
    markActivity(response.url(), response.request().resourceType());
  });

  await setupInterceptors(page, async (result) => {
    onFound(result);

    if (!firstResultResolved) {
      firstResultResolved = true;
      await page.close().catch(() => undefined);
    }
  });

  try {
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: options.navigationTimeout ?? 30000
    });

    console.log(new Date().toISOString(), '[extractor] page loaded', targetUrl);

    await safeWait(250);

    if (stopIfResolved()) {
      return;
    }

    await pokePlayers(page, targetUrl);
    await safeWait(isVidfastUrl(targetUrl) ? 1500 : 750);

    if (stopIfResolved()) {
      return;
    }

    await page.evaluate(() => window.scrollBy(0, 500)).catch(() => undefined);
    await waitForNetworkSettle(
      options.settleTimeout ?? (isVidfastUrl(targetUrl) ? 3000 : 2000),
      options.maxWaitAfterLoad ?? (isVidfastUrl(targetUrl) ? 14000 : 10000),
      options.minWaitAfterLoad ?? (isVidfastUrl(targetUrl) ? 7000 : 5000)
    );
  } catch (error) {
    if (isExpectedCloseError(error)) {
      return;
    }

    console.log(new Date().toISOString(), '[extractor] navigation error', error?.message || String(error));
    if (!String(error?.message || '').toLowerCase().includes('timeout')) {
      throw error;
    }
  } finally {
    console.log(new Date().toISOString(), '[extractor] closing', targetUrl);
    await context.close().catch(() => undefined);
  }
}

export async function warmBrowser() {
  await getBrowser();
}
