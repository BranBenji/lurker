// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// DCC API (#270). Three surfaces: the download manager (list the user's
// transfers, act on them — accept a pending offer, reject it, cancel an
// in-flight one — and fetch a completed file over HTTP), the files the account
// keeps (#1133: list, download, delete), and DCC CHAT (open or close a direct
// chat with a peer). The transfer list is the Transfers view's initial load; live updates arrive over the WS as
// `dcc-transfer` frames, and a chat's own output arrives as ordinary messages in
// its `=nick` buffer. All routes are user-scoped via requireAuth.

import fs from 'fs';
import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { requireAuth } from '../middleware/auth.js';
import ircManager from '../services/ircManager.js';
import {
  dccAllowPrivateHosts,
  dccChatEnabledForUser,
  dccMasterEnabled,
  dccReceiveEnabledForUser,
  dccMaxFileBytes,
} from '../services/dccConfig.js';
import { sanitizeDccFilename } from '../services/dccPaths.js';
import { fanOutToUser } from '../services/wsHub.js';
import {
  DCC_ACTIVE_STATES,
  dccUsageBytes,
  getDccTransfer,
  listDccTransfers,
  markDccFileDeleted,
} from '../db/dccTransfers.js';
import { getDccStorageLimit } from '../db/dccStorageLimits.js';
import { forgetDccFile, getDccFileRow, listDccFiles, type DccFileRow } from '../db/dccFiles.js';
import { getNetwork } from '../db/networks.js';
import { isChannelTarget } from '../../shared/channels.js';

const router = Router();
router.use(requireAuth);

/**
 * GET /api/dcc/config — which parts of DCC this account has (#1080), and the
 * limits on receiving when it may. Mounted ahead of the gate below on purpose:
 * Settings asks this to say "not turned on for your account" instead of
 * reading a 403.
 */
router.get('/config', (req: Request, res: Response) => {
  const chat = dccChatEnabledForUser(req.user!.id);
  const receive = dccReceiveEnabledForUser(req.user!.id);
  if (!receive) {
    res.json({ chat, receive });
    return;
  }
  res.json({
    chat,
    receive,
    // 0 means no cap.
    maxFileBytes: dccMaxFileBytes(),
    allowPrivateHosts: dccAllowPrivateHosts(),
    // What this account's received files take on disk, and its limit (null for
    // none) (#1125).
    usedBytes: dccUsageBytes(req.user!.id).stored,
    limitBytes: getDccStorageLimit(req.user!.id),
  });
});

// The DCC gate is two-tier (#1080). The instance switch (LURKER_DCC_ENABLED)
// guards everything here: with it off the whole surface is dark. The per-user
// grants guard only what STARTS something — accepting a file needs the receive
// grant, offering a chat the chat grant (needs() on those routes) — because
// revoking a grant stops what starts next. Reading your transfers, downloading
// what you received, and stopping things (reject, cancel, closing a chat) stay
// open to the account whatever its grants.
router.use((_req: Request, res: Response, next) => {
  if (!dccMasterEnabled()) {
    res.status(403).json({ error: 'DCC is not enabled on this server' });
    return;
  }
  next();
});

function needs(grant: (userId: number) => boolean, what: string): RequestHandler {
  return (req, res, next) => {
    if (!grant(req.user!.id)) {
      res.status(403).json({ error: `DCC ${what} is not enabled for this account` });
      return;
    }
    next();
  };
}
const needsReceive = needs(dccReceiveEnabledForUser, 'receiving');
const needsChat = needs(dccChatEnabledForUser, 'chat');

// A transfer id is a positive integer row id; reject anything else up front so a
// non-numeric :id can't reach better-sqlite3 as NaN (which throws → 500).
function transferId(req: Request): number | null {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** GET /api/dcc — the user's transfers, newest first. */
router.get('/', (req: Request, res: Response) => {
  const limit = req.query.limit ? Number(req.query.limit) : 100;
  res.json({ transfers: listDccTransfers(req.user!.id, { limit }) });
});

function gone(res: Response): void {
  res.status(410).json({ error: 'file is no longer on the server' });
}

/**
 * Send a file the account keeps, as an attachment named `name`. `size` is what
 * the file should be: a file removed on the box by hand, or a path some newer
 * file took since, is answered 410 rather than served. HTTP Range (via
 * res.download → sendFile) lets a multi-GB file resume instead of restarting.
 */
function sendDccFile(
  res: Response,
  next: NextFunction,
  filePath: string | null,
  size: number,
  name: string,
): void {
  const stat = filePath ? fs.statSync(filePath, { throwIfNoEntry: false }) : undefined;
  if (!filePath || !stat?.isFile() || stat.size !== size) {
    gone(res);
    return;
  }
  // The peer chose the filename and so its extension. Attachment plus
  // octet-stream means nothing it names (.html, .svg) renders on our origin;
  // nosniff and the sandbox hold that if the attachment is ever lost (the same
  // pair localUploads sets on untrusted bytes).
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  // dotfiles 'allow': with no root, send checks EVERY path component, so a
  // LURKER_DCC_DIR under a dot-directory (~/.lurker/dcc) would 404 every file.
  res.download(
    filePath,
    sanitizeDccFilename(name),
    {
      dotfiles: 'allow',
      headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store' },
    },
    (err) => {
      if (!err) return;
      // After the headers there is no status left to send. A client abort has
      // already closed the socket; a read that failed partway (a disk or NAS
      // error) has not, and send leaves the response open, so the browser would
      // wait forever for the rest of the advertised length. End it.
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // send's own refusals are the client's: an unsatisfiable Range (resuming a
      // file it already has whole) is a 416, Content-Range already set; a stale
      // If-Match is a 412. Its 404 is the file going between the stat and the
      // open.
      const status = (err as { status?: number }).status;
      if (status === 404) gone(res);
      else if (status !== undefined && status >= 400 && status < 500) res.status(status).end();
      else next(err);
    },
  );
}

/**
 * Remove a kept file from disk and forget it (#1133). The transfers that
 * pointed at it stay as history, marked deleted; every tab hears about both.
 */
function deleteDccFile(userId: number, file: DccFileRow): void {
  fs.rmSync(file.path, { force: true });
  const touched = forgetDccFile(userId, file.id);
  for (const id of touched) {
    fanOutToUser(userId, { kind: 'dcc-transfer', transfer: getDccTransfer(userId, id) });
  }
  fanOutToUser(userId, { kind: 'dcc-file-deleted', id: file.id });
}

/**
 * GET /api/dcc/:id/file — the bytes of a completed transfer (#1079), so a
 * received file can leave the box without shell access. Ownership-checked by
 * the user-scoped lookup. Served from the file the transfer produced (#1133).
 */
router.get('/:id/file', (req: Request, res: Response, next: NextFunction) => {
  const id = transferId(req);
  const t = id == null ? undefined : getDccTransfer(req.user!.id, id);
  if (!t) {
    res.status(404).json({ error: 'transfer not found' });
    return;
  }
  // Anything short of completed is a partial, or not a file at all yet.
  if (t.state !== 'completed') {
    res.status(409).json({ error: 'transfer is not complete', state: t.state });
    return;
  }
  const file = t.file_id == null ? undefined : getDccFileRow(req.user!.id, t.file_id);
  if (!file) {
    gone(res);
    return;
  }
  sendDccFile(res, next, file.path, file.size, t.filename);
});

/**
 * DELETE /api/dcc/:id/file — remove a transfer's file from the server (#1125),
 * so a user with a storage limit can make room. Needs no grant, like anything
 * else about what an account already received. A completed transfer's file is
 * a kept file (#1133), deleted as one; an unfinished transfer's partial goes
 * with it. The row stays as history, marked deleted. A transfer still in
 * flight is refused (409): cancel it first.
 */
router.delete('/:id/file', (req: Request, res: Response) => {
  const id = transferId(req);
  const t = id == null ? undefined : getDccTransfer(req.user!.id, id);
  if (!t) {
    res.status(404).json({ error: 'transfer not found' });
    return;
  }
  if (DCC_ACTIVE_STATES.has(t.state)) {
    res.status(409).json({ error: 'cancel the transfer before deleting its file' });
    return;
  }
  const file = t.file_id == null ? undefined : getDccFileRow(req.user!.id, t.file_id);
  if (file) {
    deleteDccFile(req.user!.id, file);
    res.json({ transfer: getDccTransfer(req.user!.id, t.id) });
    return;
  }
  if (!t.destination_path) {
    // Already deleted, or nothing was ever written.
    res.status(404).json({ error: 'no file to delete' });
    return;
  }
  // A partial: only one row owns a path (markDccReceiving releases it from the
  // rest), so this file is this row's.
  fs.rmSync(t.destination_path, { force: true });
  markDccFileDeleted(t.id);
  const transfer = getDccTransfer(req.user!.id, t.id);
  // The user's other tabs and devices drop Download and Delete too.
  fanOutToUser(req.user!.id, { kind: 'dcc-transfer', transfer });
  res.json({ transfer });
});

// A file id is a positive integer row id, as a transfer's is.
function fileId(req: Request): number | null {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** GET /api/dcc/files — the files the account keeps (#1133), newest first. */
router.get('/files', (req: Request, res: Response) => {
  res.json({ files: listDccFiles(req.user!.id) });
});

/** GET /api/dcc/files/:id/file — a kept file's bytes, as GET /:id/file. */
router.get('/files/:id/file', (req: Request, res: Response, next: NextFunction) => {
  const id = fileId(req);
  const file = id == null ? undefined : getDccFileRow(req.user!.id, id);
  if (!file) {
    res.status(404).json({ error: 'file not found' });
    return;
  }
  sendDccFile(res, next, file.path, file.size, file.name);
});

/** DELETE /api/dcc/files/:id — remove a kept file from the server. */
router.delete('/files/:id', (req: Request, res: Response) => {
  const id = fileId(req);
  const file = id == null ? undefined : getDccFileRow(req.user!.id, id);
  if (!file) {
    res.status(404).json({ error: 'file not found' });
    return;
  }
  deleteDccFile(req.user!.id, file);
  res.json({ ok: true });
});

// Acting on a transfer is a write — blocked for paused accounts (the list isn't)
// by the central requireAuth gate (#573); the GET list above stays available.

/** POST /api/dcc/:id/accept — accept a pending offer and start the download. */
router.post('/:id/accept', needsReceive, (req: Request, res: Response) => {
  const id = transferId(req);
  if (id == null) {
    res.status(404).json({ error: 'transfer not found' });
    return;
  }
  const result = ircManager.acceptDccTransfer(req.user!.id, id);
  if (result === 'not-found') {
    res.status(404).json({ error: 'transfer not found' });
    return;
  }
  if (result === 'not-pending') {
    res.status(409).json({ error: 'transfer is not awaiting approval' });
    return;
  }
  if (result === 'not-connected') {
    res.status(409).json({ error: 'network not connected' });
    return;
  }
  res.json({ transfer: getDccTransfer(req.user!.id, id) });
});

/** POST /api/dcc/:id/reject — reject a pending offer (no download). */
router.post('/:id/reject', (req: Request, res: Response) => {
  const id = transferId(req);
  if (id == null || !ircManager.rejectDccTransfer(req.user!.id, id)) {
    res.status(404).json({ error: 'transfer not found' });
    return;
  }
  res.json({ transfer: getDccTransfer(req.user!.id, id) });
});

/** POST /api/dcc/:id/cancel — cancel an in-flight or still-pending transfer. */
router.post('/:id/cancel', (req: Request, res: Response) => {
  const id = transferId(req);
  if (id == null || !ircManager.cancelDccTransfer(req.user!.id, id)) {
    res.status(404).json({ error: 'transfer not found' });
    return;
  }
  res.json({ transfer: getDccTransfer(req.user!.id, id) });
});

// {networkId, nick}, ownership-checked. Shared by both chat routes so neither
// can act on a network the caller doesn't own.
function chatTarget(req: Request, res: Response): { networkId: number; nick: string } | null {
  const networkId = Number(req.body?.networkId);
  const nick = typeof req.body?.nick === 'string' ? req.body.nick.trim() : '';
  if (!Number.isInteger(networkId) || networkId <= 0 || !nick) {
    res.status(400).json({ error: 'networkId and nick are required' });
    return null;
  }
  // ⚠ A nick with whitespace would become extra CTCP parameters on the wire;
  // a `=`-prefixed one would name a buffer rather than a peer. Neither is a
  // real nick, so refuse rather than normalise.
  // Matching the control chars is the whole point here — same rule the DCC
  // filename quoter states.
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f]/.test(nick) || nick.startsWith('=')) {
    res.status(400).json({ error: 'not a valid nick' });
    return null;
  }
  // A DCC chat is with a peer. A channel name would broadcast the offer to the
  // whole channel (ircConnection.offerDccChat refuses it too — this is the
  // early, explained refusal).
  if (isChannelTarget(nick)) {
    res.status(400).json({ error: 'a DCC chat is with a person, not a channel' });
    return null;
  }
  if (!getNetwork(networkId, req.user!.id)) {
    res.status(404).json({ error: 'network not found' });
    return null;
  }
  return { networkId, nick };
}

/**
 * POST /api/dcc/chat — offer a DCC chat to a peer. Body: {networkId, nick,
 * passive?}. Returns as soon as the offer is sent; the outcome (connected,
 * refused, timed out) lands in the `=nick` buffer, because a DCC handshake can
 * take as long as the peer takes to answer.
 */
router.post('/chat', needsChat, (req: Request, res: Response) => {
  const t = chatTarget(req, res);
  if (!t) return;
  const passive = req.body?.passive === true;
  if (!ircManager.dccChatOpen(req.user!.id, t.networkId, t.nick, { passive })) {
    res.status(409).json({ error: 'network not connected' });
    return;
  }
  res.json({ ok: true, target: `=${t.nick}` });
});

/** POST /api/dcc/chat/close — close a live DCC chat. Body: {networkId, nick}. */
router.post('/chat/close', (req: Request, res: Response) => {
  const t = chatTarget(req, res);
  if (!t) return;
  if (!ircManager.dccChatClose(req.user!.id, t.networkId, t.nick)) {
    res.status(404).json({ error: 'no live DCC chat with that peer' });
    return;
  }
  res.json({ ok: true });
});

export default router;
