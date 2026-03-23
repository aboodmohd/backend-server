import { Router } from 'express';
import { resolveStream } from '../extractor/universalExtractor';
import type { ResolveRequestBody } from '../types';
import { logger } from '../utils/logger';

export const resolveRouter = Router();

resolveRouter.post('/', async (req, res) => {
  const body = req.body as Partial<ResolveRequestBody>;
  const inputUrl = typeof body.url === 'string' ? body.url.trim() : '';

  if (!inputUrl) {
    return res.status(400).json({ error: 'URL_REQUIRED' });
  }

  try {
    new URL(inputUrl);
  } catch {
    return res.status(400).json({ error: 'INVALID_URL' });
  }

  try {
    const result = await resolveStream(inputUrl);
    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'STREAM_NOT_FOUND';
    logger.error('resolve failed', { url: inputUrl, message });
    return res.status(message === 'STREAM_NOT_FOUND' ? 404 : 500).json({ error: message });
  }
});
