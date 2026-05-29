import { Router } from 'express';

import {
  createImageAsset,
  imageAssetFilePath,
} from '../lib/image-assets.mjs';
import { SchemaValidationError, validateSafeId } from '../lib/schema.mjs';

function sendError(res, err) {
  if (err instanceof SchemaValidationError) {
    return res.status(err.status).json({ error: err.message });
  }
  throw err;
}

export function imageRoutes() {
  const router = Router();

  router.post('/images', async (req, res) => {
    try {
      const asset = await createImageAsset({
        dataUrl: req.body?.dataUrl,
        filename: req.body?.filename,
      });
      res.json(asset);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/images/:id', async (req, res) => {
    try {
      const id = validateSafeId(req.params.id, 'imageId');
      const { asset, filePath } = await imageAssetFilePath(id);
      res.type(asset.mediaType);
      res.sendFile(filePath);
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
