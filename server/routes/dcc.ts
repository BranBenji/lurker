// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// DCC API (#270). Four surfaces: the download manager (list the user's
// transfers, act on them — accept a pending offer, reject it, cancel an
// in-flight one — and fetch a completed file over HTTP), the files the account
// keeps (#1133: list, download, delete), sending one of them to a peer (#1086),
// and DCC CHAT (open or close a direct chat with a peer). The transfer list is the DCC window's initial load; live updates arrive over the WS as
// `dcc-transfer` frames, and a chat's own output arrives as ordinary messages in
// its `=nick` buffer. All routes are user-scoped via requireAuth.

import fs from 'fs';
import path from 'path';
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
  dccActiveListenAvailable,
  dccAllowPrivateHosts,
  dccChatEnabledForUser,
  dccMasterEnabled,
  dccReceiveEnabledForUser,
  dccSendEnabledForUser,
  dccMaxFileBytes,
} from '../services/dccConfig.js';
import { resolveDccDestination, sanitizeDccFilename } from '../services/dccPaths.js';
import { hasFreeSpaceFor } from '../utils/diskSpace.js';
import { fanOutToUser } from '../services/wsHub.js';
import {
  DCC_ACTIVE_STATES,
  clearDccTransfer,
  clearFinishedDccTransfers,
  dccFileSending,
  dccPathClaimed,
  dccUsageBytes,
  holdsDccPartial,
  type ClearedDccTransfer,
  getDccTransfer,
  listDccTransfers,
  markDccFileDeleted,
} from '../db/dccTransfers.js';
import { getDccStorageLimit } from '../db/dccStorageLimits.js';
import {
  forgetDccFile,
  getDccFile,
  getDccFileRow,
  keepUploadedDccFile,
  listDccFiles,
  type DccFileRow,
} from '../db/dccFiles.js';
import { getNetwork } from '../db/networks.js';
import { findUserById } from '../db/users.js';
import type { UploadSessionResult, UploadSessionRow } from '../db/uploadSessions.js';
import { isChannelTarget, isSinglePeerTarget } from '../../shared/channels.js';
import { XDCC_MAX_PACKS } from '../../shared/xdcc.js';

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
  const send = dccSendEnabledForUser(req.user!.id);
  if (!receive && !send) {
    res.json({ chat, receive, send });
    return;
  }
  res.json({
    chat,
    receive,
    send,
    // 0 means no cap. A file uploaded to send has it too (#1086).
    maxFileBytes: dccMaxFileBytes(),
    allowPrivateHosts: dccAllowPrivateHosts(),
    // Whether an offer can be active (#1086). Without a public address and a
    // port range, only `-passive` sends work.
    canListen: dccActiveListenAvailable(),
    // What this account's files take on disk, and its limit (null for none)
    // (#1125).
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
const needsSend = needs(dccSendEnabledForUser, 'sending');

// A transfer or file id is a positive integer row id; reject anything else up
// front so a non-numeric :id can't reach better-sqlite3 as NaN (which throws →
// 500).
function rowId(req: Request): number | null {
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

function sending(res: Response): void {
  res.status(409).json({ error: 'the file is being sent; cancel its sends first' });
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
  const id = rowId(req);
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
  const id = rowId(req);
  const t = id == null ? undefined : getDccTransfer(req.user!.id, id);
  if (!t) {
    res.status(404).json({ error: 'transfer not found' });
    return;
  }
  if (DCC_ACTIVE_STATES.has(t.state)) {
    res.status(409).json({ error: 'cancel the transfer before deleting its file' });
    return;
  }
  // A send's file is one of the account's files, which may have gone to others
  // too; it is deleted under Files, not through one transfer that sent it.
  if (t.direction === 'send') {
    res.status(409).json({ error: 'a sent file is deleted from your files' });
    return;
  }
  const file = t.file_id == null ? undefined : getDccFileRow(req.user!.id, t.file_id);
  if (file) {
    if (dccFileSending(req.user!.id, file.id)) {
      sending(res);
      return;
    }
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

/** After transfers left the list: remove what they held on disk that was
 *  theirs rather than a kept file, tell every tab, and redraw the files they
 *  received, which no longer name a transfer. */
function afterCleared(userId: number, cleared: ClearedDccTransfer[]): void {
  for (const t of cleared) {
    if (t.destination_path && t.file_id == null) fs.rmSync(t.destination_path, { force: true });
  }
  fanOutToUser(userId, { kind: 'dcc-transfers-cleared', ids: cleared.map((t) => t.id) });
  for (const t of cleared) {
    const file = t.file_id == null ? undefined : getDccFile(userId, t.file_id);
    if (file) fanOutToUser(userId, { kind: 'dcc-file', file });
  }
}

/**
 * DELETE /api/dcc/:id — clear a finished transfer from the list (#1133). The
 * file it received stays in Files. A partial it still holds goes with it,
 * since nothing else would ever reach those bytes, but only with
 * `?partial=delete`, which a client sends once the user has said so; without
 * it, 409 with `partial: true`. A transfer still in flight is refused (409):
 * cancel it first.
 */
router.delete('/:id', (req: Request, res: Response) => {
  const id = rowId(req);
  const t = id == null ? undefined : getDccTransfer(req.user!.id, id);
  if (!t) {
    res.status(404).json({ error: 'transfer not found' });
    return;
  }
  if (DCC_ACTIVE_STATES.has(t.state)) {
    res.status(409).json({ error: 'cancel the transfer before clearing it' });
    return;
  }
  if (holdsDccPartial(t) && req.query.partial !== 'delete') {
    res.status(409).json({ error: 'transfer holds a partial download', partial: true });
    return;
  }
  clearDccTransfer(req.user!.id, t.id);
  afterCleared(req.user!.id, [t]);
  res.json({ ids: [t.id] });
});

/**
 * POST /api/dcc/clear — clear every finished transfer from the list (#1133).
 * Files stay, and so does a transfer still holding a partial download.
 */
router.post('/clear', (req: Request, res: Response) => {
  const cleared = clearFinishedDccTransfers(req.user!.id);
  if (cleared.length) afterCleared(req.user!.id, cleared);
  res.json({ ids: cleared.map((t) => t.id) });
});

/** GET /api/dcc/files — the files the account keeps (#1133), newest first. */
router.get('/files', (req: Request, res: Response) => {
  res.json({ files: listDccFiles(req.user!.id) });
});

/** GET /api/dcc/files/:id/file — a kept file's bytes, as GET /:id/file. */
router.get('/files/:id/file', (req: Request, res: Response, next: NextFunction) => {
  const id = rowId(req);
  const file = id == null ? undefined : getDccFileRow(req.user!.id, id);
  if (!file) {
    res.status(404).json({ error: 'file not found' });
    return;
  }
  sendDccFile(res, next, file.path, file.size, file.name);
});

/** DELETE /api/dcc/files/:id — remove a kept file from the server. Refused
 *  (409) while it is offered to someone or being sent (#1086). */
router.delete('/files/:id', (req: Request, res: Response) => {
  const id = rowId(req);
  const file = id == null ? undefined : getDccFileRow(req.user!.id, id);
  if (!file) {
    res.status(404).json({ error: 'file not found' });
    return;
  }
  if (dccFileSending(req.user!.id, file.id)) {
    sending(res);
    return;
  }
  deleteDccFile(req.user!.id, file);
  res.json({ ok: true });
});

// Acting on a transfer is a write — blocked for paused accounts (the list isn't)
// by the central requireAuth gate (#573); the GET list above stays available.

/** POST /api/dcc/:id/accept — accept a pending offer and start the download. */
router.post('/:id/accept', needsReceive, (req: Request, res: Response) => {
  const id = rowId(req);
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
  const id = rowId(req);
  if (id == null || !ircManager.rejectDccTransfer(req.user!.id, id)) {
    res.status(404).json({ error: 'transfer not found' });
    return;
  }
  res.json({ transfer: getDccTransfer(req.user!.id, id) });
});

/** POST /api/dcc/:id/cancel — cancel an in-flight or still-pending transfer. */
router.post('/:id/cancel', (req: Request, res: Response) => {
  const id = rowId(req);
  if (id == null || !ircManager.cancelDccTransfer(req.user!.id, id)) {
    res.status(404).json({ error: 'transfer not found' });
    return;
  }
  res.json({ transfer: getDccTransfer(req.user!.id, id) });
});

/** POST /api/dcc/:id/retry — ask again for a queued pack that failed (#1085):
 *  a new row at the FRONT of its bot's queue, which resumes the partial. */
router.post('/:id/retry', needsReceive, (req: Request, res: Response) => {
  const id = rowId(req);
  const row = id == null ? undefined : getDccTransfer(req.user!.id, id);
  if (!row) {
    res.status(404).json({ error: 'transfer not found' });
    return;
  }
  // A stalled pack (interrupted mid-resume, no receiver left) can be asked for
  // again too.
  // A failed one; a cancel or reject was the user's own word.
  if (row.pack == null || (row.state !== 'failed' && row.state !== 'stalled')) {
    res
      .status(409)
      .json({ error: 'only a queued pack that ended without its file can be retried' });
    return;
  }
  const result = ircManager.retryXdcc(req.user!.id, row);
  if (result === 'not-connected') {
    res.status(409).json({ error: 'network not connected' });
    return;
  }
  if (result === 'not-queued') {
    res.status(409).json({ error: 'that pack is already in the queue' });
    return;
  }
  res.json({ transfer: getDccTransfer(req.user!.id, result) });
});

// The pack numbers in a body, or why not.
function packsFrom(req: Request, res: Response, allowNull: boolean): number[] | null | undefined {
  const raw = req.body?.packs;
  if (raw === null && allowNull) return null;
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    !raw.every((p) => Number.isSafeInteger(p) && (p as number) >= 0)
  ) {
    res.status(400).json({ error: 'packs must be a list of pack numbers' });
    return undefined;
  }
  if (raw.length > XDCC_MAX_PACKS) {
    res.status(400).json({
      error: `at most ${XDCC_MAX_PACKS} packs at a time`,
    });
    return undefined;
  }
  return raw as number[];
}

/**
 * POST /api/dcc/xdcc — queue XDCC packs from a bot (#1085). Body: {networkId,
 * nick, packs: number[]}. One queue per bot on a network; the next pack is
 * asked for once nothing of that bot's is out. A pack already waiting or out
 * is skipped. Answers with the rows queued.
 */
router.post('/xdcc', needsReceive, (req: Request, res: Response) => {
  const t = peerTarget(req, res, 'an XDCC bot is a nick, not a channel');
  if (!t) return;
  const packs = packsFrom(req, res, false);
  if (!packs) return;
  const ids = ircManager.queueXdcc(req.user!.id, t.networkId, t.nick, packs);
  if (ids === null) {
    res.status(409).json({ error: 'network not connected' });
    return;
  }
  res.json({ transfers: ids.map((id) => getDccTransfer(req.user!.id, id)).filter(Boolean) });
});

/**
 * POST /api/dcc/xdcc/remove — take packs out of a bot's queue (#1085). Body:
 * {networkId, nick, packs: number[] | null}; null empties the bot's queue. A
 * pack already asked for is cancelled, which tells the bot. Needs no grant:
 * stopping is always allowed.
 */
router.post('/xdcc/remove', (req: Request, res: Response) => {
  const t = peerTarget(req, res, 'an XDCC bot is a nick, not a channel');
  if (!t) return;
  const packs = packsFrom(req, res, true);
  if (packs === undefined) return;
  res.json({ removed: ircManager.unqueueXdcc(req.user!.id, t.networkId, t.nick, packs) });
});

// {networkId, nick}, ownership-checked. Shared by the chat routes and send so
// none can act on a network the caller doesn't own.
function peerTarget(
  req: Request,
  res: Response,
  channelRefusal = 'a DCC chat is with a person, not a channel',
): { networkId: number; nick: string } | null {
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
    res.status(400).json({ error: channelRefusal });
    return null;
  }
  // A list or a STATUSMSG target would reach a channel too (`bob,#room`,
  // `@#room`).
  if (!isSinglePeerTarget(nick)) {
    res.status(400).json({ error: 'not a single nick' });
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
  const t = peerTarget(req, res);
  if (!t) return;
  const passive = req.body?.passive === true;
  if (!ircManager.dccChatOpen(req.user!.id, t.networkId, t.nick, { passive })) {
    res.status(409).json({ error: 'network not connected' });
    return;
  }
  res.json({ ok: true, target: `=${t.nick}` });
});

/**
 * POST /api/dcc/send — offer one of the account's files to a peer (#1086).
 * Body: {networkId, nick, fileId, passive?}. Answers with the transfer as soon
 * as the offer is out; it moves through offered → sending → completed (or ends
 * failed, rejected, cancelled) over the WS like any other.
 */
router.post('/send', needsSend, (req: Request, res: Response) => {
  const t = peerTarget(req, res, 'a DCC file goes to a person, not a channel');
  if (!t) return;
  const fileId = Number(req.body?.fileId);
  const file = Number.isInteger(fileId) && fileId > 0 ? getDccFileRow(req.user!.id, fileId) : null;
  if (!file) {
    res.status(404).json({ error: 'file not found' });
    return;
  }
  const result = ircManager.dccSendFile(req.user!.id, t.networkId, t.nick, file, {
    passive: req.body?.passive === true,
  });
  if ('error' in result) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ transfer: getDccTransfer(req.user!.id, result.transferId) });
});

/** POST /api/dcc/chat/close — close a live DCC chat. Body: {networkId, nick}. */
router.post('/chat/close', (req: Request, res: Response) => {
  const t = peerTarget(req, res);
  if (!t) return;
  if (!ircManager.dccChatClose(req.user!.id, t.networkId, t.nick)) {
    res.status(404).json({ error: 'no live DCC chat with that peer' });
    return;
  }
  res.json({ ok: true });
});

export default router;

/**
 * Complete an upload session for purpose 'dcc-send' (#1086): the uploaded file
 * becomes one of the account's DCC files, kept under its DCC folder like a
 * received one and counted against its storage limit. The session's checks
 * (grant, size cap, limit, free disk) ran before the first byte.
 */
export async function answerDccUpload(
  userId: number,
  row: UploadSessionRow,
  sessionPath: string,
): Promise<UploadSessionResult> {
  const username = findUserById(userId)?.username || 'user';
  // ⚠ Sync, from resolving the name to the rename that takes it, so no other
  // write can take the name in between.
  const place = (from: string): string => {
    const dest = resolveDccDestination(username, row.filename, (p) => dccPathClaimed(userId, p));
    fs.renameSync(from, dest);
    return dest;
  };
  let dest: string;
  try {
    dest = place(sessionPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') {
      return { status: 503, body: { error: (err as Error).message } };
    }
    // The DCC folder is another disk than the data dir. Copy beside where it
    // goes, under a name no file has, then take a name for it: the copy is
    // slow, and a name chosen before it could be taken meanwhile.
    const dir = path.dirname(resolveDccDestination(username, row.filename));
    if (!hasFreeSpaceFor(dir, row.size)) {
      return {
        status: 507,
        body: { error: 'not enough free disk space on the server for this file' },
      };
    }
    const part = path.join(dir, `.lurker-upload-${row.id}`);
    try {
      await fs.promises.copyFile(sessionPath, part);
      dest = place(part);
    } catch (copyErr) {
      fs.rmSync(part, { force: true });
      throw copyErr;
    }
  }
  try {
    // Session files are owner-only; a kept file is as readable as a received one.
    fs.chmodSync(dest, 0o644);
  } catch {
    // A filesystem without POSIX modes.
  }
  const file = keepUploadedDccFile(userId, {
    path: dest,
    name: path.basename(dest),
    size: row.size,
  });
  fanOutToUser(userId, { kind: 'dcc-file', file });
  return { status: 200, body: { file } };
}
