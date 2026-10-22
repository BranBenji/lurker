// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import { parseAvatarCommand, parseDisplayNameCommand, parseMetadataCommand } from './metadata.js';

describe('/metadata', () => {
  it('sets a key on ourselves, the value as a trailing param', () => {
    expect(parseMetadataCommand('set display-name Bob the Builder')).toEqual({
      line: 'METADATA * SET display-name :Bob the Builder',
    });
    expect(parseMetadataCommand('SET Status  away for lunch ')).toEqual({
      line: 'METADATA * SET status :away for lunch',
    });
  });
  it('unsets with no value, as the spec has it', () => {
    expect(parseMetadataCommand('del avatar')).toEqual({ line: 'METADATA * SET avatar' });
    expect(parseMetadataCommand('unset avatar')).toEqual({ line: 'METADATA * SET avatar' });
    // An empty value is an unset too — the server would store "".
    expect(parseMetadataCommand('set avatar    ')).toEqual({
      error: 'usage: /metadata set <key> <value>',
    });
  });
  it('lists ourselves, a nick or a channel', () => {
    expect(parseMetadataCommand('list')).toEqual({ line: 'METADATA * LIST' });
    expect(parseMetadataCommand('list bob')).toEqual({ line: 'METADATA bob LIST' });
    expect(parseMetadataCommand('list #chan extra')).toEqual({ line: 'METADATA #chan LIST' });
    expect(parseMetadataCommand('clear')).toEqual({ line: 'METADATA * CLEAR' });
  });
  it('refuses a key the spec would, and says how', () => {
    expect(parseMetadataCommand('set Bad%Key x')).toEqual({
      error: 'invalid metadata key: bad%key (a-z, 0-9, _ . / -)',
    });
    expect(parseMetadataCommand('')).toMatchObject({ error: expect.stringMatching(/^usage/) });
    expect(parseMetadataCommand('frob')).toMatchObject({ error: expect.stringMatching(/^usage/) });
  });
  it('never lets a line break onto the wire', () => {
    expect(parseMetadataCommand('set status hi\r\nQUIT')).toEqual({
      line: 'METADATA * SET status :hiQUIT',
    });
  });
});

describe('/avatar and /displayname', () => {
  it('set their key, and `off` unsets it', () => {
    expect(parseAvatarCommand('https://example.org/me/{size}.png')).toEqual({
      line: 'METADATA * SET avatar :https://example.org/me/{size}.png',
    });
    expect(parseAvatarCommand('off')).toEqual({ line: 'METADATA * SET avatar' });
    expect(parseDisplayNameCommand('Bob the Builder')).toEqual({
      line: 'METADATA * SET display-name :Bob the Builder',
    });
    expect(parseDisplayNameCommand('OFF')).toEqual({ line: 'METADATA * SET display-name' });
  });
  it('wants an http(s) URL for the avatar', () => {
    expect(parseAvatarCommand('ftp://x/y.png')).toEqual({
      error: 'the avatar must be an http(s) URL',
    });
    expect(parseAvatarCommand('me.png')).toEqual({ error: 'the avatar must be an http(s) URL' });
    expect(parseAvatarCommand('')).toMatchObject({ error: expect.stringMatching(/^usage/) });
    expect(parseDisplayNameCommand(' ')).toMatchObject({ error: expect.stringMatching(/^usage/) });
  });
});
