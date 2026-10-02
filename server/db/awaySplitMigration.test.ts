// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

// Integration test for the schemaVersion-21 cutover (#994): away moved from one
// user_away_state row per user to one network_away_state row per network. An
// account that was away stays away on every one of its networks.
//
// The fixture is the real schema with the old table put back and
// schema_version wound back to 20 (see inviteRevivalMigration.test.ts for why a
// hand-written old DB doesn't work).

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-awaymig-'));
const dbPath = path.join(tmpDir, 'test.db');
process.env.DATABASE_PATH = dbPath;

let db: typeof import('./index.js').default;
let away: typeof import('./networkAwayState.js');

beforeAll(async () => {
  // Phase 1 — real, fully-migrated schema.
  const fresh = (await import('./index.js')).default;
  fresh.close();

  // Phase 2 — put user_away_state back, and seed an away user with two
  // networks, a user who came back, and a user with no networks.
  const raw = new Database(dbPath);
  raw.pragma('foreign_keys = OFF');
  raw.exec(`
    CREATE TABLE user_away_state (
      user_id INTEGER PRIMARY KEY,
      away_datetime TEXT,
      back_datetime TEXT,
      away_message TEXT,
      auto_set INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    INSERT INTO users (id, username) VALUES (1, 'away'), (2, 'back'), (3, 'nonets');
    INSERT INTO networks (id, user_id, name, host, nick) VALUES
      (10, 1, 'a', 'irc.example', 'away'),
      (11, 1, 'b', 'irc.example', 'away'),
      (20, 2, 'c', 'irc.example', 'back');
    INSERT INTO user_away_state VALUES
      (1, '2026-09-01T10:00:00.000Z', NULL, 'lunch', 0),
      (2, '2026-09-01T09:00:00.000Z', '2026-09-01T09:30:00.000Z', 'afk', 1),
      (3, '2026-09-01T08:00:00.000Z', NULL, 'nowhere', 0);
    UPDATE app_meta SET value = '20' WHERE key = 'schema_version';
  `);
  raw.close();

  // Phase 3 — boot again; this is the run under test.
  vi.resetModules();
  ({ default: db } = await import('./index.js'));
  away = await import('./networkAwayState.js');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('network_away_state v21 migration (#994)', () => {
  it('copies an away user’s row onto each of their networks', () => {
    for (const networkId of [10, 11]) {
      expect(away.getNetworkAwayState(networkId)).toMatchObject({
        user_id: 1,
        away_datetime: '2026-09-01T10:00:00.000Z',
        back_datetime: null,
        away_message: 'lunch',
        auto_set: 0,
      });
    }
  });

  it('keeps a completed pair, so the back divider still draws', () => {
    expect(away.getNetworkAwayState(20)).toMatchObject({
      away_datetime: '2026-09-01T09:00:00.000Z',
      back_datetime: '2026-09-01T09:30:00.000Z',
      auto_set: 1,
    });
  });

  it('drops the old table', () => {
    const t = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_away_state'`)
      .get();
    expect(t).toBeUndefined();
    expect(away.listNetworkAwayStates(3)).toEqual([]);
  });
});
