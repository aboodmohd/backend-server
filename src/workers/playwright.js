import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import CryptoJS from 'crypto-js';
import { existsSync } from 'node:fs';
import { setupInterceptors } from '../interceptors/interceptSetup.js';
import { detectType, extractStreamFromPayload } from '../interceptors/index.js';

chromium.use(StealthPlugin());

let browserPromise;
let videasySessionCache = null;
let vidkingSessionCache = null;
let vidfastSessionCache = null;
const VIDEASY_UPSTREAM_BLOCKED = 'VIDEASY_UPSTREAM_BLOCKED';

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

const VIDFUN_SERVER_LABELS = [
  'Palermo',
  'Berlin',
  'Denver',
  'Bogota',
  'Oslo',
  'Luna',
  'LordFlix',
  'Sakura',
  'Rio'
];
const VIDFUN_DEFAULT_SERVER = 'Berlin';

const NON_STREAM_ASSET_PATTERNS = [
  /(?:^|\/)_(?:build|ssg|middleware)manifest\.js(?:\?|$)/i,
  /\.(?:js|mjs|cjs|css|map|json|txt|svg|png|jpe?g|gif|webp|ico|wasm|woff2?|ttf)(?:\?|$)/i,
  /\/favicon\.ico(?:\?|$)/i
];

function parsePlaybackEmbeddedHost(targetUrl = '') {
  try {
    const parsed = new URL(targetUrl);
    const hostParam = parsed.searchParams.get('__proxy_host') || parsed.searchParams.get('host') || '';
    if (!hostParam) {
      return '';
    }

    return hostParam.includes('://') ? new URL(hostParam).toString() : `https://${hostParam}`;
  } catch {
    return '';
  }
}

function parsePlaybackEmbeddedOrigins(targetUrl = '') {
  try {
    const parsed = new URL(targetUrl);
    const encodedHeaders = parsed.searchParams.get('__proxy_headers') || parsed.searchParams.get('headers') || '';
    if (!encodedHeaders) {
      return [];
    }

    let decoded = encodedHeaders;
    try {
      decoded = decodeURIComponent(encodedHeaders);
    } catch {}

    const headers = JSON.parse(decoded);
    return ['origin', 'referer']
      .map((key) => String(headers?.[key] || '').trim())
      .filter(Boolean)
      .map((value) => new URL(value).origin)
      .filter((value, index, entries) => entries.indexOf(value) === index);
  } catch {
    return [];
  }
}

function buildCookieHeader(cookies = []) {
  const now = Date.now();
  return cookies
    .filter((cookie) => (
      cookie?.name &&
      cookie?.value &&
      (cookie.expires == null || cookie.expires < 0 || cookie.expires * 1000 > now)
    ))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function getUrlOrigin(value = '') {
  try {
    return new URL(String(value || '')).origin;
  } catch {
    return '';
  }
}

function getPlaybackCookieOrigins(targetUrl = '', playbackUrl = '') {
  const playbackOrigins = [
    getUrlOrigin(playbackUrl),
    getUrlOrigin(parsePlaybackEmbeddedHost(playbackUrl)),
    ...parsePlaybackEmbeddedOrigins(playbackUrl)
  ].filter(Boolean);

  const origins = playbackOrigins.length ? playbackOrigins : [getUrlOrigin(targetUrl)].filter(Boolean);
  return origins.filter((origin, index, entries) => entries.indexOf(origin) === index);
}

async function readPlaybackCookieHeader(context, targetUrl = '', playbackUrl = '') {
  const origins = getPlaybackCookieOrigins(targetUrl, playbackUrl);
  if (!origins.length) {
    return '';
  }

  const cookies = await context.cookies(origins).catch(() => []);
  return buildCookieHeader(cookies);
}

function getVidlinkPlaybackHeaders(playbackUrl = '', headers = {}) {
  const nextHeaders = {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    ...getRealisticClientHints(),
    ...(headers || {})
  };

  try {
    const parsed = new URL(playbackUrl);
    const encodedHeaders = parsed.searchParams.get('__proxy_headers') || parsed.searchParams.get('headers') || '';
    if (encodedHeaders) {
      let decoded = encodedHeaders;
      try {
        decoded = decodeURIComponent(encodedHeaders);
      } catch {}

      const embeddedHeaders = JSON.parse(decoded);
      Object.assign(nextHeaders, embeddedHeaders || {});
    }
  } catch {
    // Ignore malformed playback URLs and keep existing headers.
  }

  return nextHeaders;
}

async function warmPlaybackSession(context, playbackUrl = '') {
  const targetOrigins = [
    playbackUrl,
    parsePlaybackEmbeddedHost(playbackUrl),
    ...parsePlaybackEmbeddedOrigins(playbackUrl)
  ].filter(Boolean);
  if (!targetOrigins.length) {
    return '';
  }

  const page = await context.newPage();

  try {
    await page.goto(playbackUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    }).catch(() => undefined);

    await page.waitForTimeout(1500).catch(() => undefined);

    const cookies = await context.cookies(targetOrigins).catch(() => []);
    return buildCookieHeader(cookies);
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function enrichPlaybackResult(targetUrl, result, context) {
  if (!result?.url) {
    return result;
  }

  const isVidlinkTarget = isVidlinkUrl(targetUrl);
  const baseHeaders = isVidlinkTarget
    ? getVidlinkPlaybackHeaders(result.url, result.headers || {})
    : { ...(result.headers || {}) };

  if (baseHeaders.cookie) {
    return {
      ...result,
      headers: baseHeaders
    };
  }

  let cookieHeader = await readPlaybackCookieHeader(context, targetUrl, result.url);
  if (!cookieHeader && isVidlinkTarget) {
    cookieHeader = await Promise.race([
      warmPlaybackSession(context, result.url).catch(() => ''),
      new Promise((resolve) => setTimeout(() => resolve(''), 1200))
    ]);
  }

  if (!cookieHeader) {
    return {
      ...result,
      headers: baseHeaders
    };
  }

  return {
    ...result,
    headers: {
      ...baseHeaders,
      cookie: cookieHeader,
      'x-playback-cookie-source': 'playwright',
      'user-agent': getDefaultUserAgent(),
      ...getRealisticClientHints()
    }
  };
}

function clearBrowserState(reason = '') {
  if (reason) {
    console.log(new Date().toISOString(), '[browser] reset', reason);
  }

  browserPromise = null;
}

async function closeCachedBrowser(reason = '') {
  const activeBrowserPromise = browserPromise;
  clearBrowserState(reason);

  if (!activeBrowserPromise) {
    return;
  }

  try {
    const activeBrowser = await activeBrowserPromise;
    if (activeBrowser?.isConnected?.()) {
      await activeBrowser.close().catch(() => undefined);
    }
  } catch {
    // Ignore launch/close failures while resetting the cached browser.
  }
}

function getLaunchOptions(options = {}) {
  const args = ['--disable-dev-shm-usage'];

  if (process.platform === 'linux') {
    args.push('--no-sandbox', '--disable-setuid-sandbox');
  }

  return {
    headless: options.headless ?? true,
    args
  };
}

function getInstalledBrowserExecutableCandidates() {
  const envCandidates = [
    process.env.NOVA_BROWSER_EXECUTABLE,
    process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    process.env.CHROME_EXECUTABLE_PATH,
    process.env.BRAVE_EXECUTABLE_PATH
  ].filter(Boolean);

  if (process.platform === 'darwin') {
    return [
      ...envCandidates,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ].filter((candidate, index, entries) => entries.indexOf(candidate) === index && existsSync(candidate));
  }

  if (process.platform === 'win32') {
    return [
      ...envCandidates,
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ].filter((candidate, index, entries) => entries.indexOf(candidate) === index && existsSync(candidate));
  }

  return [
    ...envCandidates,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/brave-browser',
    '/snap/bin/chromium'
  ].filter((candidate, index, entries) => entries.indexOf(candidate) === index && existsSync(candidate));
}

function getLaunchCandidates(options = {}) {
  const baseOptions = getLaunchOptions(options);
  const candidates = [];
  const installedExecutables = getInstalledBrowserExecutableCandidates();

  for (const executablePath of installedExecutables) {
    candidates.push({
      label: `system:${executablePath.split(/[\\/]/).pop() || 'browser'}`,
      options: {
        ...baseOptions,
        executablePath
      }
    });
  }

  if (process.platform === 'darwin' || process.platform === 'win32') {
    candidates.push({
      label: 'channel:chrome',
      options: {
        ...baseOptions,
        channel: 'chrome'
      }
    });
  }

  const explicitExecutablePath = typeof chromium.executablePath === 'function' ? chromium.executablePath() : '';

  if (explicitExecutablePath) {
    candidates.push({
      label: 'explicit-executable',
      options: {
        ...baseOptions,
        executablePath: explicitExecutablePath
      }
    });
  } else {
    candidates.push({
      label: 'channel-chromium',
      options: {
        ...baseOptions,
        channel: 'chromium'
      }
    });
  }

  candidates.push({
    label: 'default',
    options: baseOptions
  });

  return candidates;
}

async function launchBrowser(options = {}) {
  let lastError = null;

  for (const candidate of getLaunchCandidates(options)) {
    try {
      const browser = await chromium.launch(candidate.options);
      console.log(
        new Date().toISOString(),
        '[browser] launched',
        candidate.label,
        candidate.options.executablePath || candidate.options.channel || 'managed'
      );
      browser.on('disconnected', () => {
        clearBrowserState('disconnected');
      });
      return browser;
    } catch (error) {
      lastError = error;
      console.log(new Date().toISOString(), '[browser] launch failed', candidate.label, error?.message || String(error));
    }
  }

  throw lastError;
}

async function getBrowser(options = {}) {
  if (browserPromise) {
    try {
      const browser = await browserPromise;
      if (browser?.isConnected?.()) {
        return browser;
      }
    } catch (error) {
      console.log(new Date().toISOString(), '[browser] cached launch failed', error?.message || String(error));
    }

    clearBrowserState('stale');
  }

  browserPromise = launchBrowser(options).catch((error) => {
    clearBrowserState('launch-error');
    throw error;
  });

  return browserPromise;
}

async function createBrowserContext(contextOptions = {}, launchOptions = {}) {
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const browser = await getBrowser(launchOptions);
      return await browser.newContext(contextOptions);
    } catch (error) {
      lastError = error;

      if (!isExpectedCloseError(error)) {
        throw error;
      }

      console.log(new Date().toISOString(), '[browser] newContext retry', attempt + 1, error?.message || String(error));
      await closeCachedBrowser('new-context-failed');
    }
  }

  throw lastError;
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
    'mc.yandex.ru',
    'f.clarity.ms'
  ].some((pattern) => url.includes(pattern));
}

function isVidfastUrl(url) {
  try {
    return /(^|\.)vidfast\.(pro|in|io|me|net|pm|xyz)$/i.test(new URL(String(url || '')).hostname);
  } catch {
    return false;
  }
}

function isVidlinkUrl(url) {
  try {
    return /(^|\.)vidlink\.pro$/i.test(new URL(String(url || '')).hostname);
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

function isMegaplayUrl(url) {
  try {
    return /(^|\.)megaplay\.buzz$/i.test(new URL(String(url || '')).hostname);
  } catch {
    return false;
  }
}

function isMegaplaySourcesApiUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return /(^|\.)megaplay\.buzz$/i.test(parsed.hostname) && parsed.pathname === '/stream/getSources';
  } catch {
    return false;
  }
}

function isMegaplayStreamHostUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return /streamzone\d*\.site/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

function isVidfunUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return /(^|\.)vidfun\.pro$/i.test(parsed.hostname) && /\/(?:movie|tv)\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function normalizeVidfunServerName(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!normalized) {
    return '';
  }

  return VIDFUN_SERVER_LABELS.find((label) => label.toLowerCase().replace(/[\s_-]+/g, '') === normalized) || '';
}

function getRequestedVidfunServer(targetUrl = '') {
  try {
    const parsed = new URL(String(targetUrl || ''));
    return normalizeVidfunServerName(parsed.searchParams.get('novaServer') || parsed.searchParams.get('server') || '') || VIDFUN_DEFAULT_SERVER;
  } catch {
    return VIDFUN_DEFAULT_SERVER;
  }
}

function isVidfunHlsResult(result = {}) {
  return (
    String(result?.type || '').toUpperCase() === 'HLS' ||
    /mpegurl/i.test(String(result?.contentType || '')) ||
    /workers\.dev\/content\?/i.test(String(result?.url || ''))
  );
}

function normalizeVidfunQualityLabel(value = '') {
  const text = String(value || '').trim();
  if (/^4k$/i.test(text)) return '2160p';
  if (/^2k$/i.test(text)) return '1440p';

  const height = text.match(/(\d{3,4})/);
  if (height?.[1]) {
    return `${height[1]}p`;
  }

  return text;
}

function getVidfunQualityRank(label = '') {
  if (/^4k$/i.test(label)) return 2160;
  if (/^2k$/i.test(label)) return 1440;
  return Number.parseInt(String(label || '').replace(/\D/g, ''), 10) || 0;
}

function sortVidfunQualityLabels(labels = []) {
  return [...labels].sort((left, right) => getVidfunQualityRank(right) - getVidfunQualityRank(left));
}

function normalizeVideasyQualityLabel(value = '') {
  return normalizeVidfunQualityLabel(value);
}

function sortVideasyQualityLabels(labels = []) {
  return sortVidfunQualityLabels(labels);
}

function isVideasyHlsResult(result = {}) {
  return (
    String(result?.type || '').toUpperCase() === 'HLS' ||
    /mpegurl/i.test(String(result?.contentType || '')) ||
    /\.m3u8(?:$|[?#])/i.test(String(result?.url || ''))
  );
}

function buildVidfunQualityEntries(labels = [], candidates = []) {
  const primaryCandidate = candidates.find((entry) => isVidfunHlsResult(entry));
  if (!primaryCandidate) {
    return [];
  }

  const explicitLabels = sortVidfunQualityLabels(labels)
    .map(normalizeVidfunQualityLabel)
    .filter((label) => label && !/^auto$/i.test(label));
  const seen = new Set();

  return explicitLabels
    .map((label) => {
      const match = candidates.find((entry) => normalizeVidfunQualityLabel(entry?.qualityLabel || '') === label) ||
        (label === explicitLabels[0] ? primaryCandidate : null);

      if (!match?.url) {
        return null;
      }

      const key = `${label}:${match.url}`;
      if (seen.has(key)) {
        return null;
      }
      seen.add(key);

      return {
        label,
        quality: label,
        url: match.url,
        type: 'HLS',
        headers: match.headers || {},
        isDefault: false
      };
    })
    .filter(Boolean);
}

function buildVideasyQualityEntries(labels = [], candidates = []) {
  const primaryCandidate = candidates.find((entry) => isVideasyHlsResult(entry));
  if (!primaryCandidate) {
    return [];
  }

  const explicitLabels = sortVideasyQualityLabels(labels)
    .map(normalizeVideasyQualityLabel)
    .filter((label) => label && !/^auto$/i.test(label));
  const seen = new Set();

  return explicitLabels
    .map((label) => {
      const match = candidates.find((entry) => normalizeVideasyQualityLabel(entry?.qualityLabel || '') === label);

      if (!match?.url) {
        return null;
      }

      const key = `${label}:${match.url}`;
      if (seen.has(key)) {
        return null;
      }
      seen.add(key);

      return {
        label,
        quality: label,
        url: match.url,
        type: 'HLS',
        headers: match.headers || {},
        isDefault: false
      };
    })
    .filter(Boolean);
}

async function waitForVidfunHlsCandidate(page, candidates, timeoutMs = 10000, afterIndex = 0) {
  const startedAt = Date.now();

  while (!page.isClosed() && Date.now() - startedAt < timeoutMs) {
    const candidate = candidates.slice(afterIndex).find((entry) => isVidfunHlsResult(entry));
    if (candidate) {
      return candidate;
    }

    await page.waitForTimeout(250).catch(() => undefined);
  }

  return null;
}

async function waitForVideasyHlsCandidate(page, candidates, timeoutMs = 10000, afterIndex = 0) {
  const startedAt = Date.now();

  while (!page.isClosed() && Date.now() - startedAt < timeoutMs) {
    const candidate = candidates.slice(afterIndex).find((entry) => isVideasyHlsResult(entry));
    if (candidate) {
      return candidate;
    }

    await page.waitForTimeout(250).catch(() => undefined);
  }

  return null;
}

async function openVidfunQualityMenu(page) {
  const existingLabels = await getVidfunQualityLabels(page);
  if (existingLabels.length) {
    return;
  }

  const settingsButton = page.locator('button[aria-label="Settings"]').first();
  await settingsButton.waitFor({ state: 'attached', timeout: 12000 }).catch(() => undefined);
  await settingsButton.click({ timeout: 2000, force: true }).catch(() => undefined);
  await page.waitForTimeout(500).catch(() => undefined);

  await page.evaluate(() => {
    const normalize = (value) => String(value || '').trim().toLowerCase();
    const qualityButton = [...document.querySelectorAll('button')]
      .find((button) => normalize(button.innerText || button.textContent) === 'quality');
    qualityButton?.click();
  }).catch(() => undefined);

  await page.waitForTimeout(500).catch(() => undefined);
}

async function openVideasyQualityMenu(page) {
  const existingLabels = await getVideasyQualityLabels(page);
  if (existingLabels.length) {
    return;
  }

  await page.evaluate(() => {
    const normalize = (value) => String(value || '').trim().toLowerCase();
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    const controls = [...document.querySelectorAll('button,[role="button"],[aria-label]')];
    const settings = controls.find((entry) => {
      const text = normalize(entry.innerText || entry.textContent || entry.getAttribute('aria-label'));
      return visible(entry) && /settings|quality|gear|cog/.test(text);
    }) || controls.reverse().find((entry) => visible(entry));

    settings?.click();
  }).catch(() => undefined);

  await page.waitForTimeout(500).catch(() => undefined);

  await page.evaluate(() => {
    const normalize = (value) => String(value || '').trim().toLowerCase();
    const targets = [...document.querySelectorAll('button,[role="menuitem"],[role="button"],div,span')]
      .filter((entry) => normalize(entry.innerText || entry.textContent) === 'quality');

    const target = targets.find((entry) => {
      const rect = entry.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

    target?.click();
  }).catch(() => undefined);

  await page.waitForTimeout(500).catch(() => undefined);
}

async function getVidfunQualityLabels(page) {
  return await page.evaluate(() => {
    const labels = [...document.querySelectorAll('button')]
      .map((button) => String(button.innerText || button.textContent || '').trim().replace(/\s+/g, ' '))
      .filter((label) => /^(?:auto|4k|2k|\d{3,4}p)$/i.test(label));

    return [...new Set(labels)];
  }).catch(() => []);
}

async function getVideasyQualityLabels(page) {
  return await page.evaluate(() => {
    const labels = [...document.querySelectorAll('button,[role="menuitem"],[role="option"],[role="button"],li,div,span')]
      .map((entry) => String(entry.innerText || entry.textContent || '').trim().replace(/\s+/g, ' '))
      .filter((label) => /^(?:auto|4k|2k|\d{3,4}p?)$/i.test(label))
      .map((label) => {
        const match = label.match(/^\d{3,4}$/);
        return match ? `${label}p` : label;
      });

    return [...new Set(labels)];
  }).catch(() => []);
}

async function waitForVidfunQualityLabels(page, timeoutMs = 10000) {
  const startedAt = Date.now();
  let labels = [];

  while (!page.isClosed() && Date.now() - startedAt < timeoutMs) {
    labels = await getVidfunQualityLabels(page);
    if (labels.some((label) => !/^auto$/i.test(label))) {
      return labels;
    }

    await openVidfunQualityMenu(page);
    await page.waitForTimeout(600).catch(() => undefined);
  }

  return labels;
}

async function waitForVideasyQualityLabels(page, timeoutMs = 10000) {
  const startedAt = Date.now();
  let labels = [];

  while (!page.isClosed() && Date.now() - startedAt < timeoutMs) {
    labels = await getVideasyQualityLabels(page);
    if (labels.some((label) => !/^auto$/i.test(label))) {
      return labels;
    }

    await openVideasyQualityMenu(page);
    await page.waitForTimeout(600).catch(() => undefined);
  }

  return labels;
}

async function clickVidfunQuality(page, label) {
  return await page.evaluate((targetLabel) => {
    const normalize = (value) => String(value || '').trim().toLowerCase();
    const button = [...document.querySelectorAll('button')]
      .find((entry) => normalize(entry.innerText || entry.textContent) === normalize(targetLabel));

    if (!button) {
      return false;
    }

    button.click();
    return true;
  }, label).catch(() => false);
}

async function clickVideasyQuality(page, label) {
  return await page.evaluate((targetLabel) => {
    const normalize = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const target = normalize(targetLabel).replace(/p$/i, '');
    const matches = (value) => {
      const normalized = normalize(value);
      return normalized === normalize(targetLabel) || normalized.replace(/p$/i, '') === target;
    };

    const button = [...document.querySelectorAll('button,[role="menuitem"],[role="option"],[role="button"],li,div,span')]
      .find((entry) => matches(entry.innerText || entry.textContent));

    if (!button) {
      return false;
    }

    button.click();
    return true;
  }, label).catch(() => false);
}

async function collectVidfunQualityEntries(page, targetUrl, candidates, candidateStartIndex = 0) {
  if (!isVidfunUrl(targetUrl)) {
    return [];
  }

  await waitForVidfunHlsCandidate(page, candidates, 12000, candidateStartIndex);
  await openVidfunQualityMenu(page);

  const labels = await waitForVidfunQualityLabels(page);
  const explicitLabels = sortVidfunQualityLabels(labels).filter((label) => !/^auto$/i.test(label));
  if (labels.length) {
    console.log(new Date().toISOString(), '[vidfun] quality labels', labels.join(', '));
  }

  for (const label of explicitLabels) {
    const normalizedLabel = normalizeVidfunQualityLabel(label);
    if (candidates.slice(candidateStartIndex).some((entry) => normalizeVidfunQualityLabel(entry?.qualityLabel || '') === normalizedLabel)) {
      continue;
    }

    const beforeCount = candidates.length;
    const clicked = await clickVidfunQuality(page, label);
    if (!clicked) {
      continue;
    }

    const nextCandidate = await waitForVidfunHlsCandidate(page, candidates, 4500, beforeCount);
    if (nextCandidate) {
      nextCandidate.qualityLabel = normalizedLabel;
    } else if (label === explicitLabels[0]) {
      const primaryCandidate = candidates.slice(candidateStartIndex).find((entry) => isVidfunHlsResult(entry));
      if (primaryCandidate) {
        primaryCandidate.qualityLabel = normalizedLabel;
      }
    }
  }

  const scopedCandidates = candidates.slice(candidateStartIndex);
  return buildVidfunQualityEntries(labels, scopedCandidates.length ? scopedCandidates : candidates);
}

async function collectVideasyQualityEntries(page, targetUrl, candidates, candidateStartIndex = 0) {
  if (!isVideasyUrl(targetUrl)) {
    return [];
  }

  await waitForVideasyHlsCandidate(page, candidates, 12000, candidateStartIndex);
  await openVideasyQualityMenu(page);

  const labels = await waitForVideasyQualityLabels(page);
  const explicitLabels = sortVideasyQualityLabels(labels).filter((label) => !/^auto$/i.test(label));
  if (labels.length) {
    console.log(new Date().toISOString(), '[videasy] quality labels', labels.join(', '));
  }

  const currentLabel = labels.find((label) => !/^auto$/i.test(label));
  const normalizedCurrentLabel = normalizeVideasyQualityLabel(currentLabel || '');
  const primaryCandidate = candidates.slice(candidateStartIndex).find((entry) => isVideasyHlsResult(entry));
  if (primaryCandidate && normalizedCurrentLabel && !primaryCandidate.qualityLabel) {
    primaryCandidate.qualityLabel = normalizedCurrentLabel;
  }

  for (const label of explicitLabels) {
    const normalizedLabel = normalizeVideasyQualityLabel(label);
    if (candidates.slice(candidateStartIndex).some((entry) => normalizeVideasyQualityLabel(entry?.qualityLabel || '') === normalizedLabel)) {
      continue;
    }

    const beforeCount = candidates.length;
    const clicked = await clickVideasyQuality(page, label);
    if (!clicked) {
      continue;
    }

    const nextCandidate = await waitForVideasyHlsCandidate(page, candidates, 5000, beforeCount);
    if (nextCandidate) {
      nextCandidate.qualityLabel = normalizedLabel;
    }

    await openVideasyQualityMenu(page);
  }

  const scopedCandidates = candidates.slice(candidateStartIndex);
  return buildVideasyQualityEntries(labels, scopedCandidates.length ? scopedCandidates : candidates);
}

function getNavigationTargetUrl(targetUrl = '') {
  if (!isVidfunUrl(targetUrl)) {
    return targetUrl;
  }

  try {
    const parsed = new URL(String(targetUrl || ''));
    parsed.searchParams.delete('novaServer');
    parsed.searchParams.delete('server');
    return parsed.toString();
  } catch {
    return targetUrl;
  }
}

function getBootstrapRuntimeTarget(url) {
  if (isVidfastUrl(url)) {
    return {
      label: 'vidfast',
      runtimeKey: '__VIDFAST_RUNTIME__',
      apKey: '__VIDFAST_AP__'
    };
  }

  if (isVidcoreUrl(url)) {
    return {
      label: 'vidcore',
      runtimeKey: '__VIDCORE_RUNTIME__',
      apKey: '__VIDCORE_AP__'
    };
  }

  return null;
}

function isVideasyUrl(url) {
  return /player\.videasy\.net/i.test(String(url || ''));
}

function isVidzeeUrl(url) {
  return /player\.vidzee\.wtf\/(?:v2\/)?embed\//i.test(String(url || ''));
}

function isVidkingUrl(url) {
  return /www\.vidking\.net\/embed\//i.test(String(url || ''));
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

// Chrome version MUST match the actual browser launched on this machine.
// Check `[browser] launched` logs — the real Chrome reports its version in
// Sec-CH-UA headers during extraction.  Keeping these in sync avoids
// fingerprint mismatches that upstream WAFs (Cloudflare / Akamai) detect.
const CHROME_VERSION = '147';
const CHROME_FULL_VERSION = '147.0.7727.138';

export function getDefaultUserAgent() {
  return (
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    `Chrome/${CHROME_FULL_VERSION} Safari/537.36`
  );
}

function getVidfunUserAgent() {
  return getDefaultUserAgent();
}

/**
 * Sec-CH-UA Client Hints that match the real Chrome instance.
 * Modern bot-detection (Cloudflare Turnstile, Akamai) validates these
 * against the TLS fingerprint and User-Agent.  If they disagree the
 * request is flagged.
 */
export function getRealisticClientHints() {
  return {
    'sec-ch-ua': `"Google Chrome";v="${CHROME_VERSION}", "Not(A:Brand";v="99", "Chromium";v="${CHROME_VERSION}"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"'
  };
}

function getExtractionUserAgent(targetUrl) {
  return isVidfunUrl(targetUrl) ? getVidfunUserAgent() : getDefaultUserAgent();
}

function createStatusError(message, statusCode, code = message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function isCloudflareBlockPage(body = '') {
  const snippet = String(body || '').slice(0, 4000);
  return /attention required! \| cloudflare/i.test(snippet) || /just a moment/i.test(snippet) || /challenge-platform/i.test(snippet);
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

async function decryptVideasyPayloadInPage(page, encryptedPayload, mediaId) {
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
}

async function closeUnexpectedPage(newPage, reason) {
  const pageUrl = newPage.isClosed() ? 'about:blank' : newPage.url() || 'about:blank';
  console.log(new Date().toISOString(), reason, pageUrl);

  if (newPage.isClosed()) {
    return;
  }

  await Promise.race([
    newPage.waitForLoadState('domcontentloaded', { timeout: 1000 }).catch(() => undefined),
    newPage.waitForTimeout(1200).catch(() => undefined)
  ]).catch(() => undefined);

  if (!newPage.isClosed()) {
    await newPage.close().catch(() => undefined);
  }
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

async function primeVidcorePlayer(page, targetUrl) {
  if (!isVidcoreUrl(targetUrl)) {
    return;
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (page.isClosed()) {
      return;
    }

    await page.locator('button').first().click({ force: true, timeout: 1000 }).catch(() => undefined);
    await page.mouse.click(640, 360).catch(() => undefined);
    await page.keyboard.press('Space').catch(() => undefined);
    await page.waitForTimeout(900).catch(() => undefined);
  }
}

function isVidfastResolverUrl(url) {
  return /^https:\/\/vidfast\.(?:pro|in|io|me|net|pm|xyz)\/APA91/i.test(String(url || ''));
}

function isLikelyHlsSegmentUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    const pathname = decodeURIComponent(parsed.pathname || '').toLowerCase();
    if (/\.m3u8(?:$|[?#])/i.test(pathname)) {
      return false;
    }

    return (
      /\.(?:ts|m4s|cmfv|cmfa)(?:$|[?#])/i.test(pathname) ||
      /\/(?:seg|segment|frag|fragment|chunk|part)[-_]?\d/i.test(pathname) ||
      pathname.includes('/hls/')
    );
  } catch {
    return false;
  }
}

function isLikelyStreamUrl(url, options = {}) {
  const value = String(url || '');
  if (options.ignoreHlsSegments && isLikelyHlsSegmentUrl(value)) {
    return false;
  }

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

  const now = Date.now();
  if (vidfastSessionCache && vidfastSessionCache.expiresAt > now) {
    console.log(new Date().toISOString(), '[vidfast] warmup cache hit');
    return;
  }

  let warmupContext = null;

  try {
    const browser = page.context().browser();
    if (!browser) {
      return;
    }

    warmupContext = await browser.newContext({
      bypassCSP: true,
      viewport: { width: 1280, height: 720 },
      userAgent: getDefaultUserAgent()
    });
    const warmupPage = await warmupContext.newPage();

    await warmupPage.goto('https://vidfast.pro', {
      waitUntil: 'domcontentloaded',
      timeout: 20000
    });
    console.log(new Date().toISOString(), '[vidfast] warmup visited homepage');
    await warmupPage.waitForTimeout(1000).catch(() => undefined);
    const storageState = await warmupContext.storageState().catch(() => undefined);

    vidfastSessionCache = {
      expiresAt: now + 10 * 60 * 1000,
      storageState
    };
  } catch (error) {
    console.log(new Date().toISOString(), '[vidfast] warmup failed', error?.message || String(error));
  } finally {
    await warmupContext?.close().catch(() => undefined);
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
  const isAggressiveTarget = isVidfastUrl(targetUrl) || isVidzeeUrl(targetUrl) || isVidfunUrl(targetUrl) || isVidlinkUrl(targetUrl);
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

async function selectVidfunServer(page, targetUrl) {
  const serverName = getRequestedVidfunServer(targetUrl);
  if (!serverName) {
    return false;
  }

  try {
    await page.locator('button[aria-label="Servers"]').first()
      .waitFor({ state: 'attached', timeout: 15000 })
      .catch(() => undefined);

    await page.mouse.move(640, 650).catch(() => undefined);

    const startedAt = Date.now();
    let availableServers = [];

    while (Date.now() - startedAt < 18000) {
      const state = await page.evaluate((targetServer) => {
        const normalize = (value) => String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
        const target = normalize(targetServer);
        const buttons = [...document.querySelectorAll('button')]
          .map((button) => ({
            button,
            label: String(button.innerText || button.textContent || '').trim().replace(/\s+/g, ' '),
            aria: String(button.getAttribute('aria-label') || '').trim()
          }));
        const serverLabels = buttons
          .map((entry) => entry.label)
          .filter(Boolean);
        const serverButton = buttons.find((entry) => normalize(entry.label) === target)?.button;

        if (serverButton) {
          serverButton.scrollIntoView({ block: 'center', inline: 'nearest' });
          serverButton.click();
          return { clicked: true, menuOpen: true, serverLabels };
        }

        const menuOpen = /select a server/i.test(document.body?.innerText || '') ||
          Boolean(document.querySelector('[aria-label="Server Selector"]'));
        return { clicked: false, menuOpen, serverLabels };
      }, serverName).catch(() => ({ clicked: false, menuOpen: false, serverLabels: [] }));

      availableServers = state.serverLabels || [];

      if (state.clicked) {
        console.log(new Date().toISOString(), '[vidfun] selected server', serverName);
        await page.keyboard.press('Escape').catch(() => undefined);
        await page.waitForTimeout(800).catch(() => undefined);
        return true;
      }

      if (!state.menuOpen) {
        const openClicked = await page.locator('button[aria-label="Servers"]').first().click({ timeout: 1500, force: true })
          .then(() => true)
          .catch(() => false);

        if (!openClicked) {
          await page.evaluate(() => {
            [...document.querySelectorAll('button')]
              .find((button) => button.getAttribute('aria-label') === 'Servers')
              ?.click();
          }).catch(() => undefined);
        }
      }

      await page.waitForTimeout(700).catch(() => undefined);
    }

    console.log(
      new Date().toISOString(),
      '[vidfun] server option not found',
      serverName,
      availableServers.length ? `available=${availableServers.join(', ')}` : 'available=none'
    );
    return false;
  } catch (error) {
    console.log(new Date().toISOString(), '[vidfun] server select failed', serverName, error?.message || String(error));
    return false;
  }
}

async function installVidfastHooks(page, targetUrl) {
  if (!isVidfastUrl(targetUrl) && !isVidcoreUrl(targetUrl)) {
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

async function triggerProtectedBootstrap(page, targetUrl) {
  const runtimeTarget = getBootstrapRuntimeTarget(targetUrl);

  if (!runtimeTarget) {
    return;
  }

  const result = await page.evaluate(async ({ runtimeKey, apKey }) => {
    const runtime = window[runtimeKey] || {};
    const runtimeAp = runtime.ap || window[apKey];

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
  }, runtimeTarget).catch((error) => ({ ok: false, reason: error?.message || String(error) }));

  console.log(new Date().toISOString(), `[${runtimeTarget.label}] manual bootstrap`, JSON.stringify(result));

  return result;
}

async function waitForProtectedRuntime(page, targetUrl, timeoutMs = 12000) {
  const runtimeTarget = getBootstrapRuntimeTarget(targetUrl);

  if (!runtimeTarget) {
    return false;
  }

  const startedAt = Date.now();

  while (!page.isClosed() && Date.now() - startedAt < timeoutMs) {
    const runtimeReady = await page
      .evaluate(({ runtimeKey, apKey }) => Boolean(window[runtimeKey]?.ap || window[apKey]), runtimeTarget)
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
  const navigationUrl = getNavigationTargetUrl(targetUrl);
  const expectedVidfastPath = getExpectedVidfastPath(targetUrl);
  const now = Date.now();
  const vidfastStorageState =
    isVidfastUrl(targetUrl) && vidfastSessionCache?.expiresAt > now ? vidfastSessionCache.storageState : undefined;

  const context = await createBrowserContext({
    bypassCSP: true,
    userAgent: getExtractionUserAgent(targetUrl),
    viewport: { width: 1280, height: 720 },
    storageState: vidfastStorageState
  }, options);

  const page = await context.newPage();
  const popupCloseTasks = new Set();
  page.on('popup', (popup) => {
    const closeTask = closeUnexpectedPage(popup, '[popup] closing')
      .catch(() => undefined)
      .finally(() => {
        popupCloseTasks.delete(closeTask);
      });

    popupCloseTasks.add(closeTask);
  });
  let firstResultResolved = false;
  let lastRelevantActivityAt = Date.now();
  const vidfastResolverHints = [];
  const vidfunHlsCandidates = [];
  const videasyHlsCandidates = [];
  let protectedRuntimeReadyPromise = null;
  const videasyApiStatuses = [];
  const getVideasyUpstreamBlockError = () => {
    if (!isVideasyUrl(targetUrl) || firstResultResolved) {
      return null;
    }

    const videasyForbiddenCount = videasyApiStatuses.filter((entry) => entry.status === 403).length;
    if (videasyForbiddenCount < 3) {
      return null;
    }

    return createStatusError('Videasy upstream blocked by Cloudflare', 502, VIDEASY_UPSTREAM_BLOCKED);
  };

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

  const rememberVidfunHlsCandidate = (entry) => {
    if (!isVidfunUrl(targetUrl) || !entry?.url || !isVidfunHlsResult(entry)) {
      return;
    }

    if (vidfunHlsCandidates.some((item) => item.url === entry.url)) {
      return;
    }

    vidfunHlsCandidates.push({
      ...entry,
      type: 'HLS'
    });

    if (vidfunHlsCandidates.length > 12) {
      vidfunHlsCandidates.shift();
    }
  };

  const rememberVideasyHlsCandidate = (entry) => {
    if (!isVideasyUrl(targetUrl) || !entry?.url || !isVideasyHlsResult(entry)) {
      return;
    }

    if (videasyHlsCandidates.some((item) => item.url === entry.url)) {
      return;
    }

    videasyHlsCandidates.push({
      ...entry,
      type: 'HLS'
    });

    if (videasyHlsCandidates.length > 16) {
      videasyHlsCandidates.shift();
    }
  };

  const emitFound = async (result) => {
    const enrichedResult = await enrichPlaybackResult(targetUrl, result, context);

    const accepted = await Promise.resolve(onFound({
      ...enrichedResult,
      resolverHints: vidfastResolverHints.length ? { vidfastRequests: [...vidfastResolverHints] } : undefined
    }));

    if (accepted === false) {
      return;
    }

    if (!firstResultResolved) {
      firstResultResolved = true;
      await page.close().catch(() => undefined);
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
    const requestUrl = request.url();
    const resourceType = request.resourceType();
    markActivity(requestUrl, resourceType);

    rememberVidfastResolverHint({
      url: requestUrl,
      method: request.method(),
      headers: request.headers()
    });

    if ((!isVidkingUrl(targetUrl) && !isVideasyUrl(targetUrl)) || stopIfResolved()) {
      return;
    }

    if (isLikelyStreamUrl(requestUrl, { ignoreHlsSegments: isVideasyUrl(targetUrl) })) {
      const via = isVideasyUrl(targetUrl) ? 'videasy-request' : 'vidking-request';
      console.log(new Date().toISOString(), `[${via}:media]`, resourceType, requestUrl);
      const result = {
        url: requestUrl,
        type: detectType(requestUrl, request.headers()['content-type'] || ''),
        headers: request.headers(),
        foundAt: new Date().toISOString(),
        via
      };

      if (isVideasyUrl(targetUrl) && isVideasyHlsResult(result)) {
        rememberVideasyHlsCandidate(result);
        return;
      }

      emitFound(result).catch(() => undefined);
    }
  });

  page.on('response', (response) => {
    markActivity(response.url(), response.request().resourceType());
  });

  page.on('response', async (response) => {
    if (isVideasyUrl(targetUrl)) {
      const responseUrl = response.url();
      if (isLikelyStreamUrl(responseUrl, { ignoreHlsSegments: true }) && !stopIfResolved()) {
        console.log(new Date().toISOString(), '[videasy:response-media]', response.status(), responseUrl);
        const result = {
          url: responseUrl,
          type: detectType(responseUrl, response.headers()['content-type'] || ''),
          headers: {
            ...response.request().headers(),
            ...response.headers()
          },
          foundAt: new Date().toISOString(),
          via: 'videasy-response'
        };

        if (isVideasyHlsResult(result)) {
          rememberVideasyHlsCandidate(result);
          // Keep the page open so the quality menu can be inspected before
          // selecting a final playback URL. Emitting here closes the page early.
          return;
        }

        await emitFound(result).catch(() => undefined);
        return;
      }
    }

    if (isVidkingUrl(targetUrl)) {
      const responseUrl = response.url();
      if (isLikelyStreamUrl(responseUrl) && !stopIfResolved()) {
        console.log(new Date().toISOString(), '[vidking:response-media]', response.status(), responseUrl);
        await emitFound({
          url: responseUrl,
          type: detectType(responseUrl, response.headers()['content-type'] || ''),
          headers: {
            ...response.request().headers(),
            ...response.headers()
          },
          foundAt: new Date().toISOString(),
          via: 'vidking-response'
        }).catch(() => undefined);
        return;
      }
    }

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

        if (streamUrl) {
          console.log(new Date().toISOString(), '[videasy:api] decrypted stream ignored; waiting for player media request', streamUrl);
        }
      } catch (error) {
        console.log(new Date().toISOString(), '[videasy:api:error]', url, error?.message || String(error));
      }
    }

    const runtimeTarget = getBootstrapRuntimeTarget(targetUrl);
    if (!runtimeTarget) {
      return;
    }

    const resourceType = response.request().resourceType();
    if (!['xhr', 'fetch'].includes(resourceType)) {
      return;
    }

    const url = response.url();
    const status = response.status();
    console.log(new Date().toISOString(), `[${runtimeTarget.label}:xhr]`, status, url);

    if (
      !url.includes('/api/') &&
      !url.includes('/radowi/') &&
      !url.includes('source') &&
      !url.includes('stream') &&
      !url.includes('vidfast') &&
      !url.includes('vidcore')
    ) {
      return;
    }

    try {
      const body = await response.text();
      console.log(new Date().toISOString(), `[${runtimeTarget.label}:xhr-body]`, url, '->', body.slice(0, 500));
    } catch {}
  });

  page.on('requestfailed', (request) => {
    if (!getBootstrapRuntimeTarget(targetUrl)) {
      return;
    }

    if (!['script', 'document', 'fetch', 'xhr'].includes(request.resourceType())) {
      return;
    }

    console.log(new Date().toISOString(), '[requestfailed]', request.resourceType(), request.url(), request.failure()?.errorText || 'unknown');
  });

  page.on('response', (response) => {
    if (!getBootstrapRuntimeTarget(targetUrl)) {
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
    if (isVidfunUrl(targetUrl)) {
      rememberVidfunHlsCandidate(result);
      return;
    }

    if (isVideasyUrl(targetUrl) && isVideasyHlsResult(result)) {
      rememberVideasyHlsCandidate(result);
      return;
    }

    await emitFound(result);
  });

  try {
    if (isVidfastUrl(targetUrl) && vidfastStorageState) {
      console.log(new Date().toISOString(), '[vidfast] reusing cached session state');
    }

    if (isMegaplayUrl(targetUrl)) {
      await page.setContent(`<html><body style="margin:0;overflow:hidden">
        <iframe src="${navigationUrl}" width="100%" height="100%" frameborder="0"
          scrolling="no" allowfullscreen
          style="position:fixed;top:0;left:0;width:100%;height:100%;border:none">
        </iframe>
      </body></html>`);
      await page.waitForTimeout(3000);
    } else {
      await page.goto(navigationUrl, {
        waitUntil: isVidkingUrl(targetUrl) ? 'networkidle' : 'domcontentloaded',
        timeout: options.navigationTimeout ?? 30000
      });
    }

    if (isVideasyUrl(targetUrl)) {
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
    }

    if (isVidfastUrl(targetUrl) && expectedVidfastPath) {
      const currentPath = getExpectedVidfastPath(page.url());
      if (currentPath && currentPath !== expectedVidfastPath) {
        console.log(new Date().toISOString(), '[vidfast] unexpected redirect', page.url());
        await page.goto(navigationUrl, {
          waitUntil: 'domcontentloaded',
          timeout: options.navigationTimeout ?? 30000
        });
      }
    }

    console.log(new Date().toISOString(), '[extractor] page loaded', navigationUrl);

    await logVidfastPageState(page, targetUrl);
    await patchVidfastVisibility(page, targetUrl);

    if (getBootstrapRuntimeTarget(targetUrl)) {
      protectedRuntimeReadyPromise = waitForProtectedRuntime(page, targetUrl, isVidfastUrl(targetUrl) ? 25000 : 18000);
    }

    await safeWait(isVidfastUrl(targetUrl) ? 2000 : 250);

    if (!stopIfResolved() && isVidkingUrl(targetUrl)) {
      await safeWait(3000);
    }

    if (stopIfResolved()) {
      return;
    }

    if (isVidfunUrl(targetUrl)) {
      const selectedRequestedServer = await selectVidfunServer(page, targetUrl);
      const preferredCandidateStartIndex = selectedRequestedServer ? vidfunHlsCandidates.length : 0;
      const qualities = await collectVidfunQualityEntries(page, targetUrl, vidfunHlsCandidates, preferredCandidateStartIndex);
      const serverCandidates = vidfunHlsCandidates.slice(preferredCandidateStartIndex).filter((entry) => isVidfunHlsResult(entry));
      const fallbackCandidates = serverCandidates.length ? serverCandidates : vidfunHlsCandidates.filter((entry) => isVidfunHlsResult(entry));
      const primaryCandidate = fallbackCandidates[0];

      if (primaryCandidate) {
        await emitFound({
          ...primaryCandidate,
          type: 'HLS',
          via: primaryCandidate.via || 'vidfun-quality',
          qualities
        });
        return;
      }
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

      const qualities = await collectVideasyQualityEntries(page, targetUrl, videasyHlsCandidates);
      const primaryCandidate = videasyHlsCandidates.find((entry) => isVideasyHlsResult(entry));
      if (primaryCandidate && !stopIfResolved()) {
        await emitFound({
          ...primaryCandidate,
          type: 'HLS',
          via: primaryCandidate.via || 'videasy-quality',
          qualities
        });
        return;
      }

      if (getVideasyUpstreamBlockError()) {
        console.log(new Date().toISOString(), '[videasy] upstream api blocked, continuing browser media capture');
      }
    }

    if (!stopIfResolved() && isVidzeeUrl(targetUrl)) {
      await safeWait(2500);
      await primeVidzeePlayer(page, targetUrl);
      await waitForNetworkSettle(2500, 15000, 3000);
    }

    if (!stopIfResolved() && isMegaplayUrl(targetUrl)) {
      await safeWait(2000);
      const megaplayFrame = page.frames().find((frame) => /megaplay\.buzz/i.test(frame.url()));
      const frameTarget = megaplayFrame || page;
      await frameTarget.evaluate(() => {
        const video = document.querySelector('video');
        if (video && typeof video.play === 'function') {
          video.muted = true;
          video.play().catch(() => undefined);
        }
        try { if (window.jwplayer) window.jwplayer().play().catch(() => undefined); } catch {}
      }).catch(() => undefined);
      await waitForNetworkSettle(3000, 18000, 6000);
    }

    if (!stopIfResolved() && isVidcoreUrl(targetUrl)) {
      await safeWait(2500);
      await primeVidcorePlayer(page, targetUrl);
      await waitForNetworkSettle(2500, 16000, 4000);
    }

    if (!stopIfResolved() && isVidcoreUrl(targetUrl)) {
      const runtimeReady = await (protectedRuntimeReadyPromise || waitForProtectedRuntime(page, targetUrl, 12000));
      console.log(new Date().toISOString(), '[vidcore] runtime ready', runtimeReady);
      if (runtimeReady) {
        await triggerProtectedBootstrap(page, targetUrl);
        await safeWait(1000);
        await waitForNetworkSettle(2000, 12000, 1500);
      }
    }

    if (!stopIfResolved() && isVidcoreUrl(targetUrl)) {
      await triggerProtectedBootstrap(page, targetUrl);
      await safeWait(1500);
      await waitForNetworkSettle(2500, 12000, 2000);
    }

    if (!stopIfResolved() && isVidfastUrl(targetUrl)) {
      const runtimeReady = await (protectedRuntimeReadyPromise || waitForProtectedRuntime(page, targetUrl, 12000));
      console.log(new Date().toISOString(), '[vidfast] runtime ready', runtimeReady);
      if (runtimeReady) {
        await triggerProtectedBootstrap(page, targetUrl);
        await safeWait(1000);
        await waitForNetworkSettle(2000, 8000, 1000);
      }
    }

    if (!stopIfResolved() && isVidfastUrl(targetUrl)) {
      await triggerProtectedBootstrap(page, targetUrl);
      await safeWait(1500);
      await waitForNetworkSettle(2500, 12000, 2000);
    }

    if (!stopIfResolved()) {
      const isSlowTarget = isVidfastUrl(targetUrl) || isVidlinkUrl(targetUrl) || isMegaplayUrl(targetUrl);
      await waitForNetworkSettle(
        options.settleTimeout ?? (isSlowTarget ? 3000 : 2000),
        options.maxWaitAfterLoad ?? (isSlowTarget ? 18000 : 10000),
        options.minWaitAfterLoad ?? (isSlowTarget ? 4000 : 5000)
      );
    }

    const videasyUpstreamBlockError = getVideasyUpstreamBlockError();
    if (videasyUpstreamBlockError) {
      throw videasyUpstreamBlockError;
    }

    if (!stopIfResolved() && isVidfastUrl(targetUrl)) {
      await triggerProtectedBootstrap(page, targetUrl);
      await safeWait(1500);
      await waitForNetworkSettle(2500, 8000, 1500);
    }

    if (!stopIfResolved() && getBootstrapRuntimeTarget(targetUrl)) {
      const protectedPayloadResult = await inspectVidfastPayloads(page);
      if (protectedPayloadResult) {
        await emitFound(protectedPayloadResult);
        if (stopIfResolved()) {
          return;
        }
      }

      const runtimeResult = await inspectVidfastRuntime(page);
      if (runtimeResult) {
        await emitFound(runtimeResult);
      }
    }
  } catch (error) {
    if (isExpectedCloseError(error)) {
      return;
    }

    if (error?.code === VIDEASY_UPSTREAM_BLOCKED) {
      throw error;
    }

    console.log(new Date().toISOString(), '[extractor] navigation error', error?.message || String(error));
    if (!String(error?.message || '').toLowerCase().includes('timeout')) {
      throw error;
    }
  } finally {
    if (isVidfastUrl(targetUrl)) {
      const storageState = await context.storageState().catch(() => undefined);
      if (storageState) {
        vidfastSessionCache = {
          expiresAt: Date.now() + 10 * 60 * 1000,
          storageState
        };
      }
    }

    console.log(new Date().toISOString(), '[extractor] closing', targetUrl);
    await Promise.allSettled([...popupCloseTasks]);
    await context.close().catch(() => undefined);
  }
}

export async function warmBrowser() {
  await getBrowser();
}

export async function getVideasySession(targetUrl = 'https://player.videasy.net/') {
  const now = Date.now();
  if (videasySessionCache && videasySessionCache.expiresAt > now) {
    return videasySessionCache.value;
  }

  const context = await createBrowserContext({
    bypassCSP: true,
    viewport: { width: 1280, height: 720 },
    userAgent: getDefaultUserAgent()
  });
  const page = await context.newPage();

  try {
    await page.goto('https://player.videasy.net/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    }).catch(() => undefined);

    await page.waitForTimeout(2000).catch(() => undefined);

    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
    await primeVideasyPlayer(page, targetUrl).catch(() => undefined);
    await page.waitForTimeout(6000).catch(() => undefined);

    const cookies = await context.cookies([
      'https://player.videasy.net',
      'https://api.videasy.net',
      'https://api2.videasy.net',
      'https://users.videasy.net',
      'https://db.videasy.net'
    ]).catch(() => []);
    const cookieHeader = cookies
      .filter((cookie) => !cookie.expires || cookie.expires * 1000 > now)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');

    const session = {
      userAgent: getDefaultUserAgent(),
      cookieHeader
    };

    videasySessionCache = {
      value: session,
      expiresAt: now + 10 * 60 * 1000
    };

    return session;
  } finally {
    await context.close().catch(() => undefined);
  }
}

export async function getVidkingSession(targetUrl = 'https://www.vidking.net/') {
  const now = Date.now();
  if (vidkingSessionCache && vidkingSessionCache.expiresAt > now) {
    return vidkingSessionCache.value;
  }

  const context = await createBrowserContext({
    bypassCSP: true,
    viewport: { width: 1280, height: 720 },
    userAgent: getDefaultUserAgent()
  });
  const page = await context.newPage();

  try {
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    await page.waitForTimeout(7000).catch(() => undefined);

    const cookies = await context.cookies(['https://www.vidking.net', 'https://api.videasy.net']).catch(() => []);
    const cookieHeader = cookies
      .filter((cookie) => !cookie.expires || cookie.expires * 1000 > now)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');

    const session = {
      userAgent: getDefaultUserAgent(),
      cookieHeader
    };

    vidkingSessionCache = {
      value: session,
      expiresAt: now + 10 * 60 * 1000
    };

    return session;
  } finally {
    await context.close().catch(() => undefined);
  }
}

export async function decryptVideasyPayload(encryptedPayload, mediaId, targetUrl = 'https://player.videasy.net/') {
  const context = await createBrowserContext({
    bypassCSP: true,
    viewport: { width: 1280, height: 720 },
    userAgent: getDefaultUserAgent()
  });
  const page = await context.newPage();

  try {
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    return await decryptVideasyPayloadInPage(page, encryptedPayload, mediaId);
  } finally {
    await context.close().catch(() => undefined);
  }
}

export async function resolveVideasyPayloadInBrowser(apiUrl, mediaId, targetUrl = 'https://player.videasy.net/') {
  const context = await createBrowserContext({
    bypassCSP: true,
    viewport: { width: 1280, height: 720 },
    userAgent: getDefaultUserAgent()
  });
  const page = await context.newPage();
  const capturedPayloads = [];
  const seenPayloadKeys = new Set();
  const popupCloseTasks = new Set();

  const rememberPayload = async (url, status, body) => {
    console.log(new Date().toISOString(), '[videasy:browser-api]', status, url, '->', String(body || '').slice(0, 500));

    if (status < 200 || status >= 300 || !body || isCloudflareBlockPage(body)) {
      return;
    }

    const key = `${url}::${body.length}`;
    if (seenPayloadKeys.has(key)) {
      return;
    }

    seenPayloadKeys.add(key);
    capturedPayloads.push({ url, body });
  };

  page.on('popup', (popup) => {
    const closeTask = closeUnexpectedPage(popup, '[videasy] closing popup')
      .catch(() => undefined)
      .finally(() => {
        popupCloseTasks.delete(closeTask);
      });

    popupCloseTasks.add(closeTask);
  });

  page.on('response', (response) => {
    if (!isVideasyApiUrl(response.url())) {
      return;
    }

    response.text()
      .then((body) => rememberPayload(response.url(), response.status(), body))
      .catch((error) => {
        console.log(new Date().toISOString(), '[videasy:browser-api:error]', response.url(), error?.message || String(error));
      });
  });

  try {
    await page.goto('https://player.videasy.net/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    }).catch(() => undefined);

    await page.waitForTimeout(1500).catch(() => undefined);

    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(2500).catch(() => undefined);
    await primeVideasyPlayer(page, targetUrl).catch(() => undefined);
    await page.waitForTimeout(3500).catch(() => undefined);

    const decodePayload = async (encryptedBody) => {
      try {
        return await decryptVideasyPayloadInPage(page, encryptedBody, mediaId);
      } catch (error) {
        console.log(new Date().toISOString(), '[videasy:browser-decrypt:fallback]', error?.message || String(error));
        return await decryptVideasyPayload(encryptedBody, mediaId, targetUrl).catch(() => '');
      }
    };

    const getCapturedPayload = () => {
      let preferredPath = '';
      try {
        preferredPath = new URL(apiUrl).pathname;
      } catch {
        preferredPath = '';
      }

      return capturedPayloads.find((entry) => {
        try {
          return preferredPath && new URL(entry.url).pathname === preferredPath;
        } catch {
          return false;
        }
      }) || capturedPayloads.find((entry) => entry.url === apiUrl) || capturedPayloads[0] || null;
    };

    const captured = getCapturedPayload();
    if (captured?.body) {
      return await decodePayload(captured.body);
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const manualResult = await page.evaluate(async ({ sourceApiUrl }) => {
        try {
          const response = await fetch(sourceApiUrl, {
            credentials: 'include',
            mode: 'cors',
            headers: {
              accept: 'application/json, text/plain, */*',
              'cache-control': 'no-cache',
              pragma: 'no-cache'
            }
          });

          return {
            status: response.status,
            body: await response.text(),
            ok: response.ok
          };
        } catch (error) {
          return {
            status: 0,
            body: '',
            ok: false,
            error: error?.message || String(error)
          };
        }
      }, {
        sourceApiUrl: String(apiUrl || '')
      });

      console.log(
        new Date().toISOString(),
        '[videasy:browser-fetch]',
        manualResult.status,
        apiUrl,
        manualResult.error || String(manualResult.body || '').slice(0, 500)
      );

      if (manualResult.ok && manualResult.body && !isCloudflareBlockPage(manualResult.body)) {
        return await decodePayload(manualResult.body);
      }

      const retriedCaptured = getCapturedPayload();
      if (retriedCaptured?.body) {
        return await decodePayload(retriedCaptured.body);
      }

      if (attempt === 0) {
        await primeVideasyPlayer(page, targetUrl).catch(() => undefined);
      } else if (attempt === 1) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
      }

      await page.waitForTimeout(2500).catch(() => undefined);
    }

    const finalCaptured = getCapturedPayload();
    if (finalCaptured?.body) {
      return await decodePayload(finalCaptured.body);
    }

    return '';
  } finally {
    await Promise.allSettled([...popupCloseTasks]);
    await context.close().catch(() => undefined);
  }
}

export async function decryptVidkingPayload(encryptedPayload, mediaId, targetUrl = 'https://www.vidking.net/') {
  const context = await createBrowserContext({
    bypassCSP: true,
    viewport: { width: 1280, height: 720 },
    userAgent: getDefaultUserAgent()
  });
  const page = await context.newPage();

  try {
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    await page.waitForTimeout(3000).catch(() => undefined);

    return await page.evaluate(async ({ encrypted, numericMediaId }) => {
      const compiled = await WebAssembly.compileStreaming(fetch('https://www.vidking.net/assets/wasm/module1.wasm'));
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
        if (!ptr) return null;
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
            reject(new Error('VIDKING_HASH_TIMEOUT'));
            return;
          }
          setTimeout(poll, 25);
        };
        poll();
      });

      if (!exports.verify(writeString(hash))) {
        throw new Error('VIDKING_HASH_VERIFY_FAILED');
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
