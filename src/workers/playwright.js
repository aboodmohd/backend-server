import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { setupInterceptors } from '../interceptors/interceptSetup.js';
import { detectType, extractStreamFromPayload } from '../interceptors/index.js';

chromium.use(StealthPlugin());

let browserPromise;

const STREAM_URL_PATTERNS = [
  /\.m3u8(\?|$)/i,
  /\.mpd(\?|$)/i,
  /\.mp4(\?|$)/i,
  /\.webm(\?|$)/i,
  /\.mkv(\?|$)/i,
  /\.mov(\?|$)/i,
  /\/hls\//i,
  /\/dash\//i,
  /\/stream\//i,
  /manifest/i,
  /playlist\.m3u8/i,
  /master\.m3u8/i,
  /index\.m3u8/i,
  /video\.m3u8/i
];

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

function isLikelyStreamUrl(url) {
  const value = String(url || '');
  return STREAM_URL_PATTERNS.some((pattern) => pattern.test(value));
}

function pickStreamCandidate(candidates = []) {
  for (const candidate of candidates) {
    const value = String(candidate || '')
      .replace(/\\u0026/g, '&')
      .replace(/\\\//g, '/')
      .replace(/\\"/g, '"');

    if (isLikelyStreamUrl(value)) {
      return value;
    }
  }

  return null;
}

async function logVidfastPageState(page, targetUrl) {
  if (!isVidfastUrl(targetUrl)) {
    return;
  }

  try {
    const title = await page.title();
    const bodySnippet = await page.evaluate(() => document.body?.innerText?.slice(0, 300) || '');
    console.log(new Date().toISOString(), '[vidfast] page title', title);
    console.log(new Date().toISOString(), '[vidfast] page body', bodySnippet.replace(/\s+/g, ' ').trim());
  } catch (error) {
    console.log(new Date().toISOString(), '[vidfast] page state log failed', error?.message || String(error));
  }
}

async function patchVidfastVisibility(page, targetUrl) {
  if (!isVidfastUrl(targetUrl)) {
    return;
  }

  await page.evaluate(() => {
    try {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible'
      });
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => false
      });
    } catch {}

    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  }).catch(() => undefined);
}

async function warmVidfastSession(page, targetUrl) {
  if (!isVidfastUrl(targetUrl)) {
    return;
  }

  try {
    const warmupPage = await page.context().newPage();

    await warmupPage.goto('https://vidfast.pro', {
      waitUntil: 'domcontentloaded',
      timeout: 20000
    });
    console.log(new Date().toISOString(), '[vidfast] warmup visited homepage');
    await warmupPage.waitForTimeout(2000);
    await warmupPage.close().catch(() => undefined);
  } catch (error) {
    console.log(new Date().toISOString(), '[vidfast] warmup failed', error?.message || String(error));
  }
}

function getExpectedVidfastPath(targetUrl) {
  try {
    return new URL(targetUrl).pathname;
  } catch {
    return '';
  }
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

async function installVidfastHooks(page, targetUrl) {
  if (!isVidfastUrl(targetUrl)) {
    return;
  }

  await page.addInitScript(() => {
    const store = {
      payloads: [],
      mediaUrls: []
    };

    const pushPayload = (entry) => {
      try {
        if (!entry || !entry.body) {
          return;
        }

        store.payloads.push({
          url: String(entry.url || ''),
          body: String(entry.body || '').slice(0, 200000)
        });
      } catch {}
    };

    const pushMediaUrl = (value, source = 'unknown') => {
      try {
        const url = String(value || '').trim();
        if (!url) {
          return;
        }

        store.mediaUrls.push({
          url: url.slice(0, 200000),
          source,
          at: Date.now()
        });
      } catch {}
    };

    Object.defineProperty(window, '__VIDFAST_CAPTURE__', {
      value: store,
      configurable: true
    });

    window.open = () => null;

    const mediaSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (mediaSrcDescriptor?.set) {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        configurable: true,
        enumerable: mediaSrcDescriptor.enumerable ?? true,
        get() {
          return mediaSrcDescriptor.get?.call(this);
        },
        set(value) {
          pushMediaUrl(value, 'media-src');
          return mediaSrcDescriptor.set.call(this, value);
        }
      });
    }

    const originalSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
      if (this instanceof HTMLMediaElement && String(name || '').toLowerCase() === 'src') {
        pushMediaUrl(value, 'set-attribute');
      }

      return originalSetAttribute.call(this, name, value);
    };

    const originalCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function(object) {
      const objectUrl = originalCreateObjectURL(object);
      pushMediaUrl(objectUrl, object?.constructor?.name || 'object-url');
      return objectUrl;
    };

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      try {
        const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        const cloned = response.clone();
        const body = await cloned.text();
        pushPayload({ url: requestUrl || response.url, body });
      } catch {}
      return response;
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__captureUrl = url;
      return originalOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function(...args) {
      this.addEventListener('loadend', () => {
        try {
          pushPayload({ url: this.__captureUrl || this.responseURL, body: this.responseText || '' });
        } catch {}
      });
      return originalSend.apply(this, args);
    };

    let currentExecutor;
    Object.defineProperty(globalThis, '_0x239534', {
      configurable: true,
      get() {
        return currentExecutor;
      },
      set(fn) {
        if (typeof fn !== 'function') {
          currentExecutor = fn;
          return;
        }

        currentExecutor = function wrappedExecutor(ctx, ...args) {
          try {
            if (ctx?.rs) {
              pushPayload({ url: 'executor://_0x239534', body: String(ctx.rs) });
            }
          } catch {}

          return fn.call(this, ctx, ...args);
        };
      }
    });
  });
}

async function inspectVidfastPayloads(page) {
  const payloads = await page.evaluate(() => window.__VIDFAST_CAPTURE__?.payloads || []).catch(() => []);

  console.log(new Date().toISOString(), '[vidfast] captured payload count', payloads.length);

  for (const entry of payloads) {
    const streamUrl = extractStreamFromPayload(entry?.body || '');
    if (streamUrl) {
      console.log(new Date().toISOString(), '[vidfast] extracted stream from payload source', entry?.url || 'unknown');
      return {
        url: streamUrl,
        type: detectType(streamUrl),
        headers: {},
        foundAt: new Date().toISOString(),
        via: 'payload'
      };
    }
  }

  return null;
}

async function inspectVidfastRuntime(page) {
  const runtimeState = await page.evaluate(() => {
    const video = document.querySelector('video');
    const resourceEntries = performance
      .getEntriesByType('resource')
      .map((entry) => ({ name: entry.name, initiatorType: entry.initiatorType || '' }));

    const storageValues = [];
    const collectStorage = (storage) => {
      try {
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          const value = key ? storage.getItem(key) : '';
          if (value) {
            storageValues.push(value.slice(0, 200000));
          }
        }
      } catch {}
    };

    collectStorage(window.localStorage);
    collectStorage(window.sessionStorage);

    return {
      mediaUrls: window.__VIDFAST_CAPTURE__?.mediaUrls || [],
      payloads: window.__VIDFAST_CAPTURE__?.payloads || [],
      video: video
        ? {
            src: video.getAttribute('src') || '',
            currentSrc: video.currentSrc || '',
            poster: video.getAttribute('poster') || '',
            readyState: video.readyState,
            networkState: video.networkState
          }
        : null,
      resources: resourceEntries,
      storageValues,
      html: document.documentElement?.outerHTML?.slice(0, 250000) || ''
    };
  }).catch(() => null);

  if (!runtimeState) {
    return null;
  }

  const directCandidate = pickStreamCandidate([
    runtimeState.video?.currentSrc,
    runtimeState.video?.src,
    ...(runtimeState.mediaUrls || []).map((entry) => entry?.url),
    ...(runtimeState.resources || []).map((entry) => entry?.name)
  ]);

  if (directCandidate) {
    console.log(new Date().toISOString(), '[vidfast] extracted runtime stream candidate', directCandidate);
    return {
      url: directCandidate,
      type: detectType(directCandidate),
      headers: {},
      foundAt: new Date().toISOString(),
      via: 'runtime'
    };
  }

  const payloadCandidate = pickStreamCandidate([
    ...((runtimeState.payloads || []).map((entry) => entry?.body)),
    ...(runtimeState.storageValues || []),
    runtimeState.html
  ].map((value) => extractStreamFromPayload(value)).filter(Boolean));

  if (payloadCandidate) {
    console.log(new Date().toISOString(), '[vidfast] extracted runtime payload candidate', payloadCandidate);
    return {
      url: payloadCandidate,
      type: detectType(payloadCandidate),
      headers: {},
      foundAt: new Date().toISOString(),
      via: 'runtime-payload'
    };
  }

  console.log(
    new Date().toISOString(),
    '[vidfast] runtime inspection',
    JSON.stringify({
      video: runtimeState.video,
      mediaUrls: runtimeState.mediaUrls?.length || 0,
      resources: runtimeState.resources?.length || 0,
      storageValues: runtimeState.storageValues?.length || 0
    })
  );

  return null;
}

export async function extractVideoUrls(targetUrl, onFound, options = {}) {
  console.log(new Date().toISOString(), '[extractor] starting', targetUrl);
  const browser = await getBrowser(options);
  const expectedVidfastPath = getExpectedVidfastPath(targetUrl);

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

  page.on('response', async (response) => {
    if (!isVidfastUrl(targetUrl)) {
      return;
    }

    const resourceType = response.request().resourceType();
    if (!['xhr', 'fetch'].includes(resourceType)) {
      return;
    }

    const url = response.url();
    const status = response.status();
    console.log(new Date().toISOString(), '[vidfast:xhr]', status, url);

    if (!url.includes('/api/') && !url.includes('source') && !url.includes('stream') && !url.includes('vidfast')) {
      return;
    }

    try {
      const body = await response.text();
      console.log(new Date().toISOString(), '[vidfast:xhr-body]', url, '->', body.slice(0, 500));
    } catch {}
  });

  page.on('pageerror', (error) => {
    console.log(new Date().toISOString(), '[pageerror]', error?.message || String(error));
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.log(new Date().toISOString(), '[console:error]', msg.text());
    }
  });

  page.on('framenavigated', (frame) => {
    const frameUrl = frame.url();
    if (frameUrl && frameUrl !== 'about:blank' && frame !== page.mainFrame()) {
      console.log(new Date().toISOString(), '[iframe]', frameUrl);
    }
  });

  await installVidfastHooks(page, targetUrl);

  await setupInterceptors(page, targetUrl, async (result) => {
    onFound(result);

    if (!firstResultResolved) {
      firstResultResolved = true;
      await page.close().catch(() => undefined);
    }
  });

  try {
    await warmVidfastSession(page, targetUrl);

    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: options.navigationTimeout ?? 30000
    });

    if (isVidfastUrl(targetUrl) && expectedVidfastPath) {
      const currentPath = getExpectedVidfastPath(page.url());
      if (currentPath && currentPath !== expectedVidfastPath) {
        console.log(new Date().toISOString(), '[vidfast] unexpected redirect', page.url());
        await page.goto(targetUrl, {
          waitUntil: 'domcontentloaded',
          timeout: options.navigationTimeout ?? 30000
        });
      }
    }

    console.log(new Date().toISOString(), '[extractor] page loaded', targetUrl);

    await logVidfastPageState(page, targetUrl);
    await patchVidfastVisibility(page, targetUrl);

    await safeWait(isVidfastUrl(targetUrl) ? 2000 : 250);

    if (stopIfResolved()) {
      return;
    }

    await pokePlayers(page, targetUrl);
    await safeWait(isVidfastUrl(targetUrl) ? 3000 : 750);

    if (stopIfResolved()) {
      return;
    }

    await page.evaluate(() => window.scrollBy(0, 500)).catch(() => undefined);
    if (isVidfastUrl(targetUrl)) {
      await page.mouse.click(640, 400).catch(() => undefined);
      await safeWait(2000);
      await pokePlayers(page, targetUrl);
      await safeWait(2000);
    }
    await waitForNetworkSettle(
      options.settleTimeout ?? (isVidfastUrl(targetUrl) ? 4000 : 2000),
      options.maxWaitAfterLoad ?? (isVidfastUrl(targetUrl) ? 28000 : 10000),
      options.minWaitAfterLoad ?? (isVidfastUrl(targetUrl) ? 12000 : 5000)
    );

    if (!stopIfResolved() && isVidfastUrl(targetUrl)) {
      const vidfastResult = await inspectVidfastPayloads(page);
      if (vidfastResult) {
        onFound(vidfastResult);
        firstResultResolved = true;
        await page.close().catch(() => undefined);
        return;
      }

      const runtimeResult = await inspectVidfastRuntime(page);
      if (runtimeResult) {
        onFound(runtimeResult);
        firstResultResolved = true;
        await page.close().catch(() => undefined);
      }
    }
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
