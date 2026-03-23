process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '0';

import express from 'express';
import { browserPool } from './extractor/browserPool';
import { resolveRouter } from './routes/resolve';
import { redisCache } from './cache/redisCache';
import { logger } from './utils/logger';

const app = express();
const port = Number(process.env.PORT || 10000);

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    logger.info('request completed', {
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });
  next();
});

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'video-resolver-backend' });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.use('/resolve', resolveRouter);

app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('unhandled error', { message: error.message, stack: error.stack });
  res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
});

async function start(): Promise<void> {
  await browserPool.init();

  app.listen(port, () => {
    logger.info('server listening', { port });
  });
}

async function shutdown(signal: string): Promise<void> {
  logger.info('shutdown requested', { signal });
  await browserPool.shutdown();
  await redisCache.disconnect();
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

void start();
