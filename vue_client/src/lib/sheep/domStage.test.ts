// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment happy-dom

import { describe, it, expect, beforeEach } from 'vitest';
import { DomStage } from './world.js';

function surface(
  parent: Element,
  rect: [number, number, number, number],
  attrs: Record<string, string> = {},
) {
  const el = document.createElement('div');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  const [x, y, w, h] = rect;
  el.getBoundingClientRect = () =>
    ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y }) as DOMRect;
  parent.appendChild(el);
  return el;
}

describe('DomStage', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('is the viewport, with the floor at its bottom', () => {
    const stage = new DomStage();
    expect(stage.screen()).toEqual({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
    expect(stage.area()).toEqual(stage.screen());
  });

  it('lists tagged surfaces in stacking order and keeps their ids stable', async () => {
    const stage = new DomStage();
    const low = surface(document.body, [0, 100, 300, 50], { 'data-sheep-surface': '' });
    const raised = document.createElement('div');
    raised.style.position = 'relative';
    raised.style.zIndex = '100';
    document.body.appendChild(raised);
    surface(raised, [50, 40, 100, 20], { 'data-sheep-surface': '' });
    surface(document.body, [0, 0, 0, 0], { 'data-sheep-surface': '' }); // hidden: not listed

    const wins = stage.windows();
    expect(wins.map((w) => w.rect.y)).toEqual([100, 40]);
    const lowId = wins[0].id;
    expect(stage.windowRect(lowId)).toEqual({ x: 0, y: 100, w: 300, h: 50 });
    expect(stage.windows()[0].id).toBe(lowId);
    low.remove();
    await Promise.resolve(); // the scan is cached for one synchronous step
    expect(stage.windowRect(lowId)).toBeNull();
  });

  it('a scrim hides every surface stacked below it, leaving its own card', async () => {
    const stage = new DomStage();
    surface(document.body, [0, 100, 300, 50], { 'data-sheep-surface': '' });
    const modal = surface(document.body, [0, 0, 300, 300], { 'data-sheep-scrim': '' });
    modal.style.position = 'fixed';
    modal.style.zIndex = '100';
    const card = surface(modal, [50, 40, 100, 20], { 'data-sheep-surface': '' });
    const wins = stage.windows();
    expect(wins).toHaveLength(1);
    expect(wins[0].rect.y).toBe(40);
    // With the card gone but the scrim up, nothing is walkable but the floor...
    card.remove();
    await Promise.resolve();
    expect(stage.windows()).toEqual([]);
    // ...and the surface behind is back once the dialog closes.
    modal.remove();
    await Promise.resolve();
    expect(stage.windows().map((w) => w.rect.y)).toEqual([100]);
  });
});
