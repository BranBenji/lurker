// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A client splits a long message itself, to the 512-byte line, and draws each
// line it sent. The bouncer used to split those lines AGAIN at irc-framework's
// 350 bytes, so what reached the network — and the echoes that came back — had
// boundaries the client never sent, matched none of its lines, and showed up as
// a second copy of the message (#1041). A line that fits goes up as it is, the
// way soju and ZNC relay one. Against a real IrcConnection on the fake ircd,
// with and without upstream echo-message, the real bouncer in front. See
// bouncerHarness.ts.

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';
import { FakeIrcd, DEFAULT_CAPS } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

const ctx = setupTestDb('services-bouncer-longlines');

let harnessMod: typeof import('../test-utils/bouncerHarness.js');
let bouncerMod: typeof import('./bouncer.js');
let ircManager: typeof import('./ircManager.js').default;
let users: typeof import('../db/users.js');
let networks: typeof import('../db/networks.js');
let hashPassword: typeof import('./password.js').hashPassword;
let harness: import('../test-utils/bouncerHarness.js').Harness;
// One network reflects our own lines (echo-message), one doesn't, so the self
// row comes from the echo on one and from our own send on the other.
let echoing: FakeIrcd;
let silent: FakeIrcd;

type Client = Awaited<ReturnType<import('../test-utils/bouncerHarness.js').Harness['connect']>>;

interface Live {
  userId: number;
  username: string;
  networkId: number;
  nick: string;
  password: string;
}

beforeAll(async () => {
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  harnessMod = await import('../test-utils/bouncerHarness.js');
  bouncerMod = await import('./bouncer.js');
  ircManager = (await import('./ircManager.js')).default;
  users = await import('../db/users.js');
  networks = await import('../db/networks.js');
  ({ hashPassword } = await import('./password.js'));
  echoing = await FakeIrcd.start();
  silent = await FakeIrcd.start({ caps: DEFAULT_CAPS.filter((c) => c !== 'echo-message') });
  harness = await harnessMod.startHarness();
});

afterAll(async () => {
  harness.stop();
  await echoing.close();
  await silent.close();
  ctx.cleanup();
});

beforeEach(() => {
  bouncerMod.resetAuthThrottle();
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

let seq = 0;

async function seedLive(ircd: FakeIrcd): Promise<Live> {
  seq += 1;
  const password = 'hunter2hunter2';
  const nick = `lurk${seq}`;
  const user = users.createUser(`long_${seq}`);
  users.setPasswordHash(user.id, hashPassword(password));
  const network = networks.createNetwork(user.id, {
    name: 'fake',
    host: '127.0.0.1',
    port: ircd.port,
    tls: false,
    nick,
    autoconnect: false,
  } as Parameters<typeof networks.createNetwork>[1])!;
  const conn = ircManager.startNetwork(user.id, network.id)!;
  cleanups.push(() => {
    conn.dispose();
    ircManager.connectionsForUser(user.id).delete(network.id);
  });
  await until(() => conn.state === 'connected', 5000, 'connected');
  return { userId: user.id, username: user.username, networkId: network.id, nick, password };
}

const NUL = String.fromCharCode(0);
const CTCP = String.fromCharCode(1);
const BASE_CAPS = 'sasl batch server-time message-tags';

async function attachIn(live: Live, channel: string, caps: string): Promise<Client> {
  const c = await harness.connect();
  cleanups.push(() => c.close());
  c.send('CAP LS 302');
  await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
  c.send('NICK client');
  c.send('USER client 0 * :client');
  c.send(`CAP REQ :${caps}`);
  await c.waitFor((l) => l.includes('ACK'));
  c.send('AUTHENTICATE PLAIN');
  await c.waitFor((l) => l === 'AUTHENTICATE +');
  const plain = Buffer.from(['', live.username, live.password].join(NUL)).toString('base64');
  c.send(`AUTHENTICATE ${plain}`);
  await c.waitForCommand('903');
  c.send('CAP END');
  await c.waitForCommand('422');
  c.send(`JOIN ${channel}`);
  await c.waitFor((l) => l.includes(' 366 ') && l.includes(` ${channel} `));
  return c;
}

// `w001 w002 … wNNN`, the issue's own message.
function words(from: number, to: number): string {
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`w${String(i).padStart(3, '0')}`);
  return out.join(' ');
}

// The text of every PRIVMSG/NOTICE to `target` our connection put on the wire.
function upstreamTexts(ircd: FakeIrcd, live: Live, command: string, target: string): string[] {
  const prefix = `${command} ${target} :`;
  return ircd
    .client(live.nick)!
    .sent.map((l) => (l.startsWith('@') ? l.slice(l.indexOf(' ') + 1) : l))
    .filter((l) => l.startsWith(prefix))
    .map((l) => l.slice(prefix.length));
}

// The text of every PRIVMSG/NOTICE to `target` the client got after `mark`,
// once a line sent from elsewhere afterwards has arrived too.
let sentinels = 0;
async function clientTexts(
  ircd: FakeIrcd,
  c: Client,
  mark: number,
  command: string,
  target: string,
): Promise<string[]> {
  const sentinel = `sentinel-${++sentinels}`;
  ircd.say('bob', target, sentinel);
  await c.waitFor((l) => l.includes(`:${sentinel}`));
  const marker = ` ${command} ${target} :`;
  return c.lines
    .slice(mark)
    .filter((l) => l.includes(marker) && !l.includes(sentinel))
    .map((l) => l.slice(l.indexOf(marker) + marker.length));
}

// What a client splitting at 512 bytes sends: the first line is well past 350.
const FIRST = words(1, 90);
const SECOND = words(91, 120);

describe.each([
  ['an echoing network', () => echoing],
  ['a network without echo-message', () => silent],
])('a long message a client already split, on %s', (_name, ircdOf) => {
  it('goes upstream and comes back on the lines the client sent', async () => {
    const ircd = ircdOf();
    const live = await seedLive(ircd);
    const c = await attachIn(live, '#room', `${BASE_CAPS} echo-message`);
    expect(Buffer.byteLength(FIRST)).toBeGreaterThan(350);

    const mark = c.lines.length;
    c.send(`PRIVMSG #room :${FIRST}`);
    c.send(`PRIVMSG #room :${SECOND}`);
    await until(
      () => upstreamTexts(ircd, live, 'PRIVMSG', '#room').length >= 2,
      5000,
      'both lines upstream',
    );
    expect(await clientTexts(ircd, c, mark, 'PRIVMSG', '#room')).toEqual([FIRST, SECOND]);
    expect(upstreamTexts(ircd, live, 'PRIVMSG', '#room')).toEqual([FIRST, SECOND]);
  });

  it('is not echoed to a client that did not ask for echo-message', async () => {
    const ircd = ircdOf();
    const live = await seedLive(ircd);
    const c = await attachIn(live, '#room', BASE_CAPS);

    const mark = c.lines.length;
    c.send(`PRIVMSG #room :${FIRST}`);
    c.send(`PRIVMSG #room :${SECOND}`);
    await until(
      () => upstreamTexts(ircd, live, 'PRIVMSG', '#room').length >= 2,
      5000,
      'both lines upstream',
    );
    expect(await clientTexts(ircd, c, mark, 'PRIVMSG', '#room')).toEqual([]);
  });

  it('keeps a long /me and NOTICE whole too', async () => {
    const ircd = ircdOf();
    const live = await seedLive(ircd);
    const c = await attachIn(live, '#room', `${BASE_CAPS} echo-message`);

    const mark = c.lines.length;
    c.send(`PRIVMSG #room :${CTCP}ACTION ${FIRST}${CTCP}`);
    c.send(`NOTICE #room :${FIRST}`);
    await until(
      () =>
        upstreamTexts(ircd, live, 'PRIVMSG', '#room').length >= 1 &&
        upstreamTexts(ircd, live, 'NOTICE', '#room').length >= 1,
      5000,
      'both upstream',
    );
    expect(upstreamTexts(ircd, live, 'PRIVMSG', '#room')).toEqual([
      `${CTCP}ACTION ${FIRST}${CTCP}`,
    ]);
    expect(upstreamTexts(ircd, live, 'NOTICE', '#room')).toEqual([FIRST]);
    expect(await clientTexts(ircd, c, mark, 'PRIVMSG', '#room')).toEqual([
      `${CTCP}ACTION ${FIRST}${CTCP}`,
    ]);
    expect(await clientTexts(ircd, c, mark, 'NOTICE', '#room')).toEqual([FIRST]);
  });

  // A client that doesn't split at all: the line wouldn't fit once the network
  // puts our prefix in front, so it's split here rather than truncated there —
  // and the client gets back what was actually said.
  it('still splits a line too long for the wire', async () => {
    const ircd = ircdOf();
    const live = await seedLive(ircd);
    const c = await attachIn(live, '#room', `${BASE_CAPS} echo-message`);
    const all = words(1, 120);

    const mark = c.lines.length;
    c.send(`PRIVMSG #room :${all}`);
    await until(
      () => upstreamTexts(ircd, live, 'PRIVMSG', '#room').length >= 2,
      5000,
      'the split lines upstream',
    );
    const sent = upstreamTexts(ircd, live, 'PRIVMSG', '#room');
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.join(' ')).toBe(all);
    expect(await clientTexts(ircd, c, mark, 'PRIVMSG', '#room')).toEqual(sent);
  });
});
