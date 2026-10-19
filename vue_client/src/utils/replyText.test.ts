// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  quoteBlocks,
  quoteLineFor,
  replyExcerpt,
  splitQuoteBlock,
  stripReplyAddress,
} from './replyText.js';
import { splitTextByTokens } from './nickColor.js';

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

  it('keeps a spoiler hidden, as the composer’s ||markup||', () => {
    expect(quoteLineFor({ nick: 'alice', text: 'the killer is \x0314,14bob\x03' })).toBe(
      '> <alice> the killer is ||bob||',
    );
    // A clip that lands inside the spoiler closes it rather than opening it.
    const clipped = quoteLineFor(
      { nick: 'alice', text: `the killer is \x0314,14${'b'.repeat(200)}\x03` },
      60,
    );
    expect(clipped).toMatch(/^> <alice> the killer is \|\|b+\|\|…$/);
  });

  it('measures the clip as the line will go out', () => {
    // The composer's spoiler rewrite adds bytes; the clip is measured through it.
    const measure = (s: string) => new TextEncoder().encode(s).length + (s.includes('||') ? 6 : 0);
    const line = quoteLineFor(
      { nick: 'alice', text: `\x0314,14${'x'.repeat(200)}\x03` },
      60,
      measure,
    );
    expect(measure(line)).toBeLessThanOrEqual(60);
    expect(line).toMatch(/^> <alice> \|\|x+\|\|…$/);
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

describe('quoteBlocks', () => {
  const segs = (text: string) => splitTextByTokens(text, null, null, null);
  const texts = (blocks: ReturnType<typeof quoteBlocks>) =>
    blocks!.map((b) => [b.quote, b.segments.map((s) => s.text).join('')]);

  it('is null for a message that quotes nothing, so it renders as before', () => {
    expect(quoteBlocks(segs('hello there'))).toBeNull();
    expect(quoteBlocks(segs('a\nb'))).toBeNull();
    expect(quoteBlocks(segs(''))).toBeNull();
  });

  it('splits the quote line from the answer and drops the mark', () => {
    expect(texts(quoteBlocks(segs('> <alice> what time is it?\nnoon')))).toEqual([
      [true, '<alice> what time is it?'],
      [false, 'noon'],
    ]);
  });

  it('keeps consecutive quote lines as one block, one bar', () => {
    expect(texts(quoteBlocks(segs('> <alice> hi\n> <bob> yo\nboth of you')))).toEqual([
      [true, '<alice> hi\n<bob> yo'],
      [false, 'both of you'],
    ]);
  });

  it('quotes a line anywhere in the message, not only the first', () => {
    expect(texts(quoteBlocks(segs('she said\n> <alice> hi\nto me')))).toEqual([
      [false, 'she said'],
      [true, '<alice> hi'],
      [false, 'to me'],
    ]);
  });

  // The mark is two characters, and a formatting change can fall between them.
  it('reads the mark across formatting and keeps the formatting', () => {
    const blocks = quoteBlocks(segs('\x02>\x02 bold mark\nplain'));
    expect(texts(blocks)).toEqual([
      [true, 'bold mark'],
      [false, 'plain'],
    ]);
    const bold = quoteBlocks(segs('\x02> bold\x02 line\nplain'))!;
    expect(bold[0].segments[0]).toMatchObject({ text: 'bold', bold: true });
  });

  it('cuts a segment that spans the break, keeping its formatting on both halves', () => {
    const blocks = quoteBlocks(segs('> \x1dquoted\nanswer\x1d'))!;
    expect(blocks[0].segments).toEqual([{ text: 'quoted', italic: true }]);
    expect(blocks[1].segments).toEqual([{ text: 'answer', italic: true }]);
  });

  // One spoiler run is one box to reveal: never cut, even across a break.
  it('keeps a spoiler run that spans a break in one piece', () => {
    const blocks = quoteBlocks(segs('> <alice> hi\n\x0314,14one\ntwo\x03 end'))!;
    expect(blocks[1].segments).toEqual([
      { text: 'one\ntwo', spoiler: true, fg: 14 },
      { text: ' end' },
    ]);
  });

  // A block box ends at its last break, so a blank line left there would vanish;
  // one at the start of the next block already shows. Both sides keep theirs.
  it('keeps a blank line on either side of a quote block', () => {
    expect(texts(quoteBlocks(segs('she said\n\n> <alice> hi\n\nback')))).toEqual([
      [false, 'she said\n\n'],
      [true, '<alice> hi'],
      [false, '\nback'],
    ]);
    expect(texts(quoteBlocks(segs('> <alice> hi\n\n> <bob> yo')))).toEqual([
      [true, '<alice> hi'],
      [false, '\n'],
      [true, '<bob> yo'],
    ]);
  });

  // A quoted link whose picture is shown instead: MessageBody drops the address
  // and trims the space with it, leaving the mark alone. Still a quote.
  it('counts a line that is the mark alone', () => {
    expect(texts(quoteBlocks(segs('>\nnice')))).toEqual([
      [true, ''],
      [false, 'nice'],
    ]);
  });

  // `>implying` is greentext, not a quote; a mark hidden in a spoiler is hidden.
  it('needs the space, and ignores a mark inside a spoiler', () => {
    expect(quoteBlocks(segs('>implying\nno'))).toBeNull();
    expect(quoteBlocks(segs('\x031,1> secret\x03\nno'))).toBeNull();
  });
});
