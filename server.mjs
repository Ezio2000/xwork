import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apiRoutes } from './routes/index.mjs';
import { readConfig } from './lib/config-store.mjs';
import { setWorkspaceRoot, validateWorkspaceCandidate } from './lib/workspace-root.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function bootstrapWorkspace() {
  try {
    const cfg = await readConfig();
    const root = cfg?.workspace?.root || null;
    const label = cfg?.workspace?.label || null;
    if (!root) return;
    try {
      const { absolutePath } = validateWorkspaceCandidate(root);
      setWorkspaceRoot(absolutePath, { label });
    } catch (err) {
      console.warn(`[xwork] configured workspace root is invalid, falling back to default: ${err.message}`);
    }
  } catch (err) {
    console.warn(`[xwork] failed to load workspace from config: ${err.message}`);
  }
}

await bootstrapWorkspace();

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
