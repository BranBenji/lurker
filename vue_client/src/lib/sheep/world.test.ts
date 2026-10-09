// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PetModel, type PetAnimationSpec, type PetGraph } from './model.js';
import type { Pet, Rect, Stage, StageWindow } from './pet.js';
import { SheepWorld } from './world.js';

const spec = (over: Partial<PetAnimationSpec> & { id: number }): PetAnimationSpec => ({
  name: `a${over.id}`,
  start: { x: '0', y: '0', interval: '100', offsetY: 0, opacity: 1 },
  end: { x: '0', y: '0', interval: '100', offsetY: 0, opacity: 1 },
  sequence: { repeat: '0', repeatFrom: 0, frames: [0], action: '' },
  next: [],
  ...over,
});

// Walk forever; animation 2 spawns a child that finishes at once; 3 is the kill fade.
const graph: PetGraph = {
  author: 't',
  version: '1',
  frameWidth: 40,
  frameHeight: 40,
  tilesX: 2,
  tilesY: 2,
  colors: {},
  spawns: [{ id: 1, probability: 100, x: '100', y: 'areaH-imageH', next: 1 }],
  animations: {
    '1': spec({
      id: 1,
      name: 'walk',
      sequence: { repeat: '1000', repeatFrom: 0, frames: [0, 1], action: '' },
      next: [{ id: 1, probability: 100 }],
    }),
    '2': spec({ id: 2, name: 'spawner', next: [{ id: 1, probability: 100 }] }),
    '3': spec({
      id: 3,
      name: 'kill',
      start: { x: '0', y: '0', interval: '10', offsetY: 0, opacity: 1 },
      end: { x: '0', y: '0', interval: '10', offsetY: 0, opacity: 1 },
    }),
    '4': spec({ id: 4, name: 'poof' }),
  },
  children: { '2': [{ x: 'imageX', y: 'imageY', next: 4 }] },
  sounds: { '1': { probability: 100, file: 'walk.mp3' } },
};

class FakeStage implements Stage {
  surfaces: StageWindow[] = [];
  screen(): Rect {
    return { x: 0, y: 0, w: 300, h: 300 };
  }
  area(): Rect {
    return this.screen();
  }
  windows(): StageWindow[] {
    return this.surfaces;
  }
  windowRect(id: string): Rect | null {
    return this.surfaces.find((w) => w.id === id)?.rect ?? null;
  }
}

function makeWorld(over: { sounds?: boolean; scale?: number } = {}) {
  const views: Pet[] = [];
  const closed: Pet[] = [];
  const played: string[] = [];
  const world = new SheepWorld(new PetModel(graph, () => 0.5), new FakeStage(), {
    scale: () => over.scale ?? 1,
    soundsEnabled: () => over.sounds ?? true,
    playSound: (f) => played.push(f),
    onView: (p) => views.push(p),
    onClosed: (p) => closed.push(p),
    requestFrame: () => {},
    now: () => Date.now(), // the fake timers drive Date, so draw rates see time pass
  });
  return { world, views, closed, played };
}

describe('SheepWorld', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns top-level pets, reports their views, and plays sounds only when enabled', () => {
    const { world, views, played } = makeWorld();
    const a = world.spawn();
    expect(world.flock).toEqual([a]);
    expect(views).toContain(a);
    expect(played).toEqual(['walk.mp3']);
    const muted = makeWorld({ sounds: false });
    muted.world.spawn();
    expect(muted.played).toEqual([]);
  });

  it('registers children it spawns and forgets pets that close', () => {
    const { world, closed } = makeWorld();
    const a = world.spawn();
    a.jumpTo(2);
    expect(world.pets.size).toBe(2);
    const child = [...world.pets.values()].find((p) => p.isChild)!;
    expect(child.scale).toBe(a.scale);
    expect(world.flock).toEqual([a]);
    vi.advanceTimersByTime(300);
    expect(child.isClosed).toBe(true);
    expect(closed).toEqual([child]);
    expect(world.pets.size).toBe(1);
  });

  it('dying sheep are off the flock at once, gone later', () => {
    const { world, closed } = makeWorld();
    const a = world.spawn();
    const b = world.spawn();
    vi.advanceTimersByTime(100);
    a.kill();
    b.kill();
    expect(world.flock).toEqual([]);
    expect(world.topLevel).toHaveLength(2);
    // A new sheep during the fade is the whole flock.
    const c = world.spawn();
    expect(world.flock).toEqual([c]);
    vi.advanceTimersByTime(2000);
    expect(closed).toHaveLength(2);
    expect(world.pets.size).toBe(1);
  });

  it('measures how often a pet is drawn over the last few seconds, and forgets closed pets', () => {
    const { world } = makeWorld();
    const a = world.spawn();
    expect(world.drawRate(a.id)?.perSecond).toBeGreaterThan(0);
    // Past the window, the spawn's own placement has dropped out: one step
    // per 100ms — ten draws a second.
    vi.advanceTimersByTime(5200);
    expect(world.drawRate(a.id)!.perSecond).toBeCloseTo(10, 0);
    a.kill();
    vi.advanceTimersByTime(3000);
    expect(a.isClosed).toBe(true);
    expect(world.drawRate(a.id)).toBeNull();
  });

  it('pauses and resumes every top-level pet', () => {
    const { world } = makeWorld();
    const a = world.spawn();
    vi.advanceTimersByTime(100);
    const frame = a.view.frame;
    world.pauseAll();
    vi.advanceTimersByTime(500);
    expect(a.view.frame).toBe(frame);
    world.resumeAll();
    vi.advanceTimersByTime(100);
    expect(a.view.frame).not.toBe(frame);
  });

  it('setScale resizes every pet', () => {
    const { world } = makeWorld();
    const a = world.spawn();
    world.setScale(2);
    expect(a.petWidth).toBe(80);
  });
});

describe('SheepWorld (trace)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a busy pet from crowding a quiet one out of the trace', () => {
    const { world } = makeWorld();
    const quiet = world.spawn();
    const busy = world.spawn();
    for (let i = 0; i < 200; i++) world.trace(busy, `step ${i}`);
    const mine = (p: { id: number }) => world.traces.filter((t) => t.petId === p.id);
    expect(mine(busy)).toHaveLength(15);
    expect(mine(busy)[0].event).toBe('step 185');
    expect(mine(quiet).length).toBeGreaterThan(0);
  });
});
