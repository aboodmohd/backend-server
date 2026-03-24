import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

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

function openProxyTunnel(targetUrl, proxyUrl, headers) {
  return new Promise((resolve, reject) => {
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
    request.end();
  });
}

async function proxyHttpsRequest(targetUrl, proxyUrl, options = {}) {
  const target = new URL(targetUrl);
  const headers = normalizeHeaders(options.headers);
  const socket = await openProxyTunnel(targetUrl, proxyUrl, headers);

  return new Promise((resolve, reject) => {
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

    if (options.body) {
      request.write(options.body);
    }

    request.end();
  });
}

async function directRequest(targetUrl, options = {}) {
  const response = await fetch(targetUrl, {
    method: options.method || 'GET',
    headers: options.headers,
    body: options.body
  });

  return {
    status: response.status,
    headers: normalizeHeaders(Object.fromEntries(response.headers.entries())),
    body: await response.text()
  };
}

export async function fetchVideasyThroughProxy(targetUrl, options = {}) {
  const proxyUrls = getVideasyProxyUrls();

  if (!proxyUrls.length) {
    const directResult = await directRequest(targetUrl, options);
    return {
      ...directResult,
      proxyUrl: null
    };
  }

  let lastError;

  for (const proxyUrl of proxyUrls) {
    try {
      const result = await proxyHttpsRequest(targetUrl, proxyUrl, options);
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

  if (lastError) {
    throw lastError;
  }

  return directRequest(targetUrl, options);
}

export { getVideasyProxyUrl, getVideasyProxyUrls, shouldUseVideasyProxy };
