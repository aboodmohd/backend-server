import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import CryptoJS from 'crypto-js';
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

const NON_STREAM_ASSET_PATTERNS = [
  /(?:^|\/)_(?:build|ssg|middleware)manifest\.js(?:\?|$)/i,
  /\.(?:js|mjs|cjs|css|map|json|txt|svg|png|jpe?g|gif|webp|ico|woff2?|ttf)(?:\?|$)/i,
  /\/favicon\.ico(?:\?|$)/i
];

function getBrowser(options = {}) {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      channel: 'chromium',
      headless: options.headless ?? true,
      args: [
        '--disable-web-security',
        '--disable-site-isolation-trials',
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

function isVideasyUrl(url) {
  return /player\.videasy\.net/i.test(String(url || ''));
}

function isVidzeeUrl(url) {
  return /player\.vidzee\.wtf\/v2\/embed\//i.test(String(url || ''));
}

function isVideasyApiUrl(url) {
  return /https:\/\/(?:api\d?\.videasy\.net)\/(?:[^/?]+)\/sources-with-title\?/i.test(String(url || ''));
}

function getVideasyMediaId(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    const parts = parsed.pathname.split('/').filter(Boolean);
    return parts[1] || null;
  } catch {
    return null;
  }
}

function pickVideasySourceFromPayload(payload) {
  const sources = Array.isArray(payload?.sources) ? payload.sources : [];

  return sources
    .filter((entry) => typeof entry?.url === 'string' && entry.url.startsWith('http'))
    .sort((left, right) => {
      const leftScore = Number.parseInt(String(left.quality || '').replace(/\D/g, ''), 10) || 0;
      const rightScore = Number.parseInt(String(right.quality || '').replace(/\D/g, ''), 10) || 0;
      return rightScore - leftScore;
    })[0] || null;
}

async function primeVideasyPlayer(page, targetUrl) {
  if (!isVideasyUrl(targetUrl)) {
    return;
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (page.isClosed()) {
      return;
    }

    await page.locator('button').first().click({ force: true, timeout: 1000 }).catch(() => undefined);
    await page.mouse.click(640, 360).catch(() => undefined);
    await page.keyboard.press('Space').catch(() => undefined);
    await page.waitForTimeout(1000).catch(() => undefined);
  }
}

async function primeVidzeePlayer(page, targetUrl) {
  if (!isVidzeeUrl(targetUrl)) {
    return;
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (page.isClosed()) {
      return;
    }

    await page.locator('button').first().click({ force: true, timeout: 1000 }).catch(() => undefined);
    await page.mouse.click(640, 360).catch(() => undefined);
    await page.keyboard.press('Space').catch(() => undefined);
    await page.waitForTimeout(1000).catch(() => undefined);
  }
}

function isVidfastResolverUrl(url) {
  return /^https:\/\/vidfast\.pro\/APA91/i.test(String(url || ''));
}

function isLikelyStreamUrl(url) {
  const value = String(url || '');
  if (NON_STREAM_ASSET_PATTERNS.some((pattern) => pattern.test(value))) {
    return false;
  }
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
  const isAggressiveTarget = isVidfastUrl(targetUrl) || isVidzeeUrl(targetUrl);
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
    }, isAggressiveTarget).catch(() => undefined);
  }

  if (isAggressiveTarget) {
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
      mediaUrls: [],
      errors: [],
      scriptUrls: []
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

    const pushError = (value, source = 'unknown') => {
      try {
        const message = String(value || '').trim();
        if (!message) {
          return;
        }

        store.errors.push({
          message: message.slice(0, 200000),
          source,
          at: Date.now()
        });
      } catch {}
    };

    const pushScriptUrl = (value, source = 'script') => {
      try {
        const url = String(value || '').trim();
        if (!url) {
          return;
        }

        store.scriptUrls.push({
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

    window.addEventListener('error', (event) => {
      pushError(event?.message || event?.error?.stack || event?.filename, 'window-error');
      pushScriptUrl(event?.filename, 'window-error');
    });

    window.addEventListener('unhandledrejection', (event) => {
      pushError(event?.reason?.stack || event?.reason?.message || event?.reason, 'unhandledrejection');
    });

    if (!globalThis.Buffer) {
      globalThis.Buffer = {
        from(value, encoding = 'utf8') {
          if (encoding === 'base64') {
            const binary = atob(String(value || ''));
            return Uint8Array.from(binary, (char) => char.charCodeAt(0));
          }

          return new TextEncoder().encode(String(value || ''));
        }
      };
    }

    const originalAppendChild = Element.prototype.appendChild;
    Element.prototype.appendChild = function(child) {
      if (child instanceof HTMLScriptElement) {
        pushScriptUrl(child.src || child.textContent?.slice(0, 200), 'append-child-script');
      }

      return originalAppendChild.call(this, child);
    };

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
      errors: window.__VIDFAST_CAPTURE__?.errors || [],
      scriptUrls: window.__VIDFAST_CAPTURE__?.scriptUrls || [],
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
      errors: runtimeState.errors?.length || 0,
      resources: runtimeState.resources?.length || 0,
      scriptUrls: runtimeState.scriptUrls?.length || 0,
      storageValues: runtimeState.storageValues?.length || 0
    })
  );

  if (runtimeState.errors?.length) {
    console.log(new Date().toISOString(), '[vidfast] runtime errors', JSON.stringify(runtimeState.errors.slice(0, 10)));
  }

  return null;
}

async function triggerVidfastBootstrap(page, targetUrl) {
  if (!isVidfastUrl(targetUrl)) {
    return;
  }

  const result = await page.evaluate(async () => {
    const runtime = window.__VIDFAST_RUNTIME__ || {};
    const runtimeAp = runtime.ap || window.__VIDFAST_AP__;

    const html = document.documentElement?.innerHTML || '';
    const tokenMatch = html.match(/en:\"([^\"]+)\"/) || html.match(/en:"([^"]+)"/);
    const serverMatch = html.match(/server:\"([^\"]*)\"/) || html.match(/server:"([^"]*)"/);

    runtime.en ||= tokenMatch?.[1] || '';
    runtime.server ||= serverMatch?.[1] || '';

    if (!runtimeAp || typeof runtime.setState !== 'function' || typeof runtime.setServers !== 'function') {
      return {
        ok: false,
        reason: 'runtime-missing',
        hasAp: Boolean(runtimeAp),
        hasSetState: typeof runtime.setState === 'function',
        hasSetServers: typeof runtime.setServers === 'function',
        hasEn: Boolean(runtime.en),
        hasServer: typeof runtime.server === 'string'
      };
    }

    try {
      const savedServer = runtime.server || localStorage.getItem('server') || localStorage.getItem('preferredServer') || '';
      if (savedServer) {
        localStorage.setItem('server', savedServer);
        localStorage.setItem('preferredServer', savedServer);
        localStorage.setItem('player:server', savedServer);
      }
    } catch {}

    try {
      await runtimeAp({
        crypto: runtime.crypto,
        encode: runtime.encode,
        en: runtime.en,
        server: runtime.server,
        setServers: runtime.setServers,
        setState: runtime.setState,
        setFavServer: runtime.setFavServer,
        window,
        document,
        navigator,
        localStorage,
        console,
        JSON,
        Math,
        Date,
        RegExp,
        Map,
        Set,
        WeakMap,
        WeakSet,
        Array,
        Object,
        Number,
        String,
        Boolean,
        Symbol,
        Function,
        screen,
        Error,
        TypeError,
        RangeError,
        SyntaxError,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        encodeURIComponent,
        decodeURIComponent,
        NaN,
        Infinity,
        undefined,
        Promise,
        Proxy,
        Reflect,
        Uint8Array,
        Int8Array,
        Uint16Array,
        Int16Array,
        Uint32Array,
        Int32Array,
        Float32Array,
        Float64Array,
        BigInt,
        fetch,
        TextEncoder,
        TextDecoder,
        URL,
        URLSearchParams,
        AbortSignal,
        AbortController,
        Buffer: globalThis.Buffer,
        atob,
        btoa
      });

      return { ok: true, state: runtime.state || null };
    } catch (error) {
      return { ok: false, reason: error?.stack || error?.message || String(error) };
    }
  }).catch((error) => ({ ok: false, reason: error?.message || String(error) }));

  console.log(new Date().toISOString(), '[vidfast] manual bootstrap', JSON.stringify(result));

  return result;
}

async function waitForVidfastRuntime(page, timeoutMs = 12000) {
  const startedAt = Date.now();

  while (!page.isClosed() && Date.now() - startedAt < timeoutMs) {
    const runtimeReady = await page
      .evaluate(() => Boolean(window.__VIDFAST_RUNTIME__?.ap || window.__VIDFAST_AP__))
      .catch(() => false);

    if (runtimeReady) {
      return true;
    }

    await page.waitForTimeout(250).catch(() => undefined);
  }

  return false;
}

export async function extractVideoUrls(targetUrl, onFound, options = {}) {
  console.log(new Date().toISOString(), '[extractor] starting', targetUrl);
  const browser = await getBrowser(options);
  const expectedVidfastPath = getExpectedVidfastPath(targetUrl);

  const context = await browser.newContext({
    bypassCSP: true,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 }
  });

  const page = await context.newPage();
  let firstResultResolved = false;
  let lastRelevantActivityAt = Date.now();
  const vidfastResolverHints = [];
  let vidfastRuntimeReadyPromise = null;
  const videasyApiStatuses = [];

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

  const rememberVidfastResolverHint = (entry) => {
    if (!isVidfastUrl(targetUrl) || !entry?.url || !isVidfastResolverUrl(entry.url)) {
      return;
    }

    if (vidfastResolverHints.some((item) => item.url === entry.url)) {
      return;
    }

    vidfastResolverHints.push({
      url: entry.url,
      method: entry.method || 'GET',
      headers: entry.headers || {},
      at: new Date().toISOString()
    });

    if (vidfastResolverHints.length > 6) {
      vidfastResolverHints.shift();
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

    rememberVidfastResolverHint({
      url: request.url(),
      method: request.method(),
      headers: request.headers()
    });
  });

  page.on('response', (response) => {
    markActivity(response.url(), response.request().resourceType());
  });

  page.on('response', async (response) => {
    if (isVideasyUrl(targetUrl) && isVideasyApiUrl(response.url())) {
      const url = response.url();
      const status = response.status();
      videasyApiStatuses.push({ url, status });
      if (videasyApiStatuses.length > 20) {
        videasyApiStatuses.shift();
      }

      try {
        const body = await response.text();
        console.log(new Date().toISOString(), '[videasy:api]', status, url, '->', body.slice(0, 500));

        if (!response.ok() || stopIfResolved()) {
          return;
        }

        let streamUrl = extractStreamFromPayload(body);

        if (!streamUrl) {
          const mediaId = getVideasyMediaId(targetUrl);
          if (mediaId) {
            const stageOne = await decryptVideasyPayload(body, mediaId, targetUrl).catch(() => '');
            const decrypted = stageOne ? CryptoJS.AES.decrypt(stageOne, '').toString(CryptoJS.enc.Utf8) : '';

            if (decrypted) {
              try {
                const payload = JSON.parse(decrypted);
                streamUrl = pickVideasySourceFromPayload(payload)?.url || '';
              } catch {}
            }
          }
        }

        if (!streamUrl) {
          return;
        }

        onFound({
          url: streamUrl,
          type: detectType(streamUrl, response.headers()['content-type'] || ''),
          headers: {
            ...response.request().headers(),
            ...response.headers()
          },
          foundAt: new Date().toISOString(),
          via: 'videasy-browser-api'
        });

        if (!firstResultResolved) {
          firstResultResolved = true;
          await page.close().catch(() => undefined);
        }
      } catch (error) {
        console.log(new Date().toISOString(), '[videasy:api:error]', url, error?.message || String(error));
      }
    }

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

  page.on('requestfailed', (request) => {
    if (!isVidfastUrl(targetUrl)) {
      return;
    }

    if (!['script', 'document', 'fetch', 'xhr'].includes(request.resourceType())) {
      return;
    }

    console.log(new Date().toISOString(), '[requestfailed]', request.resourceType(), request.url(), request.failure()?.errorText || 'unknown');
  });

  page.on('response', (response) => {
    if (!isVidfastUrl(targetUrl)) {
      return;
    }

    if (response.request().resourceType() !== 'script') {
      return;
    }

    console.log(new Date().toISOString(), '[script]', response.status(), response.url());
  });

  page.on('pageerror', (error) => {
    console.log(new Date().toISOString(), '[pageerror]', error?.stack || error?.message || String(error));
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
    onFound({
      ...result,
      resolverHints: vidfastResolverHints.length ? { vidfastRequests: [...vidfastResolverHints] } : undefined
    });

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

    if (isVidfastUrl(targetUrl)) {
      vidfastRuntimeReadyPromise = waitForVidfastRuntime(page, 25000);
    }

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
      await safeWait(500);
      await pokePlayers(page, targetUrl);
      await safeWait(500);
    }

    if (!stopIfResolved() && isVideasyUrl(targetUrl)) {
      await safeWait(4000);
      await primeVideasyPlayer(page, targetUrl);
      await waitForNetworkSettle(2000, 12000, 2000);

      const videasyForbiddenCount = videasyApiStatuses.filter((entry) => entry.status === 403).length;
      if (videasyForbiddenCount >= 3) {
        throw new Error('VIDEASY_UPSTREAM_FORBIDDEN');
      }
    }

    if (!stopIfResolved() && isVidzeeUrl(targetUrl)) {
      await safeWait(2500);
      await primeVidzeePlayer(page, targetUrl);
      await waitForNetworkSettle(2500, 15000, 3000);
    }

    if (!stopIfResolved() && isVidfastUrl(targetUrl)) {
      const runtimeReady = await (vidfastRuntimeReadyPromise || waitForVidfastRuntime(page, 12000));
      console.log(new Date().toISOString(), '[vidfast] runtime ready', runtimeReady);
      if (runtimeReady) {
        await triggerVidfastBootstrap(page, targetUrl);
        await safeWait(1000);
        await waitForNetworkSettle(2000, 8000, 1000);
      }
    }

    if (!stopIfResolved() && isVidfastUrl(targetUrl)) {
      await triggerVidfastBootstrap(page, targetUrl);
      await safeWait(1500);
      await waitForNetworkSettle(2500, 12000, 2000);
    }

    if (!stopIfResolved()) {
      await waitForNetworkSettle(
        options.settleTimeout ?? (isVidfastUrl(targetUrl) ? 3000 : 2000),
        options.maxWaitAfterLoad ?? (isVidfastUrl(targetUrl) ? 18000 : 10000),
        options.minWaitAfterLoad ?? (isVidfastUrl(targetUrl) ? 4000 : 5000)
      );
    }

    if (!stopIfResolved() && isVidfastUrl(targetUrl)) {
      await triggerVidfastBootstrap(page, targetUrl);
      await safeWait(1500);
      await waitForNetworkSettle(2500, 8000, 1500);
    }

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

export async function decryptVideasyPayload(encryptedPayload, mediaId, targetUrl = 'https://player.videasy.net/') {
  const browser = await getBrowser();
  const context = await browser.newContext({
    bypassCSP: true,
    viewport: { width: 1280, height: 720 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    return await page.evaluate(async ({ encrypted, numericMediaId }) => {
      const compiled = await WebAssembly.compileStreaming(fetch('https://player.videasy.net/module.wasm'));
      const { exports } = await WebAssembly.instantiate(compiled, {
        env: Object.assign(Object.create(globalThis), {
          seed: () => Date.now() * Math.random(),
          abort(message, file, line, column) {
            throw new Error(`${message}:${file}:${line}:${column}`);
          }
        })
      });
      const memory = exports.memory;

      const readString = (ptr) => {
        if (!ptr) {
          return null;
        }

        const end = ptr + new Uint32Array(memory.buffer)[(ptr - 4) >>> 2] >>> 1;
        const buffer = new Uint16Array(memory.buffer);
        let cursor = ptr >>> 1;
        let output = '';

        while (end - cursor > 1024) {
          output += String.fromCharCode(...buffer.subarray(cursor, cursor += 1024));
        }

        return output + String.fromCharCode(...buffer.subarray(cursor, end));
      };

      const writeString = (value) => {
        const ptr = exports.__new(value.length << 1, 2) >>> 0;
        const buffer = new Uint16Array(memory.buffer);

        for (let index = 0; index < value.length; index += 1) {
          buffer[(ptr >>> 1) + index] = value.charCodeAt(index);
        }

        return ptr;
      };

      Function(readString(exports.serve() >>> 0))();

      const hash = await new Promise((resolve, reject) => {
        const startedAt = Date.now();

        const poll = () => {
          if (window.hash) {
            resolve(window.hash);
            return;
          }

          if (Date.now() - startedAt > 10000) {
            reject(new Error('VIDEASY_HASH_TIMEOUT'));
            return;
          }

          setTimeout(poll, 25);
        };

        poll();
      });

      if (!exports.verify(writeString(hash))) {
        throw new Error('VIDEASY_HASH_VERIFY_FAILED');
      }

      return readString(exports.decrypt(writeString(encrypted), numericMediaId) >>> 0) || '';
    }, {
      encrypted: String(encryptedPayload || ''),
      numericMediaId: Number(mediaId)
    });
  } finally {
    await context.close().catch(() => undefined);
  }
}

export async function resolveVideasyPayloadInBrowser(apiUrl, mediaId, targetUrl = 'https://player.videasy.net/') {
  const browser = await getBrowser();
  const pageUrl = new URL('/robots.txt', targetUrl).toString();
  const context = await browser.newContext({
    bypassCSP: true,
    viewport: { width: 1280, height: 720 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    await context.route('**/*sources-with-title*', async (route) => {
      try {
        const response = await route.fetch();
        const body = await response.text();

        await route.fulfill({
          response,
          body,
          headers: {
            ...response.headers(),
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, OPTIONS',
            'access-control-allow-headers': '*'
          }
        });
      } catch {
        await route.abort().catch(() => undefined);
      }
    });

    await page.goto(pageUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    return await page.evaluate(async ({ sourceApiUrl, numericMediaId }) => {
      const compiled = await WebAssembly.compileStreaming(fetch('https://player.videasy.net/module.wasm'));
      const { exports } = await WebAssembly.instantiate(compiled, {
        env: Object.assign(Object.create(globalThis), {
          seed: () => Date.now() * Math.random(),
          abort(message, file, line, column) {
            throw new Error(`${message}:${file}:${line}:${column}`);
          }
        })
      });
      const memory = exports.memory;

      const readString = (ptr) => {
        if (!ptr) {
          return null;
        }

        const end = ptr + new Uint32Array(memory.buffer)[(ptr - 4) >>> 2] >>> 1;
        const buffer = new Uint16Array(memory.buffer);
        let cursor = ptr >>> 1;
        let output = '';

        while (end - cursor > 1024) {
          output += String.fromCharCode(...buffer.subarray(cursor, cursor += 1024));
        }

        return output + String.fromCharCode(...buffer.subarray(cursor, end));
      };

      const writeString = (value) => {
        const ptr = exports.__new(value.length << 1, 2) >>> 0;
        const buffer = new Uint16Array(memory.buffer);

        for (let index = 0; index < value.length; index += 1) {
          buffer[(ptr >>> 1) + index] = value.charCodeAt(index);
        }

        return ptr;
      };

      Function(readString(exports.serve() >>> 0))();

      const hash = await new Promise((resolve, reject) => {
        const startedAt = Date.now();

        const poll = () => {
          if (window.hash) {
            resolve(window.hash);
            return;
          }

          if (Date.now() - startedAt > 10000) {
            reject(new Error('VIDEASY_HASH_TIMEOUT'));
            return;
          }

          setTimeout(poll, 25);
        };

        poll();
      });

      const response = await fetch(sourceApiUrl, {
        credentials: 'omit',
        mode: 'cors'
      });
      const encrypted = await response.text();

      if (!response.ok || !encrypted) {
        throw new Error(`VIDEASY_BROWSER_FETCH_${response.status || 0}`);
      }

      if (!exports.verify(writeString(hash))) {
        throw new Error('VIDEASY_HASH_VERIFY_FAILED');
      }

      return readString(exports.decrypt(writeString(encrypted), numericMediaId) >>> 0) || '';
    }, {
      sourceApiUrl: String(apiUrl || ''),
      numericMediaId: Number(mediaId)
    });
  } finally {
    await context.close().catch(() => undefined);
  }
}
