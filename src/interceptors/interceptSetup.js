import { createDetectorState, detectType, extractStreamFromPayload, isVideoContentType, isVideoUrl } from './index.js';

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

const RUNTIME_PATCH_TEMPLATES = [
  {
    name: 'expose-ap',
    find: 'function ap(t,e){return ac[c4(2928)](this,7,Array[c9(2929,"wetx")](arguments),{[c4(2249)]:void 0,[c9(2096,"xw3W")]:Object[c4(1996)]({},{[c4(501)]:{get:function(){return aL},set:function(t){aL=t},enumerable:!0},[at(1344,"#DY9")]:{get:function(){return ag},set:function(t){ag=t},enumerable:!0},[c2(2733)]:{get:function(){return aP},set:function(t){aP=t},enumerable:!0},[c5(1783)]:{get:function(){return aS},set:function(t){aS=t},enumerable:!0}})},void 0,new.target)}',
    buildReplace: ({ apKey }) =>
      `function ap(t,e){return window.${apKey}=ap,ac[c4(2928)](this,7,Array[c9(2929,"wetx")](arguments),{[c4(2249)]:void 0,[c9(2096,"xw3W")]:Object[c4(1996)]({},{[c4(501)]:{get:function(){return aL},set:function(t){aL=t},enumerable:!0},[at(1344,"#DY9")]:{get:function(){return ag},set:function(t){ag=t},enumerable:!0},[c2(2733)]:{get:function(){return aP},set:function(t){aP=t},enumerable:!0},[c5(1783)]:{get:function(){return aS},set:function(t){aS=t},enumerable:!0}})},void 0,new.target)}`
  },
  {
    name: 'expose-runtime-call',
    find: 'window[at(2444,"5(XA")](c3(2853),o),ap({crypto:cE,encode:c$,en:e_,server:oW,setServers:Wa,setState:oh,setFavServer:Wm,',
    buildReplace: ({ runtimeKey }) =>
      `window[at(2444,"5(XA")](c3(2853),o),window.${runtimeKey}={ap,crypto:cE,encode:c$,en:e_,server:oW,setServers:Wa,setState:oh,setFavServer:Wm},ap({crypto:cE,encode:c$,en:e_,server:oW,setServers:Wa,setState:oh,setFavServer:Wm,`
  },
  {
    name: 'bypass-a8-gate',
    find: 'if(!a8())return;!0===window[c3(2817)]&&Wp(!0);',
    buildReplace: ({ bypassKey }) => `window.${bypassKey}=!0;!0===window[c3(2817)]&&Wp(!0);`
  },
  {
    name: 'wrap-success-state',
    find: 'window[at(1292,eB)][at(1038,"*Zm6")]({event:at(1982,"b8d1"),data:n[at(1755,"5(XA")]},"*"),oh(2),e4&&!WQ[c2(2316)]&&fetch(',
    buildReplace: ({ runtimeKey }) =>
      `window[at(1292,eB)][at(1038,"*Zm6")]({event:at(1982,"b8d1"),data:n[at(1755,"5(XA")]},"*"),oh(2),window.${runtimeKey}&&(window.${runtimeKey}.state=2),e4&&!WQ[c2(2316)]&&fetch(`
  },
  {
    name: 'wrap-loading-state',
    find: 'let W4=()=>{var t;oh(1),oS(!0),',
    buildReplace: ({ runtimeKey }) =>
      `let W4=()=>{var t;oh(1),window.${runtimeKey}&&(window.${runtimeKey}.state=1),oS(!0),`
  },
  {
    name: 'wrap-reset-state',
    find: 'oS(!1),oh(0),e6){',
    buildReplace: ({ runtimeKey }) =>
      `oS(!1),oh(0),window.${runtimeKey}&&(window.${runtimeKey}.state=0),e6){`
  }
];

const RUNTIME_REGEX_PATCH_TEMPLATES = [
  {
    name: 'runtime-call-regex',
    pattern:
      /([A-Za-z_$][\w$]*)\(\{crypto:([A-Za-z_$][\w$]*),encode:([A-Za-z_$][\w$]*),en:([A-Za-z_$][\w$]*),server:([A-Za-z_$][\w$]*),setServers:([A-Za-z_$][\w$]*),setState:([A-Za-z_$][\w$]*),setFavServer:([A-Za-z_$][\w$]*),/g,
    buildReplace: ({ runtimeKey, apKey }) =>
      `window.${runtimeKey}={ap:$1,crypto:$2,encode:$3,en:$4,server:$5,setServers:$6,setState:$7,setFavServer:$8},window.${apKey}=$1,$1({crypto:$2,encode:$3,en:$4,server:$5,setServers:$6,setState:$7,setFavServer:$8,`
  },
  {
    name: 'loading-state-regex',
    pattern: /([A-Za-z_$][\w$]*)\(1\),([A-Za-z_$][\w$]*)\(!0\),/g,
    buildReplace: ({ runtimeKey }) =>
      `$1(1),window.${runtimeKey}&&(window.${runtimeKey}.state=1),$2(!0),`
  },
  {
    name: 'bypass-gate-regex',
    pattern: /if\(!([A-Za-z_$][\w$]*)\(\)\)return;!0===window\[/g,
    buildReplace: ({ bypassKey }) =>
      `window.${bypassKey}=!0;!0===window[`
  }
];

function isVidfastUrl(url) {
  try {
    return /(^|\.)vidfast\.(pro|in|io|me|net|pm|xyz)$/i.test(new URL(String(url || '')).hostname);
  } catch {
    return false;
  }
}

function isVidcoreUrl(url) {
  try {
    return /(^|\.)vidcore\.net$/i.test(new URL(String(url || '')).hostname);
  } catch {
    return false;
  }
}

function isVideasyUrl(url) {
  return /player\.videasy\.net/i.test(String(url || ''));
}

function getRuntimePatchTarget(targetUrl) {
  if (isVidfastUrl(targetUrl)) {
    return {
      label: 'vidfast',
      runtimeKey: '__VIDFAST_RUNTIME__',
      apKey: '__VIDFAST_AP__',
      bypassKey: '__VIDFAST_BYPASS__'
    };
  }

  if (isVidcoreUrl(targetUrl)) {
    return {
      label: 'vidcore',
      runtimeKey: '__VIDCORE_RUNTIME__',
      apKey: '__VIDCORE_AP__',
      bypassKey: '__VIDCORE_BYPASS__'
    };
  }

  return null;
}

function shouldBlockVideasyNavigation(targetUrl, request) {
  if (!isVideasyUrl(targetUrl)) {
    return false;
  }

  if (request.resourceType() !== 'document' || !request.isNavigationRequest()) {
    return false;
  }

  try {
    const hostname = new URL(request.url()).hostname;
    return !/(^|\.)videasy\.net$/i.test(hostname);
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
    return !/(^|\.)vidfast\.(pro|in|io|me|net|pm|xyz)$/i.test(requestHost);
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
    if (requestHost === 'umami.vidfast.pro') {
      return true;
    }

    return !/(^|\.)vidfast\.(pro|in|io|me|net|pm|xyz)$/i.test(requestHost);
  } catch {
    return false;
  }
}

function shouldBlockVidfastRequest(targetUrl, request) {
  if (!isVidfastUrl(targetUrl)) {
    return false;
  }

  try {
    const parsed = new URL(request.url());
    return (
      parsed.hostname === 'umami.vidfast.pro' ||
      parsed.hostname === 'www.gstatic.com'
    );
  } catch {
    return false;
  }
}

function shouldPatchRuntimeScript(targetUrl, request) {
  if (!getRuntimePatchTarget(targetUrl) || request.resourceType() !== 'script') {
    return false;
  }

  try {
    const parsed = new URL(request.url());
    const expectedHost = isVidcoreUrl(targetUrl)
      ? /(^|\.)vidcore\.net$/i
      : /(^|\.)vidfast\.(pro|in|io|me|net|pm|xyz)$/i;
    return expectedHost.test(parsed.hostname) && parsed.pathname.includes('/_next/static/chunks/');
  } catch {
    return false;
  }
}

async function maybePatchRuntimeScript(route, targetUrl) {
  const patchTarget = getRuntimePatchTarget(targetUrl);

  if (!patchTarget || !shouldPatchRuntimeScript(targetUrl, route.request())) {
    return false;
  }

  const response = await route.fetch();
  let body = await response.text();
  const appliedPatches = [];
  const responseHeaders = { ...response.headers() };

  delete responseHeaders['content-encoding'];
  delete responseHeaders['content-length'];
  delete responseHeaders['transfer-encoding'];

  for (const patch of RUNTIME_PATCH_TEMPLATES) {
    if (body.includes(patch.find)) {
      body = body.replace(patch.find, patch.buildReplace(patchTarget));
      appliedPatches.push(patch.name);
    }
  }

  for (const patch of RUNTIME_REGEX_PATCH_TEMPLATES) {
    const nextBody = body.replace(patch.pattern, patch.buildReplace(patchTarget));

    if (nextBody !== body) {
      body = nextBody;
      appliedPatches.push(patch.name);
    }
  }

  if (!appliedPatches.length) {
    await route.fulfill({
      response,
      body,
      headers: responseHeaders
    });
    return true;
  }

  console.log(new Date().toISOString(), `[${patchTarget.label}] patched runtime chunk`, route.request().url(), appliedPatches.join(','));
  await route.fulfill({
    response,
    body,
    headers: {
      ...responseHeaders,
      'content-type': 'application/javascript; charset=utf-8'
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

    if (shouldBlockVideasyNavigation(targetUrl, request)) {
      console.log(new Date().toISOString(), '[videasy] blocked navigation', url);
      await route.abort().catch(() => undefined);
      return;
    }

    if (shouldBlockVidfastScript(targetUrl, request)) {
      console.log(new Date().toISOString(), '[vidfast] blocked script', url);
      await route.abort().catch(() => undefined);
      return;
    }

    if (shouldBlockVidfastRequest(targetUrl, request)) {
      console.log(new Date().toISOString(), '[vidfast] blocked request', url);
      await route.abort().catch(() => undefined);
      return;
    }

    if (await maybePatchRuntimeScript(route, targetUrl).catch(() => false)) {
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
