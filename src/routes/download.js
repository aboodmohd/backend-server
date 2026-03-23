import { Router } from 'express';
import { spawn } from 'child_process';
import path from 'path';

const router = Router();

function downloadHLS(m3u8Url, outputName, capturedHeaders = {}) {
  const outputPath = path.join('/tmp', `${outputName}.mp4`);
  const headerStr = Object.entries(capturedHeaders)
    .filter(([key]) => ['referer', 'origin', 'cookie', 'user-agent'].includes(key.toLowerCase()))
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n');

  const args = [
    '-headers', headerStr,
    '-i', m3u8Url,
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    '-y',
    outputPath
  ];

  const proc = spawn('ffmpeg', args);
  proc.stderr.on('data', (data) => process.stdout.write(data));

  return new Promise((resolve, reject) => {
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(outputPath);
        return;
      }
      reject(new Error(`ffmpeg exit ${code}`));
    });
  });
}

router.post('/', async (req, res) => {
  const { url, headers, filename = 'video' } = req.body || {};

  if (!url) {
    return res.status(400).json({ error: 'url required' });
  }

  try {
    const filePath = await downloadHLS(url, filename, headers || {});
    return res.download(filePath);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

export default router;
