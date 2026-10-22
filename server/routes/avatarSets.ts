// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// REST surface for uploaded avatar tile sets (#607). Thin like routes/themes.ts:
// validation, zip ingestion and fan-out live in services/avatarSetsService.ts.
// The bundled set is static files under /avatars/default, never listed here.
//
//   GET    /api/avatar-sets            the user's sets
//   POST   /api/avatar-sets            multipart: name + zip
//   DELETE /api/avatar-sets/:id
//   GET    /api/avatar-sets/:id/<nnn>.webp   one tile

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import avatarSetsService, { discardZip } from '../services/avatarSetsService.js';
import { UPLOAD_TMP_DIR } from '../services/uploadService.js';
import { AVATAR_SET_ZIP_MAX_BYTES, AVATAR_TILE_EXT } from '../../shared/avatarSets.js';

const router = Router();
router.use(requireAuth);

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// The zip lands in the upload temp dir under the `up-` prefix the crash-orphan
// sweep covers (routes/uploads.ts), and is removed when the handler is done.
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_TMP_DIR),
  filename: (_req, _file, cb) =>
    cb(null, `up-avatarset-${crypto.randomBytes(8).toString('hex')}.zip`),
});

const zipToDisk = (req: Request, res: Response, next: NextFunction): void => {
  const handler = multer({
    storage,
    // One name and one zip: the text fields multer keeps in memory are bounded
    // too, not just the file.
    limits: { fileSize: AVATAR_SET_ZIP_MAX_BYTES, files: 1, fields: 1, fieldSize: 256, parts: 2 },
    defParamCharset: 'utf8',
  }).single('zip');
  handler(req, res, (err: unknown) => {
    if ((err as { code?: string })?.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        error: `zip exceeds ${Math.round(AVATAR_SET_ZIP_MAX_BYTES / (1024 * 1024))} MB`,
      });
      return;
    }
    next(err as Error | undefined);
  });
};

router.get('/', (req: Request, res: Response) => {
  res.json({ items: avatarSetsService.list(req.user!.id) });
});

router.post('/', zipToDisk, async (req: Request, res: Response) => {
  const file = req.file;
  try {
    if (!file) {
      res.status(400).json({ error: 'a zip file is required (field "zip")' });
      return;
    }
    const result = await avatarSetsService.createFromZip(req.user!.id, req.body?.name, file.path);
    if (!result.ok) {
      res.status(result.status ?? 400).json({ error: result.error });
      return;
    }
    res.status(201).json({ set: result.set, skipped: result.skipped });
  } finally {
    await discardZip(file?.path);
  }
});

router.delete('/:id', (req: Request<{ id: string }>, res: Response) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'invalid avatar set id' });
    return;
  }
  const result = avatarSetsService.remove(req.user!.id, id);
  if (!result.ok) {
    res.status(result.status ?? 400).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

// One tile, by the name the client builds (shared/avatarTiles.ts tileUrl).
// Immutable: a set is never edited, only replaced, and its id is never reused.
router.get('/:id/:file', (req: Request<{ id: string; file: string }>, res: Response) => {
  const id = parseId(req.params.id);
  const m = new RegExp(`^(\\d{3})\\.${AVATAR_TILE_EXT}$`).exec(req.params.file);
  if (id === null || !m) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const tile = avatarSetsService.tile(req.user!.id, id, parseInt(m[1], 10));
  if (!tile) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // The same belt and braces the local-uploads route wears: the type is the
  // one the normaliser wrote, and nothing here is ever a document.
  res.setHeader('Content-Type', 'image/webp');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.send(tile);
});

export default router;
