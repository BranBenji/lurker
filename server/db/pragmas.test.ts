// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// db/index.js reads DATABASE_PATH at module-load time and opens the connection
// (applying these pragmas) on first import, so point it at an isolated temp DB
// before any dynamic import touches it.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: typeof import('./index.js').default;
let mod: typeof import('./index.js');

beforeAll(async () => {
  mod = await import('./index.js');
  db = mod.default;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('connection pragmas', () => {
  it('opens the database in WAL journal mode', () => {
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('sets synchronous to NORMAL so writes do not fsync the event loop', () => {
    // PRAGMA synchronous reads back the numeric level: 0=OFF, 1=NORMAL, 2=FULL.
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
  });

  // Two budgets (#748): the migrations run under a long one, and the module
  // ends by draining the WAL and dropping to the steady-state 5 s — so by the
  // time anyone imports the connection, a lock wait is bounded for live
  // traffic again.
  it('sets busy_timeout so a transient lock retries instead of throwing SQLITE_BUSY', () => {
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('migrations get a two-minute budget, and boot ends with the WAL drained', () => {
    expect(mod.BOOT_BUSY_TIMEOUT_MS).toBeGreaterThan(mod.BUSY_TIMEOUT_MS);
    // Leave a WAL behind the way a migration does, then drain it: afterwards a
    // passive checkpoint finds nothing left.
    db.exec(`CREATE TABLE IF NOT EXISTS wal_probe (id INTEGER PRIMARY KEY, body TEXT)`);
    const ins = db.prepare(`INSERT INTO wal_probe (body) VALUES (?)`);
    db.transaction(() => {
      for (let i = 0; i < 3000; i += 1) ins.run('x'.repeat(2000));
    })();
    const dirty = (
      db.pragma('wal_checkpoint(PASSIVE)') as { log: number; checkpointed: number }[]
    )[0];
    const result = mod.drainWal(10_000);
    expect(result.behind).toBeLessThanOrEqual(1000);
    expect(result.frames).toBeGreaterThanOrEqual(dirty.log);
    const after = (
      db.pragma('wal_checkpoint(PASSIVE)') as { log: number; checkpointed: number }[]
    )[0];
    expect(after.log - after.checkpointed).toBeLessThanOrEqual(1000);
    db.exec(`DROP TABLE wal_probe`);
  });

  it('enforces foreign keys', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
