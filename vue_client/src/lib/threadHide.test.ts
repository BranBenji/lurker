// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { hiddenAsThreadReply } from './threadHide.js';

describe('hiddenAsThreadReply', () => {
  const reply = { replyTo: { root: 'm1' } };

  it('hides a plain reply with a root, only where threads are on', () => {
    expect(hiddenAsThreadReply(reply, true)).toBe(true);
    expect(hiddenAsThreadReply(reply, false)).toBe(false);
  });

  it('keeps a highlight inline: it badges the channel, so it needs a row', () => {
    expect(hiddenAsThreadReply({ ...reply, matched: true }, true)).toBe(false);
    expect(hiddenAsThreadReply({ ...reply, replyToSelf: true }, true)).toBe(false);
  });

  it('keeps a reply stored before roots were tracked, and a plain line', () => {
    expect(hiddenAsThreadReply({ replyTo: {} }, true)).toBe(false);
    expect(hiddenAsThreadReply({}, true)).toBe(false);
  });
});
