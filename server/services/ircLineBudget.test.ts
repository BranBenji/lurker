// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A long message is split to what one line can carry as the network relays it
// — `:nick!user@host PRIVMSG target :text\r\n` within 512 bytes — not to
// irc-framework's fixed 350 (#1043). That left ~100 bytes of every line unused
// on most networks, and still overflowed behind a long enough host, where the
// network truncated the line for everyone else. Against a real IrcConnection on
// the fake ircd.

import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { ircLineParser } from 'irc-framework';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

type Ev = Record<string, unknown>;

let ircManager: typeof import('./ircManager.js').default;
let plain: FakeIrcd;
// Every client's host here is 200 bytes: a 350-byte line behind it is ~570.
let longHost: FakeIrcd;
const LONG_HOST = `${'h'.repeat(190)}.long.host`;
let userId: number;
let seq = 0;

beforeAll(async () => {
  ircManager = (await import('./ircManager.js')).default;
  plain = await FakeIrcd.start({});
  longHost = await FakeIrcd.start({ clientHost: LONG_HOST });
  userId = createUser('line-budget').id;
});

afterAll(async () => {
  await plain.close();
  await longHost.close();
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

// Connect a fresh network to `ircd` and join `#room`, which is what shows the
// connection its own user@host.
async function joined(ircd: FakeIrcd): Promise<{ networkId: number; nick: string; events: Ev[] }> {
  const nick = `budget${++seq}`;
  const network = createNetwork(userId, {
    name: `budget-${seq}`,
    host: '127.0.0.1',
    port: ircd.port,
    tls: false,
    nick,
    autoconnect: false,
  })!;
  const events: Ev[] = [];
  const onEvent = (e: Ev) => {
    if (e.networkId === network.id) events.push(e);
  };
  ircManager.on('event', onEvent);
  const conn = ircManager.startNetwork(userId, network.id)!;
  cleanups.push(() => {
    ircManager.off('event', onEvent);
    conn.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  });
  await until(() => conn.state === 'connected', 5000, 'connected');
  ircManager.joinChannel(userId, network.id, '#room');
  await until(() => conn.isChannelJoined('#room'), 5000, 'joined #room');
  return { networkId: network.id, nick, events };
}

// Every PRIVMSG/NOTICE our connection sent to `target`, parsed.
function upstream(ircd: FakeIrcd, nick: string, command: string, target: string): string[] {
  return ircd
    .client(nick)!
    .sent.map((l) => ircLineParser(l))
    .filter((m) => m?.command === command && m.params[0] === target)
    .map((m) => m!.params[1] ?? '');
}

// The line as the network relays it to everyone else, CRLF included.
function relayedBytes(ircd: FakeIrcd, nick: string, command: string, text: string): number {
  const c = ircd.client(nick)!;
  const host = ircd === longHost ? LONG_HOST : 'fake.host';
  return Buffer.byteLength(`:${nick}!~${c.user}@${host} ${command} #room :${text}\r\n`);
}

function words(count: number): string {
  return Array.from({ length: count }, (_, i) => `w${String(i + 1).padStart(3, '0')}`).join(' ');
}

describe('the line budget', () => {
  it('sends a message that fits the real line as ONE line, past 350 bytes', async () => {
    const { networkId, nick, events } = await joined(plain);
    const text = words(85); // 424 bytes
    expect(Buffer.byteLength(text)).toBeGreaterThan(350);

    ircManager.send(userId, networkId, '#room', text);
    await until(
      () => events.some((e) => e.type === 'message' && e.self && e.id != null),
      5000,
      'our own line',
    );
    expect(upstream(plain, nick, 'PRIVMSG', '#room')).toEqual([text]);
    expect(relayedBytes(plain, nick, 'PRIVMSG', text)).toBeLessThanOrEqual(512);
    // One self row, the whole message: what the channel saw.
    expect(events.filter((e) => e.type === 'message' && e.self).map((e) => e.text)).toEqual([text]);
  });

  it('splits so every line fits 512 bytes as relayed behind a long host', async () => {
    const { networkId, nick } = await joined(longHost);
    const text = words(240);

    ircManager.send(userId, networkId, '#room', text);
    ircManager.notice(userId, networkId, '#room', text);
    ircManager.action(userId, networkId, '#room', text);
    await until(
      () =>
        upstream(longHost, nick, 'PRIVMSG', '#room').filter((t) => t.startsWith('\x01ACTION '))
          .length > 1,
      5000,
      'the /me lines',
    );

    const said = upstream(longHost, nick, 'PRIVMSG', '#room').filter(
      (t) => !t.startsWith('\x01ACTION '),
    );
    const noticed = upstream(longHost, nick, 'NOTICE', '#room');
    const acted = upstream(longHost, nick, 'PRIVMSG', '#room').filter((t) =>
      t.startsWith('\x01ACTION '),
    );
    expect(said.join(' ')).toBe(text);
    expect(noticed.join(' ')).toBe(text);
    expect(acted.map((t) => t.slice('\x01ACTION '.length, -1)).join(' ')).toBe(text);
    for (const t of said)
      expect(relayedBytes(longHost, nick, 'PRIVMSG', t)).toBeLessThanOrEqual(512);
    for (const t of noticed)
      expect(relayedBytes(longHost, nick, 'NOTICE', t)).toBeLessThanOrEqual(512);
    for (const t of acted)
      expect(relayedBytes(longHost, nick, 'PRIVMSG', t)).toBeLessThanOrEqual(512);
  });

  // The composer estimates where a message will split by the same budget; the
  // user@host bytes are the one input it can't know, so the server tells it.
  it('tells clients the user@host bytes it learned from our JOIN', async () => {
    const { networkId, nick, events } = await joined(plain);
    const user = plain.client(nick)!.user;
    const real = Buffer.byteLength(`~${user}@fake.host`);

    await until(
      () => events.some((e) => e.type === 'line-budget' && e.userhostBytes === real),
      5000,
      'a line-budget frame with the real bytes',
    );
    const conn = ircManager.getConnection(userId, networkId)!;
    expect(conn.snapshot().userhostBytes).toBe(real);
  });

  // A cloak or vhost applied AFTER we joined, announced only by 396 (no
  // CHGHOST): a budget left on the old, shorter host overflows every full line.
  it('follows a host change a 396 announces after we joined', async () => {
    const { networkId, nick, events } = await joined(plain);
    const user = plain.client(nick)!.user;
    const cloak = `${'c'.repeat(80)}.cloak`;

    plain.sendRaw(nick, `:fake.test 396 ${nick} ${cloak} :is now your displayed host`);
    const bytes = Buffer.byteLength(`~${user}@${cloak}`);
    await until(
      () => events.some((e) => e.type === 'line-budget' && e.userhostBytes === bytes),
      5000,
      'a line-budget frame for the cloak',
    );
    expect(ircManager.getConnection(userId, networkId)!.userhostBytes()).toBe(bytes);
  });

  // Our own echo carries our prefix exactly as the network relays it, so even a
  // connection in no channel learns it from its first line.
  it('learns our prefix from the echo of our own line', async () => {
    const nick = `budget${++seq}`;
    const network = createNetwork(userId, {
      name: `budget-${seq}`,
      host: '127.0.0.1',
      port: plain.port,
      tls: false,
      nick,
      autoconnect: false,
    })!;
    const events: Ev[] = [];
    const onEvent = (e: Ev) => {
      if (e.networkId === network.id) events.push(e);
    };
    ircManager.on('event', onEvent);
    const conn = ircManager.startNetwork(userId, network.id)!;
    cleanups.push(() => {
      ircManager.off('event', onEvent);
      conn.dispose();
      ircManager.connectionsForUser(userId).delete(network.id);
    });
    await until(() => conn.state === 'connected', 5000, 'connected');
    const real = Buffer.byteLength(`~${plain.client(nick)!.user}@fake.host`);
    expect(conn.userhostBytes()).not.toBe(real);

    ircManager.send(userId, network.id, nick, 'note to self');
    await until(() => conn.userhostBytes() === real, 5000, 'learned from the echo');
    expect(events.some((e) => e.type === 'line-budget' && e.userhostBytes === real)).toBe(true);
  });

  // Every PRIVMSG/NOTICE goes out through one writer, and a newline inside the
  // text must not end the command and start another: a /me body is never
  // pre-split on newlines, so it can carry one to the wire.
  it('writes one command per line, whatever the text carries', async () => {
    const { networkId, nick } = await joined(plain);
    const conn = ircManager.getConnection(userId, networkId)!;
    const before = plain.client(nick)!.sent.length;

    conn.action('#room', 'waves\r\nQUIT :untagged');
    conn.action('#room', 'nods\r\nQUIT :tagged', { '+draft/reply': 'm1' });
    conn.say('#room', 'hi\nQUIT :say');
    conn.notice('#room', 'psst\u0000\rQUIT :notice');
    await until(
      () => upstream(plain, nick, 'NOTICE', '#room').length >= 1,
      5000,
      'the lines upstream',
    );

    // Only our four lines and no injected command. ⚠ Not "exactly four lines
    // since the mark": the join's own MODE and WHO can still be on their way
    // out, and on a slow runner they land after it.
    const sent = plain
      .client(nick)!
      .sent.slice(before)
      .map((l) => ircLineParser(l));
    expect(sent.filter((m) => m?.command === 'QUIT')).toEqual([]);
    expect(
      sent
        .filter(
          (m) => m?.params[0] === '#room' && (m.command === 'PRIVMSG' || m.command === 'NOTICE'),
        )
        .map((m) => m!.command),
    ).toEqual(['PRIVMSG', 'PRIVMSG', 'PRIVMSG', 'NOTICE']);
    expect(conn.state).toBe('connected');
  });
});
