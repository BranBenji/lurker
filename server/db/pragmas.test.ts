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

beforeAll(async () => {
  db = (await import('./index.js')).default;
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

  // Two budgets (#748): a long one while booting, when the lock a writer meets
  // can be Litestream's post-migration checkpoint over a huge WAL and nothing is
  // being served; the steady-state one once the server listens, when a wait
  // blocks live traffic.
  it('waits long for a lock while booting, 5 s once boot is over', async () => {
    const { BOOT_BUSY_TIMEOUT_MS, BUSY_TIMEOUT_MS, endBootPhase } = await import('./index.js');
    expect(db.pragma('busy_timeout', { simple: true })).toBe(BOOT_BUSY_TIMEOUT_MS);
    expect(BOOT_BUSY_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
    endBootPhase();
    expect(db.pragma('busy_timeout', { simple: true })).toBe(BUSY_TIMEOUT_MS);
    expect(BUSY_TIMEOUT_MS).toBe(5000);
  });

  it('enforces foreign keys', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
