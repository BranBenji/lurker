// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Chunked upload sessions (#650). The row is what the file is for and where
// the session stands; the bytes so far live in the session's file, whose size
// is the offset.

import db from './index.js';

export type UploadPurpose = 'upload' | 'import';
export type UploadSessionState = 'open' | 'processing' | 'done';

/** What complete answered: the HTTP status and JSON body. */
export interface UploadSessionResult {
  status: number;
  body: Record<string, unknown>;
}

export interface UploadSessionRow {
  id: string;
  user_id: number;
  purpose: UploadPurpose;
  size: number;
  filename: string;
  mime: string | null;
  uploader_id: number | null;
  state: UploadSessionState;
  /** JSON of an UploadSessionResult, once done. */
  result: string | null;
  created_at: string;
  updated_at: string;
}

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

const insertStmt = db.prepare(`
  INSERT INTO upload_sessions (id, user_id, purpose, size, filename, mime, uploader_id)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const getStmt = db.prepare('SELECT * FROM upload_sessions WHERE user_id = ? AND id = ?');
const touchStmt = db.prepare(`UPDATE upload_sessions SET updated_at = ${NOW} WHERE id = ?`);
const processingStmt = db.prepare(
  `UPDATE upload_sessions SET state = 'processing', updated_at = ${NOW} WHERE id = ?`,
);
const doneStmt = db.prepare(
  `UPDATE upload_sessions SET state = 'done', result = ?, updated_at = ${NOW} WHERE id = ?`,
);
const deleteStmt = db.prepare('DELETE FROM upload_sessions WHERE id = ?');
const idleStmt = db.prepare('SELECT id FROM upload_sessions WHERE updated_at < ?');
const allIdsStmt = db.prepare('SELECT id FROM upload_sessions');
const openStmt = db.prepare(`SELECT id, size FROM upload_sessions WHERE state = 'open'`);

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

export function markUploadSessionProcessing(id: string): void {
  processingStmt.run(id);
}

export function markUploadSessionDone(id: string, result: UploadSessionResult): void {
  doneStmt.run(JSON.stringify(result), id);
}

export function deleteUploadSession(id: string): void {
  deleteStmt.run(id);
}

/** Sessions with no activity since `beforeIso`. */
export function idleUploadSessionIds(beforeIso: string): string[] {
  return (idleStmt.all(beforeIso) as { id: string }[]).map((r) => r.id);
}

/** Every session id, to tell a session's file from an orphan. */
export function allUploadSessionIds(): Set<string> {
  return new Set((allIdsStmt.all() as { id: string }[]).map((r) => r.id));
}

/** Sessions still taking chunks, every account's: what they will yet write. */
export function openUploadSessions(): { id: string; size: number }[] {
  return openStmt.all() as { id: string; size: number }[];
}
