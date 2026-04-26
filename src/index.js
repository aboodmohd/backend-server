import express from 'express';
import cors from 'cors';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import extractRoute from './routes/extract.js';
import streamRoute from './routes/stream.js';
import downloadRoute from './routes/download.js';
import resolveRoute from './routes/resolve.js';
import proxyRoute from './routes/proxy.js';
import subtitlesRoute from './routes/subtitles.js';
import novaRoute from './routes/nova.js';
import { warmBrowser } from './workers/playwright.js';
import videasyRoute from '../server/server.js';

const app = express();
const rootDir = dirname(fileURLToPath(import.meta.url));
const shouldWarmBrowserOnStartup = String(process.env.NOVA_SKIP_BROWSER_WARMUP || '0') !== '1';
const allowedCorsOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  process.env.FRONTEND_ORIGIN || '',
  ...(process.env.CORS_ALLOWED_ORIGINS || '').split(',').map((entry) => entry.trim()),
].filter(Boolean);
const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedCorsOrigins.length === 0 || allowedCorsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error(`Origin ${origin} is not allowed by CORS`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'Accept', 'Accept-Language'],
};

function parseEmbeddedPlaybackHeaders(rawUrl = '') {
  try {
    const parsed = new URL(rawUrl);
    const encodedHeaders =
      parsed.searchParams.get('__proxy_headers') ||
      parsed.searchParams.get('headers') ||
      '';

    return encodedHeaders ? JSON.parse(decodeURIComponent(encodedHeaders)) : {};
  } catch {
    return {};
  }
}

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json());
app.use((req, res, next) => {
  // Skip logging root, health checks, and HLS segment requests.
  if (
    req.originalUrl === '/' ||
    req.originalUrl === '/health' ||
    /\.ts(\?|$)/i.test(req.originalUrl)
  ) {
    return next();
  }

  const startedAt = Date.now();
  res.on('finish', () => {
    console.log(new Date().toISOString(), '[http]', req.method, req.originalUrl, res.statusCode, `${Date.now() - startedAt}ms`);
  });
  next();
});

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'video-sniff' });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'video-sniff' });
});

app.post('/test-playlist', async (req, res) => {
  const rawUrl = String(req.body?.url || '').trim();

  if (!rawUrl) {
    return res.status(400).json({ error: 'url required' });
  }

  const embeddedHeaders = parseEmbeddedPlaybackHeaders(rawUrl);

  try {
    const response = await fetch(rawUrl, {
      headers: {
        accept: '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/145.0.0.0 Safari/537.36',
        ...embeddedHeaders,
      },
      redirect: 'follow',
    });

    const body = await response.text();
    return res.json({
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      preview: body.slice(0, 300),
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || String(error) });
  }
});

app.use('/frontend', express.static(resolve(rootDir, '../frontend')));
app.use('/api/extract', extractRoute);
app.use('/api/videasy', videasyRoute);
app.use('/api/stream', streamRoute);
app.use('/api/download', downloadRoute);
app.use('/api/subtitles', subtitlesRoute);
app.use('/resolve', resolveRoute);
app.use('/proxy', proxyRoute);
app.use('/', novaRoute);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);

  if (!shouldWarmBrowserOnStartup) {
    console.log(new Date().toISOString(), '[extractor] browser warm skipped');
    return;
  }

  warmBrowser().then(() => {
    console.log(new Date().toISOString(), '[extractor] browser warmed');
  }).catch((error) => {
    console.log(new Date().toISOString(), '[extractor] browser warm failed', error?.message || String(error));
  });
});
