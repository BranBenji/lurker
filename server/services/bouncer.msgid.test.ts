// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A message keeps the network's msgid everywhere an attached client sees it:
// live, as the echo of a message the user sent, and from CHATHISTORY. Against a
// real IrcConnection on the fake ircd, with the real bouncer in front of it. See
// bouncerHarness.ts.

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

const ctx = setupTestDb('services-bouncer-msgid');

let harnessMod: typeof import('../test-utils/bouncerHarness.js');
let bouncerMod: typeof import('./bouncer.js');
let ircManager: typeof import('./ircManager.js').default;
let users: typeof import('../db/users.js');
let networks: typeof import('../db/networks.js');
let hashPassword: typeof import('./password.js').hashPassword;
let messages: typeof import('../db/messages.js');
let e2eManager: typeof import('./e2e/manager.js').e2eManager;
let ignoreRulesService: typeof import('./ignoreRulesService.js').default;
let maskToRuleInput: typeof import('./ignoreRuleInput.js').maskToRuleInput;
let harness: import('../test-utils/bouncerHarness.js').Harness;
let ircd: FakeIrcd;

type Client = Awaited<ReturnType<import('../test-utils/bouncerHarness.js').Harness['connect']>>;
type Event = Record<string, unknown>;

interface Live {
  userId: number;
  username: string;
  networkId: number;
  password: string;
  nick: string;
  events: Event[];
}

beforeAll(async () => {
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  harnessMod = await import('../test-utils/bouncerHarness.js');
  bouncerMod = await import('./bouncer.js');
  ircManager = (await import('./ircManager.js')).default;
  users = await import('../db/users.js');
  networks = await import('../db/networks.js');
  ({ hashPassword } = await import('./password.js'));
  messages = await import('../db/messages.js');
  ({ e2eManager } = await import('./e2e/manager.js'));
  ignoreRulesService = (await import('./ignoreRulesService.js')).default;
  ({ maskToRuleInput } = await import('./ignoreRuleInput.js'));
  ircd = await FakeIrcd.start();
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
});

let seq = 0;

// A user whose network is a real IrcConnection, registered on the fake ircd.
async function seedLive(): Promise<Live> {
  seq += 1;
  const password = 'hunter2hunter2';
  const user = users.createUser(`msgid_${seq}`);
  users.setPasswordHash(user.id, hashPassword(password));
  const network = networks.createNetwork(user.id, {
    name: 'fake',
    host: '127.0.0.1',
    port: ircd.port,
    tls: false,
    nick: `lurk${seq}`,
    autoconnect: false,
  } as Parameters<typeof networks.createNetwork>[1])!;
  const events: Event[] = [];
  const listener = (event: Event) => {
    if (event.networkId === network.id) events.push(event);
  };
  ircManager.on('event', listener);
  const conn = ircManager.startNetwork(user.id, network.id)!;
  cleanups.push(() => {
    ircManager.off('event', listener);
    conn.dispose();
    ircManager.connectionsForUser(user.id).delete(network.id);
  });
  await until(() => conn.state === 'connected', 5000, 'connected');
  return {
    userId: user.id,
    username: user.username,
    networkId: network.id,
    password,
    nick: network.nick,
    events,
  };
}

const NUL = String.fromCharCode(0);
const CAPS = 'sasl batch server-time message-tags echo-message draft/chathistory';

// Attach, then join `channel` from the client.
async function attachIn(live: Live, channel: string): Promise<Client> {
  const c = await harness.connect();
  cleanups.push(() => c.close());
  c.send('CAP LS 302');
  await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
  c.send('NICK client');
  c.send('USER client 0 * :client');
  c.send(`CAP REQ :${CAPS}`);
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

function msgidOf(line: string): string | undefined {
  if (!line.startsWith('@')) return undefined;
  const tag = line
    .slice(1, line.indexOf(' '))
    .split(';')
    .find((t) => t.startsWith('msgid='));
  return tag?.slice('msgid='.length);
}

// The stored copy of a message, once the connection has published it.
async function stored(live: Live, text: string): Promise<Event> {
  await until(
    () => live.events.some((e) => e.text === text && e.id != null),
    5000,
    `stored: ${text}`,
  );
  return live.events.find((e) => e.text === text && e.id != null)!;
}

// The line CHATHISTORY returns for `text`.
async function fromHistory(c: Client, channel: string, text: string): Promise<string> {
  c.send(`CHATHISTORY LATEST ${channel} * 50`);
  return c.waitFor((l) => l.includes('batch=') && l.includes(`PRIVMSG ${channel} :${text}`));
}

describe('network msgids', () => {
  it("a peer's message has the network's msgid live and from history", async () => {
    const live = await seedLive();
    const c = await attachIn(live, '#room');
    const msgid = ircd.say('bob', '#room', 'hello there');
    const relayed = await c.waitFor((l) => l.includes('PRIVMSG #room :hello there'));
    expect(msgidOf(relayed)).toBe(msgid);
    await stored(live, 'hello there');
    expect(msgidOf(await fromHistory(c, '#room', 'hello there'))).toBe(msgid);
  });

  it("the client's own message has the network's msgid in its echo and from history", async () => {
    const live = await seedLive();
    const c = await attachIn(live, '#room');
    c.send('PRIVMSG #room :my own words');
    const echo = await c.waitFor((l) => l.includes('PRIVMSG #room :my own words'));
    const row = await stored(live, 'my own words');
    // The row took the network's msgid from its echo (echo-message).
    expect(String(row.msgid)).toMatch(/^m[0-9]+$/);
    expect(msgidOf(echo)).toBe(row.msgid);
    expect(msgidOf(await fromHistory(c, '#room', 'my own words'))).toBe(row.msgid);
  });

  it("a message sent from the web app reaches the client with the network's msgid", async () => {
    const live = await seedLive();
    const c = await attachIn(live, '#room');
    ircManager.send(live.userId, live.networkId, '#room', 'from the web');
    const echo = await c.waitFor((l) => l.includes('PRIVMSG #room :from the web'));
    const row = await stored(live, 'from the web');
    expect(String(row.msgid)).toMatch(/^m[0-9]+$/);
    expect(msgidOf(echo)).toBe(row.msgid);
  });

  // The network's echo carries the tags, but the bouncer drops it for the copy it
  // writes itself — which has to say it's a reply too, or the client shows it
  // threaded only once it reads the line back from CHATHISTORY.
  it('a reply sent from the web app reaches the client as a reply', async () => {
    const live = await seedLive();
    const c = await attachIn(live, '#room');
    const parentMsgid = ircd.say('bob', '#room', 'who broke the build?');
    const parent = await stored(live, 'who broke the build?');
    ircManager.send(live.userId, live.networkId, '#room', 'bob: not me', {
      replyTo: Number(parent.id),
    });
    const echo = await c.waitFor((l) => l.includes('PRIVMSG #room :bob: not me'));
    const tags = echo.slice(1, echo.indexOf(' ')).split(';');
    expect(tags).toContain(`+reply=${parentMsgid}`);
    expect(tags).toContain(`+draft/reply=${parentMsgid}`);

    ircManager.action(live.userId, live.networkId, '#room', 'shrugs', {
      replyTo: Number(parent.id),
    });
    const action = await c.waitFor((l) => l.includes('PRIVMSG #room :\u0001ACTION shrugs'));
    expect(action).toContain(`+reply=${parentMsgid}`);

    // A plain line stays plain.
    ircManager.send(live.userId, live.networkId, '#room', 'unrelated');
    const plain = await c.waitFor((l) => l.includes('PRIVMSG #room :unrelated'));
    expect(plain).not.toContain('reply=');
  });
});

// A client's reaction takes the web app's road (ircManager.react), so it meets
// the same rules: the line must be one we hold, and neither it nor its channel
// end-to-end encrypted — a reaction is a cleartext tag naming the line.
describe('reactions from an attached client', () => {
  const reactionSent = (l: string) => l.includes('TAGMSG') && l.includes('+draft/react=');

  it('go to the network as the web app sends them, and are recorded from the echo', async () => {
    const live = await seedLive();
    const c = await attachIn(live, '#room');
    const msgid = ircd.say('bob', '#room', 'ship it?');
    await stored(live, 'ship it?');
    // Only the draft reply name, a value with an escaped space, the channel in
    // another case: what goes out is the web app's line all the same.
    c.send(`@+draft/reply=${msgid};+draft/react=lol\\sok TAGMSG #ROOM`);
    const sent = await ircd.waitForLine((l, from) => from.nick === live.nick && reactionSent(l));
    expect(sent).toContain(' TAGMSG #room');
    expect(sent).toContain(`+reply=${msgid}`);
    expect(sent).toContain(`+draft/reply=${msgid}`);
    expect(sent).toContain('+draft/react=lol\\sok');
    await until(
      () => live.events.some((e) => e.type === 'reaction' && e.value === 'lol ok' && e.self),
      5000,
      'reaction recorded',
    );
  });

  it('are refused for a line we do not hold, on an E2E channel, and on an encrypted line', async () => {
    const live = await seedLive();
    const c = await attachIn(live, '#room');
    const msgid = ircd.say('bob', '#room', 'ship it?');
    await stored(live, 'ship it?');
    // ⚠ waitFor matches lines already received: count the notices instead, so
    // each refusal has to earn its own.
    const notices = () => c.lines.filter((l) => l.includes('Reaction not sent to')).length;
    const refused = async (line: string, target: string) => {
      const before = notices();
      c.send(line);
      await until(() => notices() > before, 2000, `refused: ${line}`);
      expect(c.lines.filter((l) => l.includes('Reaction not sent to')).at(-1)).toContain(
        `Reaction not sent to ${target}`,
      );
    };

    await refused('@+draft/reply=nope;+draft/react=👍 TAGMSG #room', '#room');
    // "MUST NOT both be attached": no telling which was meant.
    await refused(`@+draft/reply=${msgid};+draft/react=👍;+draft/unreact=👍 TAGMSG #room`, '#room');
    // A target list names no buffer, so no line either.
    await refused(`@+draft/reply=${msgid};+draft/react=👍 TAGMSG #room,#other`, '#room,#other');

    const spy = vi.spyOn(e2eManager, 'isChannelEnabled').mockReturnValue(true);
    try {
      await refused(`@+draft/reply=${msgid};+draft/react=👍 TAGMSG #room`, '#room');
    } finally {
      spy.mockRestore();
    }

    // A DM line that arrived encrypted: no channel to be E2E, the line itself is.
    messages.insertMessage({
      networkId: live.networkId,
      target: 'bob',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'bob',
      text: 'psst',
      msgid: 'e2e-line',
      extra: { e2e: true },
    });
    await refused('@+draft/reply=e2e-line;+draft/react=👍 TAGMSG bob', 'bob');

    // Nothing reached the network: a line sent after them has, and they haven't.
    c.send('PRIVMSG #room :barrier line');
    await ircd.waitForLine((l) => l.includes('PRIVMSG #room :barrier line'));
    await expect(
      ircd.waitForLine((l, from) => from.nick === live.nick && reactionSent(l), 50),
    ).rejects.toThrow('timed out');
  });
});

// #483: a client's reply goes the web app's way (ircManager.send's replyTo), so
// the network gets the tags it allows, the account stores a reply, and every
// client — the web app and the other attached ones — sees one.
describe('replies from an attached client', () => {
  const tagsOf = (line: string) => (line.startsWith('@') ? line.slice(1, line.indexOf(' ')) : '');

  it('go to the network, the account and the other clients as replies', async () => {
    const live = await seedLive();
    const c = await attachIn(live, '#room');
    const other = await attachIn(live, '#room');
    const parentMsgid = ircd.say('bob', '#room', 'who broke the build?');
    await stored(live, 'who broke the build?');

    // Only the draft name, as HexDroid sends it: both go out all the same.
    c.send(`@+draft/reply=${parentMsgid} PRIVMSG #room :bob: not me`);
    const sent = await ircd.waitForLine(
      (l, from) => from.nick === live.nick && l.includes('PRIVMSG #room :bob: not me'),
    );
    expect(tagsOf(sent).split(';')).toEqual(
      expect.arrayContaining([`+reply=${parentMsgid}`, `+draft/reply=${parentMsgid}`]),
    );
    const row = await stored(live, 'bob: not me');
    expect(row.replyTo).toMatchObject({ msgid: parentMsgid, parent: { nick: 'bob' } });
    const echoed = await other.waitFor((l) => l.includes('PRIVMSG #room :bob: not me'));
    expect(tagsOf(echoed)).toContain(`+reply=${parentMsgid}`);
    // The sender asked for echo-message: its own copy says so too.
    const own = await c.waitFor((l) => l.includes('PRIVMSG #room :bob: not me'));
    expect(tagsOf(own)).toContain(`+reply=${parentMsgid}`);

    c.send(`@+reply=${parentMsgid} PRIVMSG #room :\u0001ACTION shrugs\u0001`);
    const action = await ircd.waitForLine(
      (l, from) => from.nick === live.nick && l.includes('ACTION shrugs'),
    );
    expect(tagsOf(action)).toContain(`+reply=${parentMsgid}`);
  });

  it('go out as plain lines when the account could not show what they answer', async () => {
    const live = await seedLive();
    const c = await attachIn(live, '#room');
    const elsewhere = ircd.say('bob', live.nick, 'a line in our DM');
    await stored(live, 'a line in our DM');
    const added = ignoreRulesService.add(
      live.userId,
      live.networkId,
      maskToRuleInput('mallory!*@*')!,
    );
    expect(added.ok).toBe(true);
    const ignored = ircd.say('mallory', '#room', 'spam');
    await stored(live, 'spam');

    // Nothing by that msgid, one from another buffer, a line from someone
    // ignored (its quote would read "unavailable"), and a NOTICE (the web app
    // has no notice reply): all plain.
    c.send('@+reply=nope PRIVMSG #room :unknown: hello');
    c.send(`@+reply=${elsewhere} PRIVMSG #room :bob: wrong room`);
    c.send(`@+reply=${ignored} PRIVMSG #room :mallory: no`);
    c.send(`@+reply=${ignored} NOTICE #room :mallory: still no`);
    for (const text of ['unknown: hello', 'bob: wrong room', 'mallory: no', 'mallory: still no']) {
      const sent = await ircd.waitForLine(
        (l, from) => from.nick === live.nick && l.includes(` #room :${text}`),
      );
      expect(tagsOf(sent)).not.toContain('reply=');
      expect((await stored(live, text)).replyTo).toBeUndefined();
    }
  });
});
