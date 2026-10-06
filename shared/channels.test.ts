// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { ensureChannelPrefix, isChannelTarget, stripChannelPrefix } from './channels.js';

describe('isChannelTarget (#724)', () => {
  it('accepts all four RFC 2811 prefixes, not just #', () => {
    // The whole point: `#`-only is the bug this replaced, in ~30 client sites.
    expect(isChannelTarget('#lurker')).toBe(true);
    expect(isChannelTarget('&local')).toBe(true);
    expect(isChannelTarget('+nomodes')).toBe(true);
    expect(isChannelTarget('!ABCDEsafe')).toBe(true);
  });

  it('rejects nicks', () => {
    expect(isChannelTarget('bob')).toBe(false);
    expect(isChannelTarget('bob_')).toBe(false);
    // A nick may legally contain a prefix character — only position one counts.
    expect(isChannelTarget('a#b')).toBe(false);
    expect(isChannelTarget('nick+tag')).toBe(false);
  });

  it('rejects the `:`-prefixed sentinels', () => {
    // `:server:` / `:system:` are real buffers but neither channel nor DM, and the callers that
    // ask this question rely on them answering false.
    expect(isChannelTarget(':server:1')).toBe(false);
    expect(isChannelTarget(':system:')).toBe(false);
  });

  it('is safe on absent and empty input', () => {
    expect(isChannelTarget('')).toBe(false);
    expect(isChannelTarget(null)).toBe(false);
    expect(isChannelTarget(undefined)).toBe(false);
  });
});

describe('stripChannelPrefix', () => {
  it('strips every leading sigil, not only #', () => {
    expect(stripChannelPrefix('#lurker')).toBe('lurker');
    expect(stripChannelPrefix('&local')).toBe('local');
    expect(stripChannelPrefix('##double')).toBe('double');
    expect(stripChannelPrefix('+plus')).toBe('plus');
  });

  it('leaves a nick alone', () => {
    expect(stripChannelPrefix('bob')).toBe('bob');
  });

  it('sorts &local next to #local rather than under punctuation', () => {
    // The sidebar/quick-switcher sort key. `&local` used to keep its sigil and file under `&`.
    expect(stripChannelPrefix('&local')).toBe(stripChannelPrefix('#local'));
  });
});

describe('ensureChannelPrefix', () => {
  it('prepends # to a bare name', () => {
    expect(ensureChannelPrefix('lurker')).toBe('#lurker');
  });

  it('leaves any RFC 2811 channel prefix untouched', () => {
    expect(ensureChannelPrefix('#chan')).toBe('#chan');
    expect(ensureChannelPrefix('&local')).toBe('&local');
    expect(ensureChannelPrefix('+modeless')).toBe('+modeless');
    expect(ensureChannelPrefix('!12345chan')).toBe('!12345chan');
  });

  it('does not validate — a lone prefix or empty string passes through / gets prefixed', () => {
    // Prefix-only concern: input validation (empty, whitespace, lone prefix)
    // stays with the caller, so these are intentionally not rejected here.
    expect(ensureChannelPrefix('#')).toBe('#');
    expect(ensureChannelPrefix('')).toBe('#');
  });
});
