// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The DCC files an account keeps (#1133): every completed receive, and every
// file uploaded to send (#1086). A file owns its path; the transfer that
// received it points here (dcc_transfers.file_id) and stays as history. The
// user deletes a file; nothing expires.

import db from './index.js';
import type { DccCrcStatus } from './dccTransfers.js';

export type DccFileOrigin = 'received' | 'uploaded';

export interface DccFileRow {
  id: number;
  user_id: number;
  path: string;
  name: string;
  size: number;
  origin: DccFileOrigin;
  created_at: string;
  peer_nick: string | null;
  network_id: number | null;
  crc_status: DccCrcStatus | null;
}

/** A file as clients see it: never its path, and for a received one, who it
 *  came from and on which network. */
export interface DccFile {
  id: number;
  name: string;
  size: number;
  origin: DccFileOrigin;
  created_at: string;
  /** The transfer that received it; null for an upload, or once that row is
   *  cleared from the list. */
  transfer_id: number | null;
  peer_nick: string | null;
  /** Null for an upload, or once the network was deleted. */
  network_id: number | null;
  /** How a received file checked out against the CRC32 in its name (#1082);
   *  null for an upload, or a file kept before the check was recorded. */
  crc_status: DccCrcStatus | null;
}

const VIEW = `
  SELECT f.id, f.name, f.size, f.origin, f.created_at,
         t.id AS transfer_id, f.peer_nick, f.network_id, f.crc_status
  FROM dcc_files f
  LEFT JOIN dcc_transfers t ON t.file_id = f.id AND t.direction = 'recv'
`;

/** Keep a received transfer's file: the file row, with who sent it, and the
 *  transfer pointing at it. Returns the file, or null when the user has no
 *  such transfer. */
export function keepReceivedDccFile(
  userId: number,
  transferId: number,
  f: { path: string; name: string; size: number },
): DccFile | null {
  const keep = db.transaction((): number | null => {
    const inserted = db
      .prepare(
        `INSERT INTO dcc_files (user_id, path, name, size, origin, peer_nick, network_id, crc_status)
         SELECT ?, ?, ?, ?, 'received', peer_nick, network_id, crc_status
         FROM dcc_transfers WHERE id = ? AND user_id = ?`,
      )
      .run(userId, f.path, f.name, f.size, transferId, userId);
    // With no row selected, lastInsertRowid is some earlier insert's.
    if (inserted.changes !== 1) return null;
    const id = Number(inserted.lastInsertRowid);
    db.prepare('UPDATE dcc_transfers SET file_id = ? WHERE id = ? AND user_id = ?').run(
      id,
      transferId,
      userId,
    );
    return id;
  });
  const id = keep();
  return id == null ? null : getDccFile(userId, id)!;
}

/** Keep a file the user uploaded to send (#1086). */
export function keepUploadedDccFile(
  userId: number,
  f: { path: string; name: string; size: number },
): DccFile {
  const inserted = db
    .prepare(
      `INSERT INTO dcc_files (user_id, path, name, size, origin) VALUES (?, ?, ?, ?, 'uploaded')`,
    )
    .run(userId, f.path, f.name, f.size);
  return getDccFile(userId, Number(inserted.lastInsertRowid))!;
}

/** The user's files, newest first. */
export function listDccFiles(userId: number): DccFile[] {
  return db.prepare(`${VIEW} WHERE f.user_id = ? ORDER BY f.id DESC`).all(userId) as DccFile[];
}

/** One of the user's files, as clients see it. */
export function getDccFile(userId: number, id: number): DccFile | undefined {
  return db.prepare(`${VIEW} WHERE f.user_id = ? AND f.id = ?`).get(userId, Number(id)) as
    | DccFile
    | undefined;
}

/** One of the user's files with its path, for serving or removing it. */
export function getDccFileRow(userId: number, id: number): DccFileRow | undefined {
  return db
    .prepare('SELECT * FROM dcc_files WHERE user_id = ? AND id = ?')
    .get(userId, Number(id)) as DccFileRow | undefined;
}

/**
 * Forget a file the caller has removed from disk. Every transfer pointing at
 * it loses it too, and stays as history: the one that received it is marked
 * deleted, as a deleted received file always was (#1125). Returns the ids of
 * those transfers, for the caller to publish.
 */
export function forgetDccFile(userId: number, id: number): number[] {
  const forget = db.transaction(() => {
    const rows = db
      .prepare('SELECT id FROM dcc_transfers WHERE user_id = ? AND file_id = ?')
      .all(userId, Number(id)) as { id: number }[];
    db.prepare(
      `UPDATE dcc_transfers
         SET file_id = NULL, destination_path = NULL, file_deleted_at = datetime('now'),
             updated_at = datetime('now')
       WHERE user_id = ? AND file_id = ?`,
    ).run(userId, Number(id));
    db.prepare('DELETE FROM dcc_files WHERE user_id = ? AND id = ?').run(userId, Number(id));
    return rows.map((r) => r.id);
  });
  return forget();
}

/** Whether one of the user's files is at `path`. */
export function dccFileAt(userId: number, path: string): boolean {
  return !!db
    .prepare('SELECT 1 FROM dcc_files WHERE user_id = ? AND path = ? LIMIT 1')
    .get(userId, path);
}

/** Every path on disk the user's DCC rows own: kept files, and the partials of
 *  transfers that never finished (#1152). Read before the account is deleted,
 *  as that takes the rows with it. */
export function dccPathsOwnedBy(userId: number): string[] {
  const rows = db
    .prepare(
      `SELECT path AS p FROM dcc_files WHERE user_id = ?
       UNION
       SELECT destination_path FROM dcc_transfers
       WHERE user_id = ? AND destination_path IS NOT NULL`,
    )
    .all(userId, userId) as { p: string }[];
  return rows.map((r) => r.p);
}
