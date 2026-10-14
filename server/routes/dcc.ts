// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// DCC API (#270). Two surfaces: the download manager (list the user's transfers,
// act on them — accept a pending offer, reject it, cancel an in-flight one — and
// fetch a completed file over HTTP), and DCC CHAT (open or close a direct chat
// with a peer). The transfer list is the Transfers view's initial load; live updates arrive over the WS as
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
import { getDccTransfer, listDccTransfers } from '../db/dccTransfers.js';
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
 * GET /api/dcc/:id/file — the bytes of a completed transfer (#1079), so a
 * received file can leave the box without shell access. Ownership-checked by
 * the user-scoped lookup; HTTP Range (via res.download → sendFile) lets a
 * multi-GB file resume instead of restarting.
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
  const filePath = t.destination_path;
  const stat = filePath ? fs.statSync(filePath, { throwIfNoEntry: false }) : undefined;
  // Gone (removed on the box by hand), or no longer this transfer's file: once
  // it is removed the path is free again, so a later offer of the same name can
  // be writing there now.
  if (!filePath || !stat?.isFile() || stat.size !== t.received_bytes) {
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
    sanitizeDccFilename(t.filename),
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
