import { createDetectorState, detectType, extractStreamFromPayload, isVideoContentType, isVideoUrl } from './index.js';
import { fetchVideasyThroughProxy, shouldUseVideasyProxy } from '../utils/proxyFetch.js';

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'stylesheet']);
const BLOCKED_URL_PATTERNS = [
  'google-analytics.com',
  'googletagmanager.com',
  'doubleclick.net',
  'umami.',
  '/cdn-cgi/rum',
  'mc.yandex.ru',
  'f.clarity.ms'
];

const VIDFAST_RUNTIME_PATCHES = [
  {
    name: 'expose-ap',
    find: 'function ap(t,e){return ac[c4(2928)](this,7,Array[c9(2929,"wetx")](arguments),{[c4(2249)]:void 0,[c9(2096,"xw3W")]:Object[c4(1996)]({},{[c4(501)]:{get:function(){return aL},set:function(t){aL=t},enumerable:!0},[at(1344,"#DY9")]:{get:function(){return ag},set:function(t){ag=t},enumerable:!0},[c2(2733)]:{get:function(){return aP},set:function(t){aP=t},enumerable:!0},[c5(1783)]:{get:function(){return aS},set:function(t){aS=t},enumerable:!0}})},void 0,new.target)}',
    replace:
      'function ap(t,e){return window.__VIDFAST_AP__=ap,ac[c4(2928)](this,7,Array[c9(2929,"wetx")](arguments),{[c4(2249)]:void 0,[c9(2096,"xw3W")]:Object[c4(1996)]({},{[c4(501)]:{get:function(){return aL},set:function(t){aL=t},enumerable:!0},[at(1344,"#DY9")]:{get:function(){return ag},set:function(t){ag=t},enumerable:!0},[c2(2733)]:{get:function(){return aP},set:function(t){aP=t},enumerable:!0},[c5(1783)]:{get:function(){return aS},set:function(t){aS=t},enumerable:!0}})},void 0,new.target)}'
  },
  {
    name: 'expose-runtime-call',
    find: 'window[at(2444,"5(XA")](c3(2853),o),ap({crypto:cE,encode:c$,en:e_,server:oW,setServers:Wa,setState:oh,setFavServer:Wm,',
    replace:
      'window[at(2444,"5(XA")](c3(2853),o),window.__VIDFAST_RUNTIME__={ap,crypto:cE,encode:c$,en:e_,server:oW,setServers:Wa,setState:oh,setFavServer:Wm},ap({crypto:cE,encode:c$,en:e_,server:oW,setServers:Wa,setState:oh,setFavServer:Wm,'
  },
  {
    name: 'bypass-a8-gate',
    find: 'if(!a8())return;!0===window[c3(2817)]&&Wp(!0);',
    replace: 'window.__VIDFAST_BYPASS__=!0;!0===window[c3(2817)]&&Wp(!0);'
  },
  {
    name: 'wrap-success-state',
    find: 'window[at(1292,eB)][at(1038,"*Zm6")]({event:at(1982,"b8d1"),data:n[at(1755,"5(XA")]},"*"),oh(2),e4&&!WQ[c2(2316)]&&fetch(',
    replace:
      'window[at(1292,eB)][at(1038,"*Zm6")]({event:at(1982,"b8d1"),data:n[at(1755,"5(XA")]},"*"),oh(2),window.__VIDFAST_RUNTIME__&&(window.__VIDFAST_RUNTIME__.state=2),e4&&!WQ[c2(2316)]&&fetch('
  },
  {
    name: 'wrap-loading-state',
    find: 'let W4=()=>{var t;oh(1),oS(!0),',
    replace: 'let W4=()=>{var t;oh(1),window.__VIDFAST_RUNTIME__&&(window.__VIDFAST_RUNTIME__.state=1),oS(!0),'
  },
  {
    name: 'wrap-reset-state',
    find: 'oS(!1),oh(0),e6){',
    replace: 'oS(!1),oh(0),window.__VIDFAST_RUNTIME__&&(window.__VIDFAST_RUNTIME__.state=0),e6){'
  }
];

function isVidfastUrl(url) {
  return String(url || '').includes('vidfast.pro');
}

function isVideasyUrl(url) {
  return /player\.videasy\.net/i.test(String(url || ''));
}

function shouldProxyVideasyApi(targetUrl, request) {
  if (!isVideasyUrl(targetUrl) || request.resourceType() !== 'fetch') {
    return false;
  }

  return /https:\/\/api\d?\.videasy\.net\/.+\/sources-with-title\?/i.test(request.url());
}

function shouldBlockVideasyScript(targetUrl, request) {
  if (!isVideasyUrl(targetUrl) || request.resourceType() !== 'script') {
    return false;
  }

  try {
    const parsed = new URL(request.url());
    if (parsed.hostname !== 'player.videasy.net') {
      return true;
    }

    return parsed.pathname === '/scripts/gk.js';
  } catch {
    return false;
  }
}

function shouldBlockVidfastNavigation(targetUrl, request) {
  if (!isVidfastUrl(targetUrl)) {
    return false;
  }

  if (request.resourceType() !== 'document' || !request.isNavigationRequest()) {
    return false;
  }

  try {
    const requestHost = new URL(request.url()).hostname;
    return requestHost !== 'vidfast.pro';
  } catch {
    return false;
  }
}

function shouldBlockVidfastScript(targetUrl, request) {
  if (!isVidfastUrl(targetUrl) || request.resourceType() !== 'script') {
    return false;
  }

  try {
    const requestHost = new URL(request.url()).hostname;
    return requestHost !== 'vidfast.pro';
  } catch {
    return false;
  }
}

function shouldPatchVidfastScript(targetUrl, request) {
  if (!isVidfastUrl(targetUrl) || request.resourceType() !== 'script') {
    return false;
  }

  try {
    const parsed = new URL(request.url());
    return parsed.hostname === 'vidfast.pro' && parsed.pathname.includes('/_next/static/chunks/');
  } catch {
    return false;
  }
}

async function maybePatchVidfastScript(route, targetUrl) {
  if (!shouldPatchVidfastScript(targetUrl, route.request())) {
    return false;
  }

  const response = await route.fetch();
  let body = await response.text();
  const appliedPatches = [];

  for (const patch of VIDFAST_RUNTIME_PATCHES) {
    if (body.includes(patch.find)) {
      body = body.replace(patch.find, patch.replace);
      appliedPatches.push(patch.name);
    }
  }

  if (!appliedPatches.length) {
    await route.fulfill({ response, body });
    return true;
  }

  console.log(new Date().toISOString(), '[vidfast] patched runtime chunk', route.request().url(), appliedPatches.join(','));
  await route.fulfill({
    response,
    body,
    headers: {
      ...response.headers(),
      'content-type': 'application/javascript; charset=utf-8'
    }
  });
  return true;
}

async function maybeProxyVideasyApi(route, targetUrl) {
  if (!shouldProxyVideasyApi(targetUrl, route.request())) {
    return false;
  }

  const request = route.request();
  const upstream = await fetchVideasyThroughProxy(request.url(), {
    method: request.method(),
    headers: {
      ...request.headers(),
      origin: 'https://player.videasy.net',
      referer: 'https://player.videasy.net/'
    }
  });
  console.log(
    new Date().toISOString(),
    shouldUseVideasyProxy() ? '[videasy] proxied api via env proxy' : '[videasy] proxied api',
    request.url(),
    upstream.status,
    upstream.proxyUrl || 'direct'
  );

  await route.fulfill({
    status: upstream.status,
    body: upstream.body,
    headers: {
      ...upstream.headers,
      'access-control-allow-origin': 'https://player.videasy.net',
      'access-control-allow-methods': 'GET,HEAD,OPTIONS',
      'access-control-allow-headers': '*',
      vary: 'Origin'
    }
  });

  return true;
}

export async function setupInterceptors(page, targetUrl, onFound) {
  const state = createDetectorState();
  const context = page.context();
  const isVidfastTarget = isVidfastUrl(targetUrl);

  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    const resourceType = request.resourceType();

    if (['document', 'fetch', 'xhr', 'media'].includes(resourceType)) {
      console.log(new Date().toISOString(), '[request]', resourceType, url);
    }

    if (shouldBlockVidfastNavigation(targetUrl, request)) {
      console.log(new Date().toISOString(), '[vidfast] blocked navigation', url);
      await route.abort().catch(() => undefined);
      return;
    }

    if (shouldBlockVidfastScript(targetUrl, request)) {
      console.log(new Date().toISOString(), '[vidfast] blocked script', url);
      await route.abort().catch(() => undefined);
      return;
    }

    if (shouldBlockVideasyScript(targetUrl, request)) {
      console.log(new Date().toISOString(), '[videasy] blocked script', url);
      await route.abort().catch(() => undefined);
      return;
    }

    if (await maybePatchVidfastScript(route, targetUrl).catch(() => false)) {
      return;
    }

    if (await maybeProxyVideasyApi(route, targetUrl).catch(() => false)) {
      return;
    }

    if (isVideoUrl(url, state)) {
      onFound({
        url,
        type: detectType(url),
        headers: request.headers(),
        foundAt: new Date().toISOString(),
        via: 'request'
      });
    }

    if (
      (!isVidfastTarget && BLOCKED_RESOURCE_TYPES.has(resourceType)) ||
      (!isVidfastTarget && BLOCKED_URL_PATTERNS.some((pattern) => url.includes(pattern)))
    ) {
      await route.abort().catch(() => undefined);
      return;
    }

    await route.continue();
  });

  page.on('response', async (response) => {
    const url = response.url();
    const contentType = response.headers()['content-type'] || '';

    if (['document', 'fetch', 'xhr', 'media'].includes(response.request().resourceType())) {
      console.log(new Date().toISOString(), '[response]', response.request().resourceType(), response.status(), contentType, url);
    }

    if (isVideoUrl(url, state) || isVideoContentType(contentType)) {
      onFound({
        url,
        type: detectType(url, contentType),
        headers: {
          ...response.request().headers(),
          ...response.headers()
        },
        foundAt: new Date().toISOString(),
        via: 'response',
        contentType
      });
      return;
    }

    if (!/json|javascript|text/i.test(contentType)) {
      return;
    }

    try {
      const body = await response.text();
      const payloadUrl = extractStreamFromPayload(body);
      if (!payloadUrl || !isVideoUrl(payloadUrl, state)) {
        return;
      }

      onFound({
        url: payloadUrl,
        type: detectType(payloadUrl, contentType),
        headers: {
          ...response.request().headers(),
          ...response.headers()
        },
        foundAt: new Date().toISOString(),
        via: 'payload',
        contentType
      });
    } catch {
      // ignore unreadable bodies
    }
  });
}
