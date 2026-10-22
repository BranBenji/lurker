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
  return { conn, network, lines, stored };
}

// connect() is never called, so the library's own 'registered' listener has
// no connection options; harmless ping settings keep it from reading null.
function emitRegistered(conn: IrcConnection, nick = 'nick'): void {
  (conn.client as unknown as { options: unknown }).options = { ping_interval: 0, ping_timeout: 0 };
  conn.client.emit('registered', { nick });
}

describe('mergeUserModes', () => {
  it('keeps the last request for each letter, adds before removes', () => {
    expect(mergeUserModes(null, '+g')).toBe('+g');
    expect(mergeUserModes('+g', '-i')).toBe('+g-i');
    expect(mergeUserModes('+g-i', '+i-g')).toBe('+i-g');
    expect(mergeUserModes('+g', '+R-w+x')).toBe('+gRx-w');
  });

  it('is null when nothing was asked for', () => {
    expect(mergeUserModes(null, '+')).toBeNull();
    expect(mergeUserModes(null, '-')).toBeNull();
  });
});

describe('parseUserModeRequest', () => {
  it('reads a user-mode change', () => {
    expect(parseUserModeRequest('MODE nick +g')).toEqual({ target: 'nick', modes: '+g' });
    expect(parseUserModeRequest('mode nick :-i')).toEqual({ target: 'nick', modes: '-i' });
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
  it('remembers the modes the user sets on themselves', () => {
    const { conn, stored } = makeConn();
    conn.raw('MODE nick +g');
    expect(stored()).toBe('+g');
    conn.raw('MODE NICK -i');
    expect(stored()).toBe('+g-i');
    conn.raw('MODE nick -g');
    expect(stored()).toBe('-gi');
  });

  it('ignores a MODE on anyone or anything else', () => {
    const { conn, stored } = makeConn();
    conn.raw('MODE alice +g');
    conn.raw('MODE #chan +m');
    conn.raw('MODE nick');
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
