// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { quoteLine, quoteMarks } from './replies.js';

// The Quote action's line (#1119): the way IRC writes the line, behind `> `.
describe('quoteLine', () => {
  it('writes a message as <nick> text', () => {
    expect(quoteLine({ nick: 'alice', type: 'message', text: 'what time is it?' })).toBe(
      '> <alice> what time is it?',
    );
    // No type is a message, as everywhere a line's type is read.
    expect(quoteLine({ nick: 'alice', text: 'hi' })).toBe('> <alice> hi');
  });

  it('writes an action and a notice the way the timeline does', () => {
    expect(quoteLine({ nick: 'bob', type: 'action', text: 'waves' })).toBe('> * bob waves');
    expect(quoteLine({ nick: 'ChanServ', type: 'notice', text: 'hello' })).toBe(
      '> -ChanServ- hello',
    );
    expect(quoteMarks('action')).toEqual(['* ', '']);
  });

  it('drops formatting codes — the quote is prose', () => {
    expect(quoteLine({ nick: 'alice', text: '\x02bold\x02 and \x034,5red\x03' })).toBe(
      '> <alice> bold and red',
    );
  });

  it('collapses a multi-line original to one line', () => {
    expect(quoteLine({ nick: 'alice', text: 'first\nsecond\r\n  third  ' })).toBe(
      '> <alice> first second third',
    );
  });

  it('quotes a line with no words left as the nick alone', () => {
    expect(quoteLine({ nick: 'alice', text: '\x02\x02' })).toBe('> <alice>');
  });
});
