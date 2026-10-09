// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment happy-dom

import { describe, it, expect } from 'vitest';
import { DomStage } from './world.js';

describe('DomStage', () => {
  it('is the viewport, with the floor at its bottom and no surfaces', () => {
    const stage = new DomStage();
    expect(stage.screen()).toEqual({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
    expect(stage.area()).toEqual(stage.screen());
    expect(stage.windows()).toEqual([]);
  });
});
