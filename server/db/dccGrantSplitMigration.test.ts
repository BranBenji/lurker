// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

// Integration test for the schemaVersion-22 split (#1080): the one 'dcc' grant
// became 'dcc.chat' and 'dcc.receive'. An account granted DCC before the split
// could do both, so it keeps both; a revoked one keeps neither.
//
// The fixture is the real schema with old rows put back and schema_version
// wound back to 21 (see inviteRevivalMigration.test.ts for why a hand-written
// old DB doesn't work).

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-dccsplit-'));
const dbPath = path.join(tmpDir, 'test.db');
process.env.DATABASE_PATH = dbPath;

let db: typeof import('./index.js').default;

beforeAll(async () => {
  // Phase 1 — real, fully-migrated schema.
  const fresh = (await import('./index.js')).default;
  fresh.close();

  // Phase 2 — an account granted DCC, one granted then revoked, one never.
  const raw = new Database(dbPath);
  raw.exec(`
    INSERT INTO users (id, username) VALUES (1, 'granted'), (2, 'revoked'), (3, 'never');
    INSERT INTO user_capabilities (user_id, capability, enabled, updated_at) VALUES
      (1, 'dcc', 1, '2026-09-01 10:00:00'),
      (2, 'dcc', 0, '2026-09-02 10:00:00');
    UPDATE app_meta SET value = '21' WHERE key = 'schema_version';
  `);
  raw.close();

  // Phase 3 — boot again; this is the run under test.
  vi.resetModules();
  ({ default: db } = await import('./index.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function grants(userId: number) {
  return db
    .prepare(
      `SELECT capability, enabled, updated_at FROM user_capabilities
       WHERE user_id = ? ORDER BY capability`,
    )
    .all(userId);
}

describe('user_capabilities v22 migration (#1080)', () => {
  it('gives an account granted DCC both chat and receive', () => {
    expect(grants(1)).toEqual([
      { capability: 'dcc.chat', enabled: 1, updated_at: '2026-09-01 10:00:00' },
      { capability: 'dcc.receive', enabled: 1, updated_at: '2026-09-01 10:00:00' },
    ]);
  });

  it('carries a revoked grant over as revoked', () => {
    expect(grants(2)).toEqual([
      { capability: 'dcc.chat', enabled: 0, updated_at: '2026-09-02 10:00:00' },
      { capability: 'dcc.receive', enabled: 0, updated_at: '2026-09-02 10:00:00' },
    ]);
  });

  it('leaves no old rows, and grants nothing to an account that had none', () => {
    const old = db.prepare(`SELECT 1 FROM user_capabilities WHERE capability = 'dcc'`).get();
    expect(old).toBeUndefined();
    expect(grants(3)).toEqual([]);
  });
});
