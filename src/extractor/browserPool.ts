import { chromium, type Browser } from 'playwright';
import type { BrowserLease } from '../types';
import { logger } from '../utils/logger';
import { optimizePage } from './networkDetector';

const MIN_POOL_SIZE = 3;
const MAX_POOL_SIZE = 5;
const DEFAULT_POOL_SIZE = Math.min(
  MAX_POOL_SIZE,
  Math.max(MIN_POOL_SIZE, Number(process.env.BROWSER_POOL_SIZE || 3)),
);

const USER_AGENT =
  process.env.BROWSER_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

class BrowserPool {
  private browserPromise: Promise<Browser> | null = null;
  private activeWorkers = 0;
  private readonly waitQueue: Array<() => void> = [];

  async init(): Promise<void> {
    await this.getBrowser();
    logger.info('browser pool initialized', { size: DEFAULT_POOL_SIZE });
  }

  async acquire(): Promise<BrowserLease> {
    await this.waitForSlot();
    const browser = await this.getBrowser();
    this.activeWorkers += 1;

    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      locale: 'en-US',
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 768 },
    });
    const page = await context.newPage();
    await optimizePage(page);

    return {
      page,
      context,
      release: async () => {
        await context.close().catch(() => undefined);
        this.activeWorkers = Math.max(0, this.activeWorkers - 1);
        const next = this.waitQueue.shift();
        if (next) {
          next();
        }
      },
    };
  }

  async shutdown(): Promise<void> {
    if (!this.browserPromise) {
      return;
    }

    const browser = await this.browserPromise;
    await browser.close().catch(() => undefined);
    this.browserPromise = null;
  }

  private async waitForSlot(): Promise<void> {
    if (this.activeWorkers < DEFAULT_POOL_SIZE) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = chromium.launch({
        headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
        channel: 'chromium',
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--disable-setuid-sandbox',
          '--no-sandbox',
        ],
      });
    }

    return this.browserPromise;
  }
}

export const browserPool = new BrowserPool();
