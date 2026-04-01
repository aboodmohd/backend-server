import { Router } from 'express';
import { createMemoryCache } from './cache.js';
import { getVideasyCacheKey, resolveVideasySource } from './providers.js';

const router = Router();
const cache = createMemoryCache();

router.get('/', async (req, res) => {
  try {
    const query = {
      title: req.query.title,
      year: req.query.year,
      tmdbId: req.query.tmdbId,
      imdbId: req.query.imdbId,
      mediaType: req.query.mediaType,
      season: req.query.season,
      episode: req.query.episode,
    };

    const cacheKey = getVideasyCacheKey({
      tmdbId: Number(query.tmdbId),
      mediaType: String(query.mediaType || '').toLowerCase(),
      season: query.season ? Number(query.season) : null,
      episode: query.episode ? Number(query.episode) : null,
    });

    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const result = await resolveVideasySource(query);
    cache.set(cacheKey, result);
    return res.json(result);
  } catch (error) {
    const message = error?.message || 'Videasy resolve failed';
    const status = /required|must be/i.test(message) ? 400 : 404;
    return res.status(status).json({ error: message });
  }
});

export default router;
