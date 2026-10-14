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
  userIdsWithCapability,
} from '../db/userCapabilities.js';
import { dccAllowPrivateHosts, dccMasterEnabled, dccMaxFileBytes } from '../services/dccConfig.js';
import { DCC_FREE_DISK_FLOOR_BYTES, dccRoot } from '../services/dccPaths.js';
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
    })),
  });
});

/** PUT /api/admin/dcc/users/:id — set one or both parts: `{chat?, receive?}`. */
router.put('/users/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const { chat, receive } = (req.body ?? {}) as { chat?: unknown; receive?: unknown };
  const valid = (v: unknown) => v === undefined || typeof v === 'boolean';
  if (!valid(chat) || !valid(receive) || (chat === undefined && receive === undefined)) {
    res.status(400).json({ error: 'send chat and/or receive, each true or false' });
    return;
  }
  if (!findUserById(id)) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (typeof chat === 'boolean') setUserCapability(id, CAPABILITY_DCC_CHAT, chat);
  if (typeof receive === 'boolean') setUserCapability(id, CAPABILITY_DCC_RECEIVE, receive);
  res.json({
    chat: userIdsWithCapability(CAPABILITY_DCC_CHAT).has(id),
    receive: userIdsWithCapability(CAPABILITY_DCC_RECEIVE).has(id),
  });
});

export default router;
