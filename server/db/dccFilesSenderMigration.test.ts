// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

// A dcc_files table made before a file carried its sender (#1133) gets the
// columns at boot, filled from the transfers that received its files. The
// fixture is the real schema with dcc_files put back in that shape, one file
// in it, and the transfer that received it pointing there.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-dccfiles-sender-'));
const dbPath = path.join(tmpDir, 'test.db');
process.env.DATABASE_PATH = dbPath;

let db: typeof import('./index.js').default;

beforeAll(async () => {
  const fresh = (await import('./index.js')).default;
  fresh.close();

  const raw = new Database(dbPath);
  raw.pragma('foreign_keys = OFF');
  raw.exec(`
    DROP TABLE dcc_files;
    CREATE TABLE dcc_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      origin TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    INSERT INTO users (id, username) VALUES (1, 'alice');
    INSERT INTO dcc_files (id, user_id, path, name, size, origin)
      VALUES (7, 1, '/dcc/alice/done.mkv', 'done.mkv', 900, 'received');
    INSERT INTO dcc_transfers
      (user_id, network_id, peer_nick, filename, advertised_size, received_bytes,
       destination_path, state, file_id)
    VALUES (1, NULL, 'XdccBot', 'done.mkv', 900, 900, '/dcc/alice/done.mkv', 'completed', 7);
  `);
  raw.close();

  vi.resetModules();
  ({ default: db } = await import('./index.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('dcc_files sender columns (#1133)', () => {
  it('fills who sent each file from the transfer that received it', () => {
    expect(db.prepare('SELECT id, peer_nick, network_id FROM dcc_files').all()).toEqual([
      { id: 7, peer_nick: 'XdccBot', network_id: null },
    ]);
  });
});
