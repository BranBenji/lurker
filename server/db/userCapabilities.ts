// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Per-user feature capabilities — admin-granted gates for features that are off
// by default. Stored in the generic `user_capabilities` table (not one column
// per feature), so a feature can take up the pattern without a migration. DCC
// is the one user so far, granted in parts (#1080); its grants are managed on
// the Admin → DCC tab. Add new capability keys here.

import db from './index.js';

/** DCC is granted in parts (#1080), each two-tier: the cell-wide
 *  LURKER_DCC_ENABLED master switch AND the per-user grant must both be on.
 *  An admin can allow direct chats without letting files land on the box. */
export const CAPABILITY_DCC_CHAT = 'dcc.chat';
export const CAPABILITY_DCC_RECEIVE = 'dcc.receive';
/** Sending opens a port to a peer and offers the account's files (#1086), so
 *  it doesn't come bundled with receiving. */
export const CAPABILITY_DCC_SEND = 'dcc.send';

export interface UserCapabilityRow {
  capability: string;
  enabled: number;
  updated_at: string;
}

const getStmt = db.prepare(
  'SELECT enabled FROM user_capabilities WHERE user_id = ? AND capability = ?',
);

/** Whether `userId` has `capability` granted. An absent row means OFF —
 *  capabilities are opt-in, never default-on. */
export function userHasCapability(userId: number, capability: string): boolean {
  const row = getStmt.get(userId, capability) as { enabled: number } | undefined;
  return !!row && row.enabled === 1;
}

const upsertStmt = db.prepare(`
  INSERT INTO user_capabilities (user_id, capability, enabled, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(user_id, capability)
  DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
`);

/** Grant (enabled=true) or revoke a capability for a user. Upsert. */
export function setUserCapability(userId: number, capability: string, enabled: boolean): void {
  upsertStmt.run(userId, capability, enabled ? 1 : 0);
}

/** Every user holding `capability` — one query for a whole roster (the admin
 *  DCC table) rather than one per row. */
const holdersStmt = db.prepare(
  'SELECT user_id FROM user_capabilities WHERE capability = ? AND enabled = 1',
);

export function userIdsWithCapability(capability: string): Set<number> {
  const rows = holdersStmt.all(capability) as { user_id: number }[];
  return new Set(rows.map((r) => r.user_id));
}

/** Every capability row for a user — the read the admin control panel will use. */
export function listUserCapabilities(userId: number): UserCapabilityRow[] {
  return db
    .prepare('SELECT capability, enabled, updated_at FROM user_capabilities WHERE user_id = ?')
    .all(userId) as UserCapabilityRow[];
}
