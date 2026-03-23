import express from 'express';
import cors from 'cors';
import extractRoute from './routes/extract.js';
import streamRoute from './routes/stream.js';
import downloadRoute from './routes/download.js';
import resolveRoute from './routes/resolve.js';

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'video-sniff' });
});

app.use('/api/extract', extractRoute);
app.use('/api/stream', streamRoute);
app.use('/api/download', downloadRoute);
app.use('/resolve', resolveRoute);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
