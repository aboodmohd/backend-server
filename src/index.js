import express from 'express';
import cors from 'cors';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import extractRoute from './routes/extract.js';
import streamRoute from './routes/stream.js';
import downloadRoute from './routes/download.js';
import resolveRoute from './routes/resolve.js';
import proxyRoute from './routes/proxy.js';
import { warmBrowser } from './workers/playwright.js';
import videasyRoute from '../server/server.js';

const app = express();
const rootDir = dirname(fileURLToPath(import.meta.url));

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
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
