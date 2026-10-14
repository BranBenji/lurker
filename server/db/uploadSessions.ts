// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Chunked upload sessions (#650). The row is what the file is for; the bytes
// so far live in the session's file, whose size is the offset.

import db from './index.js';

export type UploadPurpose = 'upload' | 'import';

export interface UploadSessionRow {
  id: string;
  user_id: number;
  purpose: UploadPurpose;
  size: number;
  filename: string;
  mime: string | null;
  uploader_id: number | null;
  created_at: string;
  updated_at: string;
}

const insertStmt = db.prepare(`
  INSERT INTO upload_sessions (id, user_id, purpose, size, filename, mime, uploader_id)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const getStmt = db.prepare('SELECT * FROM upload_sessions WHERE user_id = ? AND id = ?');
const touchStmt = db.prepare(
  `UPDATE upload_sessions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
);
const deleteStmt = db.prepare('DELETE FROM upload_sessions WHERE id = ?');
const idleStmt = db.prepare('SELECT id FROM upload_sessions WHERE updated_at < ?');
const allIdsStmt = db.prepare('SELECT id FROM upload_sessions');

export function insertUploadSession(
  userId: number,
  s: {
    id: string;
    purpose: UploadPurpose;
    size: number;
    filename: string;
    mime: string | null;
    uploaderId: number | null;
  },
): void {
  insertStmt.run(s.id, userId, s.purpose, s.size, s.filename, s.mime, s.uploaderId);
}

/** The caller's own session, or undefined. */
export function getUploadSession(userId: number, id: string): UploadSessionRow | undefined {
  return getStmt.get(userId, id) as UploadSessionRow | undefined;
}

/** A chunk landed: the session is not idle. */
export function touchUploadSession(id: string): void {
  touchStmt.run(id);
}

export function deleteUploadSession(id: string): void {
  deleteStmt.run(id);
}

/** Sessions with no chunk since `beforeIso`. */
export function idleUploadSessionIds(beforeIso: string): string[] {
  return (idleStmt.all(beforeIso) as { id: string }[]).map((r) => r.id);
}

/** Every session id, to tell a session's file from an orphan. */
export function allUploadSessionIds(): Set<string> {
  return new Set((allIdsStmt.all() as { id: string }[]).map((r) => r.id));
}
