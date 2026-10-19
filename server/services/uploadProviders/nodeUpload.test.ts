// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The hosted cell's pipeline limits come from the operator's environment. The
// size cap is the cell's upload CEILING (#1131): unclamped, so the operator can
// raise hosted uploads past the old 200 MB constant, and never 0.

import { describe, it, expect, afterEach } from 'vitest';
import { nodeUploadLimits } from './nodeUpload.js';

afterEach(() => {
  delete process.env.LURKER_NODE_UPLOAD_MAX_MB;
  delete process.env.LURKER_NODE_UPLOAD_MAX_DIM;
});

describe('nodeUploadLimits', () => {
  it('reads LURKER_NODE_UPLOAD_MAX_MB as the ceiling, past 200', () => {
    process.env.LURKER_NODE_UPLOAD_MAX_MB = '300';
    expect(nodeUploadLimits().maxMb).toBe(300);
  });

  it('falls back to the install default, never to the registry default of 0', () => {
    expect(nodeUploadLimits().maxMb).toBe(200);
    for (const raw of ['0', '-5', 'lots', '']) {
      process.env.LURKER_NODE_UPLOAD_MAX_MB = raw;
      expect(nodeUploadLimits().maxMb).toBe(200);
    }
  });

  it('still clamps the knobs that keep a registry max', () => {
    process.env.LURKER_NODE_UPLOAD_MAX_DIM = '999999';
    expect(nodeUploadLimits().maxDim).toBeLessThan(999999);
  });
});
