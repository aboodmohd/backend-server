process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '0';

const express = require('express');
const proxyRoute = require('./routes/proxy');
const resolveRoute = require('./routes/resolve');
const subtitlesRoute = require('./routes/subtitles');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  const startedAt = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startedAt;
    console.log(
      `${new Date().toISOString()} [http] ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`,
    );
  });

  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.use('/resolve', resolveRoute);
app.use('/proxy', proxyRoute.router);
app.use('/subtitles', subtitlesRoute);

app.use((err, _req, res, _next) => {
  const statusCode = err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';

  console.error(`${new Date().toISOString()} [error]`, {
    code,
    message: err.message,
    stack: err.stack,
  });

  res.status(statusCode).json({
    success: false,
    message: err.message || 'Unexpected server error',
    error: {
      code,
      message: err.message || 'Unexpected server error',
    },
  });
});

app.listen(PORT, () => {
  console.log(`${new Date().toISOString()} [server] listening on port ${PORT}`);
});
