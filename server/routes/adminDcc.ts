// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Admin → DCC (#1080): the instance's DCC settings, and which parts of DCC each
// account may use. DCC is granted in parts — chat, and receiving files — so an
// admin can allow direct chats without letting files land on the box. Every
// part also needs the operator's LURKER_DCC_ENABLED. Mounted under
// routes/admin.ts, so requireAuth + requireAdmin are inherited. Self-host only.
//
// Revoking a part stops what starts next: offers are ignored and starting
// actions refuse. Anything already running finishes, and what an account
// received stays its own to list and download.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { findUserById, listUsers } from '../db/users.js';
import {
  CAPABILITY_DCC_CHAT,
  CAPABILITY_DCC_RECEIVE,
  setUserCapability,
  userHasCapability,
  userIdsWithCapability,
} from '../db/userCapabilities.js';
import { dccAllowPrivateHosts, dccMasterEnabled, dccMaxFileBytes } from '../services/dccConfig.js';
import { DCC_FREE_DISK_FLOOR_BYTES, dccRoot } from '../services/dccPaths.js';
import { listDccStoredBytes } from '../db/dccTransfers.js';
import {
  getDccStorageLimit,
  listDccStorageLimits,
  setDccStorageLimit,
} from '../db/dccStorageLimits.js';
import { isNodeMode } from '../utils/edition.js';

const router = Router();

router.use((_req: Request, res: Response, next) => {
  if (isNodeMode()) {
    res.status(409).json({ error: 'DCC is not available in node edition' });
    return;
  }
  next();
});

/** GET /api/admin/dcc — instance settings, and every account's grants. */
router.get('/', (_req: Request, res: Response) => {
  const chat = userIdsWithCapability(CAPABILITY_DCC_CHAT);
  const receive = userIdsWithCapability(CAPABILITY_DCC_RECEIVE);
  const limits = listDccStorageLimits();
  const stored = listDccStoredBytes();
  res.json({
    // LURKER_DCC_ENABLED. Off, no grant does anything — but grants still list,
    // so an admin can clear them before turning DCC back on.
    enabled: dccMasterEnabled(),
    // The download root; each account's files land in a folder under it.
    directory: dccRoot(),
    maxFileBytes: dccMaxFileBytes(),
    allowPrivateHosts: dccAllowPrivateHosts(),
    freeDiskFloorBytes: DCC_FREE_DISK_FLOOR_BYTES,
    users: listUsers().map((u) => ({
      id: u.id,
      username: u.username,
      chat: chat.has(u.id),
      receive: receive.has(u.id),
      // Null for no limit (#1125).
      limitBytes: limits.get(u.id) ?? null,
      // What the account's received files take on disk, partials included.
      usedBytes: stored.get(u.id) ?? 0,
    })),
  });
});

/** PUT /api/admin/dcc/users/:id — set any of `{chat?, receive?, limitBytes?}`;
 *  `limitBytes` is a positive whole number of bytes, or null for no limit. */
router.put('/users/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const { chat, receive, limitBytes } = (req.body ?? {}) as {
    chat?: unknown;
    receive?: unknown;
    limitBytes?: unknown;
  };
  const valid = (v: unknown) => v === undefined || typeof v === 'boolean';
  const validLimit =
    limitBytes === undefined ||
    limitBytes === null ||
    (Number.isSafeInteger(limitBytes) && (limitBytes as number) > 0);
  if (
    !valid(chat) ||
    !valid(receive) ||
    !validLimit ||
    (chat === undefined && receive === undefined && limitBytes === undefined)
  ) {
    res.status(400).json({
      error:
        'send chat and/or receive (true or false), and/or limitBytes (a positive number, or null)',
    });
    return;
  }
  if (!findUserById(id)) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (typeof chat === 'boolean') setUserCapability(id, CAPABILITY_DCC_CHAT, chat);
  if (typeof receive === 'boolean') setUserCapability(id, CAPABILITY_DCC_RECEIVE, receive);
  if (limitBytes !== undefined) setDccStorageLimit(id, limitBytes as number | null);
  res.json({
    chat: userHasCapability(id, CAPABILITY_DCC_CHAT),
    receive: userHasCapability(id, CAPABILITY_DCC_RECEIVE),
    limitBytes: getDccStorageLimit(id),
  });
});

export default router;
