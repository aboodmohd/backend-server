import { createDetectorState, detectType, extractStreamFromPayload, isVideoContentType, isVideoUrl } from './index.js';

export async function setupInterceptors(page, onFound) {
  const state = createDetectorState();

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();

    if (['document', 'fetch', 'xhr', 'media'].includes(request.resourceType())) {
      console.log(new Date().toISOString(), '[request]', request.resourceType(), url);
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
