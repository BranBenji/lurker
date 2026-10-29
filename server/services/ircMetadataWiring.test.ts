// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// IRCv3 metadata (draft/metadata-2, #607) end to end against the fake ircd,
// which speaks it the way ergo does: a SUB draws a 770 and a `774 * *ALL`,
// the SYNC that asks for comes back as a `metadata` batch of 761s, and a
// peer's change arrives as a bare 761 or 766.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import { FakeIrcd, rawClient } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

type Ev = Record<string, unknown>;

let IrcConnection: typeof import('./ircConnection.js').IrcConnection;
let ircd: FakeIrcd;
let userId: number;
let seq = 0;

beforeAll(async () => {
  ({ IrcConnection } = await import('./ircConnection.js'));
  ircd = await FakeIrcd.start({ metadata: true });
  userId = createUser('metadata-wiring').id;
});

afterAll(async () => {
  await ircd.close();
});

afterEach(() => {
  delete process.env.LURKER_PREVIEWS_URL;
});

function makeNetwork(nick: string): Network {
  return createNetwork(userId, {
    name: `metadata-${seq++}`,
    host: '127.0.0.1',
    port: ircd.port,
    tls: false,
    nick,
    autoconnect: false,
  })!;
}

function connectDirect(nick: string) {
  const network = makeNetwork(nick);
  const events: Ev[] = [];
  const conn = new IrcConnection({ network, onEvent: (e) => events.push(e as Ev) });
  conn.connect();
  return { conn, events, network };
}

const userMeta = (events: Ev[], nick: string) =>
  events.filter((e) => e.type === 'user-metadata' && e.nick === nick);

type Snapshot = {
  userMetadata: Record<string, Record<string, unknown>>;
  channels: Array<{ name: string; metadata: Record<string, unknown> }>;
  metadataLimits: { maxSubs: number | null } | null;
};
const snap = (conn: InstanceType<typeof IrcConnection>) => conn.snapshot() as unknown as Snapshot;

describe('subscribing', () => {
  it('SUBs the keys it shows on registration and SYNCs when the server asks', async () => {
    const { conn, events } = connectDirect('subone');
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      const me = await ircd.waitForRegistration('subone');
      await until(
        () =>
          me.sent.some((l) => l === 'METADATA * SUB display-name avatar pronouns homepage status'),
        5000,
        'SUB sent',
        () => me.sent.join('\n'),
      );
      // The fake answers the SUB with ergo's 774 for *ALL.
      await until(() => me.sent.some((l) => l === 'METADATA *ALL SYNC'), 5000, 'SYNC sent');
      expect(snap(conn).metadataLimits).toEqual({
        maxSubs: 10,
        maxKeys: 10,
        maxValueBytes: 512,
        beforeConnect: false,
      });
      // Nothing of it reached the server buffer: 770 and 774 are acknowledgements.
      const serverLines = events.filter(
        (e) => e.type === 'motd' && String(e.text).match(/\b77[04]\b/),
      );
      expect(serverLines).toEqual([]);
    } finally {
      conn.disconnect();
    }
  });

  it('SUBs when the cap lands mid-session (a held socket, or a CAP NEW)', async () => {
    const plain = await FakeIrcd.start({});
    const network = createNetwork(userId, {
      name: `metadata-late-${seq++}`,
      host: '127.0.0.1',
      port: plain.port,
      tls: false,
      nick: 'latecap',
      autoconnect: false,
    })!;
    const conn = new IrcConnection({ network, onEvent: () => {} });
    try {
      conn.connect();
      await until(() => conn.state === 'connected', 5000, 'connected');
      const me = await plain.waitForRegistration('latecap');
      expect(me.sent.some((l) => l.startsWith('METADATA'))).toBe(false);
      // The server starts offering it. irc-framework REQs what it wants from
      // a CAP NEW; the fake doesn't list it, so ACK it by hand as a server
      // that just turned metadata on would.
      plain.inject('latecap', ':fake.server CAP latecap NEW :draft/metadata-2=max-subs=3');
      await until(() => me.sent.some((l) => l.startsWith('CAP REQ')), 5000, 'REQ');
      plain.inject('latecap', ':fake.server CAP latecap ACK :draft/metadata-2');
      await until(
        () => me.sent.some((l) => l === 'METADATA * SUB display-name avatar pronouns'),
        5000,
        'SUB after the late ACK, trimmed to max-subs',
        () => me.sent.join('\n'),
      );
    } finally {
      conn.disconnect();
      await plain.close();
    }
  });
});

describe("a peer's metadata", () => {
  it('lands in state and goes to clients as the whole record, keyed by nick', async () => {
    const { conn, events } = connectDirect('viewer');
    const peer = await rawClient(ircd.port, 'bob');
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      conn.join('#meta');
      peer.send('JOIN #meta');
      await until(() => conn.channelState('#meta')?.members.has('bob') ?? false, 5000, 'bob in');

      ircd.setMetadata('bob', 'display-name', 'Bob the Builder');
      await until(() => userMeta(events, 'bob').length >= 1, 5000, 'display-name');
      expect(userMeta(events, 'bob').at(-1)).toMatchObject({
        target: conn.serverTarget(),
        values: { displayName: 'Bob the Builder' },
      });

      // Previews off: the avatar is kept but not served, so the client is told
      // null and shows its generated tile instead.
      ircd.setMetadata('bob', 'avatar', 'https://example.org/bob/{size}.png');
      await until(() => userMeta(events, 'bob').length >= 2, 5000, 'avatar');
      expect(userMeta(events, 'bob').at(-1)!.values).toEqual({
        displayName: 'Bob the Builder',
        avatarUrl: null,
      });
      expect(snap(conn).userMetadata.bob).toEqual({
        displayName: 'Bob the Builder',
        avatarUrl: null,
      });

      // A key we don't subscribe to, or a value that fails vetting, changes nothing.
      const before = userMeta(events, 'bob').length;
      ircd.setMetadata('bob', 'homepage', 'javascript:alert(1)');
      ircd.setMetadata('bob', 'status', '');
      ircd.setMetadata('bob', 'pronouns', 'they/them');
      await until(() => userMeta(events, 'bob').length > before, 5000, 'pronouns');
      expect(userMeta(events, 'bob').length).toBe(before + 1);
      expect(userMeta(events, 'bob').at(-1)!.values).toEqual({
        displayName: 'Bob the Builder',
        avatarUrl: null,
        pronouns: 'they/them',
      });

      // Unset.
      ircd.setMetadata('bob', 'display-name', null);
      await until(
        () => !('displayName' in ((userMeta(events, 'bob').at(-1)!.values as object) ?? {})),
        5000,
        'display-name unset',
      );
      expect(snap(conn).userMetadata.bob).toEqual({ avatarUrl: null, pronouns: 'they/them' });
    } finally {
      peer.socket.destroy();
      conn.disconnect();
    }
  });

  it('serves the avatar through the avatar route when previews are on', async () => {
    process.env.LURKER_PREVIEWS_URL = 'http://decoder.invalid';
    const { conn, events } = connectDirect('proxyviewer');
    const peer = await rawClient(ircd.port, 'carol');
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      conn.join('#proxied');
      peer.send('JOIN #proxied');
      await until(() => conn.channelState('#proxied')?.members.has('carol') ?? false, 5000, 'in');
      ircd.setMetadata('carol', 'avatar', 'https://example.org/carol/{size}.png');
      await until(() => userMeta(events, 'carol').length >= 1, 5000, 'avatar');
      const url = String((userMeta(events, 'carol').at(-1)!.values as Ev).avatarUrl);
      expect(url).toMatch(/^\/api\/link-preview\/avatar\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      // Opaque to the client, and never the origin.
      expect(url).not.toContain('example.org');
      // The token names the sized URL.
      const payload = Buffer.from(url.split('/').at(-1)!.split('.')[0], 'base64url').toString();
      expect(payload).toBe('avatar:https://example.org/carol/256.png');
    } finally {
      peer.socket.destroy();
      conn.disconnect();
    }
  });

  it('comes with the SYNC for people already there, and rides a rename', async () => {
    const peer = await rawClient(ircd.port, 'dana');
    const { conn, events } = connectDirect('syncer');
    try {
      peer.send('JOIN #early');
      ircd.setMetadata('dana', 'display-name', 'Dana Scully');
      await until(() => conn.state === 'connected', 5000, 'connected');
      conn.join('#early');
      await until(() => conn.channelState('#early')?.members.has('dana') ?? false, 5000, 'in');
      // The join's SYNC isn't a thing on this fake (a JOIN carries no metadata
      // and the SUB's *ALL sync ran before we joined), so ask as a client would
      // after a 774 for the channel.
      ircd.inject('syncer', ':fake.server 774 * #early 0 :Try again later');
      await until(() => snap(conn).userMetadata.dana !== undefined, 5000, 'synced');
      expect(snap(conn).userMetadata.dana).toEqual({ displayName: 'Dana Scully' });

      peer.send('NICK dana2');
      await until(() => snap(conn).userMetadata.dana2 !== undefined, 5000, 'rekeyed');
      expect(snap(conn).userMetadata.dana).toBeUndefined();
      // The client is told to forget the old key and learns the new.
      expect(userMeta(events, 'dana').at(-1)!.values).toBeNull();
      expect(userMeta(events, 'dana2').at(-1)!.values).toEqual({ displayName: 'Dana Scully' });

      // Gone from every shared channel: forgotten, and said so.
      peer.send('QUIT :bye');
      await until(() => snap(conn).userMetadata.dana2 === undefined, 5000, 'forgotten');
      expect(userMeta(events, 'dana2').at(-1)!.values).toBeNull();
    } finally {
      peer.socket.destroy();
      conn.disconnect();
    }
  });

  it('asks for the record of someone who joins, and again after they sign off and on (#1246)', async () => {
    const { conn, events } = connectDirect('host');
    let peer = await rawClient(ircd.port, 'erin');
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      conn.join('#late');
      conn.join('#later');
      await until(() => conn.channelState('#later')?.members.has('host') ?? false, 5000, 'in');
      // Set before the join: the server tells the joiner about the room, not
      // the room about the joiner, so this reaches us only if we ask.
      ircd.setMetadata('erin', 'display-name', 'Erin');
      peer.send('JOIN #late');
      peer.send('JOIN #later');
      await until(() => snap(conn).userMetadata.erin !== undefined, 5000, 'learned');
      expect(snap(conn).userMetadata.erin).toEqual({ displayName: 'Erin' });
      const syncs = () => ircd.client('host')!.sent.filter((l) => l === 'METADATA erin SYNC');
      // The two joins were one query.
      expect(syncs()).toHaveLength(1);

      // Signed off: forgotten. Back on with a new record: learned afresh.
      peer.send('QUIT :brb');
      await until(() => snap(conn).userMetadata.erin === undefined, 5000, 'forgotten');
      peer.socket.destroy();
      peer = await rawClient(ircd.port, 'erin');
      ircd.setMetadata('erin', 'display-name', 'Erin again');
      peer.send('JOIN #late');
      await until(() => snap(conn).userMetadata.erin !== undefined, 5000, 'learned again');
      expect(snap(conn).userMetadata.erin).toEqual({ displayName: 'Erin again' });
      expect(userMeta(events, 'erin').at(-1)!.values).toEqual({ displayName: 'Erin again' });
      expect(syncs()).toHaveLength(2);

      // Gone again before the query goes: nothing is asked, so no record is
      // left behind to be taken for current on their next join.
      peer.send('PART #late');
      await until(() => !conn.channelState('#late')?.members.has('erin'), 5000, 'out');
      peer.send('JOIN #late');
      peer.send('PART #late');
      await until(() => snap(conn).userMetadata.erin === undefined, 5000, 'forgotten again');
      await new Promise((r) => setTimeout(r, 1500));
      expect(syncs()).toHaveLength(2);
    } finally {
      peer.socket.destroy();
      conn.disconnect();
    }
  });

  it('replaces what it held of a watched DM peer with their new session’s record', async () => {
    const { conn, events } = connectDirect('watcher');
    let peer = await rawClient(ircd.port, 'gail');
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      conn.join('#dm');
      await until(() => conn.channelState('#dm')?.members.has('watcher') ?? false, 5000, 'in');
      conn.trackDmPeer('gail');
      ircd.setMetadata('gail', 'display-name', 'Gail');
      ircd.setMetadata('gail', 'pronouns', 'she/her');
      peer.send('JOIN #dm');
      await until(() => snap(conn).userMetadata.gail?.pronouns !== undefined, 5000, 'learned');
      expect(snap(conn).userMetadata.gail).toEqual({ displayName: 'Gail', pronouns: 'she/her' });

      // A watched peer's record outlives their QUIT — the DM still shows it.
      peer.send('QUIT :bye');
      await until(() => !conn.channelState('#dm')?.members.has('gail'), 5000, 'gone');
      expect(snap(conn).userMetadata.gail).toEqual({ displayName: 'Gail', pronouns: 'she/her' });
      peer.socket.destroy();

      // Back with less: the sync's end drops what this session didn't set.
      ircd.metadata.delete('gail');
      peer = await rawClient(ircd.port, 'gail');
      ircd.setMetadata('gail', 'display-name', 'Gail II');
      peer.send('JOIN #dm');
      await until(() => snap(conn).userMetadata.gail?.pronouns === undefined, 5000, 'reconciled');
      expect(snap(conn).userMetadata.gail).toEqual({ displayName: 'Gail II' });
      expect(userMeta(events, 'gail').at(-1)!.values).toEqual({ displayName: 'Gail II' });
    } finally {
      peer.socket.destroy();
      conn.disconnect();
    }
  });

  it('follows a rename made before the join’s query went out', async () => {
    const { conn } = connectDirect('renamer');
    const peer = await rawClient(ircd.port, 'Guest42');
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      conn.join('#id');
      await until(() => conn.channelState('#id')?.members.has('renamer') ?? false, 5000, 'in');
      ircd.setMetadata('Guest42', 'display-name', 'Hal');
      peer.send('JOIN #id');
      peer.send('NICK hal');
      await until(() => snap(conn).userMetadata.hal !== undefined, 5000, 'learned as hal');
      expect(snap(conn).userMetadata.hal).toEqual({ displayName: 'Hal' });
      const sent = ircd.client('renamer')!.sent.filter((l) => /^METADATA \S+ SYNC$/.test(l));
      expect(sent.filter((l) => l !== 'METADATA *ALL SYNC')).toEqual(['METADATA hal SYNC']);
    } finally {
      peer.socket.destroy();
      conn.disconnect();
    }
  });

  it('keeps a channel’s own record beside its members', async () => {
    const { conn, events } = connectDirect('chanviewer');
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      conn.join('#named');
      await until(() => conn.isChannelJoined('#named'), 5000, 'joined');
      ircd.setMetadata('#named', 'display-name', 'The Named');
      await until(() => events.some((e) => e.type === 'channel-metadata'), 5000, 'frame');
      expect(events.find((e) => e.type === 'channel-metadata')).toMatchObject({
        target: '#named',
        values: { displayName: 'The Named' },
      });
      expect(snap(conn).channels.find((c) => c.name === '#named')!.metadata).toEqual({
        displayName: 'The Named',
      });
    } finally {
      conn.disconnect();
    }
  });
});

describe("the user's own commands", () => {
  it('echoes a SET, a LIST and a FAIL where a /command replies, and nothing else', async () => {
    const { conn, events } = connectDirect('setter');
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      const me = await ircd.waitForRegistration('setter');
      await until(() => me.sent.some((l) => l === 'METADATA *ALL SYNC'), 5000, 'settled');
      const serverLines = () =>
        events
          .filter(
            (e) => (e.type === 'notice' || e.type === 'error') && e.target === conn.serverTarget(),
          )
          .map((e) => String(e.text));

      conn.raw('METADATA * SET display-name :The Setter');
      await until(() => serverLines().some((t) => t.includes('display-name')), 5000, 'echo');
      expect(serverLines().at(-1)).toBe('setter display-name: The Setter');
      // Our own record, under our own nick.
      expect(snap(conn).userMetadata.setter).toEqual({ displayName: 'The Setter' });

      conn.raw('METADATA * LIST');
      await until(() => serverLines().length >= 2, 5000, 'list echo');
      expect(serverLines().at(-1)).toBe('setter display-name: The Setter');

      conn.raw('METADATA * SET Bad%Key :x');
      await until(() => serverLines().some((t) => t.startsWith('Metadata:')), 5000, 'fail');
      expect(serverLines().at(-1)).toBe('Metadata: Invalid key name (INVALID_KEY)');
      // The SUB's sync and the SET's own 761 never printed as raw numerics.
      expect(events.filter((e) => e.type === 'motd' && /\b76[16]\b/.test(String(e.text)))).toEqual(
        [],
      );
    } finally {
      conn.disconnect();
    }
  });
});
