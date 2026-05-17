import { Router } from 'express';

import {
  createBasePricingEntry,
  deleteBasePricingEntry,
  listBasePricing,
  updateBasePricingEntry,
} from '../lib/pricing-store.mjs';
import { SchemaValidationError } from '../lib/schema.mjs';

function sendResult(res, result, fallbackStatus = 400) {
  if (result?.error) {
    return res.status(result.status || fallbackStatus).json({ error: result.error });
  }
  return res.json(result);
}

function sendError(res, err) {
  if (err instanceof SchemaValidationError) {
    return res.status(err.status).json({ error: err.message });
  }
  throw err;
}

export function pricingRoutes() {
  const router = Router();

  router.get('/model-pricing', async (_req, res) => {
    res.json(await listBasePricing());
  });

  router.post('/model-pricing', async (req, res) => {
    try {
      sendResult(res, await createBasePricingEntry(req.body || {}));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.put('/model-pricing/:id', async (req, res) => {
    try {
      sendResult(res, await updateBasePricingEntry(req.params.id, req.body || {}));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.delete('/model-pricing/:id', async (req, res) => {
    try {
      sendResult(res, await deleteBasePricingEntry(req.params.id));
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
