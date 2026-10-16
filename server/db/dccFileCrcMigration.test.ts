// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

// Integration test for the schemaVersion-26 block (#1082): a kept file takes
// how it checked out from the transfer that received it, where that row is
// still there. An upload, or a file whose transfer was cleared, says nothing.
//
// The fixture is the real schema with dcc_files put back in its v25 shape (no
// crc_status) and schema_version wound back to 25 (see
// inviteRevivalMigration.test.ts for why a hand-written old DB doesn't work).

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-dcccrc-'));
const dbPath = path.join(tmpDir, 'test.db');
process.env.DATABASE_PATH = dbPath;

let db: typeof import('./index.js').default;

beforeAll(async () => {
  // Phase 1 — real, fully-migrated schema.
  const fresh = (await import('./index.js')).default;
  fresh.close();

  // Phase 2 — the v25 shape, with one of each kind of file.
  const raw = new Database(dbPath);
  raw.pragma('foreign_keys = OFF');
  raw.exec(`
    ALTER TABLE dcc_files DROP COLUMN crc_status;
    INSERT INTO users (id, username) VALUES (1, 'alice');
    INSERT INTO dcc_files (id, user_id, path, name, size, origin, peer_nick)
    VALUES
      (1, 1, '/dcc/alice/ok.mkv', 'ok.mkv', 900, 'received', 'bot'),
      (2, 1, '/dcc/alice/plain.mkv', 'plain.mkv', 900, 'received', 'friend'),
      (3, 1, '/dcc/alice/cleared.mkv', 'cleared.mkv', 900, 'received', 'bot'),
      (4, 1, '/dcc/alice/mine.mkv', 'mine.mkv', 900, 'uploaded', NULL);
    INSERT INTO dcc_transfers
      (id, user_id, peer_nick, filename, advertised_size, received_bytes, state, crc_status,
       file_id)
    VALUES
      (1, 1, 'bot', 'ok.mkv', 900, 900, 'completed', 'ok', 1),
      (2, 1, 'friend', 'plain.mkv', 900, 900, 'completed', 'absent', 2);
    UPDATE app_meta SET value = '25' WHERE key = 'schema_version';
  `);
  raw.close();

  // Phase 3 — boot again; this is the run under test.
  vi.resetModules();
  ({ default: db } = await import('./index.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('dcc_files v26 migration (#1082)', () => {
  it('fills each kept file from its transfer, and leaves the rest null', () => {
    expect(db.prepare('SELECT id, crc_status FROM dcc_files ORDER BY id').all()).toEqual([
      { id: 1, crc_status: 'ok' },
      { id: 2, crc_status: 'absent' },
      { id: 3, crc_status: null },
      { id: 4, crc_status: null },
    ]);
  });
});
