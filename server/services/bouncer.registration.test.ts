// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The upstream registering under an attached client (#1202). A client that
// binds while the network is down gets Lurker's own 001–004 and no 005, and the
// network's 001–005 are never relayed live — so until this, its ISUPPORT
// (NETWORK, CHANTYPES, PREFIX, CASEMAPPING) stayed at the client's defaults
// until it reconnected. Now the end of every new burst brings the network's
// 005s, after a NICK onto a registered nick the client wasn't told. Against a
// real IrcConnection and the fake ircd, then the harness's fake upstream for
// the shapes the ircd can't stage. See bouncerHarness.ts.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { CHANNEL_PREFIX_CHARS } from '../../shared/channels.js';

const ctx = setupTestDb('services-bouncer-registration');

let harnessMod: typeof import('../test-utils/bouncerHarness.js');
let bouncerMod: typeof import('./bouncer.js');
let ircManager: typeof import('./ircManager.js').default;
let usersDb: typeof import('../db/users.js');
let networksDb: typeof import('../db/networks.js');
let passwordMod: typeof import('./password.js');
let harness: import('../test-utils/bouncerHarness.js').Harness;
let ircd: FakeIrcd;

type Client = Awaited<ReturnType<import('../test-utils/bouncerHarness.js').Harness['connect']>>;
type Account = import('../test-utils/bouncerHarness.js').HarnessAccount;

const PASSWORD = 'hunter2hunter2';

beforeAll(async () => {
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  harnessMod = await import('../test-utils/bouncerHarness.js');
  bouncerMod = await import('./bouncer.js');
  ircManager = (await import('./ircManager.js')).default;
  usersDb = await import('../db/users.js');
  networksDb = await import('../db/networks.js');
  passwordMod = await import('./password.js');
  ircd = await FakeIrcd.start({ network: 'FakeNet' });
  harness = await harnessMod.startHarness();
});

afterAll(async () => {
  harness.stop();
  await ircd.close();
  ctx.cleanup();
});

beforeEach(() => {
  bouncerMod.resetAuthThrottle();
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  ircd.hold = null;
  vi.restoreAllMocks();
});

// A client on a network by its login name, with no caps.
async function attachPlain(username: string, networkName: string): Promise<Client> {
  const c = await harness.connect();
  cleanups.push(() => c.close());
  c.send(`PASS ${username}/${networkName}:${PASSWORD}`);
  c.send('NICK client');
  c.send('USER client 0 * :client');
  await c.waitForCommand('422');
  return c;
}

let syncSeq = 0;
// Resolves once the client has everything the bouncer sent before this.
async function synced(c: Client): Promise<void> {
  const token = `sync${++syncSeq}`;
  c.send(`PING :${token}`);
  await c.waitFor((l) => l.includes(' PONG ') && l.endsWith(`:${token}`));
}

const commandOf = (l: string) => harnessMod.commandOf(l);
const ofCommand = (lines: string[], command: string) =>
  lines.filter((l) => commandOf(l) === command);
// What the bouncer sent after `mark` lines, minus the PONG synced() asked for.
const sentAfter = (c: Client, mark: number) =>
  c.lines.slice(mark).filter((l) => commandOf(l) !== 'PONG');

describe('a client bound before the network registered', () => {
  it('gets the ISUPPORT when it does, and nothing more for a later MOTD', async () => {
    const user = usersDb.createUser('bnc_reg_slow');
    usersDb.setPasswordHash(user.id, passwordMod.hashPassword(PASSWORD));
    const network = networksDb.createNetwork(user.id, {
      name: 'slow',
      host: '127.0.0.1',
      port: ircd.port,
      tls: 0,
      nick: 'slownick',
      autoconnect: 0,
    })!;
    // The ircd sits on the USER, so the connection is up but unregistered —
    // the window Lurker's own boot leaves while an autoreconnecting client
    // comes back.
    let held: string | null = null;
    ircd.hold = (cmd, _params, c) => {
      if (cmd !== 'USER') return false;
      held = c.sent.at(-1) ?? null;
      return true;
    };
    const conn = ircManager.startNetwork(user.id, network.id)!;
    cleanups.push(() => ircManager.disposeNetwork(user.id, network.id));
    await vi.waitFor(() => expect(held).not.toBeNull(), { timeout: 5000 });
    expect(conn.state).not.toBe('connected');

    const c = await attachPlain(user.username, 'slow');
    // The fallback burst: Lurker's own welcome, no 005, the network's nick.
    expect(ofCommand(c.lines, '001')).toEqual([
      ':lurker.bouncer 001 client :Welcome to the Lurker bouncer, client',
    ]);
    expect(ofCommand(c.lines, '005')).toEqual([]);
    expect(ofCommand(c.lines, 'NICK')).toHaveLength(1);
    expect(ofCommand(c.lines, 'NICK')[0]).toMatch(/^:client!\S+@lurker\.bouncer NICK :slownick$/);
    expect(c.lines.some((l) => l.includes("Network 'slow' is connecting"))).toBe(true);

    const mark = c.lines.length;
    ircd.hold = null;
    ircd.feed('slownick', held!);
    await vi.waitFor(() => expect(conn.isupportComplete).toBe(true), { timeout: 5000 });
    await synced(c);

    const after = sentAfter(c, mark);
    expect(ofCommand(after, '005')).toEqual([
      `:fake.test 005 slownick CASEMAPPING=ascii CHANTYPES=${CHANNEL_PREFIX_CHARS} NETWORK=FakeNet NICKLEN=32 PREFIX=(ov)@+ MONITOR=100 :are supported by this server`,
    ]);
    // The nick it was told is the one it registered under: no NICK, and the
    // network's own 001–004 stay dropped (its MOTD is relayed, as ZNC does).
    expect(ofCommand(after, 'NICK')).toEqual([]);
    for (const numeric of ['001', '002', '003', '004']) {
      expect(ofCommand(after, numeric)).toEqual([]);
    }

    // The 376 a /MOTD brings is not a registration.
    const quiet = c.lines.length;
    c.send('MOTD');
    await c.waitForCommand('376');
    await synced(c);
    expect(ofCommand(c.lines.slice(quiet), '005')).toEqual([]);
  }, 15000);
});

// A -notify-less client bound to a seeded account's fake upstream.
async function attachSeeded(acct: Account): Promise<Client> {
  return attachPlain(acct.user.username, acct.network.name);
}

const ISUPPORT = (nick: string) =>
  `:irc.example.test 005 ${nick} NETWORK=Alpha CASEMAPPING=ascii :are supported by this server`;

// The network registers again under `nick`, with its burst recorded.
function reregister(acct: Account, nick: string): void {
  acct.upstream.currentNick = nick;
  acct.upstream.registrationLines = [`:irc.example.test 001 ${nick} :Welcome`, ISUPPORT(nick)];
  acct.upstream.state = 'connected';
  acct.upstream.client.emit('registered', { nick });
  acct.upstream.client.emit('motd', {});
}

describe('a new registration burst', () => {
  it('names a registered nick the client was not told, before the 005', async () => {
    const acct = harnessMod.seedAccount({ networkName: 'alpha', nick: 'alice' });
    acct.upstream.registrationLines = [':irc.example.test 001 alice :Welcome', ISUPPORT('alice')];
    const c = await attachSeeded(acct);
    expect(ofCommand(c.lines, '005')).toEqual([ISUPPORT('client')]);
    expect(c.lines).toContain(':client!alice@lurker.bouncer NICK :alice');

    // The primary was taken when the network came back: a 433 fallback, which
    // has no NICK line.
    const mark = c.lines.length;
    reregister(acct, 'alice_');
    await synced(c);
    expect(sentAfter(c, mark)).toEqual([
      ':alice!alice@lurker.bouncer NICK :alice_',
      ISUPPORT('alice_'),
    ]);

    // And the next, back on the primary.
    const again = c.lines.length;
    reregister(acct, 'alice');
    await synced(c);
    expect(sentAfter(c, again)).toEqual([
      ':alice_!alice@lurker.bouncer NICK :alice',
      ISUPPORT('alice'),
    ]);
  });

  it('says nothing about a rename the relay already carried', async () => {
    const acct = harnessMod.seedAccount({ networkName: 'alpha', nick: 'alice' });
    acct.upstream.registrationLines = [':irc.example.test 001 alice :Welcome', ISUPPORT('alice')];
    const c = await attachSeeded(acct);

    // Nick enforcement renamed us mid-burst; the relay forwarded the NICK.
    const mark = c.lines.length;
    acct.upstream.pushUpstream(':alice!alice@fake.host NICK :alicia');
    reregister(acct, 'alicia');
    await synced(c);
    expect(sentAfter(c, mark)).toEqual([':alice!alice@fake.host NICK :alicia', ISUPPORT('alicia')]);
  });

  it('is nothing to say to a client the connection is replaying its session into', async () => {
    const acct = harnessMod.seedAccount({ networkName: 'alpha', nick: 'alice' });
    acct.upstream.registrationLines = [':irc.example.test 001 alice :Welcome', ISUPPORT('alice')];
    const c = await attachSeeded(acct);

    const mark = c.lines.length;
    acct.upstream.restoring = true;
    reregister(acct, 'alice');
    acct.upstream.restoring = false;
    await synced(c);
    expect(sentAfter(c, mark)).toEqual([]);
  });

  it('carries our own ISUPPORT with the network’s', async () => {
    const acct = harnessMod.seedAccount({ networkName: 'alpha', nick: 'alice' });
    acct.upstream.registrationLines = [':irc.example.test 001 alice :Welcome', ISUPPORT('alice')];
    const c = await harness.connect();
    cleanups.push(() => c.close());
    c.send('CAP LS 302');
    await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    c.send(`PASS ${acct.user.username}/alpha:${acct.password}`);
    c.send('NICK client');
    c.send('USER client 0 * :client');
    c.send('CAP REQ :soju.im/bouncer-networks draft/chathistory');
    await c.waitFor((l) => l.includes('ACK'));
    c.send('CAP END');
    await c.waitForCommand('422');
    const [theirs, ours] = ofCommand(c.lines, '005');
    expect(theirs).toBe(ISUPPORT('client'));
    expect(ours).toMatch(
      new RegExp(
        `^:lurker\\.bouncer 005 alice BOUNCER_NETID=${acct.network.id} CHATHISTORY=\\d+ MSGREFTYPES=timestamp :`,
      ),
    );

    const mark = c.lines.length;
    reregister(acct, 'alice');
    await synced(c);
    expect(sentAfter(c, mark)).toEqual([ISUPPORT('alice'), ours]);
  });
});
