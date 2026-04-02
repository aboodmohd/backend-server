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
import { warmBrowser } from './workers/playwright.js';
import videasyRoute from '../server/server.js';

const app = express();
const rootDir = dirname(fileURLToPath(import.meta.url));

function isPlaylistUrl(targetUrl = '') {
  return /\.m3u8(\?|$)/i.test(String(targetUrl || ''));
}

function summarizeUrl(targetUrl = '') {
  try {
    const parsed = new URL(String(targetUrl || ''));
    const segments = parsed.pathname.split('/').filter(Boolean);
    const tail = segments.slice(-2).join('/');
    return `${parsed.host}/${tail || ''}`.replace(/\/$/, '');
  } catch {
    return String(targetUrl || '');
  }
}

function formatHttpLog(req, res, durationMs) {
  const status = res.statusCode;

  if (req.path === '/resolve') {
    return ['[http]', req.method, req.path, status, `${durationMs}ms`];
  }

  if (req.path === '/' && status < 400) {
    return null;
  }

  if (req.path === '/proxy') {
    const targetUrl = String(req.query.url || '');
    const playlist = isPlaylistUrl(targetUrl);

    if (!playlist && status < 400) {
      return null;
    }

    return ['[http]', req.method, req.path, summarizeUrl(targetUrl), status, `${durationMs}ms`];
  }

  if (status < 400) {
    return null;
  }

  return ['[http]', req.method, req.path, status, `${durationMs}ms`];
}

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    const logParts = formatHttpLog(req, res, Date.now() - startedAt);
    if (logParts) {
      console.log(new Date().toISOString(), ...logParts);
    }
  });
  next();
});

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'video-sniff' });
});

app.use('/frontend', express.static(resolve(rootDir, '../frontend')));
app.use('/api/extract', extractRoute);
app.use('/api/videasy', videasyRoute);
app.use('/api/stream', streamRoute);
app.use('/api/download', downloadRoute);
app.use('/api/subtitles', subtitlesRoute);
app.use('/resolve', resolveRoute);
app.use('/proxy', proxyRoute);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  warmBrowser().then(() => {
    console.log(new Date().toISOString(), '[extractor] browser warmed');
  }).catch((error) => {
    console.log(new Date().toISOString(), '[extractor] browser warm failed', error?.message || String(error));
  });
});
