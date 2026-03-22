const cheerio = require('cheerio');
const { chromium: playwrightChromium } = require('playwright');
const { addExtra } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { absoluteUrl, extractUrls, fetchJson, fetchText, isMediaUrl, isSubtitleUrl, MEDIA_URL_REGEX } = require('../utils/request');

const chromium = addExtra(playwrightChromium);

chromium.use(StealthPlugin());

const STREAM_EXTENSIONS = ['.m3u8', '.mp4', '.m3u', '.mpd', '.mkv', '.webm'];
const SUBTITLE_EXTENSIONS = ['.vtt', '.srt', '.ass'];
const PLAYER_CONFIG_PATTERNS = [
  /(?:file|src)\s*[:=]\s*["'](https?:\/\/[^"']+|\/[^"']+)["']/gi,
  /(?:sources|source)\s*[:=]\s*\[[^\]]*(https?:\/\/[^"']+|\/[^"']+)[^\]]*\]/gi,
  /(?:hls|dash|stream|video)\s*[:=]\s*["'](https?:\/\/[^"']+|\/[^"']+)["']/gi,
];

let browserPromise = null;

function createError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function logStep(scope, message, extra) {
  if (extra === undefined) {
    console.log(`${new Date().toISOString()} [${scope}] ${message}`);
    return;
  }

  console.log(`${new Date().toISOString()} [${scope}] ${message}`, extra);
}

function normalizeSubtitle(url, index) {
  return {
    lang: `track-${index + 1}`,
    url,
  };
}

function inferSubtitleLabel(url, fallback) {
  const match = url.match(/(?:lang|label|srclang)=([a-zA-Z-]+)/i) || url.match(/\.([a-z]{2,3})(?:\.|\?|$)/i);
  return match ? match[1].toLowerCase() : fallback;
}

function dedupeSubtitles(subtitles) {
  const seen = new Set();
  const normalized = [];

  for (const subtitle of subtitles) {
    if (!subtitle || !subtitle.url || seen.has(subtitle.url)) {
      continue;
    }

    seen.add(subtitle.url);
    normalized.push({
      lang: subtitle.lang || inferSubtitleLabel(subtitle.url, `track-${normalized.length + 1}`),
      url: subtitle.url,
    });
  }

  return normalized;
}

function pickBestStream(candidates) {
  const uniqueCandidates = [...new Set(candidates.filter(Boolean))];

  uniqueCandidates.sort((left, right) => {
    const scoreCandidate = (candidate) => {
      if (candidate.includes('.m3u8')) return 0;
      if (candidate.includes('.mpd')) return 1;
      if (candidate.includes('.mp4')) return 2;
      if (candidate.includes('.webm')) return 3;
      if (candidate.includes('.mkv')) return 4;
      return 5;
    };
    const leftScore = scoreCandidate(left);
    const rightScore = scoreCandidate(right);
    return leftScore - rightScore;
  });

  return uniqueCandidates[0] || null;
}

function collectPlayerConfigCandidates(input, baseUrl) {
  const html = String(input || '');
  const streamCandidates = [];

  for (const pattern of PLAYER_CONFIG_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(html);

    while (match) {
      const candidate = absoluteUrl(baseUrl, match[1]);
      if (candidate && isMediaUrl(candidate)) {
        streamCandidates.push(candidate);
      }
      match = pattern.exec(html);
    }
  }

  return streamCandidates;
}

function shouldTraceNetworkCandidate(source, candidate, resourceType) {
  if (!['vidlink', 'vidfast'].includes(source)) {
    return false;
  }

  if (!candidate || candidate.startsWith('data:')) {
    return false;
  }

  if (isMediaUrl(candidate)) {
    return true;
  }

  if (resourceType && ['fetch', 'xhr', 'document', 'script'].includes(resourceType)) {
    return /(?:api|embed|source|stream|playlist|manifest|m3u8|videostr|vodvidl|vidfast|jwplayer|player)/i.test(candidate);
  }

  return false;
}

function parseVidlinkDescriptor(targetUrl) {
  try {
    const parsedUrl = new URL(targetUrl);
    const segments = parsedUrl.pathname.split('/').filter(Boolean);
    const [type, tmdbId, season, episode] = segments;

    if (!tmdbId || !['movie', 'tv'].includes(type)) {
      return null;
    }

    if (type === 'tv' && (!season || !episode)) {
      return null;
    }

    return {
      origin: parsedUrl.origin,
      type,
      tmdbId,
      season: season || null,
      episode: episode || null,
    };
  } catch {
    return null;
  }
}

function extractVidlinkPayload(payload, baseUrl) {
  try {
    const parsed = JSON.parse(payload);
    const playlist = absoluteUrl(baseUrl, parsed?.stream?.playlist || parsed?.stream?.url || parsed?.playlist || parsed?.url);
    const subtitles = dedupeSubtitles(
      (parsed?.subtitles || parsed?.tracks || parsed?.captions || []).map((track, index) => ({
        lang: track?.lang || track?.label || track?.srclang || `track-${index + 1}`,
        url: absoluteUrl(baseUrl, track?.url || track?.file || track?.src),
      })),
    );

    if (!playlist) {
      return null;
    }

    return {
      stream: playlist,
      subtitles,
    };
  } catch {
    return scanPayloadForMedia(payload, baseUrl);
  }
}

function extractVidfastBootstrapObject(text) {
  const marker = '5:["$","$L11",null,{';
  const start = String(text || '').indexOf(marker);
  if (start === -1) {
    return null;
  }

  const objectStart = start + marker.length - 1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = objectStart; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(objectStart, index + 1);
      }
    }
  }

  return null;
}

function parseVidfastFlightBootstrap(html, baseUrl) {
  const objectText = extractVidfastBootstrapObject(String(html || ''));
  if (!objectText) {
    return null;
  }

  try {
    return {
      ...JSON.parse(objectText),
      url: baseUrl,
    };
  } catch {
    return null;
  }
}

async function tryVidlinkBrowserApi(page, targetUrl) {
  const descriptor = parseVidlinkDescriptor(targetUrl);

  if (!descriptor) {
    return null;
  }

  try {
    await page.waitForFunction(() => typeof window.getAdv === 'function', { timeout: 4000 });

    const response = await page.evaluate(async ({ type, tmdbId, season, episode }) => {
      const rawToken = typeof window.getAdv === 'function' ? window.getAdv(String(tmdbId)) : null;

      if (!rawToken) {
        return null;
      }

      const tokenData = Array.isArray(rawToken) ? rawToken : [rawToken, null, false];
      const multiLang = tokenData[2] === true ? 1 : 0;
      const apiPaths = type === 'tv'
        ? [
          `/api/b/${type}/${tokenData[0]}/${season}/${episode}?multiLang=${multiLang}`,
          `/api/b/${type}/${tokenData[0]}?multiLang=${multiLang}`,
        ]
        : [`/api/b/${type}/${tokenData[0]}?multiLang=${multiLang}`];

      for (const apiPath of apiPaths) {
        const apiResponse = await fetch(apiPath, {
          headers: {
            Accept: 'application/json, text/plain, */*',
            'X-Requested-With': 'XMLHttpRequest',
          },
        });

        const payload = await apiResponse.text();

        if (apiResponse.ok) {
          return {
            apiPath,
            ok: true,
            status: apiResponse.status,
            payload,
          };
        }
      }

      return {
        apiPath: apiPaths[apiPaths.length - 1],
        ok: false,
        status: 404,
        payload: null,
      };
    }, descriptor);

    if (!response) {
      return null;
    }

    const endpoint = new URL(response.apiPath, descriptor.origin).toString();

    if (!response.ok) {
      logStep('vidlink', 'browser bootstrap API failed', {
        endpoint,
        status: response.status,
      });
      return null;
    }

    const result = extractVidlinkPayload(response.payload, endpoint);

    if (!result) {
      return null;
    }

    logStep('vidlink', 'provider API returned media', { endpoint, via: 'browser-bootstrap' });
    return result;
  } catch (error) {
    logStep('vidlink', 'browser bootstrap API failed', {
      message: error.message,
    });
    return null;
  }
}

async function triggerVidfastPlayback(page) {
  try {
    await page.waitForSelector('video', { timeout: 5000 });
  } catch {
    return;
  }

  try {
    await page.evaluate(() => {
      const clickIfVisible = (element) => {
        if (!element) {
          return false;
        }

        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) {
          return false;
        }

        element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        if (typeof element.click === 'function') {
          element.click();
        }
        return true;
      };

      const video = document.querySelector('video');
      if (video) {
        video.muted = true;
        video.autoplay = true;
        video.controls = true;
        video.playsInline = true;
        video.setAttribute('muted', '');
        video.setAttribute('autoplay', '');
        video.setAttribute('playsinline', '');
        clickIfVisible(video);
        if (typeof video.load === 'function') {
          video.load();
        }
        if (typeof video.play === 'function') {
          video.play().catch(() => {});
        }
      }

      const buttonCandidates = [...document.querySelectorAll('button, [role="button"], [class*="play"], [class*="player"] button')];
      for (const candidate of buttonCandidates) {
        const label = (candidate.innerText || candidate.getAttribute('aria-label') || candidate.getAttribute('title') || '').toLowerCase();
        if (!label || /play|watch|start|resume/.test(label)) {
          clickIfVisible(candidate);
        }
      }
    });

    await page.keyboard.press('Space').catch(() => {});
    await page.keyboard.press('KeyK').catch(() => {});
    await page.mouse.click(683, 384, { delay: 100 }).catch(() => {});
  } catch {
    // Ignore vidfast bootstrap interaction failures.
  }
}

async function installVidfastCapture(page) {
  await page.addInitScript(() => {
    const store = {
      urls: [],
      events: [],
      bootstrap: [],
    };

    const pushUnique = (bucket, value) => {
      if (!value || bucket.includes(value)) {
        return;
      }
      bucket.push(value);
    };

    const captureUrl = (value) => {
      if (typeof value === 'string' && value) {
        pushUnique(store.urls, value);
      }
    };

    const captureEvent = (type, value) => {
      if (!value) {
        return;
      }
      pushUnique(store.events, `${type}:${String(value).slice(0, 400)}`);
    };

    const parseFlightChunk = (payload) => {
      if (typeof payload !== 'string' || !payload.includes('5:["$","$L11",null,{')) {
        return;
      }

      const marker = '5:["$","$L11",null,{';
      const start = payload.indexOf(marker);
      if (start === -1) {
        return;
      }

      const objectStart = start + marker.length - 1;
      let depth = 0;
      let inString = false;
      let escaped = false;

      for (let index = objectStart; index < payload.length; index += 1) {
        const char = payload[index];

        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (char === '\\') {
            escaped = true;
          } else if (char === '"') {
            inString = false;
          }
          continue;
        }

        if (char === '"') {
          inString = true;
          continue;
        }

        if (char === '{') {
          depth += 1;
        } else if (char === '}') {
          depth -= 1;
          if (depth === 0) {
            const objectText = payload.slice(objectStart, index + 1);
            try {
              pushUnique(store.bootstrap, JSON.stringify(JSON.parse(objectText)));
            } catch {
              // Ignore malformed bootstrap chunks.
            }
            return;
          }
        }
      }
    };

    Object.defineProperty(window, '__open_capture__', {
      value: store,
      configurable: false,
      enumerable: false,
      writable: false,
    });

    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      captureUrl(args[0] && typeof args[0] === 'object' ? args[0].url : args[0]);
      return originalFetch.apply(window, args);
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function open(method, url, ...rest) {
      captureUrl(url);
      return originalOpen.call(this, method, url, ...rest);
    };

    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function send(body) {
      if (typeof body === 'string') {
        captureEvent('xhr-body', body);
      }
      return originalSend.call(this, body);
    };

    const originalSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function setAttribute(name, value) {
      if (name === 'src' || name === 'href') {
        captureUrl(value);
      }
      return originalSetAttribute.call(this, name, value);
    };

    const mediaDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (mediaDescriptor && mediaDescriptor.set) {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        configurable: true,
        enumerable: mediaDescriptor.enumerable,
        get: mediaDescriptor.get,
        set(value) {
          captureUrl(value);
          return mediaDescriptor.set.call(this, value);
        },
      });
    }

    const originalPostMessage = window.postMessage;
    window.postMessage = function postMessage(message, targetOrigin, transfer) {
      if (typeof message === 'string') {
        captureEvent('postMessage', message);
      }
      return originalPostMessage.call(window, message, targetOrigin, transfer);
    };

    const originalSetItem = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = (key, value) => {
      if (typeof value === 'string') {
        captureEvent(`localStorage:${key}`, value);
      }
      return originalSetItem(key, value);
    };

    const nextFlight = window.self.__next_f = window.self.__next_f || [];
    const originalPush = nextFlight.push.bind(nextFlight);
    nextFlight.push = (...entries) => {
      for (const entry of entries) {
        if (Array.isArray(entry) && typeof entry[1] === 'string') {
          parseFlightChunk(entry[1]);
        }
      }
      return originalPush(...entries);
    };
  });
}

async function installVidfastEnvironment(page) {
  await page.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    } catch {}

    try {
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    } catch {}

    try {
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    } catch {}

    try {
      Object.defineProperty(document, 'referrer', { get: () => 'https://vidfast.pro/' });
    } catch {}

    try {
      Object.defineProperty(window, 'chrome', {
        get: () => ({ runtime: {}, app: {} }),
      });
    } catch {}

    try {
      window.localStorage.setItem('server', 'auto');
      window.localStorage.setItem('preferredServer', 'auto');
      window.localStorage.setItem('player:server', 'auto');
    } catch {}
  });
}

async function installVidfastResourceBlocking(page) {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const resourceType = request.resourceType();

    if (['image', 'font', 'stylesheet'].includes(resourceType)) {
      await route.abort();
      return;
    }

    await route.continue();
  });
}

async function installVidfastChunkPatches(page) {
  await page.route('https://vidfast.pro/_next/static/chunks/*.js', async (route) => {
    const response = await route.fetch();
    const body = await response.text();

    if (!body.includes('ap({crypto:')) {
      await route.fulfill({ response, body });
      return;
    }

    const settersNeedle = 'ap({crypto:cE,encode:c$,en:e_,server:oW,setServers:Wa,setState:oh,setFavServer:Wm,window:window';
    const apNeedle = 'async function ap(t,e){return';
    const bootstrapNeedle = 'return o(),window[at(2444,"5(XA")](c3(2853),o),ap({crypto:cE,encode:c$,en:e_,server:oW,';

    const hadSettersNeedle = body.includes(settersNeedle);
    const hadApNeedle = body.includes(apNeedle);
    const hadBootstrapNeedle = body.includes(bootstrapNeedle);

    let patchedBody = body.replace(
      settersNeedle,
      'ap({crypto:cE,encode:c$,en:e_,server:oW,setServers:(...args)=>{try{globalThis.__open_capture__.bootstrap.push(JSON.stringify({type:"setServers",value:args[0]}));}catch(e){}return Wa(...args)},setState:(...args)=>{try{globalThis.__open_capture__.bootstrap.push(JSON.stringify({type:"setState",value:args[0]}));}catch(e){}return oh(...args)},setFavServer:(...args)=>{try{globalThis.__open_capture__.bootstrap.push(JSON.stringify({type:"setFavServer",value:args[0]}));}catch(e){}return Wm(...args)},window:window',
    );

    patchedBody = patchedBody.replace(
      apNeedle,
      'async function ap(t,e){try{if(globalThis.__open_capture__){globalThis.__open_capture__.bootstrap.push(JSON.stringify({type:"ap-call",keys:Object.keys(t||{}),en:t&&t.en,server:t&&t.server,host:t&&t.host}));if(t&&typeof t.fetch==="function"){const __vfFetch=t.fetch.bind(t);t.fetch=async(...args)=>{try{globalThis.__open_capture__.bootstrap.push(JSON.stringify({type:"ap-fetch",url:(args[0]&&typeof args[0]==="object")?args[0].url:args[0],init:args[1]||null}));}catch(e){}const res=await __vfFetch(...args);try{globalThis.__open_capture__.bootstrap.push(JSON.stringify({type:"ap-fetch-response",url:res.url,status:res.status,contentType:res.headers&&res.headers.get?res.headers.get("content-type"):null,body:await res.clone().text().then(text=>text.slice(0,1200))}));}catch(e){}return res;};}if(t&&t.crypto&&t.crypto.subtle){for(const key of ["encrypt","decrypt","importKey","deriveBits","deriveKey","sign"]){if(typeof t.crypto.subtle[key]==="function"){const original=t.crypto.subtle[key].bind(t.crypto.subtle);t.crypto.subtle[key]=async(...args)=>{try{globalThis.__open_capture__.bootstrap.push(JSON.stringify({type:"ap-subtle",method:key,args:args.map(arg=>typeof arg)}));}catch(e){}return original(...args);};}}}}}catch(e){}return',
    );

    patchedBody = patchedBody.replace(
      bootstrapNeedle,
      'return o(),window[at(2444,"5(XA")](c3(2853),o),globalThis.__open_capture__&&(globalThis.__open_capture__.bootstrap.push(JSON.stringify({type:"bootstrap",en:e_,server:oW})),globalThis.__open_capture__.runtime={ap:ap,crypto:cE,encode:c$,en:e_,server:oW,setServers:Wa,setState:oh,setFavServer:Wm}),ap({crypto:cE,encode:c$,en:e_,server:oW,',
    );

    patchedBody = patchedBody.replace(
      'var aK=new Uint8Array(',
      'globalThis.__open_capture__&&(globalThis.__open_capture__.globals={ap:typeof ap!=="undefined"?ap:null,crypto:typeof cE!=="undefined"?cE:null,encode:typeof c$!=="undefined"?c$:null,bufferCtor:typeof c1!=="undefined"?c1:null});var aK=new Uint8Array(',
    );

    if (patchedBody === body) {
      logStep('vidfast', 'vidfast chunk patch skipped');
      await route.fulfill({ response, body });
      return;
    }

    logStep('vidfast', 'vidfast chunk patch applied', {
      url: route.request().url(),
      matchedSetters: hadSettersNeedle,
      matchedAp: hadApNeedle,
      matchedBootstrap: hadBootstrapNeedle,
    });
    await route.fulfill({ response, body: patchedBody });
  });
}

async function collectVidfastCapture(page, currentUrl) {
  try {
    return await page.evaluate((baseUrl) => {
      const store = window.__open_capture__ || { urls: [], events: [], bootstrap: [] };
      const html = document.documentElement ? document.documentElement.outerHTML : '';
      return {
        urls: store.urls || [],
        events: store.events || [],
        bootstrap: store.bootstrap || [],
        html,
        title: document.title || '',
        baseUrl,
      };
    }, currentUrl);
  } catch {
    return null;
  }
}

async function tryVidfastManualBootstrap(page, bootstrapData) {
  try {
    return await page.evaluate(async (bootstrapDataArg) => {
      const store = window.__open_capture__;
      const bootstrapData = bootstrapDataArg || null;

      const runtime = store && (store.runtime || store.globals && {
        ap: store.globals.ap,
        crypto: store.globals.crypto,
        encode: store.globals.encode,
        bufferCtor: store.globals.bufferCtor,
        ...bootstrapData,
        setServers: (value) => {
          store.bootstrap.push(JSON.stringify({ type: 'manual-setServers', value }));
          return value;
        },
        setState: (value) => {
          store.bootstrap.push(JSON.stringify({ type: 'manual-setState', value }));
          return value;
        },
        setFavServer: (value) => {
          store.bootstrap.push(JSON.stringify({ type: 'manual-setFavServer', value }));
          return value;
        },
      });

      if (!runtime || typeof runtime.ap !== 'function') {
        return { invoked: false, reason: 'missing-runtime' };
      }

      store.bootstrap.push(JSON.stringify({ type: 'manual-bootstrap-attempt', en: runtime.en, server: runtime.server }));

      const wrapEnvironmentProxy = (target, label) => new Proxy(target, {
        get(obj, prop, receiver) {
          const value = Reflect.get(obj, prop, receiver);
          if (value === undefined && typeof prop !== 'symbol') {
            try {
              store.bootstrap.push(JSON.stringify({ type: 'manual-missing-env', label, prop: String(prop) }));
            } catch {
              // Ignore env logging failures.
            }
          }
          if (typeof value === 'function') {
            return value.bind(obj);
          }
          return value;
        },
      });

      const bootstrapArgs = {
        crypto: runtime.crypto,
        encode: runtime.encode,
        en: runtime.en,
        server: runtime.server,
        host: runtime.host,
        ad: runtime.ad,
        from: runtime.from,
        chromecast: runtime.chromecast,
        fullscreenButton: runtime.fullscreenButton,
        hideServer: runtime.hideServer,
        sub: runtime.sub,
        mobile: runtime.mobile,
        backdrop: runtime.backdrop,
        id: runtime.id,
        title: runtime.title,
        year: runtime.year,
        progress: runtime.progress,
        autoPlay: runtime.autoPlay,
        startAt: runtime.startAt,
        theme: runtime.theme,
        setServers: runtime.setServers,
        setState: runtime.setState,
        setFavServer: runtime.setFavServer,
        window: wrapEnvironmentProxy(window, 'window'),
        document: wrapEnvironmentProxy(document, 'document'),
        navigator: wrapEnvironmentProxy(navigator, 'navigator'),
        localStorage: wrapEnvironmentProxy(localStorage, 'localStorage'),
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
        Infinity: 1 / 0,
        undefined: void 0,
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
        Buffer: runtime.bufferCtor || window.Buffer,
        atob,
        btoa,
      };

      if (bootstrapArgs.Buffer && typeof bootstrapArgs.Buffer.from === 'function') {
        const originalFrom = bootstrapArgs.Buffer.from.bind(bootstrapArgs.Buffer);
        bootstrapArgs.Buffer.from = (...args) => {
          try {
            const error = new Error('vidfast-buffer-trace');
            store.bootstrap.push(JSON.stringify({
              type: 'manual-buffer-from',
              argTypes: args.map((arg) => typeof arg),
              firstArg: typeof args[0] === 'string' ? args[0].slice(0, 300) : args[0],
              secondArg: typeof args[1] === 'string' ? args[1] : args[1],
              stack: error.stack ? error.stack.split('\n').slice(0, 6) : [],
            }));
          } catch {
            // Ignore logging failures.
          }
          return originalFrom(...args);
        };
      }

      const wrapBootstrapProxy = (target, label) => new Proxy(target, {
        get(obj, prop, receiver) {
          const value = Reflect.get(obj, prop, receiver);
          if (value === undefined && typeof prop !== 'symbol') {
            try {
              store.bootstrap.push(JSON.stringify({ type: 'manual-missing-prop', label, prop: String(prop) }));
            } catch {
              // Ignore proxy logging failures.
            }
          }
          return value;
        },
      });

      await runtime.ap(wrapBootstrapProxy(bootstrapArgs, 'arg0'), wrapBootstrapProxy(bootstrapArgs, 'arg1'));

      return { invoked: true };
    }, bootstrapData);
  } catch (error) {
    return { invoked: false, reason: error.message };
  }
}

function buildCookieHeader(cookies = []) {
  return cookies
    .filter((cookie) => cookie && cookie.name)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function collectFrameUrls(page, currentUrl) {
  const discovered = new Set();

  for (const frame of page.frames()) {
    try {
      const frameUrl = frame.url();
      if (frameUrl && frameUrl !== currentUrl && !frameUrl.startsWith('about:')) {
        discovered.add(frameUrl);
      }
    } catch {
      continue;
    }
  }

  return [...discovered];
}

function collectDomCandidates(html, baseUrl) {
  const $ = cheerio.load(html);
  const streamCandidates = collectPlayerConfigCandidates(html, baseUrl);
  const subtitleCandidates = [];
  const iframeCandidates = [];

  $('video source, source').each((_, element) => {
    const src = $(element).attr('src');
    if (src) {
      streamCandidates.push(absoluteUrl(baseUrl, src));
    }
  });

  $('track').each((_, element) => {
    const src = $(element).attr('src');
    if (!src) {
      return;
    }

    subtitleCandidates.push({
      lang: ($(element).attr('srclang') || $(element).attr('label') || '').toLowerCase(),
      url: absoluteUrl(baseUrl, src),
    });
  });

  $('iframe').each((_, element) => {
    const src = $(element).attr('src');
    if (src) {
      iframeCandidates.push(absoluteUrl(baseUrl, src));
    }
  });

  const inlineUrls = extractUrls(html, baseUrl);

  for (const url of inlineUrls) {
    if (isMediaUrl(url)) {
      streamCandidates.push(url);
    }

    if (isSubtitleUrl(url)) {
      subtitleCandidates.push({
        lang: inferSubtitleLabel(url, ''),
        url,
      });
    }
  }

  return {
    stream: pickBestStream(streamCandidates.filter(isMediaUrl)),
    subtitles: dedupeSubtitles(subtitleCandidates),
    iframes: [...new Set(iframeCandidates.filter(Boolean))],
  };
}

function scanPayloadForMedia(payload, baseUrl) {
  const textPayload = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const urls = [...extractUrls(textPayload, baseUrl), ...collectPlayerConfigCandidates(textPayload, baseUrl)];
  const stream = pickBestStream(urls.filter(isMediaUrl));
  const subtitles = dedupeSubtitles(
    urls.filter(isSubtitleUrl).map((url, index) => ({
      lang: inferSubtitleLabel(url, `track-${index + 1}`),
      url,
    })),
  );

  if (!stream) {
    return null;
  }

  return { stream, subtitles };
}

async function extractDirectMedia(url, scope) {
  if (MEDIA_URL_REGEX.test(url)) {
    logStep(scope, 'input URL is already a direct media stream');
    return {
      stream: url,
      subtitles: [],
      iframes: [],
    };
  }

  const html = await fetchText(url, { headers: { Referer: url } });

  if (/sorry, you have been blocked|cloudflare ray id|access denied/i.test(html)) {
    throw createError(403, 'PROVIDER_BLOCKED', `Provider page is blocked by anti-bot protection for ${scope}`);
  }

  const domResult = collectDomCandidates(html, url);

  if (domResult.stream) {
    logStep(scope, 'direct media found in HTML');
    return {
      stream: domResult.stream,
      subtitles: domResult.subtitles,
      iframes: domResult.iframes,
    };
  }

  return {
    stream: null,
    subtitles: domResult.subtitles,
    iframes: domResult.iframes,
  };
}

async function tryApiRequest(requestConfig, scope) {
  try {
    const payload = requestConfig.expectJson
      ? await fetchJson(requestConfig.url, requestConfig)
      : await fetchText(requestConfig.url, requestConfig);
    const result = scanPayloadForMedia(payload, requestConfig.url);

    if (!result) {
      return null;
    }

    logStep(scope, 'provider API returned media', { endpoint: requestConfig.url });
    return result;
  } catch (error) {
    logStep(scope, 'provider API request failed', {
      endpoint: requestConfig.url,
      message: error.message,
    });
    return null;
  }
}

async function getBrowser() {
  if (!browserPromise) {
    const headless = process.env.PLAYWRIGHT_HEADLESS !== 'false';

    browserPromise = chromium.launch({
      headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox',
        '--no-sandbox',
      ],
    });
  }

  return browserPromise;
}

async function browserFallback(url, source) {
  logStep(source, 'browser fallback started');

  const browser = await getBrowser();
  const browserUserAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  const context = await browser.newContext({
    extraHTTPHeaders: source === 'vidfast'
      ? {
        Referer: 'https://vidfast.pro/',
        Origin: 'https://vidfast.pro',
      }
      : undefined,
    locale: 'en-US',
    userAgent: browserUserAgent,
    viewport: { width: 1366, height: 768 },
  });
  const page = await context.newPage();

  if (source === 'vidfast') {
    await installVidfastResourceBlocking(page);
    await installVidfastEnvironment(page);
    await installVidfastChunkPatches(page);
    await installVidfastCapture(page);
  }

  const streamCandidates = new Set();
  const mediaRequestHeaders = new Map();
  const subtitles = [];
  const visitedUrls = new Set();
  const tracedNetworkUrls = new Set();
  let resolveStreamDetected;
  const streamDetected = new Promise((resolve) => {
    resolveStreamDetected = resolve;
  });

  const signalStreamDetected = () => {
    if (pickBestStream([...streamCandidates])) {
      resolveStreamDetected();
    }
  };

  const waitForStream = async (timeoutMs) => {
    if (pickBestStream([...streamCandidates])) {
      return;
    }

    await Promise.race([
      streamDetected,
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  };

  const captureUrl = (candidate) => {
    if (!candidate) {
      return;
    }

    if (isMediaUrl(candidate)) {
      streamCandidates.add(candidate);
      signalStreamDetected();
    }

    if (isSubtitleUrl(candidate)) {
      subtitles.push({
        lang: inferSubtitleLabel(candidate, `track-${subtitles.length + 1}`),
        url: candidate,
      });
    }
  };

  const captureRequest = (request) => {
    const candidate = request.url();
    const resourceType = request.resourceType();

    if (shouldTraceNetworkCandidate(source, candidate, resourceType) && !tracedNetworkUrls.has(`request:${candidate}`)) {
      tracedNetworkUrls.add(`request:${candidate}`);
      logStep(source, 'browser network request', {
        resourceType,
        method: request.method(),
        url: candidate,
      });
    }

    if (!isMediaUrl(candidate)) {
      return;
    }

    mediaRequestHeaders.set(candidate, request.headers());
    streamCandidates.add(candidate);
    signalStreamDetected();
  };

  const captureResponse = async (response) => {
    const candidate = response.url();
    captureUrl(candidate);

    const request = response.request();
    const resourceType = request.resourceType();

    if (!shouldTraceNetworkCandidate(source, candidate, resourceType) || tracedNetworkUrls.has(`response:${candidate}`)) {
      return;
    }

    tracedNetworkUrls.add(`response:${candidate}`);

    const contentType = response.headers()['content-type'] || '';
    const details = {
      resourceType,
      status: response.status(),
      contentType,
      url: candidate,
    };

    if ((resourceType === 'fetch' || resourceType === 'xhr') && /json|javascript|text/i.test(contentType)) {
      try {
        const text = await response.text();
        const preview = text.replace(/\s+/g, ' ').slice(0, 220);
        if (preview) {
          details.preview = preview;
        }
      } catch {
        // Ignore preview failures for traced responses.
      }
    }

    logStep(source, 'browser network response', details);
  };

  page.on('request', captureRequest);
  page.on('response', (response) => {
    captureResponse(response).catch(() => {});
  });

  const attemptPlayback = async (targetPage) => {
    const selectors = [
      'button[aria-label*="Play"]',
      'button[title*="Play"]',
      'button',
      '[role="button"]',
      '.jw-icon-playback',
      '.vjs-big-play-button',
      '.plyr__control--overlaid',
      '[data-plyr="play"]',
      'video',
    ];

    for (const selector of selectors) {
      try {
        const element = targetPage.locator(selector).first();
        if (await element.count()) {
          await element.click({ timeout: 1500 });
        }
      } catch {
        continue;
      }
    }

    try {
      await targetPage.evaluate(() => {
        for (const media of document.querySelectorAll('video, audio')) {
          if (typeof media.play === 'function') {
            media.muted = true;
            media.play().catch(() => {});
          }
        }
      });
    } catch {
      return;
    }
  };

  const clickHotspots = async (targetPage) => {
    const points = [
      { x: 500, y: 400 },
      { x: 640, y: 360 },
      { x: 320, y: 180 },
    ];

    for (const point of points) {
      try {
        await targetPage.mouse.click(point.x, point.y, { delay: 80 });
      } catch {
        continue;
      }
    }
  };

  const interactWithFrames = async () => {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) {
        continue;
      }

      try {
        await attemptPlayback(frame);
      } catch {
        continue;
      }
    }
  };

  const collectIframeUrls = async (baseUrl) => {
    try {
      return await page.$$eval(
        'iframe',
        (elements, currentBase) => elements
          .map((element) => element.getAttribute('src'))
          .filter(Boolean)
          .map((src) => {
            try {
              return new URL(src, currentBase).toString();
            } catch {
              return null;
            }
          })
          .filter(Boolean),
        baseUrl,
      );
    } catch {
      return [];
    }
  };

  const navigateRecursive = async (targetUrl, depth = 0) => {
    if (depth > 5 || visitedUrls.has(targetUrl)) {
      return;
    }

    visitedUrls.add(targetUrl);
    logStep(source, 'browser navigating', { depth, url: targetUrl });

    await page.goto(targetUrl, { waitUntil: source === 'vidfast' ? 'networkidle' : 'domcontentloaded', timeout: 20000 });

    if (source === 'vidlink') {
      const vidlinkApiResult = await tryVidlinkBrowserApi(page, targetUrl);

      if (vidlinkApiResult?.stream) {
        streamCandidates.add(vidlinkApiResult.stream);
        for (const subtitle of vidlinkApiResult.subtitles || []) {
          subtitles.push(subtitle);
        }
        signalStreamDetected();
        return;
      }
    }

    if (source === 'vidfast') {
      await triggerVidfastPlayback(page);
    }

    await waitForStream(1500);
    await attemptPlayback(page);
    await waitForStream(1500);
    await clickHotspots(page);
    await interactWithFrames();
    await waitForStream(source === 'vidfast' ? 5000 : 2500);

    if (source === 'vidfast') {
      const capture = await collectVidfastCapture(page, targetUrl);
      const capturedBootstrap = (() => {
        for (const entry of capture?.bootstrap || []) {
          try {
            const parsed = JSON.parse(entry);
            if (parsed && parsed.en && parsed.host && parsed.id) {
              return parsed;
            }
          } catch {
            continue;
          }
        }
        return null;
      })();
      const bootstrap = capturedBootstrap || parseVidfastFlightBootstrap(capture?.html || '', targetUrl);

      if (capture?.html) {
        if (bootstrap) {
          logStep(source, 'vidfast bootstrap discovered', bootstrap);
        }
      }

      if (capture?.bootstrap?.length) {
        logStep(source, 'vidfast captured bootstrap entries', {
          count: capture.bootstrap.length,
          entries: capture.bootstrap.slice(0, 10),
        });
      }

      for (const candidate of capture?.urls || []) {
        captureUrl(candidate);
      }

      for (const event of capture?.events || []) {
        const extracted = extractUrls(event, targetUrl);
        for (const candidate of extracted) {
          captureUrl(candidate);
        }
      }

      for (const entry of capture?.bootstrap || []) {
        const extracted = extractUrls(entry, targetUrl);
        for (const candidate of extracted) {
          captureUrl(candidate);
        }
      }

      const htmlResult = scanPayloadForMedia(capture?.html || '', targetUrl);
      if (htmlResult?.stream) {
        streamCandidates.add(htmlResult.stream);
        for (const subtitle of htmlResult.subtitles || []) {
          subtitles.push(subtitle);
        }
        signalStreamDetected();
      }

      if (!pickBestStream([...streamCandidates])) {
        const manualBootstrap = await tryVidfastManualBootstrap(page, bootstrap);
        logStep(source, 'vidfast manual bootstrap', manualBootstrap);
        const postManualCapture = await collectVidfastCapture(page, targetUrl);
        if (postManualCapture?.bootstrap?.length) {
          logStep(source, 'vidfast post-manual bootstrap entries', {
            count: postManualCapture.bootstrap.length,
            entries: postManualCapture.bootstrap.slice(0, 20),
          });
        }
        await waitForStream(5000);
      }
    }

    if (pickBestStream([...streamCandidates])) {
      return;
    }

    const nextUrls = [
      ...(await collectIframeUrls(targetUrl)),
      ...collectFrameUrls(page, targetUrl),
    ].filter(Boolean);

    for (const nextUrl of [...new Set(nextUrls)]) {
      if (visitedUrls.has(nextUrl)) {
        continue;
      }

      logStep(source, 'browser following nested frame', { depth: depth + 1, url: nextUrl });
      await navigateRecursive(nextUrl, depth + 1);

      if (pickBestStream([...streamCandidates])) {
        return;
      }
    }
  };

  try {
    await navigateRecursive(url);
    await waitForStream(source === 'vidfast' ? 5000 : 2000);

    const stream = pickBestStream([...streamCandidates]);

    if (!stream) {
      throw createError(504, 'BROWSER_NO_STREAM', 'Browser fallback did not detect a valid media stream');
    }

    const relevantCookies = await context.cookies([...visitedUrls, stream]);
    const cookieHeader = buildCookieHeader(relevantCookies);
    const capturedHeaders = mediaRequestHeaders.get(stream) || {};

    return {
      stream,
      subtitles: dedupeSubtitles(subtitles),
      headers: {
        Referer: capturedHeaders.referer || capturedHeaders.Referer,
        Origin: capturedHeaders.origin || capturedHeaders.Origin,
        Accept: capturedHeaders.accept || capturedHeaders.Accept,
        'Accept-Language': capturedHeaders['accept-language'] || capturedHeaders['Accept-Language'],
        'Sec-Fetch-Dest': capturedHeaders['sec-fetch-dest'] || capturedHeaders['Sec-Fetch-Dest'],
        'Sec-Fetch-Mode': capturedHeaders['sec-fetch-mode'] || capturedHeaders['Sec-Fetch-Mode'],
        'Sec-Fetch-Site': capturedHeaders['sec-fetch-site'] || capturedHeaders['Sec-Fetch-Site'],
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        'User-Agent': capturedHeaders['user-agent'] || capturedHeaders['User-Agent'] || browserUserAgent,
      },
    };
  } finally {
    await context.close();
  }
}

async function runProviderExtractor({ name, url, apiRequests }) {
  const directResult = await extractDirectMedia(url, name);

  if (directResult.stream) {
    return {
      stream: directResult.stream,
      subtitles: directResult.subtitles,
      source: name,
    };
  }

  const apiCandidates = typeof apiRequests === 'function' ? apiRequests(url) : [];

  if (apiCandidates.length > 0) {
    const apiResults = await Promise.all(apiCandidates.map((candidate) => tryApiRequest(candidate, name)));
    const firstApiResult = apiResults.find(Boolean);

    if (firstApiResult) {
      return {
        stream: firstApiResult.stream,
        subtitles: dedupeSubtitles([...directResult.subtitles, ...firstApiResult.subtitles]),
        source: name,
      };
    }
  }

  const browserResult = await browserFallback(url, name);

  return {
    stream: browserResult.stream,
    subtitles: dedupeSubtitles([...directResult.subtitles, ...browserResult.subtitles]),
    headers: browserResult.headers,
    source: name,
  };
}

function ensureResolved(result, fallbackSource) {
  if (!result || !result.stream) {
    throw createError(404, 'STREAM_NOT_FOUND', 'Unable to extract a playable stream from the provided URL');
  }

  return {
    stream: result.stream,
    headers: result.headers || {},
    subtitles: dedupeSubtitles(result.subtitles || []),
    source: result.source || fallbackSource,
  };
}

process.on('exit', async () => {
  if (!browserPromise) {
    return;
  }

  try {
    const browser = await browserPromise;
    await browser.close();
  } catch {
    return;
  }
});

module.exports = {
  STREAM_EXTENSIONS,
  SUBTITLE_EXTENSIONS,
  browserFallback,
  collectDomCandidates,
  createError,
  ensureResolved,
  extractDirectMedia,
  logStep,
  normalizeSubtitle,
  runProviderExtractor,
  scanPayloadForMedia,
};
