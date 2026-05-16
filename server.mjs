import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apiRoutes } from './routes/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (_req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));
app.use('/api/v1', apiRoutes());

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`xwork running at http://localhost:${PORT}`);
});
