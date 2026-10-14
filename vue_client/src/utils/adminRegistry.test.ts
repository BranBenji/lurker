// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { isAdminTab, visibleAdminTabs } from './adminRegistry.js';

// DCC is self-host only, so a hosted cell's admin panel has no DCC tab, and
// /admin/dcc there falls back to the default tab rather than an empty pane.
describe('admin tabs by edition', () => {
  it('shows the DCC tab only when self-hosted', () => {
    expect(visibleAdminTabs(false).some((t) => t.id === 'dcc')).toBe(true);
    expect(visibleAdminTabs(true).some((t) => t.id === 'dcc')).toBe(false);
    expect(isAdminTab('dcc')).toBe(true);
    expect(isAdminTab('dcc', true)).toBe(false);
  });

  it('keeps every other tab in both editions', () => {
    expect(isAdminTab('users', true)).toBe(true);
    expect(isAdminTab('storage', true)).toBe(true);
  });
});
