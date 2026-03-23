import { createDetectorState, detectType, isVideoContentType, isVideoUrl } from './index.js';

export async function setupInterceptors(page, onFound) {
  const state = createDetectorState();

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();

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
    }
  });
}
