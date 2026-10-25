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

  it('hides a highlight too: the Threads button and the badge carry it', () => {
    const mention = { ...reply, matched: true } as { replyTo: { root: string } };
    const toMe = { ...reply, replyToSelf: true } as { replyTo: { root: string } };
    expect(hiddenAsThreadReply(mention, true)).toBe(true);
    expect(hiddenAsThreadReply(toMe, true)).toBe(true);
  });

  it('keeps a reply stored before roots were tracked, and a plain line', () => {
    expect(hiddenAsThreadReply({ replyTo: {} }, true)).toBe(false);
    expect(hiddenAsThreadReply({}, true)).toBe(false);
  });
});
