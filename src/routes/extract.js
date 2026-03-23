import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { enqueueExtraction } from '../queue/index.js';
import { appendResult, createCacheStore } from '../store/results.js';

const router = Router();
const cache = createCacheStore();
const ONE_HOUR_MS = 60 * 60 * 1000;

router.post('/', async (req, res) => {
  const { url } = req.body || {};
  if (!url) {
    return res.status(400).json({ error: 'url required' });
  }

  const cacheKey = `stream:${url}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return res.json({ jobId: null, cached: true, results: cached });
  }

  const jobId = uuid();
  res.json({ jobId, cached: false });

  enqueueExtraction(url, jobId, (id, data) => {
    appendResult(id, data);
    if (data && data.url) {
      cache.set(cacheKey, [data], ONE_HOUR_MS);
    }
  }).catch((error) => {
    appendResult(jobId, { error: error.message, done: true });
  });
});

export default router;
