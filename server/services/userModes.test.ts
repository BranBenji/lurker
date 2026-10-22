// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// User modes across reconnects (#1181). A user mode lasts as long as the
// socket, so someone who set +g lost it on the next reconnect without being
// told. Lurker remembers what the user asked for with `MODE <own nick> …`, the
// way irssi keeps its wanted_usermode, and asks again after every registration.

// MUST be first: points DATABASE_PATH at a throwaway file before the imports
// below open the database.
import '../test-utils/isolateDb.js';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { IrcConnection, mergeUserModes, parseUserModeRequest } from './ircConnection.js';
import { createUser } from '../db/users.js';
import { createNetwork, getNetwork, setNetworkUserModes } from '../db/networks.js';

let userId: number;

beforeAll(() => {
  userId = createUser('usermodes-test').id;
});

let seq = 0;
function makeNetwork({
  connectCommands = null as string | null,
  userModes = null as string | null,
} = {}) {
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
    connect_commands: connectCommands,
  })!;
  if (userModes) setNetworkUserModes(network.id, userId, userModes);
  return getNetwork(network.id, userId)!;
}

function makeConn(opts: Parameters<typeof makeNetwork>[0] = {}) {
  const network = makeNetwork(opts);
  const conn = new IrcConnection({ network, onEvent: () => {} });
  conn.client.raw = vi.fn<(line: string) => void>();
  conn.publish = vi.fn<(event: Record<string, unknown>) => void>();
  conn.logNet = vi.fn<(text: string) => void>();
  conn.currentNick = 'nick';
  conn.state = 'connected';
  const lines = () => vi.mocked(conn.client.raw).mock.calls.map(([line]) => String(line));
  const stored = () => getNetwork(network.id, userId)!.user_modes;
  const read = (line: string) => conn.client.connection.addReadBuffer(line);
  // The server's answer to a user-mode change it made.
  const confirm = (modes: string) => read(`:nick!n@example.test MODE nick :${modes}`);
  return { conn, network, lines, stored, read, confirm };
}

// connect() is never called, so the library's own 'registered' listener has
// no connection options; harmless ping settings keep it from reading null.
function emitRegistered(conn: IrcConnection, nick = 'nick'): void {
  (conn.client as unknown as { options: unknown }).options = { ping_interval: 0, ping_timeout: 0 };
  conn.client.emit('registered', { nick });
}

describe('mergeUserModes', () => {
  it('keeps each letter’s sign, adds before removes', () => {
    expect(mergeUserModes(null, '+g')).toBe('+g');
    expect(mergeUserModes('+g', '-i')).toBe('+g-i');
    expect(mergeUserModes('+g', '+R-w+x')).toBe('+gRx-w');
    expect(mergeUserModes('+g', '+g')).toBe('+g');
  });

  it('lets a letter’s opposite undo it', () => {
    expect(mergeUserModes('+g-i', '+i-g')).toBeNull();
    expect(mergeUserModes('+gR', '-g')).toBe('+R');
  });

  it('is null when nothing is kept', () => {
    expect(mergeUserModes(null, '+')).toBeNull();
    expect(mergeUserModes(null, '-')).toBeNull();
  });
});

describe('parseUserModeRequest', () => {
  it('reads a user-mode change', () => {
    expect(parseUserModeRequest('MODE nick +g')).toEqual({ target: 'nick', modes: '+g' });
    expect(parseUserModeRequest('mode nick :-i')).toEqual({ target: 'nick', modes: '-i' });
    expect(parseUserModeRequest('@label=abc MODE nick +g')).toEqual({
      target: 'nick',
      modes: '+g',
    });
  });

  it('ignores channel modes, queries and modes with parameters', () => {
    expect(parseUserModeRequest('MODE #chan +m')).toBeNull();
    expect(parseUserModeRequest('MODE &chan +m')).toBeNull();
    expect(parseUserModeRequest('MODE nick')).toBeNull();
    expect(parseUserModeRequest('MODE nick +s +cF')).toBeNull();
    expect(parseUserModeRequest('MODE nick g')).toBeNull();
    expect(parseUserModeRequest('PRIVMSG nick +g')).toBeNull();
  });
});

describe('user modes across reconnects (#1181)', () => {
  it('keeps a mode the user set once the server confirms it', () => {
    const { conn, stored, confirm } = makeConn();
    conn.raw('MODE nick +g');
    expect(stored()).toBeNull();
    confirm('+g');
    expect(stored()).toBe('+g');
    conn.raw('MODE NICK -i');
    confirm('-i');
    expect(stored()).toBe('+g-i');
  });

  it('keeps only the letters the server took', () => {
    const { conn, stored, read, confirm } = makeConn();
    conn.raw('MODE nick +gQ');
    read(':irc.example.test 501 nick :Unknown MODE flag');
    confirm('+g');
    expect(stored()).toBe('+g');
  });

  it('keeps nothing the server refused, or set on its own', () => {
    const { conn, stored, read, confirm } = makeConn();
    conn.raw('MODE nick +Q');
    read(':irc.example.test 501 nick :Unknown MODE flag');
    confirm('+Ziw');
    conn.raw('MODE nick +x');
    confirm('-x');
    expect(stored()).toBeNull();
  });

  it('keeps nothing the server confirms long after the request', () => {
    vi.useFakeTimers();
    try {
      const { conn, stored, confirm } = makeConn();
      conn.raw('MODE nick +g');
      vi.advanceTimersByTime(60_000);
      confirm('+g');
      expect(stored()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets a kept mode the moment the user undoes it, confirmed or not', () => {
    const { conn, stored, read } = makeConn({ userModes: '+gR' });
    conn.raw('MODE nick -g');
    expect(stored()).toBe('+R');
    // A network that no longer has the letter refuses the undo; it's gone anyway.
    read(':irc.example.test 501 nick :Unknown MODE flag');
    expect(stored()).toBe('+R');
  });

  it('keeps a removal from the network’s default, and drops it on the way back', () => {
    const { conn, stored, confirm } = makeConn();
    conn.raw('MODE nick -i');
    confirm('-i');
    expect(stored()).toBe('-i');
    conn.raw('MODE nick +i');
    expect(stored()).toBeNull();
  });

  it('keeps a bouncer client’s tagged MODE', () => {
    const { conn, stored, confirm } = makeConn();
    conn.raw('@label=abc MODE nick +g');
    confirm('+g');
    expect(stored()).toBe('+g');
  });

  it('ignores a MODE on anyone or anything else', () => {
    const { conn, stored, confirm } = makeConn();
    conn.raw('MODE alice +g');
    conn.raw('MODE #chan +m');
    conn.raw('MODE nick');
    confirm('+g');
    expect(stored()).toBeNull();
  });

  it('asks for them again after registering, before the connect commands', () => {
    const { conn, lines } = makeConn({
      userModes: '+g-i',
      connectCommands: 'PRIVMSG NickServ :IDENTIFY pw',
    });
    emitRegistered(conn);
    const sent = lines();
    expect(sent).toContain('MODE nick +g-i');
    expect(sent.indexOf('MODE nick +g-i')).toBeLessThan(
      sent.indexOf('PRIVMSG NickServ :IDENTIFY pw'),
    );
  });

  it('never sends a stored value that isn’t a plain mode string', () => {
    const { conn, lines } = makeConn({ userModes: '+g #chan' });
    emitRegistered(conn);
    expect(lines().filter((l) => l.startsWith('MODE '))).toEqual([]);
  });

  it('asks under the nick it registered with', () => {
    const { conn, lines } = makeConn({ userModes: '+g' });
    emitRegistered(conn, 'nick_');
    expect(lines()).toContain('MODE nick_ +g');
  });

  it('sends nothing when the user never set a mode', () => {
    const { conn, lines } = makeConn();
    emitRegistered(conn);
    expect(lines().filter((l) => l.startsWith('MODE '))).toEqual([]);
  });

  it('sends nothing on a re-attach, whose socket kept its modes', () => {
    const { conn, lines } = makeConn({ userModes: '+g' });
    conn.restoring = true;
    emitRegistered(conn);
    expect(lines()).not.toContain('MODE nick +g');
  });

  it('survives a restart: a new connection reads them from the network', () => {
    const first = makeConn();
    first.conn.raw('MODE nick +g');
    first.confirm('+g');
    const conn = new IrcConnection({
      network: getNetwork(first.network.id, userId)!,
      onEvent: () => {},
    });
    conn.client.raw = vi.fn<(line: string) => void>();
    conn.publish = vi.fn<(event: Record<string, unknown>) => void>();
    conn.logNet = vi.fn<(text: string) => void>();
    emitRegistered(conn);
    expect(vi.mocked(conn.client.raw).mock.calls.map(([l]) => l)).toContain('MODE nick +g');
  });

  it('asks on a socket the engine registered while no app was attached', () => {
    const { conn, lines } = makeConn({ userModes: '+g' });
    const priv = conn as unknown as {
      onEnginePhase(phase: string, info: Record<string, unknown>): void;
    };
    priv.onEnginePhase('attached', { unattended: true, nick: 'nick', channels: [] });
    priv.onEnginePhase('restored', {});
    expect(lines()).toContain('MODE nick +g');
    conn.dispose();
  });

  it('does not ask on an attended re-attach', () => {
    const { conn, lines } = makeConn({ userModes: '+g' });
    const priv = conn as unknown as {
      onEnginePhase(phase: string, info: Record<string, unknown>): void;
    };
    priv.onEnginePhase('attached', { nick: 'nick', channels: [] });
    priv.onEnginePhase('restored', {});
    expect(lines()).not.toContain('MODE nick +g');
    conn.dispose();
  });
});
