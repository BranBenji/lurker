// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-away-state-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let mod: typeof import('./networkAwayState.js');
let userId: number;
let netA: number;
let netB: number;

beforeAll(async () => {
  const { createUser } = await import('./users.js');
  const { createNetwork } = await import('./networks.js');
  mod = await import('./networkAwayState.js');
  userId = createUser('away-alice').id;
  const fields = { host: 'irc.example', port: 6697, tls: true, nick: 'alice' };
  netA = createNetwork(userId, { name: 'a', ...fields })!.id;
  netB = createNetwork(userId, { name: 'b', ...fields })!.id;
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('writeAwayMarker / getNetworkAwayState', () => {
  it('round-trips the away cycle', () => {
    expect(mod.getNetworkAwayState(netA)).toBeNull();
    mod.writeAwayMarker(userId, netA, {
      awayDatetime: '2026-05-17T10:00:00Z',
      awayMessage: 'lunch',
      autoSet: false,
    });
    expect(mod.getNetworkAwayState(netA)).toMatchObject({
      network_id: netA,
      user_id: userId,
      away_datetime: '2026-05-17T10:00:00Z',
      back_datetime: null,
      away_message: 'lunch',
      auto_set: 0,
    });
    expect(mod.isAwayRow(mod.getNetworkAwayState(netA))).toBe(true);
    // Another network is untouched.
    expect(mod.getNetworkAwayState(netB)).toBeNull();
  });

  it('a new /away clears any prior back_datetime', () => {
    mod.writeBackMarker(netA, '2026-05-17T11:00:00Z');
    expect(mod.getNetworkAwayState(netA)!.back_datetime).toBe('2026-05-17T11:00:00Z');
    expect(mod.isAwayRow(mod.getNetworkAwayState(netA))).toBe(false);
    mod.writeAwayMarker(userId, netA, {
      awayDatetime: '2026-05-17T12:00:00Z',
      awayMessage: 'second',
      autoSet: true,
    });
    expect(mod.getNetworkAwayState(netA)).toMatchObject({
      away_datetime: '2026-05-17T12:00:00Z',
      back_datetime: null,
      auto_set: 1,
    });
  });
});

describe('writeBackMarker', () => {
  it('only fills in back_datetime, leaving the rest of the cycle', () => {
    mod.writeBackMarker(netA, '2026-05-17T13:00:00Z');
    expect(mod.getNetworkAwayState(netA)).toMatchObject({
      away_datetime: '2026-05-17T12:00:00Z',
      back_datetime: '2026-05-17T13:00:00Z',
      away_message: 'second',
      auto_set: 1,
    });
  });
});

describe('listNetworkAwayStates', () => {
  it('lists every network of the user that has a row', () => {
    mod.writeAwayMarker(userId, netB, { awayDatetime: '2026-05-17T14:00:00Z', awayMessage: 'b' });
    expect(
      mod
        .listNetworkAwayStates(userId)
        .map((r) => r.network_id)
        .toSorted(),
    ).toEqual([netA, netB].toSorted());
  });
});
