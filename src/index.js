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
const shouldWarmBrowserOnStartup = String(process.env.NOVA_SKIP_BROWSER_WARMUP || '0') !== '1';

function shouldLogHttpRequest(req, res) {
  if (!String(req.originalUrl || '').startsWith('/proxy')) {
    return true;
  }

  if (res.statusCode >= 400) {
    return true;
  }

  return res.locals.proxyLogMode !== 'asset';
}

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    if (!shouldLogHttpRequest(req, res)) {
      return;
    }

    console.log(new Date().toISOString(), '[http]', req.method, req.originalUrl, res.statusCode, `${Date.now() - startedAt}ms`);
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
