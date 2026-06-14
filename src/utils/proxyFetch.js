import tls from 'node:tls';
import { gotScraping } from 'got-scraping';
import { getDefaultUserAgent, getRealisticClientHints } from '../workers/playwright.js';

const DEFAULT_TIMEOUT_MS = Number(process.env.VIDEASY_PROXY_TIMEOUT_MS || 8000);

function splitProxyEnv(value) {
  return String(value || '')
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getVideasyProxyUrls() {
  return splitProxyEnv(process.env.VIDEASY_PROXY_URL || process.env.VIDEASY_API_PROXY_URL || '');
}

function getVideasyProxyUrl() {
  return getVideasyProxyUrls()[0] || '';
}

function shouldUseVideasyProxy() {
  return getVideasyProxyUrls().length > 0;
}

function normalizeHeaders(headers = {}) {
  return Object.entries(headers).reduce((acc, [key, value]) => {
    if (value == null) {
      return acc;
    }

    acc[String(key).toLowerCase()] = String(value);
    return acc;
  }, {});
}

function readResponseBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

function createTimeoutError(label, timeoutMs) {
  const error = new Error(`${label} timed out after ${timeoutMs}ms`);
  error.code = 'ETIMEDOUT';
  return error;
}

function withTimeout(promiseFactory, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(createTimeoutError(label, timeoutMs)), timeoutMs);

    promiseFactory()
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function openProxyTunnel(targetUrl, proxyUrl, headers, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return withTimeout(() => new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const proxy = new URL(proxyUrl);
    const isSecureProxy = proxy.protocol === 'https:';
    const connectModule = isSecureProxy ? https : http;

    const proxyHeaders = {
      host: `${target.hostname}:${target.port || 443}`,
      ...headers
    };

    if (proxy.username || proxy.password) {
      proxyHeaders['proxy-authorization'] = `Basic ${Buffer.from(
        `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
      ).toString('base64')}`;
    }

    const request = connectModule.request({
      host: proxy.hostname,
      port: proxy.port || (isSecureProxy ? 443 : 80),
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      headers: proxyHeaders
    });

    request.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed with status ${response.statusCode || 'unknown'}`));
        return;
      }

      const secureSocket = tls.connect({
        socket,
        servername: target.hostname
      });

      secureSocket.once('secureConnect', () => resolve(secureSocket));
      secureSocket.once('error', reject);
    });

    request.once('error', reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(createTimeoutError('Proxy CONNECT', timeoutMs));
    });
    request.end();
  }), timeoutMs + 250, 'Proxy tunnel');
}

export async function fetchVideasyThroughProxy(targetUrl, options = {}) {
  const proxyUrls = getVideasyProxyUrls();
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const headers = {
    ...getRealisticClientHints(),
    'user-agent': getDefaultUserAgent(),
    ...normalizeHeaders(options.headers)
  };

  const fetchOptions = {
    url: targetUrl,
    method: options.method || 'GET',
    headers,
    timeout: { request: timeoutMs },
    retry: { limit: 0 },
    throwHttpErrors: false,
    followRedirect: true,
    responseType: 'text',
    http2: true
  };

  if (options.body) {
    fetchOptions.body = options.body;
  }

  if (!proxyUrls.length) {
    const response = await gotScraping(fetchOptions);
    return {
      status: response.statusCode,
      headers: normalizeHeaders(response.headers),
      body: response.body,
      proxyUrl: null
    };
  }

  let lastError;
  for (const proxyUrl of proxyUrls) {
    try {
      const response = await gotScraping({
        ...fetchOptions,
        proxyUrl
      });

      if (response.statusCode !== 403) {
        return {
          status: response.statusCode,
          headers: normalizeHeaders(response.headers),
          body: response.body,
          proxyUrl
        };
      }
      lastError = new Error(`Proxy returned 403 via ${proxyUrl}`);
    } catch (error) {
      lastError = error;
    }
  }

  // Fallback to direct request if all proxies fail
  try {
    const response = await gotScraping(fetchOptions);
    return {
      status: response.statusCode,
      headers: normalizeHeaders(response.headers),
      body: response.body,
      proxyUrl: null,
      fallbackFromProxyError: lastError ? lastError.message || String(lastError) : null
    };
  } catch (directError) {
    if (lastError) {
      directError.cause = lastError;
    }
    throw directError;
  }
}

export { getVideasyProxyUrl, getVideasyProxyUrls, shouldUseVideasyProxy };
