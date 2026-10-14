// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

// Integration test for the schemaVersion-24 block (#1133): a completed receive
// still holding its file becomes a kept file the transfer points at. A partial
// stays its transfer's, and a file the user already deleted stays deleted.
//
// The fixture is the real schema with dcc_transfers put back in its v23 shape
// (no file_id), dcc_files gone, and schema_version wound back to 23 (see
// inviteRevivalMigration.test.ts for why a hand-written old DB doesn't work).

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-dccfiles-'));
const dbPath = path.join(tmpDir, 'test.db');
process.env.DATABASE_PATH = dbPath;

let db: typeof import('./index.js').default;

beforeAll(async () => {
  // Phase 1 — real, fully-migrated schema.
  const fresh = (await import('./index.js')).default;
  fresh.close();

  // Phase 2 — the v23 shape, with one of each kind of row.
  const raw = new Database(dbPath);
  raw.pragma('foreign_keys = OFF');
  raw.exec(`
    DROP TABLE dcc_files;
    DROP TABLE dcc_transfers;
    CREATE TABLE dcc_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      network_id INTEGER,
      peer_nick TEXT NOT NULL COLLATE NOCASE,
      direction TEXT NOT NULL DEFAULT 'recv',
      filename TEXT NOT NULL,
      advertised_size INTEGER NOT NULL,
      received_bytes INTEGER NOT NULL DEFAULT 0,
      destination_path TEXT,
      state TEXT NOT NULL,
      passive INTEGER NOT NULL DEFAULT 0,
      token INTEGER,
      peer_host TEXT,
      peer_port INTEGER,
      trigger_text TEXT,
      crc_expected TEXT,
      crc_actual TEXT,
      crc_status TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      file_deleted_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE SET NULL
    );
    INSERT INTO users (id, username) VALUES (1, 'alice');
    INSERT INTO dcc_transfers
      (id, user_id, network_id, peer_nick, filename, advertised_size, received_bytes,
       destination_path, state, completed_at, file_deleted_at)
    VALUES
      (1, 1, NULL, 'bot', 'done.mkv', 900, 900, '/dcc/alice/done.mkv', 'completed',
       '2026-10-01 12:00:00', NULL),
      (2, 1, NULL, 'bot', 'half.mkv', 900, 400, '/dcc/alice/half.mkv', 'failed', NULL, NULL),
      (3, 1, NULL, 'bot', 'gone.mkv', 900, 900, NULL, 'completed',
       '2026-10-02 12:00:00', '2026-10-03 12:00:00');
    UPDATE app_meta SET value = '23' WHERE key = 'schema_version';
  `);
  raw.close();

  // Phase 3 — boot again; this is the run under test.
  vi.resetModules();
  ({ default: db } = await import('./index.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('dcc_files v24 migration (#1133)', () => {
  it('keeps a completed receive’s file, and the transfer points at it', () => {
    const files = db.prepare('SELECT * FROM dcc_files').all();
    expect(files).toEqual([
      expect.objectContaining({
        user_id: 1,
        path: '/dcc/alice/done.mkv',
        name: 'done.mkv',
        size: 900,
        origin: 'received',
        // ISO, like every file kept since, whatever the transfer row held.
        created_at: '2026-10-01T12:00:00.000Z',
        // Who sent it travels with the file, past the transfer's clearing.
        peer_nick: 'bot',
        network_id: null,
      }),
    ]);
    const t = db.prepare('SELECT file_id, destination_path FROM dcc_transfers WHERE id = 1').get();
    expect(t).toEqual({
      file_id: (files[0] as { id: number }).id,
      destination_path: '/dcc/alice/done.mkv',
    });
  });

  it('leaves a partial with its transfer, and a deleted file deleted', () => {
    const rows = db.prepare('SELECT id, file_id FROM dcc_transfers WHERE id IN (2, 3)').all();
    expect(rows).toEqual([
      { id: 2, file_id: null },
      { id: 3, file_id: null },
    ]);
  });

  it('counts the same bytes as before: the kept file and the partial', async () => {
    const { dccUsageBytes } = await import('./dccTransfers.js');
    expect(dccUsageBytes(1).stored).toBe(1300);
  });
});
