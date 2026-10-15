// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Persistence for the DCC download manager (#270) — one row per DCC transfer,
// either way. The IRC connection lives on the cell, so received bytes land on
// disk at destination_path while this row tracks the transfer's lifecycle for
// the download-manager UI and survives a cell restart (so a stalled transfer can
// be resumed). A send (#1086) is a row with direction 'send' and the file it
// sends in file_id; its received_bytes is what the peer has confirmed. Nothing
// here touches the message tables.

import db from './index.js';
import { dccFileAt, keepReceivedDccFile, type DccFile } from './dccFiles.js';

// The download-manager state machine. Two entry states:
//   - `requested`: we sent an XDCC trigger and armed acceptance for the bot's
//     reply (phase 1). Survives a slow bot queue — the row just waits.
//   - `pending_approval`: an UNSOLICITED offer awaiting the user's Accept/Reject
//     (phase 2). Phase 0 records every detected offer here, since arming doesn't
//     exist yet and nothing may auto-land.
// From an accepted offer the flow is connecting → receiving → (stalled, on a
// dropped connection or restart) → verifying → completed; or it ends
// failed / rejected / cancelled. A send (#1086) is `offered` until the peer
// connects, then `sending`, and ends the same ways. Kept as a TS union + a TEXT
// column (matching the repo's other enum columns, e.g. peer_presence_state.state)
// rather than a DB CHECK, so the allowed values live in one documented place.
export type DccTransferState =
  | 'requested'
  | 'pending_approval'
  | 'connecting'
  | 'receiving'
  | 'stalled'
  | 'verifying'
  | 'offered'
  | 'sending'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cancelled';

// States a transfer can still leave — i.e. NOT terminal. Used to gate the
// cancel/reject actions so they never clobber a finished row (completed /
// failed / rejected / cancelled): a one-shot transfer never legitimately
// re-enters an active state, so a late action on a terminal row is a no-op.
export const DCC_ACTIVE_STATES: ReadonlySet<DccTransferState> = new Set([
  'requested',
  'pending_approval',
  'connecting',
  'receiving',
  'stalled',
  'verifying',
  'offered',
  'sending',
]);

/** Which way a transfer goes: a file we receive, or one of ours we send. */
export type DccDirection = 'recv' | 'send';

export interface DccTransferRow {
  id: number;
  user_id: number;
  /** Null once the network was deleted: the row, and its file, stay (#1125). */
  network_id: number | null;
  peer_nick: string;
  direction: DccDirection;
  filename: string;
  advertised_size: number;
  received_bytes: number;
  destination_path: string | null;
  state: DccTransferState;
  passive: number;
  token: number | null;
  peer_host: string | null;
  peer_port: number | null;
  trigger_text: string | null;
  crc_expected: string | null;
  crc_actual: string | null;
  crc_status: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  /** When the user deleted the received file from the server (#1125). */
  file_deleted_at: string | null;
  /** The kept file a completed receive produced (#1133), or the one a send
   *  sends (#1086), while it is kept. For a receive, destination_path mirrors
   *  its path; a send has none. */
  file_id: number | null;
}

export interface InsertDccTransferFields {
  network_id: number;
  peer_nick: string;
  filename: string;
  advertised_size: number;
  state: DccTransferState;
  passive?: boolean;
  token?: number | null;
  /** The offer's decoded address + port, persisted so a pending_approval offer
   *  can be accepted (dialed) later. */
  peer_host?: string | null;
  peer_port?: number | null;
  /** The XDCC trigger we sent, kept so a stalled transfer can be re-requested on
   *  manual resume. Null for an unsolicited offer. */
  trigger_text?: string | null;
  /** CRC32 parsed from the filename (e.g. `[A1B2C3D4]`), null when absent. */
  crc_expected?: string | null;
}

const insertStmt = db.prepare(`
  INSERT INTO dcc_transfers
    (user_id, network_id, peer_nick, filename, advertised_size, state,
     passive, token, peer_host, peer_port, trigger_text, crc_expected)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function insertDccTransfer(userId: number, f: InsertDccTransferFields): number {
  const info = insertStmt.run(
    userId,
    f.network_id,
    f.peer_nick,
    f.filename,
    f.advertised_size,
    f.state,
    f.passive ? 1 : 0,
    f.token ?? null,
    f.peer_host ?? null,
    f.peer_port ?? null,
    f.trigger_text ?? null,
    f.crc_expected ?? null,
  );
  return Number(info.lastInsertRowid);
}

export interface InsertDccSendFields {
  network_id: number;
  peer_nick: string;
  file_id: number;
  /** The name as offered on the wire. */
  filename: string;
  size: number;
  passive: boolean;
  token: number | null;
}

/** Record a send we are about to offer (#1086), as `offered`. */
export function insertDccSend(userId: number, f: InsertDccSendFields): number {
  const info = db
    .prepare(
      `INSERT INTO dcc_transfers
         (user_id, network_id, peer_nick, direction, filename, advertised_size, state,
          passive, token, file_id)
       VALUES (?, ?, ?, 'send', ?, ?, 'offered', ?, ?, ?)`,
    )
    .run(
      userId,
      f.network_id,
      f.peer_nick,
      f.filename,
      f.size,
      f.passive ? 1 : 0,
      f.token,
      f.file_id,
    );
  return Number(info.lastInsertRowid);
}

/** The peer connected to a send: it is `sending`, from `offset` (non-zero
 *  when the peer asked to resume). */
export function markDccSending(id: number, offset: number): void {
  db.prepare(
    `UPDATE dcc_transfers
       SET state = 'sending', received_bytes = ?, error = NULL, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(offset, Number(id));
}

/** Whether any of the user's sends of a file is still offered or sending. */
export function dccFileSending(userId: number, fileId: number): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM dcc_transfers
       WHERE user_id = ? AND file_id = ? AND direction = 'send'
         AND state IN ('offered', 'sending') LIMIT 1`,
    )
    .get(userId, Number(fileId));
}

/** At boot: a send offered or in flight when the process stopped is over. Its
 *  listener and socket died with the process, and the peer gave up on it. */
export function failInterruptedDccSends(): number {
  return db
    .prepare(
      `UPDATE dcc_transfers
         SET state = 'failed', error = 'the server restarted', updated_at = datetime('now')
       WHERE direction = 'send' AND state IN ('offered', 'sending')`,
    )
    .run().changes;
}

/** A single transfer, scoped to its owner (every read path is user-scoped — a
 *  transfer is private to the account that requested it). */
export function getDccTransfer(userId: number, id: number): DccTransferRow | undefined {
  return db
    .prepare('SELECT * FROM dcc_transfers WHERE user_id = ? AND id = ?')
    .get(userId, Number(id)) as DccTransferRow | undefined;
}

/** A user's transfers, newest first — backs the download-manager view. */
export function listDccTransfers(
  userId: number,
  { limit = 100 }: { limit?: number } = {},
): DccTransferRow[] {
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  return db
    .prepare('SELECT * FROM dcc_transfers WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, lim) as DccTransferRow[];
}

/** Transition a transfer's state, optionally stamping an error. Always bumps
 *  updated_at. The receive engine (phase 1+) drives the richer transitions;
 *  phase 0/2 use this for cancel/reject. */
export function updateDccTransferState(
  id: number,
  state: DccTransferState,
  error: string | null = null,
): void {
  db.prepare(
    `UPDATE dcc_transfers SET state = ?, error = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(state, error, Number(id));
}

// An armed request only auto-accepts an offer that arrives within this window of
// the trigger. Generous enough to survive a slow bot send-queue, but bounded so a
// stale arm from hours/days ago can't silently auto-accept a later unsolicited
// offer (which would defeat the pending_approval gate).
export const DCC_ARM_TTL_MINUTES = 120;

/** The most recent still-waiting, NOT-yet-expired `requested` row for a bot on a
 *  network — used to match an inbound DCC SEND offer to a trigger the user sent
 *  (arm-on-trigger auto-accept). peer_nick collates NOCASE, so the bot's nick
 *  casing in the offer needn't match what the user typed. */
export function findArmedRequest(
  userId: number,
  networkId: number,
  peerNick: string,
): DccTransferRow | undefined {
  return db
    .prepare(
      `SELECT * FROM dcc_transfers
       WHERE user_id = ? AND network_id = ? AND peer_nick = ? AND state = 'requested'
         AND created_at >= datetime('now', '-${DCC_ARM_TTL_MINUTES} minutes')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(userId, networkId, peerNick) as DccTransferRow | undefined;
}

/** The most recent INCOMPLETE transfer for a (network, filename) whose partial we
 *  could resume — interrupted by failure, disconnect (stalled), or a restart that
 *  left it 'receiving'. Resuming is gated on this (not just any same-named file on
 *  disk) so an unrelated leftover can't get a bot's bytes appended onto it. */
export function findResumableTransfer(
  userId: number,
  networkId: number,
  filename: string,
): DccTransferRow | undefined {
  return db
    .prepare(
      `SELECT * FROM dcc_transfers
       WHERE user_id = ? AND network_id = ? AND filename = ? AND destination_path IS NOT NULL
         AND state IN ('failed', 'stalled', 'receiving')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(userId, networkId, filename) as DccTransferRow | undefined;
}

export interface DccReceivingFields {
  /** The real filename from the offer (the `requested` row held a placeholder). */
  filename: string;
  advertised_size: number;
  destination_path: string;
  passive?: boolean;
  token?: number | null;
  /** CRC32 parsed from the offer filename (e.g. `[A1B2C3D4]`), null when absent. */
  crc_expected?: string | null;
  /** Bytes already on disk when resuming (so the row's progress starts there). */
  received_bytes?: number;
}

/** Promote a transfer to `receiving` once an offer is accepted, stamping the
 *  real filename/size/destination (and any filename CRC) from the offer, the
 *  starting byte count (non-zero on resume), and clearing any prior error.
 *
 *  A path belongs to one row (#1125). Taking one — a resume continuing an
 *  earlier row's partial — releases it from every other row, so a file is
 *  downloaded, deleted and counted against the storage limit through exactly
 *  one row. Returns the ids of the rows that let go, for the caller to publish. */
export function markDccReceiving(id: number, f: DccReceivingFields): number[] {
  const others = db
    .prepare(
      `SELECT id FROM dcc_transfers
       WHERE destination_path = ? AND id != ?
         AND user_id = (SELECT user_id FROM dcc_transfers WHERE id = ?)`,
    )
    .all(f.destination_path, Number(id), Number(id)) as { id: number }[];
  for (const o of others) {
    db.prepare('UPDATE dcc_transfers SET destination_path = NULL WHERE id = ?').run(o.id);
  }
  db.prepare(
    `UPDATE dcc_transfers
       SET state = 'receiving', filename = ?, advertised_size = ?, destination_path = ?,
           passive = ?, token = ?, crc_expected = ?, received_bytes = ?, error = NULL,
           updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    f.filename,
    f.advertised_size,
    f.destination_path,
    f.passive ? 1 : 0,
    f.token ?? null,
    f.crc_expected ?? null,
    f.received_bytes ?? 0,
    Number(id),
  );
  return others.map((o) => o.id);
}

/** Checkpoint progress. Called on a throttle by the caller (never per-chunk) so
 *  the single shared SQLite connection isn't hammered. Hands back the row it
 *  wrote, so publishing the checkpoint needs no second read. */
export function updateDccReceivedBytes(
  userId: number,
  id: number,
  received: number,
): DccTransferRow | undefined {
  return db
    .prepare(
      `UPDATE dcc_transfers SET received_bytes = ?, updated_at = datetime('now')
       WHERE user_id = ? AND id = ?
       RETURNING *`,
    )
    .get(received, userId, Number(id)) as DccTransferRow | undefined;
}

/** Mark a transfer failed, stamping the final byte count (so a throttled
 *  progress write doesn't leave received_bytes stale) and the reason. */
export function markDccFailed(id: number, received: number, error: string): void {
  db.prepare(
    `UPDATE dcc_transfers
       SET state = 'failed', received_bytes = ?, error = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(received, error, Number(id));
}

/** How a completed transfer's bytes verified against the filename CRC32:
 *  matched ('ok'), didn't ('mismatch'), the filename carried no CRC ('absent' —
 *  size match is then the only integrity signal), or it was resumed so the full
 *  file's CRC wasn't recomputed ('unverified'). */
export type DccCrcStatus = 'ok' | 'mismatch' | 'absent' | 'unverified';

/** Mark a transfer done, stamping the final byte count, completion time, and the
 *  computed CRC32 + how it verified, and keep its file (#1133). Returns the
 *  kept file, or null when there was none to keep. */
export function markDccCompleted(
  id: number,
  received: number,
  crcActual: string | null = null,
  crcStatus: DccCrcStatus | null = null,
): DccFile | null {
  const complete = db.transaction((): DccFile | null => {
    db.prepare(
      `UPDATE dcc_transfers
         SET state = 'completed', received_bytes = ?, crc_actual = ?, crc_status = ?, error = NULL,
             completed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`,
    ).run(received, crcActual, crcStatus, Number(id));
    // The file is the account's now, apart from this transfer (#1133).
    const row = db
      .prepare(
        'SELECT user_id, destination_path, filename, file_id FROM dcc_transfers WHERE id = ?',
      )
      .get(Number(id)) as
      | {
          user_id: number;
          destination_path: string | null;
          filename: string;
          file_id: number | null;
        }
      | undefined;
    if (!row?.destination_path || row.file_id != null) return null;
    return keepReceivedDccFile(row.user_id, Number(id), {
      path: row.destination_path,
      name: row.filename,
      size: received,
    });
  });
  return complete();
}

// An upload to send that has taken no chunk for this long has been given up
// (a closed tab, or a server that stopped mid-complete): it stops holding
// space against the limit, though the sweep only removes it after a day. A
// client retries a failed chunk for about a minute.
const DCC_UPLOAD_STALE_MINUTES = 60;

/** Bytes every account's uploads to send will still put in the DCC folder:
 *  the free-disk check counts them, when that folder is another disk than
 *  the sessions' own. */
export function pendingDccUploadBytes(userId: number | null = null): number {
  return (
    db
      .prepare(
        `SELECT COALESCE(SUM(size), 0) AS n FROM upload_sessions
         WHERE purpose = 'dcc-send' AND state != 'done' AND (? IS NULL OR user_id = ?)
           AND updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${DCC_UPLOAD_STALE_MINUTES} minutes')`,
      )
      .get(userId, userId) as { n: number }
  ).n;
}

/** Whether an upload to send has gone idle long enough to stop holding space
 *  (see DCC_UPLOAD_STALE_MINUTES); taking a chunk again, it must fit again. */
export function dccUploadIsStale(updatedAt: string): boolean {
  return Date.parse(updatedAt) < Date.now() - DCC_UPLOAD_STALE_MINUTES * 60_000;
}

/** What the user's DCC files take (#1125): the files they keep (#1133), and
 *  the partials of transfers that haven't finished, which still own theirs.
 *  `stored` is what is on disk now. `committed` adds what transfers in flight
 *  will still write: one of those counts its full advertised size, and so does
 *  a file still uploading to be sent (#1086), until it goes an hour idle. `exclude` leaves out transfers the
 *  caller accounts for itself. */
export function dccUsageBytes(
  userId: number,
  exclude: number[] = [],
): { stored: number; committed: number } {
  const files = (
    db
      .prepare('SELECT COALESCE(SUM(size), 0) AS n FROM dcc_files WHERE user_id = ?')
      .get(userId) as { n: number }
  ).n;
  const partials = db
    .prepare(
      `SELECT COALESCE(SUM(received_bytes), 0) AS stored,
              COALESCE(SUM(CASE WHEN state IN ('connecting', 'receiving', 'stalled', 'verifying')
                                THEN MAX(advertised_size, received_bytes)
                                ELSE received_bytes END), 0) AS committed
       FROM dcc_transfers
       WHERE user_id = ? AND destination_path IS NOT NULL AND file_id IS NULL
         AND id NOT IN (SELECT value FROM json_each(?))`,
    )
    .get(userId, JSON.stringify(exclude)) as { stored: number; committed: number };
  const uploading = pendingDccUploadBytes(userId);
  return {
    stored: files + partials.stored,
    committed: files + partials.committed + uploading,
  };
}

/** What each user's DCC files take on disk, as dccUsageBytes counts `stored` —
 *  one pass for the admin roster. Users with none are absent. */
export function listDccStoredBytes(): Map<number, number> {
  const rows = db
    .prepare(
      `SELECT user_id, SUM(n) AS stored FROM (
         SELECT user_id, size AS n FROM dcc_files
         UNION ALL
         SELECT user_id, received_bytes AS n FROM dcc_transfers
         WHERE destination_path IS NOT NULL AND file_id IS NULL
       ) GROUP BY user_id`,
    )
    .all() as { user_id: number; stored: number }[];
  return new Map(rows.map((r) => [r.user_id, r.stored]));
}

/** Record that the user deleted the row's file: the row stays as history, with
 *  no path to serve, resume or count. */
export function markDccFileDeleted(id: number): void {
  db.prepare(
    `UPDATE dcc_transfers
       SET destination_path = NULL, file_deleted_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`,
  ).run(Number(id));
}

/** Cancel a transfer, recording the bytes it actually wrote (#1125). Progress
 *  is checkpointed every few seconds, so the row's own count can be well short
 *  of the partial on disk; null keeps the row's count. */
export function markDccCancelled(id: number, received: number | null): void {
  db.prepare(
    `UPDATE dcc_transfers
       SET state = 'cancelled', received_bytes = COALESCE(?, received_bytes),
           updated_at = datetime('now')
     WHERE id = ?`,
  ).run(received, Number(id));
}

/** Whether one of the user's transfers or files owns `destPath` (#1125, #1133). */
export function dccPathClaimed(userId: number, destPath: string): boolean {
  return (
    !!db
      .prepare('SELECT 1 FROM dcc_transfers WHERE user_id = ? AND destination_path = ? LIMIT 1')
      .get(userId, destPath) || dccFileAt(userId, destPath)
  );
}

/** Clear one finished transfer from the list (#1133). The file it received is
 *  the account's and stays. A partial it still owns is the caller's to remove
 *  first. */
export function clearDccTransfer(userId: number, id: number): void {
  db.prepare('DELETE FROM dcc_transfers WHERE user_id = ? AND id = ?').run(userId, Number(id));
}

/** Whether a transfer holds part of a download (#1133): bytes of its own on
 *  disk, not a kept file. A path with nothing received is only a reservation
 *  (the peer never connected). */
export function holdsDccPartial(
  t: Pick<DccTransferRow, 'destination_path' | 'file_id' | 'received_bytes'>,
): boolean {
  return !!t.destination_path && t.file_id == null && t.received_bytes > 0;
}

export interface ClearedDccTransfer {
  id: number;
  file_id: number | null;
  destination_path: string | null;
}

/** Clear every finished transfer from the list, keeping the files (#1133).
 *  One still holding a partial stays: those are bytes on disk, which only the
 *  user deletes. Returns the rows cleared, with the kept file each received
 *  and any path one had reserved, for the caller to remove. */
export function clearFinishedDccTransfers(userId: number): ClearedDccTransfer[] {
  return db
    .prepare(
      `DELETE FROM dcc_transfers
       WHERE user_id = ? AND state IN ('completed', 'failed', 'rejected', 'cancelled')
         AND NOT (destination_path IS NOT NULL AND file_id IS NULL AND received_bytes > 0)
       RETURNING id, file_id, destination_path`,
    )
    .all(userId) as ClearedDccTransfer[];
}
