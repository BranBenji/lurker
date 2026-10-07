// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The catch-up repeat probe for lines without a msgid (hasRecentMessageLike).
// Unbounded, it read every row of the line's type in the buffer for each line
// that wasn't a repeat; after 2.4.0's migration kept a large cell detached, the
// backlog's thousands of lines froze the process for minutes. It now looks only
// at the buffer's tail, and skips the probe for lines newer than anything the
// buffer held when the catch-up began.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-catchup-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let m: typeof import('./messages.js');
let db: typeof import('./index.js').default;
let networkId: number;

beforeAll(async () => {
  const { createUser } = await import('./users.js');
  const { createNetwork } = await import('./networks.js');
  m = await import('./messages.js');
  db = (await import('./index.js')).default;
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

describe('hasRecentMessageLike (catch-up repeat probe)', () => {
  it('finds a re-delivered line stored at the tail', () => {
    say('#tail', 'alice', 'hello', at(0));
    const horizon: import('./messages.js').CatchUpHorizon = new Map();
    expect(
      m.hasRecentMessageLike(
        networkId,
        '#tail',
        'message',
        'alice',
        'hello',
        at(1000),
        5000,
        horizon,
      ),
    ).toBe(true);
    // A different line in the same window is not a repeat.
    expect(
      m.hasRecentMessageLike(
        networkId,
        '#tail',
        'message',
        'alice',
        'other',
        at(1000),
        5000,
        horizon,
      ),
    ).toBe(false);
  });

  it('skips the probe for a line newer than anything the buffer held at the start', () => {
    say('#horizon', 'bob', 'old', at(0));
    const horizon: import('./messages.js').CatchUpHorizon = new Map();
    // Even the identical text, an hour later, can't be a re-delivery.
    expect(
      m.hasRecentMessageLike(
        networkId,
        '#horizon',
        'message',
        'bob',
        'old',
        at(3_600_000),
        5000,
        horizon,
      ),
    ).toBe(false);
    // The buffer's newest time is captured once, at the first look...
    const bufferId = [...horizon.keys()][0];
    expect(horizon.get(bufferId)).toBe(T0);
    // ...so a line the catch-up stores afterwards doesn't move it: later backlog
    // lines are still judged against what was there when the catch-up began.
    say('#horizon', 'bob', 'new', at(3_600_000));
    expect(horizon.get(bufferId)).toBe(T0);
    expect(
      m.hasRecentMessageLike(
        networkId,
        '#horizon',
        'message',
        'bob',
        'new',
        at(3_600_500),
        5000,
        horizon,
      ),
    ).toBe(false);
  });

  it('treats an empty buffer as holding nothing to repeat', () => {
    // A buffer that exists but has no rows.
    say('#empty', 'carol', 'x', at(0));
    db.prepare(`DELETE FROM messages WHERE text = 'x'`).run();
    const horizon: import('./messages.js').CatchUpHorizon = new Map();
    expect(
      m.hasRecentMessageLike(networkId, '#empty', 'message', 'carol', 'x', at(0), 5000, horizon),
    ).toBe(false);
  });

  it('only looks at the tail: an original buried under more rows than that is out of reach', () => {
    // This pins the bound itself — the unbounded probe would find it, reading
    // every row of the buffer to do so.
    say('#deep', 'dave', 'buried', at(0));
    const insert = db.transaction(() => {
      for (let i = 0; i < m.CATCH_UP_TAIL_ROWS; i++) say('#deep', 'eve', `filler ${i}`, at(1));
    });
    insert();
    expect(m.hasRecentMessageLike(networkId, '#deep', 'message', 'dave', 'buried', at(0))).toBe(
      false,
    );
    // ...while one inside the tail is still found.
    expect(m.hasRecentMessageLike(networkId, '#deep', 'message', 'eve', 'filler 5', at(1))).toBe(
      true,
    );
  });
});
