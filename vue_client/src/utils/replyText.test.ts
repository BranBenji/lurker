// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { quoteLineFor, replyExcerpt, splitQuoteBlock, stripReplyAddress } from './replyText.js';

describe('stripReplyAddress', () => {
  it('drops the address to the author being answered', () => {
    expect(stripReplyAddress('alice: sure', 'alice')).toBe('sure');
    expect(stripReplyAddress('alice, sure', 'alice')).toBe('sure');
    expect(stripReplyAddress('Alice:  sure', 'alice')).toBe('sure');
  });

  it('keeps a first word that only looks like the nick', () => {
    // A reply to `will` that opens with the word "will".
    expect(stripReplyAddress('will you come?', 'will')).toBe('will you come?');
    // A different nick that starts with this one.
    expect(stripReplyAddress('alicia: hi', 'alice')).toBe('alicia: hi');
    // `bob_` is its own nick (every ghost's), not bob plus punctuation.
    expect(stripReplyAddress('bob_: hi', 'bob')).toBe('bob_: hi');
  });

  it('keeps an address to someone else', () => {
    expect(stripReplyAddress('carol: ask alice', 'alice')).toBe('carol: ask alice');
  });

  it('treats the nick literally, not as a pattern', () => {
    expect(stripReplyAddress('[m]x: hi', '[m]x')).toBe('hi');
    expect(stripReplyAddress('mx: hi', '[m]x')).toBe('mx: hi');
  });

  it('never strips a line to nothing', () => {
    expect(stripReplyAddress('alice: ', 'alice')).toBe('alice: ');
  });
});

describe('replyExcerpt', () => {
  it('drops formatting and folds lines into one', () => {
    expect(replyExcerpt('\x02bold\x02 and \x0304red\x03\nsecond line')).toBe(
      'bold and red second line',
    );
  });
});

// The Quote action's line (#1119): the way IRC writes the line, behind `> `.
describe('quoteLineFor', () => {
  it('writes a message as <nick> text', () => {
    expect(quoteLineFor({ nick: 'alice', type: 'message', text: 'what time is it?' })).toBe(
      '> <alice> what time is it?',
    );
    // No type is a message, as everywhere a line's type is read.
    expect(quoteLineFor({ nick: 'alice', text: 'hi' })).toBe('> <alice> hi');
  });

  it('writes an action and a notice the way the timeline does', () => {
    expect(quoteLineFor({ nick: 'bob', type: 'action', text: 'waves' })).toBe('> * bob waves');
    expect(quoteLineFor({ nick: 'ChanServ', type: 'notice', text: 'hello' })).toBe(
      '> -ChanServ- hello',
    );
  });

  it('reads the text by the reply quote’s rule: no formatting, one line', () => {
    expect(quoteLineFor({ nick: 'alice', text: '\x02bold\x02 and \x034,5red\x03' })).toBe(
      '> <alice> bold and red',
    );
    expect(quoteLineFor({ nick: 'alice', text: 'first\nsecond\r\n  third  ' })).toBe(
      '> <alice> first second third',
    );
    expect(quoteLineFor({ nick: 'alice', text: '\x02\x02' })).toBe('> <alice>');
  });

  it('clips to the wire budget in bytes, between characters, with an ellipsis', () => {
    const long = quoteLineFor({ nick: 'alice', text: 'x'.repeat(900) }, 100);
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(100);
    expect(long).toMatch(/^> <alice> x+…$/);
    // Multi-byte text: counted in bytes, never torn mid-character.
    const cjk = quoteLineFor({ nick: 'alice', text: '漢'.repeat(100) }, 40);
    expect(new TextEncoder().encode(cjk).length).toBeLessThanOrEqual(40);
    expect(cjk).toMatch(/^> <alice> 漢+…$/);
    // One that fits is left alone.
    expect(quoteLineFor({ nick: 'alice', text: 'hi' }, 100)).toBe('> <alice> hi');
  });
});

describe('splitQuoteBlock', () => {
  it('separates the leading quote lines from the answer', () => {
    expect(splitQuoteBlock('> <alice> hi\n> <bob> yo\nboth of you')).toEqual({
      quotes: '> <alice> hi\n> <bob> yo\n',
      body: 'both of you',
    });
    expect(splitQuoteBlock('> <alice> hi\n')).toEqual({ quotes: '> <alice> hi\n', body: '' });
    expect(splitQuoteBlock('plain')).toEqual({ quotes: '', body: 'plain' });
    expect(splitQuoteBlock('')).toEqual({ quotes: '', body: '' });
  });

  it('counts only complete quote lines, and only at the top', () => {
    expect(splitQuoteBlock('> <alice> hi')).toEqual({ quotes: '', body: '> <alice> hi' });
    expect(splitQuoteBlock('sure\n> <alice> hi\n')).toEqual({
      quotes: '',
      body: 'sure\n> <alice> hi\n',
    });
  });
});
