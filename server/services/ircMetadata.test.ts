// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The pure half of IRCv3 metadata (#607): what the cap says, how the three
// line shapes parse, and what a value has to be to reach state.

import { describe, it, expect } from 'vitest';
import {
  METADATA_SUB_KEYS,
  channelMetadataView,
  metadataSubKeysFor,
  parseMetadataLimits,
  parseMetadataLine,
  sizedAvatarUrl,
  userMetadataView,
  vetMetadataValue,
} from './ircMetadata.js';

describe('the cap value', () => {
  it('reads the limits ergo advertises', () => {
    expect(
      parseMetadataLimits('before-connect,max-subs=100,max-keys=50,max-value-bytes=1024'),
    ).toEqual({ maxSubs: 100, maxKeys: 50, maxValueBytes: 1024, beforeConnect: true });
  });
  it('reads nothing into a bare cap', () => {
    expect(parseMetadataLimits(undefined)).toEqual({
      maxSubs: null,
      maxKeys: null,
      maxValueBytes: null,
      beforeConnect: false,
    });
    expect(parseMetadataLimits('foo,bar=baz')).toMatchObject({ maxSubs: null });
  });
  it('trims the SUB list to max-subs, most wanted first', () => {
    expect(metadataSubKeysFor(parseMetadataLimits(undefined))).toEqual(METADATA_SUB_KEYS);
    expect(metadataSubKeysFor(parseMetadataLimits('max-subs=2'))).toEqual([
      'display-name',
      'avatar',
    ]);
    expect(metadataSubKeysFor(parseMetadataLimits('max-subs=0'))).toEqual([]);
  });
});

describe('the three line shapes', () => {
  it('reads the draft-2 METADATA message, three params being an unset', () => {
    expect(parseMetadataLine('METADATA', ['bob', 'avatar', '*', 'https://x/a.png'])).toEqual({
      target: 'bob',
      key: 'avatar',
      value: 'https://x/a.png',
    });
    expect(parseMetadataLine('METADATA', ['bob', 'avatar', '*'])).toEqual({
      target: 'bob',
      key: 'avatar',
      value: null,
    });
  });
  it("reads ergo's 761 and 766, whoever the asker param names", () => {
    expect(parseMetadataLine('761', ['*', 'bob', 'display-name', '*', 'Bob the Builder'])).toEqual({
      target: 'bob',
      key: 'display-name',
      value: 'Bob the Builder',
    });
    expect(parseMetadataLine('761', ['me', '#chan', 'display-name', '*', 'The Chan'])).toEqual({
      target: '#chan',
      key: 'display-name',
      value: 'The Chan',
    });
    expect(parseMetadataLine('766', ['*', 'bob', 'display-name', 'Key deleted'])).toEqual({
      target: 'bob',
      key: 'display-name',
      value: null,
    });
    // A WHOIS line is current too.
    expect(parseMetadataLine('760', ['me', 'bob', 'pronouns', '*', 'they/them'])).toEqual({
      target: 'bob',
      key: 'pronouns',
      value: 'they/them',
    });
  });
  it('is not fooled by anything else', () => {
    expect(parseMetadataLine('770', ['me', 'avatar'])).toBeNull();
    expect(parseMetadataLine('761', ['*'])).toBeNull();
    expect(parseMetadataLine('PRIVMSG', ['#chan', 'hi'])).toBeNull();
  });
});

describe('vetting a value', () => {
  it('keeps the keys we show and drops the rest', () => {
    expect(vetMetadataValue('display-name', 'Bob')).toBe('Bob');
    expect(vetMetadataValue('color', '#ff0000')).toBeNull();
    expect(vetMetadataValue('bot', 'yes')).toBeNull();
  });
  it('treats an empty or oversized value as unset, never truncated', () => {
    expect(vetMetadataValue('display-name', '')).toBeNull();
    expect(vetMetadataValue('display-name', '   ')).toBeNull();
    expect(vetMetadataValue('display-name', 'x'.repeat(65))).toBeNull();
    expect(vetMetadataValue('status', 'x'.repeat(200))).toHaveLength(200);
  });
  it('strips line breaks, keeps mIRC formatting for the display layer', () => {
    expect(vetMetadataValue('display-name', 'Bob\r\nthe Builder')).toBe('Bobthe Builder');
    expect(vetMetadataValue('display-name', '\x0304Bob\x0f')).toBe('\x0304Bob\x0f');
  });
  it('takes only http(s) for the URL keys, with {size} filled in for avatars', () => {
    expect(vetMetadataValue('avatar', 'https://x/a/{size}.png')).toBe('https://x/a/128.png');
    expect(vetMetadataValue('avatar', 'javascript:alert(1)')).toBeNull();
    expect(vetMetadataValue('avatar', 'data:image/png;base64,AAAA')).toBeNull();
    expect(vetMetadataValue('avatar', 'not a url')).toBeNull();
    expect(vetMetadataValue('homepage', 'http://example.org')).toBe('http://example.org');
    expect(vetMetadataValue('homepage', 'ftp://example.org')).toBeNull();
    expect(sizedAvatarUrl('https://x/{size}/{size}.png', 64)).toBe('https://x/64/64.png');
  });
});

describe('what a client is sent', () => {
  it('mints the avatar and never hands over the origin', () => {
    const mint = (origin: string) => `/proxied/${encodeURIComponent(origin)}`;
    expect(
      userMetadataView(
        { 'display-name': 'Bob', avatar: 'https://x/a.png', pronouns: 'he/him' },
        mint,
      ),
    ).toEqual({
      displayName: 'Bob',
      avatarUrl: '/proxied/https%3A%2F%2Fx%2Fa.png',
      pronouns: 'he/him',
    });
    expect(channelMetadataView({ avatar: 'https://x/c.png', url: 'https://x' }, mint)).toEqual({
      avatarUrl: '/proxied/https%3A%2F%2Fx%2Fc.png',
    });
  });
  it('says null for an avatar it cannot serve, so the client shows its tile', () => {
    expect(userMetadataView({ avatar: 'https://x/a.png' }, () => null)).toEqual({
      avatarUrl: null,
    });
  });
});
