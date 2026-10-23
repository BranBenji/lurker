// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';

// Our own IRCv3 metadata on each network (#1189): what we last set, kept
// because most servers forget it at disconnect. A null value is a saved
// unset — the key is cleared on the server at the next connect too.

/** A row from the `network_metadata` table. */
export interface NetworkMetadataRow {
  network_id: number;
  user_id: number;
  key: string;
  value: string | null;
  updated_at: string;
}

const listStmt = db.prepare(`
  SELECT key, value FROM network_metadata WHERE network_id = ? ORDER BY key
`);

const upsertStmt = db.prepare(`
  INSERT INTO network_metadata (network_id, user_id, key, value, updated_at)
  VALUES (@networkId, @userId, @key, @value, datetime('now'))
  ON CONFLICT(network_id, key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at
`);

const clearStmt = db.prepare(`
  UPDATE network_metadata SET value = NULL, updated_at = datetime('now')
  WHERE network_id = ? AND value IS NOT NULL
`);

/** Every saved key on a network, unsets included (value null). */
export function listNetworkMetadata(networkId: number): Map<string, string | null> {
  const rows = listStmt.all(networkId) as Array<{ key: string; value: string | null }>;
  return new Map(rows.map((row) => [row.key, row.value]));
}

/** The saved keys that have a value, for showing. */
export function networkMetadataValues(networkId: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of listNetworkMetadata(networkId)) if (value !== null) out[key] = value;
  return out;
}

/** Save one key: a value, or null to keep it unset. */
export function saveNetworkMetadata(
  userId: number,
  networkId: number,
  key: string,
  value: string | null,
): void {
  upsertStmt.run({ networkId, userId, key, value });
}

/** Several keys at once, as one write. */
export const saveNetworkMetadataMany = db.transaction(
  (userId: number, networkId: number, values: Map<string, string | null>): void => {
    for (const [key, value] of values) upsertStmt.run({ networkId, userId, key, value });
  },
);

/** `METADATA * CLEAR`: every saved key becomes a saved unset. */
export function clearNetworkMetadata(networkId: number): void {
  clearStmt.run(networkId);
}
