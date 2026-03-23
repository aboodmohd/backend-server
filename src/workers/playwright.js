import { chromium } from 'playwright';
import { setupInterceptors } from '../interceptors/interceptSetup.js';

const BLOCKED_RESOURCE_PATTERN = '**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,css}';

export async function extractVideoUrls(targetUrl, onFound, options = {}) {
  const browser = await chromium.launch({
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

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 }
  });

  const page = await context.newPage();
  let firstResultResolved = false;

  await page.route(BLOCKED_RESOURCE_PATTERN, (route) => route.abort());
  await page.route('**/*google-analytics*', (route) => route.abort().catch(() => route.continue()));
  await page.route('**/*googletagmanager*', (route) => route.abort().catch(() => route.continue()));
  await page.route('**/*doubleclick*', (route) => route.abort().catch(() => route.continue()));
  await page.route('**/*umami*', (route) => route.abort().catch(() => route.continue()));
  await page.route('**/*cdn-cgi/rum*', (route) => route.abort().catch(() => route.continue()));

  await setupInterceptors(page, async (result) => {
    onFound(result);

    if (!firstResultResolved) {
      firstResultResolved = true;
      await page.close().catch(() => undefined);
    }
  });

  try {
    await page.goto(targetUrl, {
      waitUntil: 'networkidle',
      timeout: options.navigationTimeout ?? 30000
    });

    await page.waitForTimeout(1000);

    const playButton = page
      .locator('button, .play, .vjs-play-control, [data-play], [class*="play"], [aria-label*="play" i]')
      .first();

    if (await playButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await playButton.click().catch(() => undefined);
      await page.waitForTimeout(2000);
    }

    await page.evaluate(() => window.scrollBy(0, 500)).catch(() => undefined);
    await page.waitForTimeout(options.settleTimeout ?? 5000);
  } catch (error) {
    if (!String(error?.message || '').toLowerCase().includes('timeout')) {
      throw error;
    }
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}
