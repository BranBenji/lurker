// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Per-user DCC storage limits (#1125): how much an account's received files may
// take on disk, set by an admin on Admin → DCC. No row means no limit.

import db from './index.js';

const getStmt = db.prepare('SELECT limit_bytes FROM dcc_storage_limits WHERE user_id = ?');
const setStmt = db.prepare(`
  INSERT INTO dcc_storage_limits (user_id, limit_bytes) VALUES (?, ?)
  ON CONFLICT(user_id) DO UPDATE SET limit_bytes = excluded.limit_bytes
`);
const clearStmt = db.prepare('DELETE FROM dcc_storage_limits WHERE user_id = ?');
const listStmt = db.prepare('SELECT user_id, limit_bytes FROM dcc_storage_limits');

/** The account's limit in bytes, or null for none. */
export function getDccStorageLimit(userId: number): number | null {
  const row = getStmt.get(userId) as { limit_bytes: number } | undefined;
  return row ? row.limit_bytes : null;
}

/** Set the account's limit, or clear it with null. */
export function setDccStorageLimit(userId: number, limitBytes: number | null): void {
  if (limitBytes === null) clearStmt.run(userId);
  else setStmt.run(userId, limitBytes);
}

/** Every account's limit — one query for the admin roster. */
export function listDccStorageLimits(): Map<number, number> {
  const rows = listStmt.all() as { user_id: number; limit_bytes: number }[];
  return new Map(rows.map((r) => [r.user_id, r.limit_bytes]));
}
