// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// useTheme turns the compact density settings (#1186) into the CSS lengths
// MessageList's compact rules read: px, a unitless line-height, ch.

import { describe, it, expect, beforeAll } from 'vitest';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { useTheme } from './useTheme.js';
import { useSettingsStore } from '../stores/settings.js';

const root = document.documentElement;
const read = (name: string) => root.style.getPropertyValue(name);

describe('useTheme — compact density variables', () => {
  // useTheme installs once per page, so one pinia serves every test here and
  // the tests mutate the same settings store.
  beforeAll(() => {
    setActivePinia(createPinia());
    useTheme();
  });

  it('writes the registry defaults on install, in the units the CSS consumes', async () => {
    await nextTick();
    expect(read('--compact-group-gap')).toBe('10px');
    expect(read('--compact-line-height')).toBe('1.55');
    expect(read('--compact-indent')).toBe('1ch');
  });

  it('follows a changed setting live: percent becomes a unitless multiplier', async () => {
    useSettingsStore().values = {
      'look.message.compact.group_gap': 0,
      'look.message.compact.line_height': 120,
      'look.message.compact.indent': 0,
    } as never;
    await nextTick();
    expect(read('--compact-group-gap')).toBe('0px');
    expect(read('--compact-line-height')).toBe('1.2');
    expect(read('--compact-indent')).toBe('0ch');
  });

  it('a reset falls back to the default without a stale override lingering', async () => {
    useSettingsStore().values = {} as never;
    await nextTick();
    expect(read('--compact-group-gap')).toBe('10px');
    expect(read('--compact-indent')).toBe('1ch');
  });
});
