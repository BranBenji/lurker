// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Chunked, resumable uploads (#650); see services/uploadSessions.ts.
//
//   POST   /                  {purpose, size, filename, mime?, uploaderId?}
//                             → 201 {id, purpose, size, offset, chunkBytes, state}
//   GET    /:id               → the same, and once done `result`: what
//                             complete answered, {status, body}
//   PUT    /:id               raw chunk, Upload-Offset header → {offset}
//   POST   /:id/complete      {progressToken?} → what POST /api/uploads or
//                             POST /api/imports answers, or for 'dcc-send'
//                             {file}, the DCC file it became; again once done
//   DELETE /:id               → {ok: true}
//
// Every refusal that concerns where the file is carries `offset`, so a client
// never has to guess where to carry on.

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { capText } from '../utils/capText.js';
import {
  abortUploadSession,
  appendUploadChunk,
  createUploadSession,
  finishUploadSession,
  uploadSessionStatus,
} from '../services/uploadSessions.js';
import { processUpload, UploadRequestError } from '../services/uploadService.js';
import { requestBaseUrl } from './uploads.js';
import { answerImport } from './exports.js';
import { answerDccUpload } from './dcc.js';

const router = Router();
router.use(requireAuth);

function fail(res: Response, next: NextFunction, err: unknown): void {
  if (err instanceof UploadRequestError) {
    // A chunk whose client went away has no one to answer.
    if (!res.writableEnded && !res.destroyed) {
      res.status(err.status).json({ error: err.message, ...err.extra });
    }
    return;
  }
  next(err);
}

router.post('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = createUploadSession(
      { id: req.user!.id, isAdmin: req.user!.role === 'admin' },
      (req.body ?? {}) as Record<string, unknown>,
    );
    res.status(201).json(session);
  } catch (err) {
    fail(res, next, err);
  }
});

router.get('/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(uploadSessionStatus(req.user!.id, String(req.params.id)));
  } catch (err) {
    fail(res, next, err);
  }
});

router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const length = req.headers['content-length'];
    const out = await appendUploadChunk(
      req.user!.id,
      String(req.params.id),
      req.headers['upload-offset'],
      length === undefined ? null : Number(length),
      req,
    );
    res.json(out);
  } catch (err) {
    fail(res, next, err);
  }
});

router.post('/:id/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tokenRaw = (req.body as { progressToken?: unknown } | undefined)?.progressToken;
    const { status, body } = await finishUploadSession(
      req.user!.id,
      String(req.params.id),
      async (row, filePath) => {
        if (row.purpose === 'import') return answerImport(req.user!.id, filePath);
        if (row.purpose === 'dcc-send') return answerDccUpload(req.user!.id, row, filePath);
        try {
          const uploaded = await processUpload({
            userId: req.user!.id,
            isAdmin: req.user!.role === 'admin',
            tempPath: filePath,
            size: row.size,
            claimedMime: row.mime ?? 'application/octet-stream',
            originalName: row.filename,
            requestedUploaderId: row.uploader_id,
            progressToken: typeof tokenRaw === 'string' && tokenRaw ? capText(tokenRaw, 64) : null,
            chunked: true,
            baseUrl: () => requestBaseUrl(req),
          });
          return { status: 200, body: { ...uploaded } };
        } catch (err) {
          if (!(err instanceof UploadRequestError)) throw err;
          return { status: err.status, body: { error: err.message, ...err.extra } };
        }
      },
    );
    res.status(status).json(body);
  } catch (err) {
    fail(res, next, err);
  }
});

router.delete('/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    abortUploadSession(req.user!.id, String(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    fail(res, next, err);
  }
});

export default router;
