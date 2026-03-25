import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

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

async function proxyHttpsRequest(targetUrl, proxyUrl, options = {}) {
  const target = new URL(targetUrl);
  const headers = normalizeHeaders(options.headers);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const socket = await openProxyTunnel(targetUrl, proxyUrl, headers, timeoutMs);

  return withTimeout(() => new Promise((resolve, reject) => {
    const request = https.request({
      host: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: options.method || 'GET',
      headers,
      socket,
      agent: false
    }, async (response) => {
      try {
        const body = await readResponseBody(response);
        resolve({
          status: response.statusCode || 500,
          headers: normalizeHeaders(response.headers),
          body
        });
      } catch (error) {
        reject(error);
      }
    });

    request.once('error', reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(createTimeoutError('Proxy HTTPS request', timeoutMs));
    });

    if (options.body) {
      request.write(options.body);
    }

    request.end();
  }), timeoutMs + 250, 'Proxy HTTPS request');
}

async function directRequest(targetUrl, options = {}) {
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(createTimeoutError('Direct fetch', timeoutMs)), timeoutMs);

  try {
    const response = await fetch(targetUrl, {
      method: options.method || 'GET',
      headers: options.headers,
      body: options.body,
      signal: controller.signal
    });

    return {
      status: response.status,
      headers: normalizeHeaders(Object.fromEntries(response.headers.entries())),
      body: await response.text()
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchVideasyThroughProxy(targetUrl, options = {}) {
  const proxyUrls = getVideasyProxyUrls();
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);

  if (!proxyUrls.length) {
    const directResult = await directRequest(targetUrl, { ...options, timeoutMs });
    return {
      ...directResult,
      proxyUrl: null
    };
  }

  let lastError;

  for (const proxyUrl of proxyUrls) {
    try {
      const result = await proxyHttpsRequest(targetUrl, proxyUrl, { ...options, timeoutMs });
      if (result.status !== 403) {
        return {
          ...result,
          proxyUrl
        };
      }

      lastError = new Error(`Proxy returned 403 via ${proxyUrl}`);
    } catch (error) {
      lastError = error;
    }
  }

  try {
    const directResult = await directRequest(targetUrl, { ...options, timeoutMs: Math.max(5000, Math.min(timeoutMs, 10000)) });
    return {
      ...directResult,
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
