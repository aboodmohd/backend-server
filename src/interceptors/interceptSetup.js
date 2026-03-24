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

function isVidfastUrl(url) {
  return String(url || '').includes('vidfast.pro');
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
