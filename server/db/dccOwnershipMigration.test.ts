// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

// Integration test for the schemaVersion-23 block (#1125). Received files count
// against a storage limit through the rows that own them, so:
//   - deleting a network must no longer cascade its transfer rows away (the
//     files stay on disk, and would be uncounted and out of reach);
//   - a resumed file that two rows shared goes to the newest row only.
//
// The fixture is the real schema with dcc_transfers put back in its old shape
// (network_id NOT NULL, ON DELETE CASCADE) and schema_version wound back to 22
// (see inviteRevivalMigration.test.ts for why a hand-written old DB doesn't
// work).

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-dccown-'));
const dbPath = path.join(tmpDir, 'test.db');
process.env.DATABASE_PATH = dbPath;

let db: typeof import('./index.js').default;

beforeAll(async () => {
  // Phase 1 — real, fully-migrated schema.
  const fresh = (await import('./index.js')).default;
  fresh.close();

  // Phase 2 — the old table shape, a resumed file both rows still point at, and
  // a finished file of its own.
  const raw = new Database(dbPath);
  raw.pragma('foreign_keys = OFF');
  raw.exec(`
    DROP TABLE dcc_transfers;
    CREATE TABLE dcc_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      peer_nick TEXT NOT NULL COLLATE NOCASE,
      direction TEXT NOT NULL DEFAULT 'recv',
      filename TEXT NOT NULL,
      advertised_size INTEGER NOT NULL,
      received_bytes INTEGER NOT NULL DEFAULT 0,
      destination_path TEXT,
      state TEXT NOT NULL,
      passive INTEGER NOT NULL DEFAULT 0,
      token INTEGER,
      trigger_text TEXT,
      crc_expected TEXT,
      crc_actual TEXT,
      crc_status TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      peer_host TEXT,
      peer_port INTEGER,
      file_deleted_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
    INSERT INTO users (id, username) VALUES (1, 'alice');
    INSERT INTO networks (id, user_id, name, host, nick) VALUES (10, 1, 'rizon', 'irc.example', 'a');
    INSERT INTO dcc_transfers
      (id, user_id, network_id, peer_nick, filename, advertised_size, received_bytes,
       destination_path, state)
    VALUES
      (1, 1, 10, 'bot', 'long.mkv', 1000, 400, '/dcc/alice/long.mkv', 'failed'),
      (2, 1, 10, 'bot', 'long.mkv', 1000, 1000, '/dcc/alice/long.mkv', 'completed'),
      (3, 1, 10, 'bot', 'ep.mkv', 500, 500, '/dcc/alice/ep.mkv', 'completed');
    UPDATE app_meta SET value = '22' WHERE key = 'schema_version';
  `);
  raw.close();

  // Phase 3 — boot again; this is the run under test.
  vi.resetModules();
  ({ default: db } = await import('./index.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const pathOf = (id: number) =>
  (
    db.prepare('SELECT destination_path FROM dcc_transfers WHERE id = ?').get(id) as {
      destination_path: string | null;
    }
  ).destination_path;

describe('dcc_transfers v23 migration (#1125)', () => {
  it('keeps every row', () => {
    const n = db.prepare('SELECT COUNT(*) AS n FROM dcc_transfers').get() as { n: number };
    expect(n.n).toBe(3);
  });

  it('gives a resumed file to the row that finished it', () => {
    expect(pathOf(1)).toBeNull();
    expect(pathOf(2)).toBe('/dcc/alice/long.mkv');
    expect(pathOf(3)).toBe('/dcc/alice/ep.mkv');
  });

  it('keeps the rows, and their files, when the network is deleted', () => {
    db.prepare('DELETE FROM networks WHERE id = 10').run();
    const rows = db.prepare('SELECT id, network_id FROM dcc_transfers ORDER BY id').all();
    expect(rows).toEqual([
      { id: 1, network_id: null },
      { id: 2, network_id: null },
      { id: 3, network_id: null },
    ]);
    expect(pathOf(3)).toBe('/dcc/alice/ep.mkv');
  });
});
