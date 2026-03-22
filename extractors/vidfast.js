const { getBrowser } = require("./browser.js");
const { isStream } = require("./streamDetector.js");
const { createError } = require("./shared.js");

const cache = new Map();

async function extractVidfast(url) {
  let targetUrl = url;
  try {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith('/movie/') || parsed.pathname.startsWith('/tv/')) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      parsed.pathname = '/embed/' + parts.slice(1).join('/');
      parsed.searchParams.set('autoPlay', 'true');
      targetUrl = parsed.toString();
    }
  } catch (e) {
    // ignore
  }

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
  });
  const page = await context.newPage();

  console.log('[vidfast] Extracting from targetUrl:', targetUrl);

  let stream = null;

  // await page.route("**/*", async (route) => {
  //   const type = route.request().resourceType();
  //   if (type === "image" || type === "font" || type === "stylesheet") {
  //     await route.abort().catch(() => {});
  //   } else {
  //     await route.continue().catch(() => {});
  //   }
  // });

  page.on("response", async (res) => {
    const u = res.url();
    if (u.includes('api') || u.includes('stream') || u.includes('m3u8') || u.endsWith('js')) {
      console.log('[vidfast] response:', u);
    }
    if (isStream(u)) {
      console.log('[vidfast] found stream:', u);
      stream = u;
    }
  });

  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
  } catch (err) {
    console.error('[vidfast] goto error:', err.message);
  }

  try {
    await page.waitForFunction(
      () => window.document.readyState === "complete" || window.document.readyState === "interactive",
      { timeout: 10000 }
    );
  } catch (e) {}

  const title = await page.title();
  const html = await page.content();
  console.log('[vidfast] page title:', title, 'html length:', html.length);
  await page.screenshot({ path: '/Users/abdullahmohd/Desktop/NOVA/backend/vidfast-debug.png' });

  if (stream) {
    await context.close().catch(() => {});
    return stream;
  }

  if (!stream) {
    let waitTime = 0;
    while (!stream && waitTime < 10000) {
      await new Promise(r => setTimeout(r, 500));
      waitTime += 500;
    }
  }

  console.log(`[vidfast] Finished polling. Stream =`, stream);
  await context.close().catch(() => {});
  return stream;
}

module.exports = async function resolveVidfast(url) {
  if (cache.has(url)) {
    return { stream: cache.get(url), source: 'vidfast' };
  }

  const stream = await extractVidfast(url);

  if (stream) {
    cache.set(url, stream);
    return { stream, source: 'vidfast' };
  }

  throw createError(404, 'STREAM_NOT_FOUND', 'Vidfast did not expose a playable stream from this environment');
};
