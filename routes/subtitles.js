const express = require('express');
const universal = require('../extractors/universal');

const router = express.Router();

router.get('/', async (req, res) => {
  const { embedUrl } = req.query;

  if (!embedUrl) {
    return res.json({
      success: true,
      subtitles: [],
      source: null,
    });
  }

  try {
    const result = await universal.resolve(String(embedUrl), { quality: 'auto' });
    return res.json({
      success: true,
      subtitles: Array.isArray(result.subtitles) ? result.subtitles : [],
      source: result.source || null,
    });
  } catch {
    return res.json({
      success: true,
      subtitles: [],
      source: null,
    });
  }
});

module.exports = router;
