// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Query layer for avatar_sets + avatar_set_tiles — uploaded avatar tile sets
// (#607). Validation, zip ingestion and fan-out live in
// services/avatarSetsService.ts; this file is SQL only, per-user scoped
// throughout. Tiles are blobs here rather than files on disk because a hosted
// cell has no app-owned file store that survives, and the export/import path
// already carries blobs.

import type { AvatarSetSummary } from '../../shared/avatarSets.js';
import db from './index.js';

interface RawRow {
  id: number;
  name: string;
  count: number;
  bytes: number;
  created_at: string;
}

function toSummary(row: RawRow): AvatarSetSummary {
  return {
    id: row.id,
    name: row.name,
    count: row.count,
    bytes: row.bytes,
    createdAt: row.created_at,
  };
}

const COLS = 'id, name, count, bytes, created_at';

export function listAvatarSetsForUser(userId: number): AvatarSetSummary[] {
  const rows = db
    .prepare(`SELECT ${COLS} FROM avatar_sets WHERE user_id = ? ORDER BY name COLLATE NOCASE`)
    .all(userId) as RawRow[];
  return rows.map(toSummary);
}

export function getAvatarSet(userId: number, id: number): AvatarSetSummary | null {
  const row = db
    .prepare(`SELECT ${COLS} FROM avatar_sets WHERE user_id = ? AND id = ?`)
    .get(userId, id) as RawRow | undefined;
  return row ? toSummary(row) : null;
}

export function findAvatarSetByName(userId: number, name: string): AvatarSetSummary | null {
  // name is COLLATE NOCASE in the schema, so = matches case-insensitively.
  const row = db
    .prepare(`SELECT ${COLS} FROM avatar_sets WHERE user_id = ? AND name = ?`)
    .get(userId, name) as RawRow | undefined;
  return row ? toSummary(row) : null;
}

export function countAvatarSetsForUser(userId: number): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM avatar_sets WHERE user_id = ?').get(userId) as {
    n: number;
  };
  return row.n;
}

/** The set row and every tile, in one transaction. `tiles[i]` is tile i. */
export function createAvatarSet(userId: number, name: string, tiles: Buffer[]): AvatarSetSummary {
  const bytes = tiles.reduce((n, t) => n + t.length, 0);
  const insertSet = db.prepare(
    'INSERT INTO avatar_sets (user_id, name, count, bytes) VALUES (?, ?, ?, ?)',
  );
  const insertTile = db.prepare(
    'INSERT INTO avatar_set_tiles (set_id, idx, data) VALUES (?, ?, ?)',
  );
  const id = db.transaction(() => {
    const info = insertSet.run(userId, name, tiles.length, bytes);
    const setId = Number(info.lastInsertRowid);
    tiles.forEach((tile, idx) => insertTile.run(setId, idx, tile));
    return setId;
  })();
  return getAvatarSet(userId, id)!;
}

export function deleteAvatarSet(userId: number, id: number): boolean {
  const info = db.prepare('DELETE FROM avatar_sets WHERE user_id = ? AND id = ?').run(userId, id);
  return info.changes > 0;
}

/** One tile's bytes, or null when the set isn't the user's or has no such tile. */
export function getAvatarTile(userId: number, setId: number, idx: number): Buffer | null {
  const row = db
    .prepare(
      `SELECT t.data AS data FROM avatar_set_tiles t
         JOIN avatar_sets s ON s.id = t.set_id
        WHERE s.user_id = ? AND t.set_id = ? AND t.idx = ?`,
    )
    .get(userId, setId, idx) as { data: Buffer } | undefined;
  return row ? row.data : null;
}

/** Every tile of a set in order (the exporter's walk). */
export function listAvatarTiles(setId: number): Array<{ idx: number; data: Buffer }> {
  return db
    .prepare('SELECT idx, data FROM avatar_set_tiles WHERE set_id = ? ORDER BY idx')
    .all(setId) as Array<{ idx: number; data: Buffer }>;
}
