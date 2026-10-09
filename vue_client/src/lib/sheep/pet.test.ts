// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PetModel, type PetAnimationSpec, type PetChild, type PetGraph } from './model.js';
import { DragVelocity, Pet, type PetHost, type Rect, type Stage, type StageWindow } from './pet.js';

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const spec = (over: Partial<PetAnimationSpec> & { id: number }): PetAnimationSpec => ({
  name: `a${over.id}`,
  start: { x: '0', y: '0', interval: '100', offsetY: 0, opacity: 1 },
  end: { x: '0', y: '0', interval: '100', offsetY: 0, opacity: 1 },
  sequence: { repeat: '0', repeatFrom: 0, frames: [over.id], action: '' },
  next: [],
  ...over,
});

const move = (x: string, y: string, interval = '100') => ({
  x,
  y,
  interval,
  offsetY: 0,
  opacity: 1,
});

// A tiny pet: walks left along the floor, turns at the screen edge, idles on
// the taskbar, falls under gravity, lands on the floor or a surface, spawns a
// child from one animation, and has the usual specials.
const WALK = 1;
const IDLE = 2;
const SPAWNER = 3;
const TURN = 4;
const FALL = 5;
const LAND = 6;
const LAND_WINDOW = 7;
const DRAG = 8;
const FALL_SOFT = 9;
const FALL_HARD = 10;
const KILL = 11;
const TOSS = 12;
const POOF = 13;

function tinyGraph(): PetGraph {
  const animations = [
    spec({
      id: WALK,
      name: 'walk',
      start: move('-2', '0'),
      end: move('-2', '0'),
      sequence: { repeat: '3', repeatFrom: 0, frames: [0, 1], action: '' },
      // Idle on the taskbar or a surface; with nothing eligible elsewhere a
      // finished walk respawns, like the original.
      next: [
        { id: IDLE, probability: 100, only: 'taskbar' },
        { id: IDLE, probability: 100, only: 'window' },
      ],
      border: [{ id: TURN, probability: 100, only: 'vertical' }],
      gravity: [{ id: FALL, probability: 100 }],
    }),
    spec({ id: IDLE, name: 'idle', next: [{ id: WALK, probability: 100 }] }),
    spec({ id: SPAWNER, name: 'spawner', next: [{ id: WALK, probability: 100 }] }),
    spec({
      id: TURN,
      name: 'turn',
      sequence: { repeat: '0', repeatFrom: 0, frames: [4], action: 'flip' },
      next: [{ id: WALK, probability: 100 }],
    }),
    spec({
      id: FALL,
      name: 'fall',
      start: move('0', '10', '50'),
      end: move('0', '10', '50'),
      sequence: { repeat: '1000', repeatFrom: 0, frames: [5], action: '' },
      border: [
        { id: LAND, probability: 100, only: 'taskbar' },
        { id: LAND_WINDOW, probability: 100, only: 'window' },
      ],
    }),
    spec({ id: LAND, name: 'land', next: [{ id: WALK, probability: 100 }] }),
    spec({ id: LAND_WINDOW, name: 'land window', next: [{ id: WALK, probability: 100 }] }),
    spec({
      id: DRAG,
      name: 'drag',
      sequence: { repeat: '1000', repeatFrom: 0, frames: [8], action: '' },
    }),
    spec({ id: FALL_SOFT, name: 'fall soft', next: [{ id: WALK, probability: 100 }] }),
    spec({ id: FALL_HARD, name: 'fall hard', next: [{ id: WALK, probability: 100 }] }),
    spec({ id: KILL, name: 'kill', start: move('0', '0', '10'), end: move('0', '0', '10') }),
    spec({
      id: TOSS,
      name: 'toss',
      sequence: { repeat: '1000', repeatFrom: 0, frames: [12], action: '' },
    }),
    spec({ id: POOF, name: 'poof' }),
  ];
  return {
    author: 'test',
    version: '1',
    frameWidth: 40,
    frameHeight: 40,
    tilesX: 4,
    tilesY: 4,
    colors: {},
    spawns: [{ id: 1, probability: 100, x: 'screenW-imageW', y: 'areaH-imageH', next: WALK }],
    animations: Object.fromEntries(animations.map((a) => [String(a.id), a])),
    children: { [SPAWNER]: [{ x: 'imageX', y: 'imageY', next: POOF }] },
    sounds: { [IDLE]: { probability: 100, file: 'idle.mp3' } },
  };
}

class TestStage implements Stage {
  constructor(
    public size: Rect = { x: 0, y: 0, w: 200, h: 300 },
    public surfaces: StageWindow[] = [],
  ) {}
  screen(): Rect {
    return this.size;
  }
  area(): Rect {
    return this.size;
  }
  windows(): StageWindow[] {
    return this.surfaces;
  }
  windowRect(id: string): Rect | null {
    return this.surfaces.find((w) => w.id === id)?.rect ?? null;
  }
}

class TestHost implements PetHost {
  renders = 0;
  traces: string[] = [];
  sounds: string[] = [];
  children: Array<{ parent: Pet; child: PetChild }> = [];
  closed: Pet[] = [];
  frames: Array<(now: number) => void> = [];
  clock = 0;
  pets: Pet[] = [];
  constructor(
    private readonly model: PetModel,
    private readonly stage: Stage,
  ) {}
  render(): void {
    this.renders++;
  }
  playSound(file: string): void {
    this.sounds.push(file);
  }
  spawnChild(parent: Pet, child: PetChild): void {
    this.children.push({ parent, child });
    const pet = new Pet(this.model, this.stage, this, parent.scale, parent);
    this.pets.push(pet);
    pet.playChild(child);
  }
  petClosed(pet: Pet): void {
    this.closed.push(pet);
  }
  trace(_pet: Pet, event: string): void {
    this.traces.push(event);
  }
  requestFrame(cb: (now: number) => void): void {
    this.frames.push(cb);
  }
  now(): number {
    return this.clock;
  }
  /** Run the queued animation frames once, at `now`. */
  runFrames(now: number): void {
    const list = this.frames;
    this.frames = [];
    this.clock = now;
    for (const cb of list) cb(now);
  }
}

function setup(graph = tinyGraph(), stage = new TestStage(), seed = 1) {
  const model = new PetModel(graph, seeded(seed));
  const host = new TestHost(model, stage);
  const pet = new Pet(model, stage, host);
  const visited: number[] = [];
  const origRender = host.render.bind(host);
  host.render = () => {
    origRender();
    const id = pet.currentAnimation.id;
    if (visited[visited.length - 1] !== id) visited.push(id);
  };
  return { model, host, pet, stage, visited };
}

describe('Pet', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns where the spawn says, hidden, and starts the spawn animation', () => {
    const { pet, visited } = setup();
    pet.play();
    expect(pet.view).toMatchObject({ x: 160, y: 260, opacity: 0, frame: 0, flipped: false });
    expect(visited).toEqual([WALK]);
  });

  it('walks left two pixels per step', () => {
    const { pet } = setup();
    pet.play();
    vi.advanceTimersByTime(100);
    expect(pet.view.x).toBe(158);
    expect(pet.view.opacity).toBe(1);
    vi.advanceTimersByTime(100);
    expect(pet.view.x).toBe(156);
    expect(pet.view.frame).toBe(1);
  });

  it('idles on the taskbar between walks and plays the idle sound', () => {
    const { pet, host, visited } = setup();
    pet.play();
    // One walk is 2 frames × (1 + 3 repeats) = 8 steps.
    vi.advanceTimersByTime(100 * 9);
    expect(visited).toEqual([WALK, IDLE]);
    expect(host.sounds).toEqual(['idle.mp3']);
    expect(pet.view.y).toBe(260);
  });

  it('turns at the screen edge instead of leaving and never crosses it', () => {
    const { pet, visited } = setup();
    pet.play();
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < 400; i++) {
      vi.advanceTimersByTime(100);
      minX = Math.min(minX, pet.view.x);
      maxX = Math.max(maxX, pet.view.x);
    }
    expect(visited).toContain(TURN);
    expect(minX).toBeGreaterThanOrEqual(0);
    expect(maxX).toBeLessThanOrEqual(160);
    // The turn flipped the sprite: we have walked both ways.
    expect(visited.indexOf(TURN)).toBeGreaterThan(0);
    expect(pet.view.flipped).toBe(!pet.movingLeft);
  });

  it('falls under gravity to the floor and lands there', () => {
    const graph = tinyGraph();
    graph.spawns = [{ id: 1, probability: 100, x: '100', y: '0', next: WALK }];
    const { pet, visited } = setup(graph);
    pet.play();
    vi.advanceTimersByTime(5000);
    expect(visited.slice(0, 3)).toEqual([WALK, FALL, LAND]);
    expect(pet.view.y).toBe(260);
    expect(visited).toContain(WALK);
  });

  it('lands on a surface, walks along it, and drops off its edge', () => {
    const graph = tinyGraph();
    graph.spawns = [{ id: 1, probability: 100, x: '100', y: '0', next: WALK }];
    const stage = new TestStage({ x: 0, y: 0, w: 200, h: 300 }, [
      { id: 'composer', rect: { x: 60, y: 150, w: 100, h: 60 } },
    ]);
    const { pet, visited } = setup(graph, stage);
    pet.play();
    vi.advanceTimersByTime(1500);
    expect(visited.slice(0, 3)).toEqual([WALK, FALL, LAND_WINDOW]);
    expect(pet.view.y).toBe(150 - 40);
    // Keep walking left: off the surface's edge the pet falls to the floor.
    vi.advanceTimersByTime(8000);
    expect(visited).toContain(LAND);
    expect(pet.view.y).toBe(260);
  });

  it('spawns a child from an animation with child entries; the child closes when its sequence ends', () => {
    const { pet, host } = setup();
    pet.play();
    pet.jumpTo(SPAWNER);
    expect(host.children).toHaveLength(1);
    expect(host.children[0].child.next).toBe(POOF);
    const child = host.pets[0];
    expect(child.isChild).toBe(true);
    expect(child.childDepth).toBe(1);
    expect(child.view.x).toBe(pet.view.x);
    expect(pet.childPets).toContain(child);
    vi.advanceTimersByTime(300);
    expect(host.closed).toContain(child);
    expect(child.isClosed).toBe(true);
    expect(pet.isClosed).toBe(false);
  });

  it('kill fades the pet out over the kill animation and then closes it', () => {
    const { pet, host } = setup();
    pet.play();
    vi.advanceTimersByTime(100); // visible now (a spawn starts hidden)
    expect(pet.view.opacity).toBe(1);
    pet.kill();
    expect(pet.currentAnimation.id).toBe(KILL);
    const opacities: number[] = [];
    // The running step finishes at the walk's interval; the kill ticks every 10ms after that.
    vi.advanceTimersByTime(100);
    for (let i = 0; i < 30 && !pet.isClosed; i++) {
      vi.advanceTimersByTime(10);
      opacities.push(pet.view.opacity);
    }
    expect(opacities[0]).toBeLessThan(1);
    expect(pet.isClosed).toBe(true);
    expect(host.closed).toEqual([pet]);
    for (let i = 1; i < opacities.length; i++) {
      expect(opacities[i]).toBeLessThanOrEqual(opacities[i - 1]);
    }
    // Nothing else can interrupt a kill.
    pet.jumpTo(WALK);
    expect(pet.currentAnimation.id).toBe(KILL);
  });

  it('kill closes the children too', () => {
    const { pet, host } = setup();
    pet.play();
    pet.jumpTo(SPAWNER);
    const child = host.pets[0];
    pet.kill();
    expect(child.isClosed).toBe(true);
  });

  it('close without a kill animation closes at once', () => {
    const graph = tinyGraph();
    delete graph.animations[String(KILL)];
    const { pet, host } = setup(graph);
    pet.play();
    pet.kill();
    expect(pet.isClosed).toBe(true);
    expect(host.closed).toEqual([pet]);
    // A closed pet never ticks again.
    const renders = host.renders;
    vi.advanceTimersByTime(1000);
    expect(host.renders).toBe(renders);
  });

  it('follows the pointer while dragged and falls when released still', () => {
    const { pet, host, visited } = setup();
    pet.play();
    host.clock = 1000;
    pet.dragStart(170, 270);
    expect(pet.currentAnimation.id).toBe(DRAG);
    host.clock = 1050;
    pet.dragMove(100, 100);
    expect(pet.view).toMatchObject({ x: 90, y: 90 });
    vi.advanceTimersByTime(100);
    expect(pet.view).toMatchObject({ x: 90, y: 90 });
    host.clock = 1300; // the pointer stopped before release → no toss
    pet.dragEnd(100, 100);
    expect(pet.currentAnimation.id).toBe(FALL);
    vi.advanceTimersByTime(3000);
    expect(visited).toContain(LAND);
    expect(pet.view.y).toBe(260);
  });

  it('a fling tosses the pet, bounces it off the wall and lands it with a fall animation', () => {
    const { pet, host, visited } = setup();
    pet.play();
    host.clock = 0;
    pet.dragStart(170, 270);
    for (let t = 16; t <= 96; t += 16) {
      host.clock = t;
      pet.dragMove(170 - t * 3, 270 - t * 2);
    }
    host.clock = 100;
    pet.dragEnd(170 - 300, 270 - 200);
    expect(pet.currentAnimation.id).toBe(TOSS);
    expect(host.frames).toHaveLength(1);
    let minX = Infinity;
    for (let now = 116; now < 6000 && pet.currentAnimation.id === TOSS; now += 16) {
      host.runFrames(now);
      minX = Math.min(minX, pet.view.x);
    }
    expect(minX).toBeGreaterThanOrEqual(0);
    expect([FALL_SOFT, FALL_HARD]).toContain(pet.currentAnimation.id);
    expect(pet.view.y).toBe(260);
    expect(host.frames).toHaveLength(0);
    // The tick timer keeps running after the landing.
    vi.advanceTimersByTime(500);
    expect(visited).toContain(WALK);
  });

  it('children cannot be dragged', () => {
    const { pet, host } = setup();
    pet.play();
    pet.jumpTo(SPAWNER);
    const child = host.pets[0];
    const before = child.currentAnimation.id;
    child.dragStart(0, 0);
    expect(child.currentAnimation.id).toBe(before);
  });

  it('pause stops the clock and resume picks it up', () => {
    const { pet } = setup();
    pet.play();
    vi.advanceTimersByTime(100);
    const x = pet.view.x;
    pet.pause();
    vi.advanceTimersByTime(1000);
    expect(pet.view.x).toBe(x);
    pet.resume();
    vi.advanceTimersByTime(100);
    expect(pet.view.x).toBe(x - 2);
  });

  it('recoverLayout pulls a pet that the viewport shrank away from back inside', () => {
    const stage = new TestStage();
    const { pet } = setup(tinyGraph(), stage);
    pet.play();
    stage.size = { x: 0, y: 0, w: 100, h: 100 };
    pet.recoverLayout();
    expect(pet.view).toMatchObject({ x: 60, y: 60 });
  });

  it('setScale doubles the pet and its moves from the next animation on', () => {
    const { pet } = setup();
    pet.play();
    pet.setScale(2);
    expect(pet.petWidth).toBe(80);
    // The bigger pet is pulled inside the right edge first (200 - 80), then walks 2×2.
    pet.jumpTo(WALK);
    vi.advanceTimersByTime(100);
    expect(pet.view.x).toBe(120 - 4);
  });

  it('runs the shipped gSheep graph for a long while without leaving the stage', () => {
    const graph: PetGraph = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../public/sheep/gsheep.json', import.meta.url)),
        'utf8',
      ),
    );
    const stage = new TestStage({ x: 0, y: 0, w: 1280, h: 720 }, [
      { id: 'composer', rect: { x: 260, y: 660, w: 1000, h: 60 } },
    ]);
    const { pet, host, visited } = setup(graph, stage, 42);
    pet.play();
    const tiles = graph.tilesX * graph.tilesY;
    for (let i = 0; i < 20000; i++) {
      vi.advanceTimersByTime(50);
      for (const p of [pet, ...host.pets]) {
        if (p.isClosed) continue;
        expect(Number.isFinite(p.view.x) && Number.isFinite(p.view.y)).toBe(true);
        expect(p.view.frame).toBeGreaterThanOrEqual(0);
        expect(p.view.frame).toBeLessThan(tiles);
        // Leaving the screen is allowed (it respawns), teleporting far away is not.
        expect(Math.abs(p.view.x)).toBeLessThan(1280 + 40 * 20);
        expect(Math.abs(p.view.y)).toBeLessThan(720 + 40 * 20);
      }
    }
    expect(pet.isClosed).toBe(false);
    expect(new Set(visited).size).toBeGreaterThan(10);
  });
});

describe('DragVelocity', () => {
  // The upstream MotionTests.cs drag checks.
  it('release speed is independent of the event cadence', () => {
    for (const cadence of [8, 20, 40]) {
      const v = new DragVelocity();
      v.reset(0, 0, 0);
      for (let t = cadence; t <= 160; t += cadence) v.add(t, -t, t);
      const f = v.tossForce(160);
      expect(f.dx).toBeCloseTo(10, 3);
      expect(f.dy).toBeCloseTo(-10, 3);
      // Holding still before the release stops the toss; stale samples never throw the pet.
      for (let t = 168; t <= 280; t += 8) v.add(160, -160, t);
      expect(Math.hypot(v.tossForce(280).dx, v.tossForce(280).dy)).toBeCloseTo(0, 3);
      expect(Math.hypot(v.tossForce(500).dx, v.tossForce(500).dy)).toBeCloseTo(0, 3);
    }
  });
});

function landOnSurface() {
  const graph = tinyGraph();
  graph.spawns = [{ id: 1, probability: 100, x: '100', y: '0', next: WALK }];
  const stage = new TestStage({ x: 0, y: 0, w: 200, h: 300 }, [
    { id: 'composer', rect: { x: 60, y: 150, w: 100, h: 60 } },
  ]);
  const { pet, visited, host } = setup(graph, stage);
  pet.play();
  vi.advanceTimersByTime(1500);
  expect(visited).toContain(LAND_WINDOW);
  expect(pet.view.y).toBe(110);
  return { pet, stage, host };
}

describe('Pet (review fixes)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('follows a surface that moves or resizes even during an animation without gravity', () => {
    const { pet, stage } = landOnSurface();
    pet.jumpTo(DRAG); // long, no gravity
    stage.surfaces[0] = { id: 'composer', rect: { x: 60, y: 130, w: 100, h: 80 } };
    vi.advanceTimersByTime(100);
    expect(pet.view.y).toBe(90);
    // A resize scales the pet's position along the surface.
    stage.surfaces[0] = { id: 'composer', rect: { x: 0, y: 130, w: 200, h: 80 } };
    const before = pet.view.x;
    vi.advanceTimersByTime(100);
    expect(pet.view.x).toBe((before - 60) * 2);
  });

  it('stands back on the floor when the floor rises under it', () => {
    const stage = new TestStage();
    const { pet } = setup(tinyGraph(), stage);
    pet.play();
    vi.advanceTimersByTime(100);
    expect(pet.view.y).toBe(260);
    stage.size = { x: 0, y: 0, w: 200, h: 240 };
    vi.advanceTimersByTime(100);
    expect(pet.view.y).toBe(200);
  });

  it('setScale keeps a floor-standing pet on the floor and inside the right edge', () => {
    const { pet } = setup();
    pet.play();
    vi.advanceTimersByTime(100);
    pet.setScale(3);
    expect(pet.view.y).toBe(300 - 120);
    expect(pet.view.x).toBeLessThanOrEqual(200 - 120);
  });

  it('a child that finishes drops out of its parent', () => {
    const { pet, host } = setup();
    pet.play();
    pet.jumpTo(SPAWNER);
    const child = host.pets[0];
    expect(pet.childPets).toContain(child);
    vi.advanceTimersByTime(300);
    expect(child.isClosed).toBe(true);
    expect(pet.childPets).not.toContain(child);
  });

  it('isDying is true only during the kill fade', () => {
    const { pet } = setup();
    pet.play();
    expect(pet.isDying).toBe(false);
    pet.kill();
    expect(pet.isDying).toBe(true);
  });

  it('dragCancel drops the pet where it is with no toss', () => {
    const { pet, host, visited } = setup();
    pet.play();
    host.clock = 0;
    pet.dragStart(170, 270);
    for (let t = 16; t <= 96; t += 16) {
      host.clock = t;
      pet.dragMove(170 - t * 3, 270 - t * 2);
    }
    const { x, y } = pet.view;
    pet.dragCancel();
    expect(pet.currentAnimation.id).toBe(FALL);
    expect(host.frames).toHaveLength(0);
    expect(pet.view).toMatchObject({ x, y });
    vi.advanceTimersByTime(3000);
    expect(visited).toContain(LAND);
  });
});

describe('Pet (surfaces near the top)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function fallOnto(surfaceTop: number) {
    const graph = tinyGraph();
    graph.spawns = [{ id: 1, probability: 100, x: '100', y: '0-imageH', next: FALL }];
    const stage = new TestStage({ x: 0, y: 0, w: 200, h: 300 }, [
      { id: 'messages', rect: { x: 0, y: surfaceTop, w: 200, h: 100 } },
    ]);
    const { pet, visited } = setup(graph, stage);
    pet.play();
    vi.advanceTimersByTime(3000);
    return { pet, visited };
  }

  it('lands on a surface right under the topic bar, standing inside it', () => {
    const { pet, visited } = fallOnto(50);
    expect(visited).toContain(LAND_WINDOW);
    expect(pet.view.y).toBe(10);
  });

  it('still refuses a surface the sheep would not fit above', () => {
    const { pet, visited } = fallOnto(30);
    expect(visited).not.toContain(LAND_WINDOW);
    expect(visited).toContain(LAND);
    expect(pet.view.y).toBe(260);
  });
});

describe('Pet (seams between surfaces)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function dropOnto(surfaces: StageWindow[], x = '140') {
    const graph = tinyGraph();
    graph.spawns = [{ id: 1, probability: 100, x, y: '0', next: WALK }];
    const stage = new TestStage({ x: 0, y: 0, w: 200, h: 300 }, surfaces);
    const { pet, visited } = setup(graph, stage);
    pet.play();
    vi.advanceTimersByTime(1500);
    expect(visited.slice(0, 3)).toEqual([WALK, FALL, LAND_WINDOW]);
    expect(pet.view.y).toBe(110);
    return { pet, visited };
  }

  it('walks across the seam onto a neighbouring surface on the same line', () => {
    const { pet, visited } = dropOnto([
      { id: 'messages', rect: { x: 100, y: 150, w: 100, h: 100 } },
      { id: 'members', rect: { x: 0, y: 150, w: 100, h: 100 } },
    ]);
    // Follow it across: it reaches the far surface still standing on the line,
    // without another fall in between.
    const landed = visited.length;
    let reached = false;
    for (let i = 0; i < 80 && !reached; i++) {
      vi.advanceTimersByTime(100);
      if (pet.view.x < 60) reached = true;
      expect(pet.view.y).toBe(110);
    }
    expect(reached).toBe(true);
    expect(visited.slice(landed)).not.toContain(FALL);
  });

  it('a neighbour on the same line does not count as covering the edge', () => {
    // The neighbour is stacked above (later) and one pixel of the pet already
    // overlaps it on landing: no fall.
    const { pet, visited } = dropOnto(
      [
        { id: 'messages', rect: { x: 100, y: 150, w: 100, h: 100 } },
        { id: 'members', rect: { x: 0, y: 150, w: 100, h: 100 } },
      ],
      '101',
    );
    vi.advanceTimersByTime(2000);
    expect(visited.filter((id) => id === FALL)).toHaveLength(1);
    expect(pet.view.y).toBe(110);
  });

  it('a tall surface opening under the pet covers its edge and drops it', () => {
    const surfaces: StageWindow[] = [{ id: 'messages', rect: { x: 0, y: 150, w: 200, h: 100 } }];
    const { pet, visited } = dropOnto(surfaces);
    // A dialog opens under the sheep, reaching well above the ledge.
    surfaces.push({ id: 'dialog', rect: { x: 100, y: 60, w: 100, h: 190 } });
    vi.advanceTimersByTime(3000);
    expect(visited.filter((id) => id === FALL).length).toBeGreaterThan(1);
    expect(pet.view.y).toBe(260);
  });
});

describe('Pet (edge overhang)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('walks until its centre passes the edge of a surface before it drops', () => {
    const graph = tinyGraph();
    graph.spawns = [{ id: 1, probability: 100, x: '120', y: '0', next: WALK }];
    const stage = new TestStage({ x: 0, y: 0, w: 200, h: 300 }, [
      { id: 'card', rect: { x: 100, y: 150, w: 100, h: 60 } },
    ]);
    const { pet, visited } = setup(graph, stage);
    pet.play();
    vi.advanceTimersByTime(1500);
    expect(visited).toContain(LAND_WINDOW);
    // Standing on the card: keep walking left and note where it leaves the line.
    let lastOnLine = pet.view.x;
    for (let i = 0; i < 60 && pet.view.y === 110; i++) {
      lastOnLine = pet.view.x;
      vi.advanceTimersByTime(100);
    }
    // Half the sheep (20px) hangs over the card's left edge at x = 100 before it falls.
    expect(lastOnLine).toBeLessThanOrEqual(82);
    expect(lastOnLine).toBeGreaterThanOrEqual(78);
  });
});

describe('Pet (randS and falling clear)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('parent and child share one randS, so a child placed by it meets its parent', () => {
    const graph = tinyGraph();
    graph.spawns = [{ id: 1, probability: 100, x: 'randS+50', y: 'areaH-imageH', next: WALK }];
    graph.children = { [SPAWNER]: [{ x: 'randS+50', y: 'imageY', next: POOF }] };
    const { pet, host, model } = setup(graph);
    pet.play();
    expect(pet.view.x).toBe(model.randS + 50);
    pet.jumpTo(SPAWNER);
    expect(host.pets[0].view.x).toBe(model.randS + 50);
  });

  it('slips clear of the edge it drops off instead of falling through the surface', () => {
    const graph = tinyGraph();
    graph.spawns = [{ id: 1, probability: 100, x: '120', y: '0', next: WALK }];
    const stage = new TestStage({ x: 0, y: 0, w: 200, h: 300 }, [
      { id: 'card', rect: { x: 100, y: 150, w: 100, h: 60 } },
    ]);
    const { pet, visited } = setup(graph, stage);
    pet.play();
    vi.advanceTimersByTime(1500);
    expect(visited).toContain(LAND_WINDOW);
    // Walk off the left edge: the moment it is below the card's top it is beside the card.
    for (let i = 0; i < 80 && pet.view.y <= 110; i++) vi.advanceTimersByTime(100);
    expect(pet.view.y).toBeGreaterThan(110);
    expect(pet.view.x + 40).toBeLessThanOrEqual(100);
  });
});

describe('Pet (surfaces flush with the screen edge)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats a surface edge on the screen edge as a wall and never leaves the screen', () => {
    const graph = tinyGraph();
    graph.spawns = [{ id: 1, probability: 100, x: '60', y: '0', next: WALK }];
    const stage = new TestStage({ x: 0, y: 0, w: 200, h: 300 }, [
      { id: 'foot', rect: { x: 0, y: 150, w: 120, h: 60 } },
    ]);
    const { pet, visited } = setup(graph, stage);
    pet.play();
    vi.advanceTimersByTime(1500);
    expect(visited).toContain(LAND_WINDOW);
    let minX = Infinity;
    let fellAtTheWall = false;
    for (let i = 0; i < 100; i++) {
      vi.advanceTimersByTime(100);
      minX = Math.min(minX, pet.view.x);
      if (pet.currentAnimation.id === FALL && pet.view.x < 20) fellAtTheWall = true;
    }
    expect(minX).toBe(0);
    expect(visited).toContain(TURN);
    // It turns at the wall; the only fall is off the far end of the surface.
    expect(fellAtTheWall).toBe(false);
  });
});

describe('Pet (boxes beside each other)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function onStatusBar(footTop: number) {
    const graph = tinyGraph();
    graph.spawns = [{ id: 1, probability: 100, x: '140', y: '0', next: WALK }];
    const stage = new TestStage({ x: 0, y: 0, w: 200, h: 300 }, [
      { id: 'foot', rect: { x: 0, y: footTop, w: 99, h: 300 - footTop } },
      { id: 'status', rect: { x: 100, y: 150, w: 100, h: 150 } },
    ]);
    const { pet, visited } = setup(graph, stage);
    pet.play();
    vi.advanceTimersByTime(1500);
    expect(visited.slice(0, 3)).toEqual([WALK, FALL, LAND_WINDOW]);
    expect(pet.view.y).toBe(110);
    return { pet, visited, landed: visited.length };
  }

  it('falls off the status bar onto a lower icon bar beside it', () => {
    const { pet, visited, landed } = onStatusBar(190); // 40px lower
    vi.advanceTimersByTime(6000);
    expect(visited.slice(landed)).toContain(FALL);
    expect(visited.slice(landed)).toContain(LAND_WINDOW);
    expect(pet.view.y).toBe(150);
    expect(pet.view.x + 40).toBeLessThanOrEqual(100);
  });

  it('walks off the status bar in front of a taller icon bar and lands on the floor', () => {
    const { pet, visited, landed } = onStatusBar(60); // 90px higher: still not a wall
    vi.advanceTimersByTime(6000);
    const firstFall = visited.indexOf(FALL, landed);
    expect(firstFall).toBeGreaterThan(0);
    // No turning at the box: the first thing after the walk is the drop.
    expect(visited.slice(landed, firstFall)).not.toContain(TURN);
    expect(visited.slice(landed)).toContain(LAND);
    expect(pet.view.y).toBe(260);
  });

  it('a box one pixel off the line is the same ledge', () => {
    const { pet, visited, landed } = onStatusBar(151);
    let reached = false;
    for (let i = 0; i < 80 && !reached; i++) {
      vi.advanceTimersByTime(100);
      if (pet.view.x < 60) reached = true;
    }
    expect(reached).toBe(true);
    expect(pet.view.y).toBe(111);
    expect(visited.slice(landed)).not.toContain(FALL);
  });
});

describe('Pet (audit against the C# original)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('evaluates screen- and sprite-dependent values against the real stage, not an empty one', () => {
    const graph = tinyGraph();
    graph.animations[String(WALK)].sequence.repeat = 'screenW/32'; // gSheep's walk_top
    graph.animations[String(IDLE)].start.x = '-imageW*0.45'; // gSheep's fall_wina hop
    graph.animations[String(IDLE)].start.y = 'imageH*0.45';
    const stage = new TestStage({ x: 0, y: 0, w: 640, h: 300 });
    const { pet } = setup(graph, stage);
    pet.play();
    expect(pet.currentAnimation.sequence.totalSteps).toBe(2 + 2 * 20);
    const x = pet.view.x;
    pet.jumpTo(IDLE);
    vi.advanceTimersByTime(100);
    expect(pet.view.x).toBe(x - 18);
  });

  it('lets an animation sink through the floor so a pet can leave that way', () => {
    const graph = tinyGraph();
    const EXIT = 20;
    graph.animations[String(EXIT)] = {
      id: EXIT,
      name: 'exit',
      start: move('0', '14', '50'),
      end: move('0', '14', '50'),
      sequence: { repeat: '40', repeatFrom: 0, frames: [20], action: '' },
      next: [],
    };
    const { pet } = setup(graph);
    pet.play();
    vi.advanceTimersByTime(100);
    pet.jumpTo(EXIT);
    let maxY = 0;
    for (let i = 0; i < 40; i++) {
      vi.advanceTimersByTime(50);
      maxY = Math.max(maxY, pet.view.y);
    }
    expect(maxY).toBeGreaterThan(300);
    // ...and the top-level pet respawns rather than closing.
    vi.advanceTimersByTime(3000);
    expect(pet.isClosed).toBe(false);
    expect(pet.view.y).toBeLessThanOrEqual(260);
  });

  it('kill closes every child, not every second one', () => {
    const graph = tinyGraph();
    graph.children = {
      [SPAWNER]: [
        { x: 'imageX', y: 'imageY', next: DRAG },
        { x: 'imageX', y: 'imageY', next: DRAG },
        { x: 'imageX', y: 'imageY', next: DRAG },
      ],
    };
    const { pet, host } = setup(graph);
    pet.play();
    pet.jumpTo(SPAWNER);
    expect(host.pets).toHaveLength(3);
    pet.kill();
    expect(host.pets.every((c) => c.isClosed)).toBe(true);
    expect(pet.childPets).toHaveLength(0);
  });

  it('a kill or a drag starts on its own interval instead of waiting out the current step', () => {
    const graph = tinyGraph();
    graph.animations[String(IDLE)].start.interval = '2000';
    graph.animations[String(IDLE)].end.interval = '2000';
    const { pet } = setup(graph);
    pet.play();
    pet.jumpTo(IDLE);
    vi.advanceTimersByTime(100);
    pet.kill();
    vi.advanceTimersByTime(10 * 12);
    expect(pet.isClosed).toBe(true);
  });
});

describe('Pet (a child that fades in)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts at its animation's opacity instead of flashing at full for one tick", () => {
    const graph = tinyGraph();
    graph.animations[String(POOF)].start.opacity = 0;
    graph.animations[String(POOF)].sequence = {
      repeat: '10',
      repeatFrom: 0,
      frames: [13],
      action: '',
    };
    const { pet, host } = setup(graph);
    pet.play();
    pet.jumpTo(SPAWNER);
    const child = host.pets[0];
    expect(child.view.opacity).toBe(0);
    vi.advanceTimersByTime(600);
    expect(child.view.opacity).toBeGreaterThan(0);
    expect(child.view.opacity).toBeLessThan(1);
  });
});

describe('Pet (leaving a surface upward)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('forgets the surface it jumped off, so a ceiling walk only corners at the screen edge', () => {
    const graph = tinyGraph();
    const JUMP_UP = 30;
    const CEILING = 31;
    graph.animations[String(JUMP_UP)] = {
      id: JUMP_UP,
      name: 'jump up',
      start: move('0', '-10'),
      end: move('0', '-10'),
      sequence: { repeat: '30', repeatFrom: 0, frames: [30], action: '' },
      next: [],
      border: [{ id: CEILING, probability: 100, only: 'horizontal' }],
    };
    // Like gSheep's walk_top: its corner is a border exit eligible anywhere.
    graph.animations[String(CEILING)] = {
      id: CEILING,
      name: 'ceiling walk',
      start: move('-2', '0'),
      end: move('-2', '0'),
      sequence: { repeat: '1000', repeatFrom: 0, frames: [31], action: '' },
      next: [],
      border: [{ id: TURN, probability: 100 }],
    };
    graph.spawns = [{ id: 1, probability: 100, x: '140', y: '0', next: WALK }];
    const stage = new TestStage({ x: 0, y: 0, w: 200, h: 300 }, [
      { id: 'messages', rect: { x: 100, y: 150, w: 100, h: 100 } },
    ]);
    const { pet, visited } = setup(graph, stage);
    pet.play();
    vi.advanceTimersByTime(1500);
    expect(visited).toContain(LAND_WINDOW);
    pet.jumpTo(JUMP_UP);
    for (let i = 0; i < 40 && pet.currentAnimation.id !== CEILING; i++) vi.advanceTimersByTime(100);
    expect(pet.currentAnimation.id).toBe(CEILING);
    expect(pet.view.y).toBe(0);
    let xAtTurn = -1;
    for (let i = 0; i < 100 && xAtTurn < 0; i++) {
      vi.advanceTimersByTime(100);
      if (pet.currentAnimation.id === TURN) xAtTurn = pet.view.x;
    }
    expect(xAtTurn).toBe(0);
  });
});

describe('Pet (review round two)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('setScale keeps a pet standing on a surface on its feet', () => {
    const { pet } = landOnSurface();
    pet.setScale(3);
    expect(pet.view.y).toBe(150 - 120);
    pet.setScale(1);
    expect(pet.view.y).toBe(110);
  });

  it('a kill lands mid-drag and still fades out; a dying pet cannot be grabbed', () => {
    const { pet, host } = setup();
    pet.play();
    vi.advanceTimersByTime(100);
    host.clock = 1000;
    pet.dragStart(170, 270);
    expect(pet.currentAnimation.id).toBe(DRAG);
    pet.kill();
    expect(pet.isDying).toBe(true);
    const { x, y } = pet.view;
    pet.dragMove(10, 10); // the gesture is still going; the pet no longer follows it
    expect(pet.view).toMatchObject({ x, y });
    pet.dragStart(10, 10); // nor can it be picked up again
    expect(pet.currentAnimation.id).toBe(KILL);
    vi.advanceTimersByTime(1000);
    expect(pet.isClosed).toBe(true);
  });

  it('a kill mid-toss stops the physics and fades out', () => {
    const { pet, host } = setup();
    pet.play();
    host.clock = 0;
    pet.dragStart(170, 270);
    for (let t = 16; t <= 96; t += 16) {
      host.clock = t;
      pet.dragMove(170 - t * 3, 270 - t * 2);
    }
    host.clock = 100;
    pet.dragEnd(170 - 300, 270 - 200);
    expect(pet.currentAnimation.id).toBe(TOSS);
    pet.kill();
    const { x, y } = pet.view;
    host.runFrames(116);
    expect(pet.view).toMatchObject({ x, y });
    expect(host.frames).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect(pet.isClosed).toBe(true);
  });
});

describe('Pet (landing on the floor after a surface)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('forgets the surface it left once it lands on the floor', () => {
    const { pet, host } = landOnSurface();
    expect(host.traces.at(-1)).toContain('on surface composer');
    host.traces.length = 0;
    // Drop straight off the surface (the way a jump that misses would).
    pet.jumpTo(FALL);
    vi.advanceTimersByTime(3000);
    expect(pet.view.y).toBe(260);
    const landed = host.traces.find((t) => t.startsWith(`#${LAND} land at`));
    expect(landed).toBeDefined();
    expect(landed).not.toContain('on surface');
    expect(host.traces.at(-1)).not.toContain('on surface');
  });

  it('logs a surface moving under it, with the old and new rectangles', () => {
    const { pet, host, stage } = landOnSurface();
    pet.jumpTo(DRAG);
    stage.surfaces[0] = { id: 'composer', rect: { x: 60, y: 142, w: 100, h: 68 } };
    vi.advanceTimersByTime(100);
    expect(host.traces.at(-1)).toBe('surface composer moved: 60,150 100×60 → 60,142 100×68');
  });
});

describe('Pet (a dive and its bathtub)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const DIVE = 14;

  /** A spawn whose first animation places a child on the screen, like the dive places its tub. */
  function diveGraph(): PetGraph {
    const graph = tinyGraph();
    graph.animations[String(DIVE)] = spec({
      id: DIVE,
      name: 'dive',
      start: move('0', '10', '50'),
      end: move('0', '10', '50'),
      sequence: { repeat: '12', repeatFrom: 0, frames: [5], action: '' },
      next: [{ id: IDLE, probability: 100 }],
    });
    graph.spawns = [{ id: 1, probability: 100, x: 'screenW-60', y: '0', next: DIVE }];
    graph.children = { [DIVE]: [{ x: 'screenW-60', y: 'areaH-imageH', next: POOF }] };
    return graph;
  }

  it('mirrors a screen-placed child with a mirrored spawn, so the tub is where the dive ends', () => {
    const { pet, host } = setup(diveGraph());
    pet.play();
    expect(pet.movingLeft).toBe(true);
    expect(pet.view.x).toBe(140);
    expect(host.pets[0].view.x).toBe(140);
    // Facing right, the spawn point is mirrored — and so is the tub.
    pet.jumpTo(TURN);
    vi.advanceTimersByTime(300);
    expect(pet.movingLeft).toBe(false);
    pet.play();
    expect(pet.view.x).toBe(200 - 140 - 40);
    expect(host.pets[1].view.x).toBe(200 - 140 - 40);
  });

  it('a dive through a surface it has no landing for does not come out standing on it', () => {
    const stage = new TestStage({ x: 0, y: 0, w: 200, h: 300 }, [
      { id: 'composer', rect: { x: 60, y: 150, w: 100, h: 60 } },
    ]);
    const graph = diveGraph();
    graph.spawns = [{ id: 1, probability: 100, x: '100', y: '0', next: DIVE }];
    const { pet, host } = setup(graph, stage);
    pet.play();
    vi.advanceTimersByTime(2000);
    const idle = host.traces.find((t) => t.startsWith(`#${IDLE} idle at`));
    expect(idle).toBeDefined();
    expect(idle).not.toContain('on surface');
  });

  it('recoverLayout leaves a child outside the viewport to its parent', () => {
    const graph = tinyGraph();
    graph.children = { [SPAWNER]: [{ x: 'imageX', y: '0-imageH-100', next: POOF }] };
    const { pet, host } = setup(graph);
    pet.play();
    pet.jumpTo(SPAWNER);
    const child = host.pets[0];
    expect(child.view.y).toBe(-140);
    child.recoverLayout();
    expect(child.view.y).toBe(-140);
  });
});

describe('Pet (a still pet stays on the screen)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a pet leaning into the wall with no sideways motion comes back onto the screen', () => {
    const graph = tinyGraph();
    graph.spawns = [{ id: 1, probability: 100, x: '0-6', y: 'areaH-imageH', next: IDLE }];
    const { pet } = setup(graph);
    pet.play();
    expect(pet.view.x).toBe(-6);
    vi.advanceTimersByTime(100);
    expect(pet.view.x).toBe(0);
  });

  it('a pet walking in from off-screen is left to walk in', () => {
    const graph = tinyGraph();
    graph.spawns = [{ id: 1, probability: 100, x: 'screenW', y: 'areaH-imageH', next: WALK }];
    const { pet } = setup(graph);
    pet.play();
    expect(pet.view.x).toBe(200);
    vi.advanceTimersByTime(100);
    expect(pet.view.x).toBe(198);
  });
});

describe('Pet (standing means feet on the edge)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const HOP = 15;

  it('a pet left in the air above its surface falls back onto it', () => {
    const graph = tinyGraph();
    graph.spawns = [{ id: 1, probability: 100, x: '100', y: '0', next: WALK }];
    // A hop too small to count as leaving the surface, then a walk with gravity.
    graph.animations[String(HOP)] = spec({
      id: HOP,
      name: 'hop',
      start: move('0', '-30'),
      end: move('0', '-30'),
      next: [{ id: WALK, probability: 100 }],
    });
    const stage = new TestStage({ x: 0, y: 0, w: 200, h: 300 }, [
      { id: 'composer', rect: { x: 60, y: 150, w: 100, h: 60 } },
    ]);
    const { pet, visited, host } = setup(graph, stage);
    pet.play();
    vi.advanceTimersByTime(1500);
    expect(pet.view.y).toBe(110);
    host.traces.length = 0;
    visited.length = 0;
    pet.jumpTo(HOP);
    vi.advanceTimersByTime(250);
    expect(pet.view.y).toBeLessThan(110);
    // The walk notices it is standing on nothing and drops; it lands on the surface again.
    vi.advanceTimersByTime(2000);
    expect(visited).toContain(FALL);
    expect(visited).toContain(LAND_WINDOW);
    expect(pet.view.y).toBe(110);
  });
});
