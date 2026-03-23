import { Router } from 'express';
import { addListener, getResults, removeListener } from '../store/results.js';

const router = Router();

router.get('/:jobId', (req, res) => {
  const { jobId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  getResults(jobId).forEach(send);
  addListener(jobId, send);

  req.on('close', () => {
    removeListener(jobId, send);
  });
});

export default router;
