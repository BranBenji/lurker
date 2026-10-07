// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The catch-up repeat probe for lines without a msgid (hasRecentMessageLike).
// Unbounded, it read every row of the line's type in the buffer for each line
// that wasn't a repeat; after 2.4.0's migration kept a large cell detached, the
// backlog's thousands of lines froze the process for minutes. It now looks only
// at rows stored before the catch-up began (`maxId`), and only at the newest of
// those (`tailRows`).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-catchup-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let m: typeof import('./messages.js');
let networkId: number;

beforeAll(async () => {
  const { createUser } = await import('./users.js');
  const { createNetwork } = await import('./networks.js');
  m = await import('./messages.js');
  const user = createUser('catchup-user');
  networkId = createNetwork(user.id, {
    name: 'n',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'me',
  })!.id;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const T0 = Date.parse('2026-10-07T01:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

function say(target: string, nick: string, text: string, time: string) {
  m.insertMessage({ networkId, target, time, type: 'message', nick, text, self: false });
}

const probe = (target: string, nick: string, text: string, time: string, opts = {}) =>
  m.hasRecentMessageLike(networkId, target, 'message', nick, text, time, opts);

describe('hasRecentMessageLike (catch-up repeat probe)', () => {
  it('finds a re-delivered line stored before the catch-up', () => {
    say('#tail', 'alice', 'hello', at(0));
    const maxId = m.maxMessageId();
    expect(probe('#tail', 'alice', 'hello', at(1000), { maxId })).toBe(true);
    // A different line in the same window is not a repeat.
    expect(probe('#tail', 'alice', 'other', at(1000), { maxId })).toBe(false);
  });

  it("never treats the catch-up's own rows as an original", () => {
    // Two identical lines in one backlog (a "lol", twice, within seconds) are
    // two lines: the first is stored during the catch-up, above `maxId`, so the
    // second is not mistaken for its re-delivery.
    say('#own', 'bob', 'warm-up', at(0));
    const maxId = m.maxMessageId();
    say('#own', 'bob', 'lol', at(10_000));
    expect(probe('#own', 'bob', 'lol', at(11_000), { maxId })).toBe(false);
  });

  it('only looks at the tail: an original buried under more rows than that is out of reach', () => {
    // Pins the bound itself — the unbounded probe would find it, reading every
    // row of the buffer to do so. A small tail keeps the test's cost fixed.
    say('#deep', 'dave', 'buried', at(0));
    for (let i = 0; i < 5; i++) say('#deep', 'eve', `filler ${i}`, at(1));
    const maxId = m.maxMessageId();
    expect(probe('#deep', 'dave', 'buried', at(0), { maxId, tailRows: 5 })).toBe(false);
    // ...while one inside the tail is still found.
    expect(probe('#deep', 'eve', 'filler 4', at(1), { maxId, tailRows: 5 })).toBe(true);
  });
});
