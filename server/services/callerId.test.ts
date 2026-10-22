// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Caller ID (#206): +g on solanum (Libera), hybrid (OFTC) and InspIRCd. A
// message to someone in +g who hasn't accepted you is discarded, and under
// echo-message never echoed, so all the user saw was a raw 716 in the server
// buffer. Lines go in through irc-framework the way a socket's do, so both
// the 'raw' handler and the parsed 'unknown command' see them.

// MUST be first: points DATABASE_PATH at a throwaway file before the imports
// below open the database.
import '../test-utils/isolateDb.js';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { IrcConnection, dmRefusalReason, parseCallerIdNotice } from './ircConnection.js';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import { ensureExists } from '../db/buffers.js';
import { favoriteBuffer } from '../db/favoriteBuffers.js';
import ignoreRulesService from './ignoreRulesService.js';
import { stubCtcpRequest } from '../test-utils/ctcpStub.js';

let userId: number;

beforeAll(() => {
  userId = createUser('callerid-test').id;
});

let seq = 0;
function makeConn() {
  const network = createNetwork(userId, {
    name: `n${++seq}`,
    host: 'irc.example.test',
    port: 6697,
    tls: 1,
    trusted_certificates: 1,
    nick: 'nick',
    username: null,
    realname: null,
    server_password: null,
    autoconnect: 0,
    sasl_account: null,
    sasl_password: null,
    connect_commands: null,
  })!;
  const conn = new IrcConnection({ network, onEvent: () => {} });
  conn.client.raw = vi.fn<(line: string) => void>();
  conn.client.say = vi.fn<(target: string, message: string) => void>();
  const publish = vi.fn<(event: Record<string, unknown>) => void>();
  const publishEphemeral = vi.fn<(event: Record<string, unknown>) => void>();
  const logNet = vi.fn<(text: string) => void>();
  conn.publish = publish;
  conn.publishEphemeral = publishEphemeral;
  conn.logNet = logNet;
  const read = (line: string) => conn.client.connection.addReadBuffer(line);
  return { conn, network, publish, publishEphemeral, logNet, read };
}

const TARGUMODEG =
  ':irc.example.test 716 nick alice :is in +g mode and must manually allow you to message them. Your message was discarded.';
const TARGNOTIFY = ':irc.example.test 717 nick alice :has been informed that you messaged them.';

describe('a message the recipient’s caller ID refused', () => {
  it('says so in the DM, and that they were told', () => {
    const { conn, publish, read } = makeConn();
    conn.say('alice', 'hi');
    read(TARGUMODEG);
    read(TARGNOTIFY);

    const dm = publish.mock.calls.map(([e]) => e).filter((e) => e.target === 'alice');
    expect(dm).toEqual([
      expect.objectContaining({
        type: 'error',
        text: "Message not delivered — alice has caller ID on and hasn't accepted you.",
      }),
      expect.objectContaining({ type: 'motd', text: 'alice was told you tried to message them.' }),
    ]);
  });

  it('puts nothing in the DM for a 716 the user didn’t send — a typing TAGMSG’s', () => {
    const { conn, publish, read } = makeConn();
    read(TARGUMODEG);
    read(TARGNOTIFY);

    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ target: 'alice' }));
    // …but typing to them stops, or every keystroke draws another 716.
    expect(conn.unsendableTargets.has('alice')).toBe(true);
  });

  it('reports a /ctcp’s 716 where the /ctcp was typed, with no DM line', () => {
    const { conn, publish, publishEphemeral, read } = makeConn();
    conn.upsertChannel('#anime');
    stubCtcpRequest(conn, vi.fn<(target: string, type: string, payload?: string) => void>());
    conn.sendCtcpRequest('#anime', 'alice', 'VERSION', '');
    publishEphemeral.mockClear(); // the request's own echo
    read(TARGUMODEG);
    read(TARGNOTIFY);

    expect(publishEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ctcp',
        target: '#anime',
        text: "Message not delivered — alice has caller ID on and hasn't accepted you.",
      }),
    );
    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ target: 'alice' }));
  });

  it('takes 486 (+R, not identified) in the server’s own words', () => {
    const { conn, publish, read } = makeConn();
    conn.say('alice', 'hi');
    read(
      ':irc.example.test 486 nick alice :You must log into your NickServ account to message this user',
    );

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        target: 'alice',
        text: 'Message not delivered — You must log into your NickServ account to message this user',
      }),
    );
  });

  it('explains 494: our own +g with a full accept list', () => {
    const { conn, publish, read } = makeConn();
    conn.say('alice', 'hi');
    read(
      ':irc.example.test 494 nick alice :cannot answer you while you are +g, your message was not sent',
    );

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        target: 'alice',
        text: "Message not delivered — you have caller ID on and your accept list is full, so alice couldn't be added to answer you.",
      }),
    );
  });

  it('lets typing back on once they message us', () => {
    const { conn, read } = makeConn();
    read(TARGUMODEG);
    expect(conn.unsendableTargets.has('alice')).toBe(true);
    read(':alice!a@example.test PRIVMSG nick :ok, you are accepted');
    expect(conn.unsendableTargets.has('alice')).toBe(false);
  });

  it('keeps typing off after a NOTICE from them, which accepts nobody', () => {
    const { conn, read } = makeConn();
    read(TARGUMODEG);
    read(':alice!a@example.test NOTICE nick :I am away');
    expect(conn.unsendableTargets.has('alice')).toBe(true);
  });

  it('doesn’t take a 486 that names nobody for a nick', () => {
    const { conn, publish, read } = makeConn();
    conn.say('bob', 'hi');
    read(
      ':irc.example.test 486 nick :You must identify to a registered nick to private message bob',
    );
    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(conn.unsendableTargets.size).toBe(0);
  });

  it('leaves a channel-targeted 486 alone', () => {
    expect(dmRefusalReason('486', '#chan', 'x')).toBe('x');
    const { conn, publish, read } = makeConn();
    conn.say('#chan', 'hi');
    read(':irc.example.test 486 nick #chan :You must be authed');
    expect(publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', target: '#chan' }),
    );
  });
});

const UMODEGMSG =
  ':irc.example.test 718 nick bob bob@example.test :is messaging you, and you have umode +g. The message was discarded.';

describe('someone our caller ID turned away (718)', () => {
  it('raises a toast and a system-buffer line, not a raw server-buffer line', () => {
    const { network, publish, publishEphemeral, logNet, read } = makeConn();
    read(UMODEGMSG);

    expect(publishEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'callerid-blocked',
        target: `:server:${network.id}`,
        from: 'bob',
        userhost: 'bob!bob@example.test',
      }),
    );
    expect(logNet).toHaveBeenCalledWith(
      'bob (bob@example.test) tried to message you; caller ID blocked it.',
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it('says nothing about someone the user ignores', () => {
    const { network, publishEphemeral, logNet, read } = makeConn();
    ignoreRulesService.add(userId, network.id, {
      mask: 'bob!*@*',
      channels: null,
      pattern: null,
      patternKind: 'substr',
      levels: ['ALL'],
      isExcept: false,
      expiresAt: null,
    });
    read(UMODEGMSG);

    expect(publishEphemeral).not.toHaveBeenCalled();
    expect(logNet).not.toHaveBeenCalled();
  });

  it('says nothing about someone ignored by host', () => {
    const { network, publishEphemeral, logNet, read } = makeConn();
    ignoreRulesService.add(userId, network.id, {
      mask: '*!*@example.test',
      channels: null,
      pattern: null,
      patternKind: 'substr',
      levels: ['ALL'],
      isExcept: false,
      expiresAt: null,
    });
    read(UMODEGMSG);

    expect(publishEphemeral).not.toHaveBeenCalled();
    expect(logNet).not.toHaveBeenCalled();
  });

  it('keeps the record but raises no toast for a NONOTIFY nick', () => {
    const { network, publishEphemeral, logNet, read } = makeConn();
    ignoreRulesService.add(userId, network.id, {
      mask: 'bob!*@*',
      channels: null,
      pattern: null,
      patternKind: 'substr',
      levels: ['NONOTIFY'],
      isExcept: false,
      expiresAt: null,
    });
    read(UMODEGMSG);

    expect(publishEphemeral).not.toHaveBeenCalled();
    expect(logNet).toHaveBeenCalledTimes(1);
  });

  it('reads both wire shapes', () => {
    expect(parseCallerIdNotice(['me', 'bob', 'b@h', 'is messaging you'])).toEqual({
      nick: 'bob',
      userhost: 'b@h',
    });
    // hybrid
    expect(parseCallerIdNotice(['me', 'bob[b@h]', 'is messaging you'])).toEqual({
      nick: 'bob',
      userhost: 'b@h',
    });
    // …with brackets in the nick itself
    expect(parseCallerIdNotice(['me', 'foo[m][f@h]', 'is messaging you'])).toEqual({
      nick: 'foo[m]',
      userhost: 'f@h',
    });
    expect(parseCallerIdNotice(['me'])).toBeNull();
  });
});

describe('the accept list (/accept with no argument)', () => {
  // A network with caller ID says so in ISUPPORT.
  function makeCallerIdConn() {
    const made = makeConn();
    made.read(':irc.example.test 005 nick CALLERID=g :are supported by this server');
    made.publish.mockClear();
    return made;
  }
  const notices = (publish: ReturnType<typeof makeConn>['publish']) =>
    publish.mock.calls.map(([e]) => e).filter((e) => String(e.target).startsWith(':server:'));

  it('says solanum’s one 281 as one line', () => {
    const { publish, read } = makeCallerIdConn();
    read(':irc.example.test 281 nick alice bob');
    read(':irc.example.test 282 nick :End of /ACCEPT list.');
    expect(notices(publish)).toEqual([
      expect.objectContaining({ type: 'notice', text: 'Accept list: alice, bob' }),
    ]);
  });

  it('collects InspIRCd’s 281 per nick into one line', () => {
    const { publish, read } = makeCallerIdConn();
    read(':irc.example.test 281 nick :alice');
    read(':irc.example.test 281 nick :bob');
    read(':irc.example.test 282 nick :End of ACCEPT list');
    expect(notices(publish)).toEqual([
      expect.objectContaining({ type: 'notice', text: 'Accept list: alice, bob' }),
    ]);
  });

  it('says an empty list is empty', () => {
    const { publish, read } = makeCallerIdConn();
    read(':irc.example.test 282 nick :End of /ACCEPT list.');
    expect(notices(publish)).toEqual([
      expect.objectContaining({ type: 'notice', text: 'Your accept list is empty.' }),
    ]);
  });

  it('starts each listing fresh', () => {
    const { publish, read } = makeCallerIdConn();
    read(':irc.example.test 281 nick alice');
    read(':irc.example.test 282 nick :End of /ACCEPT list.');
    read(':irc.example.test 282 nick :End of /ACCEPT list.');
    expect(notices(publish).map((e) => e.text)).toEqual([
      'Accept list: alice',
      'Your accept list is empty.',
    ]);
  });

  it('leaves 281 and 282 verbatim where there is no caller ID — ircu’s G-line and jupe replies', () => {
    const { publish, read } = makeConn();
    read(':irc.example.test 281 nick :End of G-line List');
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'motd', text: 'End of G-line List' }),
    );
    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'notice' }));
  });
});

describe('friends get through caller ID (#1181)', () => {
  // A connected socket on a network with caller ID, where bob is a friend (a
  // favorited DM) and carol is only an open DM.
  function makeFriendConn({ callerId = true } = {}) {
    const made = makeConn();
    const { conn, network, read } = made;
    if (callerId) read(':irc.example.test 005 nick CALLERID=g :are supported by this server');
    conn.state = 'connected';
    for (const nick of ['bob', 'carol']) {
      ensureExists(userId, network.id, nick);
      conn.trackDmPeer(nick);
    }
    favoriteBuffer(userId, network.id, 'bob');
    made.publish.mockClear();
    return made;
  }
  const accepts = (conn: IrcConnection) =>
    vi
      .mocked(conn.client.raw)
      .mock.calls.map(([line]) => line)
      .filter((line) => String(line).startsWith('ACCEPT'));

  it('accepts a friend once when they’re seen online', () => {
    const { conn, read } = makeFriendConn();
    read(':irc.example.test 730 nick :bob!b@example.test,carol!c@example.test');
    read(':bob!b@example.test PRIVMSG nick :hi');
    expect(accepts(conn)).toEqual(['ACCEPT bob']);
  });

  it('accepts them again after they’ve been offline, when the server forgot them', () => {
    const { conn, read } = makeFriendConn();
    read(':irc.example.test 730 nick :bob!b@example.test');
    read(':irc.example.test 731 nick :bob');
    read(':irc.example.test 730 nick :bob!b@example.test');
    expect(accepts(conn)).toEqual(['ACCEPT bob', 'ACCEPT bob']);
  });

  it('starts over on a new socket, which has an empty list with room in it', () => {
    const { conn, read } = makeFriendConn();
    read(':irc.example.test 730 nick :bob!b@example.test');
    read(':irc.example.test 456 nick :Accept list is full');
    conn.client.emit('socket close');
    conn.state = 'connected';
    read(':irc.example.test 730 nick :bob!b@example.test');
    expect(accepts(conn)).toEqual(['ACCEPT bob', 'ACCEPT bob']);
  });

  it('accepts nobody where the network has no caller ID', () => {
    const { conn, read } = makeFriendConn({ callerId: false });
    read(':irc.example.test 730 nick :bob!b@example.test');
    expect(accepts(conn)).toEqual([]);
  });

  it('accepts nobody while not connected', () => {
    const { conn, read } = makeFriendConn();
    conn.state = 'disconnected';
    read(':irc.example.test 730 nick :bob!b@example.test');
    expect(accepts(conn)).toEqual([]);
  });

  it('says nothing when a friend was on the list already, and passes other 457s through', () => {
    const { conn, publish, read } = makeFriendConn();
    read(':irc.example.test 730 nick :bob!b@example.test');
    read(':irc.example.test 457 nick bob :is already on your accept list');
    expect(publish).not.toHaveBeenCalled();
    read(':irc.example.test 457 nick carol :is already on your accept list');
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('carol') }),
    );
    expect(accepts(conn)).toEqual(['ACCEPT bob']);
  });

  it('stops accepting once the server says the list is full', () => {
    const { conn, network, read } = makeFriendConn();
    ensureExists(userId, network.id, 'dave');
    conn.trackDmPeer('dave');
    favoriteBuffer(userId, network.id, 'dave');
    read(':irc.example.test 456 nick :Accept list is full');
    read(':irc.example.test 730 nick :bob!b@example.test,dave!d@example.test');
    expect(accepts(conn)).toEqual([]);
  });

  it('takes being seen away as being seen online', () => {
    const { conn, read } = makeFriendConn();
    read(':bob!b@example.test AWAY :lunch');
    expect(accepts(conn)).toEqual(['ACCEPT bob']);
  });

  it('accepts a friend again under their new nick', () => {
    const { conn, read } = makeFriendConn();
    read(':irc.example.test 730 nick :bob!b@example.test');
    read(':bob!b@example.test NICK bobby');
    expect(accepts(conn)).toEqual(['ACCEPT bob', 'ACCEPT bobby']);
  });

  it('weighs a peer once per sighting, not on every line from them', () => {
    const { conn, network, read } = makeFriendConn();
    read(':irc.example.test 730 nick :carol!c@example.test');
    // Made a friend behind the connection's back: only acceptFriendIfOnline,
    // which favorite-buffer calls, or a fresh sighting picks that up.
    favoriteBuffer(userId, network.id, 'carol');
    read(':carol!c@example.test PRIVMSG nick :hi');
    expect(accepts(conn)).toEqual([]);
    read(':irc.example.test 731 nick :carol');
    read(':irc.example.test 730 nick :carol!c@example.test');
    expect(accepts(conn)).toEqual(['ACCEPT carol']);
  });

  it('matches the server’s spelling of a nick by the network’s case rules', () => {
    const { conn, network, publish, read } = makeFriendConn();
    read(':irc.example.test 005 nick CASEMAPPING=rfc1459 :are supported by this server');
    publish.mockClear();
    ensureExists(userId, network.id, 'foo[m]');
    conn.trackDmPeer('foo[m]');
    favoriteBuffer(userId, network.id, 'foo[m]');
    read(':irc.example.test 730 nick :foo[m]!f@example.test');
    read(':irc.example.test 457 nick FOO[M] :is already on your accept list');
    expect(accepts(conn)).toEqual(['ACCEPT foo[m]']);
    expect(publish).not.toHaveBeenCalled();
  });

  it('takes back only the ACCEPTs it sent when a friend is removed', () => {
    const { conn, read } = makeFriendConn();
    read(':irc.example.test 730 nick :bob!b@example.test');
    conn.unacceptFriend('bob');
    conn.unacceptFriend('carol');
    expect(accepts(conn)).toEqual(['ACCEPT bob', 'ACCEPT -bob']);
  });

  it('accepts a friend added after coming back from away', () => {
    const { conn, network, read } = makeFriendConn();
    read(':irc.example.test 730 nick :carol!c@example.test');
    read(':carol!c@example.test AWAY :lunch');
    read(':carol!c@example.test AWAY');
    favoriteBuffer(userId, network.id, 'carol');
    conn.acceptFriendIfOnline('carol');
    expect(accepts(conn)).toEqual(['ACCEPT carol']);
  });

  it('accepts a friend added while they’re online, and not one who’s offline', () => {
    const { conn, network, read } = makeFriendConn();
    read(':irc.example.test 730 nick :carol!c@example.test');
    expect(accepts(conn)).toEqual([]);
    favoriteBuffer(userId, network.id, 'carol');
    conn.acceptFriendIfOnline('carol');
    expect(accepts(conn)).toEqual(['ACCEPT carol']);

    ensureExists(userId, network.id, 'erin');
    conn.trackDmPeer('erin');
    read(':irc.example.test 731 nick :erin');
    favoriteBuffer(userId, network.id, 'erin');
    conn.acceptFriendIfOnline('erin');
    expect(accepts(conn)).toEqual(['ACCEPT carol']);
  });
});
