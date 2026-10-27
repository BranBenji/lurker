// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The DB file holds raw session tokens; SQLite creates it under the umask, so
// the module holds it to session-secret.key's 0600 once it is open.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

beforeAll(async () => {
  await import('./index.js');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('database file mode', () => {
  it('is owner-only once the module has opened it', () => {
    const mode = fs.statSync(process.env.DATABASE_PATH as string).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
