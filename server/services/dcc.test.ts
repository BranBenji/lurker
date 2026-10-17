// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';

import {
  buildDccAccept,
  buildDccResume,
  buildDccChat,
  buildDccChatPassive,
  buildDccChatReverse,
  buildDccSend,
  buildDccSendPassive,
  buildDccSendReply,
  crc32Hex,
  crc32Update,
  decodeDccAddress,
  type DccChat,
  type DccSend,
  encodeDccAddress,
  formatBytes,
  formatDccOfferLine,
  isBlockedDccHost,
  parseCrcFromFilename,
  parseDcc,
  parseDccChatLine,
  parseDccRejectSend,
  dccWireFilename,
  PASSIVE_DCC_FAKE_HOST,
} from './dcc.js';

// Convenience: assert a parse succeeded as a CHAT and return it narrowed.
function chat(args: string): DccChat {
  const r = parseDcc(args);
  expect(r.kind).toBe('chat');
  return r as DccChat;
}

// Convenience: assert a parse succeeded as a SEND and return it narrowed.
function send(args: string): DccSend {
  const r = parseDcc(args);
  expect(r.kind).toBe('send');
  return r as DccSend;
}

describe('decodeDccAddress', () => {
  it('decodes the classic IPv4-as-uint32 (network byte order)', () => {
    expect(decodeDccAddress('3232235777')).toBe('192.168.1.1');
    expect(decodeDccAddress('16843009')).toBe('1.1.1.1');
    expect(decodeDccAddress('0')).toBe('0.0.0.0');
    expect(decodeDccAddress('4294967295')).toBe('255.255.255.255');
  });

  it('passes through a dotted-quad IPv4', () => {
    expect(decodeDccAddress('192.168.1.1')).toBe('192.168.1.1');
  });

  it('keeps an IPv6 literal verbatim', () => {
    expect(decodeDccAddress('::1')).toBe('::1');
    expect(decodeDccAddress('fe80::1')).toBe('fe80::1');
    expect(decodeDccAddress('::ffff:192.168.1.1')).toBe('::ffff:192.168.1.1');
  });

  it('rejects junk and out-of-range values', () => {
    expect(decodeDccAddress('')).toBeNull();
    expect(decodeDccAddress('4294967296')).toBeNull(); // > 2^32-1
    expect(decodeDccAddress('999.1.1.1')).toBeNull(); // octet > 255
    expect(decodeDccAddress('1:2')).toBeNull(); // not a real v6 literal
    expect(decodeDccAddress('hello')).toBeNull();
  });
});

describe('parseDcc — SEND (active)', () => {
  it('parses a standard offer', () => {
    expect(send('SEND file.mkv 3232235777 50612 1024')).toEqual({
      kind: 'send',
      filename: 'file.mkv',
      host: '192.168.1.1',
      port: 50612,
      size: 1024,
      token: null,
      passive: false,
      secure: false,
    });
  });

  it('is case-insensitive on the subtype', () => {
    expect(send('send file.mkv 16843009 1 1').filename).toBe('file.mkv');
  });

  it('handles a quoted filename with spaces', () => {
    const r = send('SEND "my cool file.txt" 3232235777 50612 1024');
    expect(r.filename).toBe('my cool file.txt');
    expect(r.host).toBe('192.168.1.1');
  });

  it('takes an unquoted filename as the first token only', () => {
    // Per the convention a spaced name must be quoted; unquoted ⇒ first token.
    expect(send('SEND scene_release_-_01.mkv 16843009 5000 1234').filename).toBe(
      'scene_release_-_01.mkv',
    );
  });

  it('handles a purely-numeric filename', () => {
    expect(send('SEND 12345 16843009 5000 1024').filename).toBe('12345');
  });

  it('preserves a size larger than 4 GiB (no uint32 clamp)', () => {
    expect(send('SEND big.iso 3232235777 50612 5368709120').size).toBe(5368709120);
  });

  it('parses an IPv6 offer', () => {
    const r = send('SEND file.mkv fe80::1 50612 1024');
    expect(r.host).toBe('fe80::1');
    expect(r.passive).toBe(false);
  });

  it('accepts the maximum valid port', () => {
    expect(send('SEND f 16843009 65535 1').port).toBe(65535);
  });
});

describe('parseDcc — SEND (passive/reverse)', () => {
  it('flags port 0 as passive and captures the token', () => {
    expect(send('SEND file.mkv 3232235777 0 1024 42')).toEqual({
      kind: 'send',
      filename: 'file.mkv',
      host: '192.168.1.1',
      port: 0,
      size: 1024,
      token: 42,
      passive: true,
      secure: false,
    });
  });

  it('reads the token alongside a quoted filename', () => {
    const r = send('SEND "my file.bin" 16843009 0 99 7');
    expect(r.passive).toBe(true);
    expect(r.token).toBe(7);
  });

  it('takes token 0, which irssi and halloy can pick', () => {
    expect(send('SEND f.bin 16843009 0 99 0').token).toBe(0);
  });

  it('refuses port 0 with no token, which nobody could answer', () => {
    expect(parseDcc('SEND f.bin 16843009 0 99').kind).toBe('invalid');
  });
});

describe('parseDcc — non-SEND subtypes', () => {
  it('reports an unknown subtype as unsupported, not invalid', () => {
    expect(parseDcc('FROBNICATE 1 2 3')).toEqual({ kind: 'unsupported', subtype: 'FROBNICATE' });
  });
});

describe('parseDcc — secure DCC (#1157)', () => {
  // KVIrc's spellings (libkvidcc.cpp:1475-1527): the same grammar, an `S` in
  // front, and the connection in TLS.
  it('reads SSEND as a SEND over TLS', () => {
    expect(parseDcc('SSEND file.mkv 3232235777 50000 1024')).toMatchObject({
      kind: 'send',
      filename: 'file.mkv',
      host: '192.168.1.1',
      port: 50000,
      size: 1024,
      secure: true,
    });
    expect(parseDcc('ssend "my file.mkv" 3232235777 0 1024 7')).toMatchObject({
      kind: 'send',
      passive: true,
      token: 7,
      secure: true,
    });
  });

  it('reads SCHAT as a CHAT over TLS', () => {
    expect(parseDcc('SCHAT chat 3232235777 50000')).toMatchObject({
      kind: 'chat',
      host: '192.168.1.1',
      port: 50000,
      secure: true,
    });
  });

  it('a plain SEND or CHAT is not secure', () => {
    expect(parseDcc('SEND file.mkv 3232235777 50000 1024')).toMatchObject({ secure: false });
    expect(parseDcc('CHAT chat 3232235777 50000')).toMatchObject({ secure: false });
  });

  // A turbo transfer has no ACKs; Lurker's receiver sends them and its sender
  // waits for them. KVIrc reads the letters in either order (requests.cpp:487).
  it('leaves a turbo transfer unsupported in every spelling, secure or not', () => {
    for (const verb of ['TSEND', 'TSSEND', 'STSEND']) {
      expect(parseDcc(`${verb} file.mkv 3232235777 50000 1024`)).toEqual({
        kind: 'unsupported',
        subtype: verb,
      });
    }
  });

  // RESUME and ACCEPT keep their names inside a secure transfer
  // (DccFileTransfer.cpp:1298-1308), so a prefixed one is nobody's.
  it('has no secure spelling of RESUME or ACCEPT', () => {
    expect(parseDcc('SRESUME file.mkv 50000 100')).toEqual({
      kind: 'unsupported',
      subtype: 'SRESUME',
    });
    expect(parseDcc('SACCEPT file.mkv 50000 100')).toEqual({
      kind: 'unsupported',
      subtype: 'SACCEPT',
    });
  });

  it('builds every offer and reply with the S in front, and nothing else changed', () => {
    expect(buildDccSend('file.mkv', '192.168.1.1', 50000, 1024, true)).toBe(
      'SSEND file.mkv 3232235777 50000 1024',
    );
    expect(buildDccSendPassive('file.mkv', 1024, 9, true)).toBe('SSEND file.mkv 16843009 0 1024 9');
    expect(buildDccSendReply('my file.mkv', '203.0.113.5', 30001, 1024, 9, true)).toBe(
      'SSEND "my file.mkv" 3405803781 30001 1024 9',
    );
    expect(buildDccChat('192.168.1.1', 30001, true)).toBe('SCHAT chat 3232235777 30001');
    expect(buildDccChatPassive('1.1.1.1', 42, true)).toBe('SCHAT chat 16843009 0 42');
    expect(buildDccChatReverse('203.0.113.5', 30002, 42, true)).toBe(
      'SCHAT chat 3405803781 30002 42',
    );
    // RESUME and ACCEPT have no secure form to build.
    expect(buildDccResume('file.mkv', 50000, 100, null)).toBe('RESUME file.mkv 50000 100');
  });

  it('round-trips a secure offer through the parser', () => {
    expect(parseDcc(buildDccSend('file.mkv', '203.0.113.5', 30001, 1024, true)!)).toMatchObject({
      kind: 'send',
      host: '203.0.113.5',
      secure: true,
    });
    expect(parseDcc(buildDccChatPassive('1.1.1.1', 7, true)!)).toMatchObject({
      kind: 'chat',
      passive: true,
      token: 7,
      secure: true,
    });
  });

  it('says so in the offer line', () => {
    const offer = parseDcc('SSEND file.mkv 3232235777 50000 1024');
    expect(offer.kind).toBe('send');
    expect(formatDccOfferLine('bob', offer as DccSend)).toBe(
      'bob offered "file.mkv" (1.0 KB) via DCC SSEND (secure)',
    );
  });
});

describe('parseDcc — ACCEPT (resume confirmation)', () => {
  it('parses port + position', () => {
    expect(parseDcc('ACCEPT file.mkv 50612 1024')).toEqual({
      kind: 'accept',
      filename: 'file.mkv',
      port: 50612,
      position: 1024,
      token: null,
    });
  });

  it('handles a quoted filename and a passive token', () => {
    expect(parseDcc('ACCEPT "my file.bin" 0 2048 7')).toEqual({
      kind: 'accept',
      filename: 'my file.bin',
      port: 0,
      position: 2048,
      token: 7,
    });
  });

  it('rejects a malformed ACCEPT', () => {
    expect(parseDcc('ACCEPT file.mkv 50612').kind).toBe('invalid'); // missing position
    expect(parseDcc('ACCEPT file.mkv 70000 1').kind).toBe('invalid'); // bad port
  });
});

// A receiver asking to resume a file we offered (#1086). Same fields as ACCEPT.
describe('parseDcc — RESUME', () => {
  it('parses an active resume', () => {
    expect(parseDcc('RESUME file.mkv 50612 1024')).toEqual({
      kind: 'resume',
      filename: 'file.mkv',
      port: 50612,
      position: 1024,
      token: null,
    });
  });

  it('parses a passive resume: port 0 and our token', () => {
    expect(parseDcc('RESUME "my file.bin" 0 2048 7')).toEqual({
      kind: 'resume',
      filename: 'my file.bin',
      port: 0,
      position: 2048,
      token: 7,
    });
  });

  it('rejects a malformed RESUME', () => {
    expect(parseDcc('RESUME file.mkv 50612').kind).toBe('invalid');
    expect(parseDcc('RESUME').kind).toBe('invalid');
  });
});

describe('DCC SEND builders', () => {
  // Quassel, bouncedcc and the irssi/halloy passive reply all break on one.
  it('sends a space as _, as WeeChat and KVIrc do', () => {
    expect(dccWireFilename('my file.mkv')).toBe('my_file.mkv');
    expect(dccWireFilename('file.mkv')).toBe('file.mkv');
  });

  it('swaps a double quote for a single one, which nothing unescapes', () => {
    expect(dccWireFilename('say "hi".txt')).toBe(`say_'hi'.txt`);
  });

  it('never sends a path or a control character', () => {
    expect(dccWireFilename('../../etc/passwd')).toBe('passwd');
    expect(dccWireFilename('a\u0001b.txt')).toBe('ab.txt');
  });

  it('builds an active offer with the address as a uint32', () => {
    expect(buildDccSend('file.mkv', '192.168.1.1', 50000, 1024)).toBe(
      'SEND file.mkv 3232235777 50000 1024',
    );
    expect(buildDccSend('file.mkv', 'example.com', 50000, 1024)).toBeNull();
  });

  it('builds a passive offer: placeholder address, port 0, the token', () => {
    expect(buildDccSendPassive('a_b.mkv', 5_000_000_000, 7)).toBe(
      'SEND a_b.mkv 16843009 0 5000000000 7',
    );
  });

  // #1145: our answer to a peer's passive offer, and our RESUME of one.
  it('answers a passive offer with our address and port, and their name, size and token', () => {
    expect(buildDccSendReply('f.bin', '203.0.113.5', 30001, 99, 0)).toBe(
      'SEND f.bin 3405803781 30001 99 0',
    );
    expect(buildDccSendReply('my file.bin', '203.0.113.5', 30001, 99, 7)).toBe(
      'SEND "my file.bin" 3405803781 30001 99 7',
    );
    // KVIrc's escaped space goes back as it came.
    expect(buildDccSendReply('a\\040b', '203.0.113.5', 30001, 99, 7)).toBe(
      'SEND a\\040b 3405803781 30001 99 7',
    );
    // Quoted for an ASCII space only, the one the parser splits on.
    expect(buildDccSendReply('a\u00a0b', '203.0.113.5', 30001, 99, 7)).toBe(
      'SEND a\u00a0b 3405803781 30001 99 7',
    );
    expect(buildDccSendReply('f.bin', 'example.com', 30001, 99, 7)).toBeNull();
  });

  it('asks to resume an offer, with the token for a passive one', () => {
    expect(buildDccResume('f.bin', 50000, 1024, null)).toBe('RESUME f.bin 50000 1024');
    expect(buildDccResume('my f.bin', 0, 1024, 0)).toBe('RESUME "my f.bin" 0 1024 0');
  });

  it('answers a resume with ACCEPT, on the port it asked with', () => {
    expect(buildDccAccept('file.mkv', 50000, 1024, null)).toBe('ACCEPT file.mkv 50000 1024');
    expect(buildDccAccept('file.mkv', 0, 1024, 7)).toBe('ACCEPT file.mkv 0 1024 7');
    // WeeChat's passive RESUME names its own port.
    expect(buildDccAccept('file.mkv', 41234, 1024, 7)).toBe('ACCEPT file.mkv 41234 1024 7');
  });

  it("reads a receiver's REJECT of a file we offered", () => {
    expect(parseDccRejectSend('REJECT SEND file.mkv')).toBe('file.mkv');
    expect(parseDccRejectSend('REJECT SEND "my file.mkv"')).toBe('my file.mkv');
    expect(parseDccRejectSend('REJECT CHAT chat')).toBeNull();
    expect(parseDccRejectSend('SEND file.mkv 1 2 3')).toBeNull();
  });
});

describe('parseDcc — invalid', () => {
  it('rejects an empty body', () => {
    expect(parseDcc('')).toEqual({ kind: 'invalid', reason: 'empty DCC body' });
    expect(parseDcc('   ')).toEqual({ kind: 'invalid', reason: 'empty DCC body' });
  });

  it('rejects an out-of-range port', () => {
    expect(parseDcc('SEND f 16843009 70000 1')).toEqual({
      kind: 'invalid',
      reason: 'bad port: 70000',
    });
  });

  it('rejects a bad address', () => {
    expect(parseDcc('SEND f not-an-ip 50612 1')).toEqual({
      kind: 'invalid',
      reason: 'bad address: not-an-ip',
    });
  });

  it('rejects too few or too many fields', () => {
    expect(parseDcc('SEND f 16843009 50612').kind).toBe('invalid'); // missing size
    expect(parseDcc('SEND f 16843009 50612 1024 42 99').kind).toBe('invalid'); // extra
  });

  // irssi's reply to a passive offer never quotes the name (dcc-get.c:364-366),
  // nor does halloy's (dcc.rs:128-133). Read from the right, as irssi does.
  it('reads an unquoted name with spaces from the right', () => {
    expect(send('SEND my file.txt 3232235777 50612 1024 7')).toMatchObject({
      filename: 'my file.txt',
      host: '192.168.1.1',
      port: 50612,
      size: 1024,
      token: 7,
    });
    expect(send('SEND a b c.mkv 3232235777 50612 1024')).toMatchObject({
      filename: 'a b c.mkv',
      token: null,
    });
    expect(parseDcc('RESUME my file.txt 50612 1024')).toMatchObject({
      kind: 'resume',
      filename: 'my file.txt',
      position: 1024,
    });
    // A separator is an ASCII space: other whitespace stays in the name.
    expect(parseDcc('ACCEPT a\u00a012 5000 1024')).toMatchObject({
      kind: 'accept',
      filename: 'a\u00a012',
      port: 5000,
      position: 1024,
      token: null,
    });
    // A number in the name is not an address.
    expect(send('SEND track 12 3232235777 50612 1024')).toMatchObject({
      filename: 'track 12',
      token: null,
    });
  });

  it('rejects an unterminated quoted filename', () => {
    expect(parseDcc('SEND "no closing quote 16843009 50612 1024')).toEqual({
      kind: 'invalid',
      reason: 'unterminated quoted filename',
    });
  });

  it('rejects a non-numeric size or token', () => {
    expect(parseDcc('SEND f 16843009 50612 big').kind).toBe('invalid');
    expect(parseDcc('SEND f 16843009 0 1024 xyz').kind).toBe('invalid');
  });
});

describe('formatBytes', () => {
  it('renders 1024-based sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
  });
});

describe('formatDccOfferLine', () => {
  it('describes an active offer', () => {
    const offer = parseDcc('SEND scene.mkv 3232235777 50612 5368709120') as DccSend;
    expect(formatDccOfferLine('[EWG]MArchive', offer)).toBe(
      '[EWG]MArchive offered "scene.mkv" (5.0 GB) via DCC SEND',
    );
  });

  it('flags a passive offer', () => {
    const offer = parseDcc('SEND f.bin 16843009 0 1024 7') as DccSend;
    expect(formatDccOfferLine('bot', offer)).toBe(
      'bot offered "f.bin" (1.0 KB) via DCC SEND (passive)',
    );
  });
});

describe('isBlockedDccHost', () => {
  it('blocks loopback / private / link-local / CGNAT / reserved IPv4', () => {
    for (const h of [
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.10',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '224.0.0.1', // multicast
      '255.255.255.255',
    ]) {
      expect(isBlockedDccHost(h)).toBe(true);
    }
  });

  it('allows ordinary public IPv4', () => {
    for (const h of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1']) {
      expect(isBlockedDccHost(h)).toBe(false);
    }
  });

  it('blocks loopback / link-local / ULA / multicast IPv6 and v4-mapped privates', () => {
    for (const h of [
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isBlockedDccHost(h)).toBe(true);
    }
  });

  it('allows a public IPv6 (and public v4-mapped)', () => {
    expect(isBlockedDccHost('2606:4700:4700::1111')).toBe(false);
    expect(isBlockedDccHost('::ffff:8.8.8.8')).toBe(false);
  });
});

describe('crc32', () => {
  it('matches the standard IEEE test vector', () => {
    expect(crc32Hex(crc32Update(0, Buffer.from('123456789')))).toBe('CBF43926');
  });

  it('is 0 for empty input', () => {
    expect(crc32Update(0, Buffer.alloc(0))).toBe(0);
  });

  it('composes across chunks (incremental == one-shot)', () => {
    const a = Buffer.from('hello ');
    const b = Buffer.from('world');
    expect(crc32Update(crc32Update(0, a), b)).toBe(crc32Update(0, Buffer.concat([a, b])));
  });

  it('renders 8-char uppercase hex', () => {
    expect(crc32Hex(0xdeadbeef)).toBe('DEADBEEF');
    expect(crc32Hex(0xabc)).toBe('00000ABC');
  });
});

describe('parseCrcFromFilename', () => {
  it('extracts a bracketed CRC32, uppercased', () => {
    expect(parseCrcFromFilename('[A1b2C3d4].mkv')).toBe('A1B2C3D4');
    expect(parseCrcFromFilename('show (deadbeef).mkv')).toBe('DEADBEEF');
  });

  it('takes the LAST 8-hex token (after resolution/group tags)', () => {
    expect(parseCrcFromFilename('[HorribleSubs] Show - 01 [1080p][CAFEBABE].mkv')).toBe('CAFEBABE');
    expect(parseCrcFromFilename('[AAAAAAAA] foo [BBBBBBBB].mkv')).toBe('BBBBBBBB');
  });

  it('is null when there is no CRC token', () => {
    expect(parseCrcFromFilename('movie.mkv')).toBeNull();
    expect(parseCrcFromFilename('[1080p][x264].mkv')).toBeNull(); // not 8 hex chars
  });
});

describe('parseDcc — CHAT', () => {
  it('parses an active chat offer (uint32 address)', () => {
    const c = chat('CHAT chat 16843009 5000');
    expect(c).toEqual({
      kind: 'chat',
      protocol: 'chat',
      host: '1.1.1.1',
      port: 5000,
      token: null,
      passive: false,
      secure: false,
    });
  });

  it('parses a passive chat offer (port 0 + token)', () => {
    const c = chat('CHAT chat 3232235777 0 42');
    expect(c.passive).toBe(true);
    expect(c.port).toBe(0);
    expect(c.token).toBe(42);
    expect(c.host).toBe('192.168.1.1');
  });

  // Four of the six implementations that speak DCC CHAT never read the protocol
  // token; irssi labels it `<unused>`. Rejecting an unexpected value would only
  // lose us peers, so every one of these is a valid offer.
  it('never validates the protocol token', () => {
    expect(chat('CHAT chat 16843009 5000').protocol).toBe('chat');
    expect(chat('CHAT CHAT 16843009 5000').protocol).toBe('CHAT'); // irssi + repartee
    expect(chat('CHAT ssl 16843009 5000').protocol).toBe('ssl');
    expect(chat('CHAT banana 16843009 5000').protocol).toBe('banana');
  });

  // irssi accepts a 5th+ field (dcc-chat.c:627 only tests `paramcount < 3`), so
  // refusing one would drop offers a real client considers well-formed.
  it('ignores trailing junk past the token', () => {
    const c = chat('CHAT chat 16843009 0 42 and some junk');
    expect(c.passive).toBe(true);
    expect(c.token).toBe(42);
  });

  it('accepts a dotted quad and an IPv6 literal as well as the uint32 form', () => {
    expect(chat('CHAT chat 192.168.1.1 5000').host).toBe('192.168.1.1');
    expect(chat('CHAT chat 2001:db8::1 5000').host).toBe('2001:db8::1');
  });

  // ⚠⚠ The one shape a careless parser turns into a dial to port 0. A passive
  // offer is only meaningful with a token to correlate the reverse reply; port 0
  // without one is malformed and must never reach the dial path.
  it('REFUSES port 0 with no token rather than treating it as passive', () => {
    const r = parseDcc('CHAT chat 16843009 0');
    expect(r.kind).toBe('invalid');
    expect(r).not.toMatchObject({ passive: true });
  });

  it('rejects malformed CHAT', () => {
    expect(parseDcc('CHAT chat').kind).toBe('invalid'); // missing addr/port
    expect(parseDcc('CHAT chat 16843009 70000').kind).toBe('invalid'); // bad port
    expect(parseDcc('CHAT chat notanip 5000').kind).toBe('invalid'); // bad addr
    expect(parseDcc('CHAT chat 16843009 5000 nope').kind).toBe('invalid'); // bad token
  });

  // A hostname in the address field is a remotely-triggerable DNS lookup. WeeChat
  // runs the field through getaddrinfo and accepts one; we must not.
  it('refuses a hostname in the address field', () => {
    expect(parseDcc('CHAT chat evil.example.com 5000').kind).toBe('invalid');
  });
});

describe('encodeDccAddress', () => {
  it('encodes dotted-quad IPv4 to its network-order uint32', () => {
    expect(encodeDccAddress('1.1.1.1')).toBe('16843009');
    expect(encodeDccAddress('192.168.1.1')).toBe('3232235777');
    expect(encodeDccAddress('255.255.255.255')).toBe('4294967295');
    expect(encodeDccAddress('0.0.0.0')).toBe('0');
  });

  it('round-trips with decodeDccAddress', () => {
    for (const ip of ['1.2.3.4', '203.0.113.5', '8.8.8.8']) {
      expect(decodeDccAddress(encodeDccAddress(ip)!)).toBe(ip);
    }
  });

  it('passes an IPv6 literal through', () => {
    expect(encodeDccAddress('2001:db8::1')).toBe('2001:db8::1');
  });

  it('returns null for junk', () => {
    expect(encodeDccAddress('nope')).toBeNull();
    expect(encodeDccAddress('999.1.1.1')).toBeNull();
  });
});

describe('DCC CHAT offer builders', () => {
  // ⚠⚠ The address must be the uint32 form: irssi decodes a colon-free address
  // with strtoul, so a dotted quad would reach it as 0.0.0.192.
  it('builds an active offer as exactly five wire tokens, uint32 address', () => {
    const body = buildDccChat('192.168.1.1', 30001);
    expect(body).toBe('CHAT chat 3232235777 30001');
    expect(`DCC ${body}`.split(' ')).toHaveLength(5);
  });

  it('sends the protocol token lowercase', () => {
    expect(buildDccChat('1.1.1.1', 5000)).toMatch(/^CHAT chat /);
  });

  // ⚠ irssi detects passive with a literal string compare against "0"
  // (dcc-chat.c:634), so the port must be exactly `0` — never padded.
  it('builds a passive offer with a literal 0 port', () => {
    expect(buildDccChatPassive('1.1.1.1', 42)).toBe('CHAT chat 16843009 0 42');
  });

  it('builds a reverse reply with our real port and the peer token', () => {
    expect(buildDccChatReverse('203.0.113.5', 30002, 42)).toBe('CHAT chat 3405803781 30002 42');
  });

  it('passes an IPv6 literal through', () => {
    expect(buildDccChat('2001:db8::1', 5000)).toBe('CHAT chat 2001:db8::1 5000');
  });

  it('returns null when the host cannot be encoded', () => {
    expect(buildDccChat('not-an-ip', 5000)).toBeNull();
    expect(buildDccChatPassive('not-an-ip', 1)).toBeNull();
    expect(buildDccChatReverse('not-an-ip', 1, 1)).toBeNull();
  });

  it('round-trips: a built offer parses back to the same fields', () => {
    const active = parseDcc(buildDccChat('203.0.113.5', 30001)!);
    expect(active).toMatchObject({
      kind: 'chat',
      host: '203.0.113.5',
      port: 30001,
      passive: false,
    });
    const passive = parseDcc(buildDccChatPassive('203.0.113.5', 7)!);
    expect(passive).toMatchObject({
      kind: 'chat',
      host: '203.0.113.5',
      port: 0,
      passive: true,
      token: 7,
    });
  });
});

describe('parseDccChatLine', () => {
  it('passes ordinary text through', () => {
    expect(parseDccChatLine('just talking')).toEqual({ text: 'just talking', action: false });
  });

  // The mIRC dialect — the only one WeeChat, HexChat, HexDroid and repartee parse.
  it('reads a bare \\x01ACTION\\x01', () => {
    expect(parseDccChatLine('\u0001ACTION waves\u0001')).toEqual({ text: 'waves', action: true });
  });

  // irssi's default (dcc_mirc_ctcp = FALSE, dcc-chat.c:154-157). Nothing else
  // emits it, but refusing to read it would render irssi's /me as literal junk.
  it("reads irssi's CTCP_MESSAGE-prefixed action", () => {
    expect(parseDccChatLine('CTCP_MESSAGE \u0001ACTION nods\u0001')).toEqual({
      text: 'nods',
      action: true,
    });
    expect(parseDccChatLine('CTCP_REPLY \u0001ACTION nods\u0001')).toEqual({
      text: 'nods',
      action: true,
    });
  });

  it('is case-insensitive on ACTION and handles an empty one', () => {
    expect(parseDccChatLine('\u0001action waves\u0001').action).toBe(true);
    expect(parseDccChatLine('\u0001ACTION\u0001')).toEqual({ text: '', action: true });
  });

  // WeeChat strips the delimiters from any CTCP and shows the payload rather
  // than dropping the line; showing the user control characters is worse.
  it('unwraps a non-ACTION CTCP instead of dropping it', () => {
    expect(parseDccChatLine('\u0001VERSION\u0001')).toEqual({ text: 'VERSION', action: false });
  });

  it('leaves a half-delimited line alone', () => {
    expect(parseDccChatLine('\u0001ACTION unterminated')).toEqual({
      text: '\u0001ACTION unterminated',
      action: false,
    });
  });
});

describe('PASSIVE_DCC_FAKE_HOST', () => {
  // irssi (dcc-chat.c:530-533) and repartee (protocol.rs:5) both use 1.1.1.1;
  // HexChat's 199 decodes to 0.0.0.199, which a receiver validating the address
  // as routable can reject.
  it('is the 1.1.1.1 placeholder irssi and repartee use', () => {
    expect(PASSIVE_DCC_FAKE_HOST).toBe('1.1.1.1');
    expect(encodeDccAddress(PASSIVE_DCC_FAKE_HOST)).toBe('16843009');
  });
});

// Copilot's second pass on #973 named "invalid IPv6 configuration validation".
// Both directions took anything of hex, colons and dots as an IPv6 literal.
describe('IPv6 literals are validated, not pattern-matched', () => {
  // ⚠⚠ `1.2.3.4:5` is the realistic one: host:port pasted into
  // LURKER_DCC_EXTERNAL_HOST. It passed as configured and went out in offers.
  it.each(['1.2.3.4:5', '1:2', ':::', 'abc:def', ':', 'f:f:f'])(
    'refuses to advertise %s',
    (bad) => {
      expect(encodeDccAddress(bad)).toBeNull();
      expect(buildDccChat(bad, 5000)).toBeNull();
    },
  );

  // The inbound side reached the dialler, which called them "private or
  // reserved" — a misleading reason for what simply isn't an address.
  it.each([':::', 'f:f:f'])('refuses to parse %s from an offer', (bad) => {
    expect(decodeDccAddress(bad)).toBeNull();
    expect(parseDcc(`CHAT chat ${bad} 5000`).kind).toBe('invalid');
  });

  it.each(['::1', '2001:db8::1', '::ffff:1.2.3.4', 'fe80::1'])('still accepts %s', (good) => {
    expect(encodeDccAddress(good)).toBe(good);
    expect(decodeDccAddress(good)).toBe(good);
  });
});
