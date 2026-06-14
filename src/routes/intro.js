import { Router } from 'express';

const router = Router();
const INTRODB_BASE_URL = 'https://api.theintrodb.org/v2/media';
const REQUEST_TIMEOUT_MS = 10000;

function withTimeout(ms = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    done: () => clearTimeout(timer)
  };
}

router.get('/', async (req, res) => {
  const tmdbId = String(req.query.tmdb_id || '').trim();
  if (!tmdbId) {
    return res.status(400).json({ error: 'tmdb_id required' });
  }

  const query = new URLSearchParams(req.query);
  const { signal, done } = withTimeout();

  try {
    const response = await fetch(`${INTRODB_BASE_URL}?${query}`, {
      signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });

    if (response.status === 404) {
      // Return empty success instead of 404 to avoid browser console errors
      return res.json({});
    }

    if (!response.ok) {
      console.error(new Date().toISOString(), '[introdb] upstream error', response.status, tmdbId);
      return res.status(response.status).json({ error: 'Upstream API error' });
    }

    const data = await response.json();
    return res.json(data);
  } catch (error) {
    if (error.name === 'AbortError') {
      return res.status(504).json({ error: 'Upstream API timeout' });
    }
    console.error(new Date().toISOString(), '[introdb] fetch error', error.message || String(error));
    return res.status(502).json({ error: 'Failed to fetch from IntroDB' });
  } finally {
    done();
  }
});

export default router;
