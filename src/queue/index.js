import PQueue from 'p-queue';
import { extractVideoUrls } from '../workers/playwright.js';

const queue = new PQueue({ concurrency: Number(process.env.EXTRACTION_CONCURRENCY || 2) });

export function enqueueExtraction(url, jobId, onResult) {
  return queue.add(async () => {
    await extractVideoUrls(url, (result) => onResult(jobId, result));
    onResult(jobId, { done: true });
  });
}
