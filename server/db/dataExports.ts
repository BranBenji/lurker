// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Data-access for the data_exports table — per-user export jobs and their
// on-disk .lurk artifacts. See db/index.ts for the schema and
// services/exportJobs.ts for the lifecycle that drives these rows.

import { randomBytes } from 'crypto';
import db from './index.js';
import { capText } from '../utils/capText.js';

export type ExportStatus = 'pending' | 'running' | 'done' | 'error';

export interface ExportJob {
  id: number;
  user_id: number;
  status: ExportStatus;
  include_messages: number;
  total_rows: number;
  processed_rows: number;
  filename: string | null;
  file_path: string | null;
  byte_size: number | null;
  token: string;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  downloaded_at: string | null;
}

const insertStmt = db.prepare(`
  INSERT INTO data_exports (user_id, status, include_messages, token)
  VALUES (?, 'pending', ?, ?)
`);

export function createExportJob(userId: number, includeMessages: boolean): ExportJob {
  // 24 bytes hex = 48 chars; unguessable on-disk filename. Auth + ownership
  // still gate the download endpoint — the token only keeps the path opaque.
  const token = randomBytes(24).toString('hex');
  const res = insertStmt.run(userId, includeMessages ? 1 : 0, token);
  return getExportJob(Number(res.lastInsertRowid))!;
}

export function getExportJob(id: number): ExportJob | undefined {
  return db.prepare('SELECT * FROM data_exports WHERE id = ?').get(id) as ExportJob | undefined;
}

/** The job for `id` only if it belongs to `userId` — the download authorization check. */
export function getExportJobForUser(id: number, userId: number): ExportJob | undefined {
  return db.prepare('SELECT * FROM data_exports WHERE id = ? AND user_id = ?').get(id, userId) as
    | ExportJob
    | undefined;
}

/** An in-flight (pending/running) job for the user, if any — enforces one-at-a-time. */
export function getActiveJobForUser(userId: number): ExportJob | undefined {
  return db
    .prepare(
      `SELECT * FROM data_exports
       WHERE user_id = ? AND status IN ('pending', 'running')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(userId) as ExportJob | undefined;
}

/** The most recent job for the user (any status) — what the UI restores on load. */
export function getLatestJobForUser(userId: number): ExportJob | undefined {
  return db
    .prepare('SELECT * FROM data_exports WHERE user_id = ? ORDER BY id DESC LIMIT 1')
    .get(userId) as ExportJob | undefined;
}

export function markRunning(id: number, totalRows: number): void {
  db.prepare(
    `UPDATE data_exports
     SET status = 'running', total_rows = ?, started_at = datetime('now')
     WHERE id = ?`,
  ).run(totalRows, id);
}

export function updateProgress(id: number, processedRows: number, totalRows?: number): void {
  // Keep total_rows in sync with the worker's own denominator when it reports
  // one (> 0). The initial markRunning count is a main-thread estimate on a
  // different snapshot; the worker's count is authoritative, and persisting it
  // keeps the UI from ever showing processed > total.
  if (typeof totalRows === 'number' && totalRows > 0) {
    db.prepare('UPDATE data_exports SET processed_rows = ?, total_rows = ? WHERE id = ?').run(
      processedRows,
      totalRows,
      id,
    );
  } else {
    db.prepare('UPDATE data_exports SET processed_rows = ? WHERE id = ?').run(processedRows, id);
  }
}

export function markDone(
  id: number,
  opts: { filePath: string; filename: string; byteSize: number; ttlHours: number },
): void {
  // expires_at is computed in SQLite's own datetime format (UTC, no 'T'/'Z') so
  // the sweep's `expires_at < datetime('now')` comparison is apples-to-apples.
  // The sign is explicit so a non-positive ttl yields a valid '-N hours'
  // modifier rather than the malformed '+-N hours' SQLite would resolve to NULL.
  const sign = opts.ttlHours >= 0 ? '+' : '-';
  const modifier = `${sign}${Math.abs(opts.ttlHours)} hours`;
  db.prepare(
    `UPDATE data_exports
     SET status = 'done', file_path = ?, filename = ?, byte_size = ?,
         expires_at = datetime('now', ?), completed_at = datetime('now')
     WHERE id = ?`,
  ).run(opts.filePath, opts.filename, opts.byteSize, modifier, id);
}

export function markError(id: number, message: string): void {
  db.prepare(
    `UPDATE data_exports
     SET status = 'error', error = ?, completed_at = datetime('now')
     WHERE id = ?`,
  ).run(capText(message, 1000), id);
}

export function markDownloaded(id: number): void {
  db.prepare(`UPDATE data_exports SET downloaded_at = datetime('now') WHERE id = ?`).run(id);
}

export function deleteJob(id: number): void {
  db.prepare('DELETE FROM data_exports WHERE id = ?').run(id);
}

/** Completed jobs whose artifact TTL has lapsed — their files + rows get swept. */
export function listExpiredJobs(): ExportJob[] {
  return db
    .prepare(
      `SELECT * FROM data_exports
       WHERE status = 'done' AND expires_at IS NOT NULL AND expires_at < datetime('now')`,
    )
    .all() as ExportJob[];
}

/** Jobs still marked in-flight — used on boot to fail anything a restart orphaned. */
export function listInflightJobs(): ExportJob[] {
  return db
    .prepare(`SELECT * FROM data_exports WHERE status IN ('pending', 'running')`)
    .all() as ExportJob[];
}

/** Older completed jobs for a user, excluding `keepId` — superseded artifacts to clean up. */
export function listSupersededDoneJobs(userId: number, keepId: number): ExportJob[] {
  return db
    .prepare(
      `SELECT * FROM data_exports
       WHERE user_id = ? AND status = 'done' AND id <> ?`,
    )
    .all(userId, keepId) as ExportJob[];
}
