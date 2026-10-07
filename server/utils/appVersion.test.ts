// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The release version lives in two hand-edited manifests: the server's
// APP_VERSION (User-Agent, CTCP VERSION, the engine log) comes from the root
// package.json, the client's build stamp (Settings → About) from
// vue_client/package.json via vite.config.ts. Nothing else keeps them equal,
// so a half-done bump — one file edited, the other forgotten — passed CI.
// This is the one line that doesn't.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { APP_VERSION } from './userAgent.js';

const read = (rel: string) =>
  (
    JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../..', rel), 'utf8')) as {
      version: string;
    }
  ).version;

describe('release version', () => {
  it('is the same in the root and vue_client manifests, and is what the server reports', () => {
    const root = read('package.json');
    expect(read('vue_client/package.json')).toBe(root);
    expect(APP_VERSION).toBe(root);
    expect(root).toMatch(/^\d+\.\d+\.\d+/);
  });
});
