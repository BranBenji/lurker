// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { PetGraph } from '../lib/sheep/model.js';

// The settings PATCH is the only API call the flock makes: apply it to a map
// and hand the map back, like the server does.
type Patch = { changes: Record<string, unknown>; resets: string[] };
const h = vi.hoisted(() => {
  const values: Record<string, unknown> = {};
  const patches: Patch[] = [];
  const api = vi.fn<(url: string, opts?: { method?: string; body?: unknown }) => Promise<unknown>>(
    async (url, opts) => {
      if (url === '/api/settings' && opts?.method === 'PATCH') {
        const body = opts.body as Patch;
        patches.push(body);
        Object.assign(values, body.changes);
        for (const k of body.resets) delete values[k];
        return { values: { ...values } };
      }
      throw new Error(`unexpected api call ${opts?.method ?? 'GET'} ${url}`);
    },
  );
  return { values, patches, api };
});
vi.mock('../api.js', () => ({ api: h.api }));

import { useSettingsStore } from './settings.js';
import { resetSheepWorldForTests, useSheepStore } from './sheep.js';

const anim = (id: number, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  start: { x: '0', y: '0', interval: '50', offsetY: 0, opacity: 1 },
  end: { x: '0', y: '0', interval: '50', offsetY: 0, opacity: 1 },
  sequence: { repeat: '0', repeatFrom: 0, frames: [0], action: '' },
  next: [],
  ...over,
});

const graph: PetGraph = {
  author: 't',
  version: '1',
  frameWidth: 40,
  frameHeight: 40,
  tilesX: 2,
  tilesY: 2,
  colors: { red: { petName: 'Rick', title: 'Red' }, blue: { petName: 'Ben', title: 'Blue' } },
  spawns: [{ id: 1, probability: 100, x: '100', y: 'areaH-imageH', next: 1 }],
  animations: {
    '1': anim(1, 'walk', {
      sequence: { repeat: '1000', repeatFrom: 0, frames: [0, 1], action: '' },
      next: [{ id: 1, probability: 100 }],
    }),
    '2': anim(2, 'kill'),
  },
  children: {},
  sounds: {},
};

function settingsWith(flock: string[]) {
  const settings = useSettingsStore();
  settings.values = { ...h.values, 'sheep.flock': flock };
  h.values['sheep.flock'] = flock;
  settings.loaded = true;
  return settings;
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('sheep store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    resetSheepWorldForTests();
    for (const k of Object.keys(h.values)) delete h.values[k];
    h.patches.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn<() => Promise<{ ok: boolean; json: () => Promise<unknown> }>>(async () => ({
        ok: true,
        json: async () => graph,
      })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not load the assets while the flock is empty', async () => {
    settingsWith([]);
    const sheep = useSheepStore();
    await sheep.reconcile();
    expect(fetch).not.toHaveBeenCalled();
    expect(sheep.sprites).toEqual({});
  });

  it('reconciles running sheep to the flock setting: spawn, recolor, shoo', async () => {
    const settings = settingsWith(['aaa111:red', 'bbb222:blue']);
    const sheep = useSheepStore();
    await sheep.reconcile();
    await flush();
    const sprites = () => Object.values(sheep.sprites).filter((s) => !s.isChild);
    // The names are the pet file's, one per color.
    expect(sprites().map((s) => [s.key, s.color, s.name])).toEqual([
      ['aaa111', 'red', 'Rick'],
      ['bbb222', 'blue', 'Ben'],
    ]);

    // Another client recolored Rick — a pink sheep has no name in this pet file.
    settings.values = { 'sheep.flock': ['aaa111:pink', 'bbb222:blue'] };
    await sheep.reconcile();
    expect(sprites().find((s) => s.key === 'aaa111')).toMatchObject({ color: 'pink', name: '' });

    // ...and shooed Ben: his kill fade runs in his own blue, then he is gone. Rick stays.
    settings.values = { 'sheep.flock': ['aaa111:pink'] };
    await sheep.reconcile();
    expect(sprites()).toHaveLength(2);
    vi.advanceTimersByTime(100);
    expect(sprites().find((s) => s.key === 'bbb222')).toMatchObject({ color: 'blue', name: 'Ben' });
    vi.advanceTimersByTime(2000);
    expect(sprites().map((s) => s.key)).toEqual(['aaa111']);

    // Reconciling again spawns nothing new.
    await sheep.reconcile();
    expect(sprites()).toHaveLength(1);
  });

  it('spawn, shoo and recolor are settings writes', async () => {
    settingsWith([]);
    const sheep = useSheepStore();
    const e = await sheep.spawn('blue');
    expect(e.color).toBe('blue');
    expect(sheep.describe(e)).toBe('Ben');
    expect(h.patches).toHaveLength(1);
    expect(h.patches[0].changes['sheep.flock']).toEqual([`${e.id}:blue`]);
    expect(sheep.flock).toEqual([e]);

    const f = await sheep.spawn('random');
    expect(sheep.flock).toHaveLength(2);
    await sheep.recolor(e.id, 'green');
    expect(sheep.flock[0]).toEqual({ id: e.id, color: 'green' });

    expect(await sheep.shooLast()).toEqual(f);
    expect(sheep.flock).toEqual([{ id: e.id, color: 'green' }]);
    expect(await sheep.shoo('nope')).toBeNull();
    // Recoloring a sheep that is gone writes nothing.
    const writes = h.patches.length;
    await sheep.recolor('nope', 'pink');
    expect(h.patches).toHaveLength(writes);
    expect(await sheep.shooAll()).toBe(1);
    expect(sheep.flock).toEqual([]);
    expect(await sheep.shooAll()).toBe(0);
  });

  it('reads sounds and scale from the settings and writes them back', async () => {
    const settings = settingsWith([]);
    const sheep = useSheepStore();
    expect(sheep.sounds).toBe(true);
    expect(sheep.scale).toBe(1);
    await sheep.setSounds(false);
    await sheep.setScale(3);
    expect(settings.values['sheep.sounds']).toBe(false);
    expect(sheep.sounds).toBe(false);
    expect(sheep.scale).toBe(3);
  });
});

describe('sheep store (review fixes)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    resetSheepWorldForTests();
    for (const k of Object.keys(h.values)) delete h.values[k];
    h.patches.length = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function stubFetch(opts: { graphGate?: Promise<void> } = {}) {
    vi.stubGlobal(
      'fetch',
      vi.fn<() => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>>(
        async () => {
          if (opts.graphGate) await opts.graphGate;
          return { ok: true, status: 200, json: async () => graph };
        },
      ),
    );
  }

  it('two overlapping spawns both land in the flock', async () => {
    stubFetch();
    settingsWith([]);
    const sheep = useSheepStore();
    const [a, b] = await Promise.all([sheep.spawn('red'), sheep.spawn('blue')]);
    expect(sheep.flock.map((e) => e.id)).toEqual([a.id, b.id]);
    expect(h.patches).toHaveLength(2);
  });

  it('a shoo overlapping a spawn removes only its sheep', async () => {
    stubFetch();
    settingsWith(['aaa111:red:Rick']);
    const sheep = useSheepStore();
    const [gone, added] = await Promise.all([sheep.shoo('aaa111'), sheep.spawn('green')]);
    expect(gone?.id).toBe('aaa111');
    expect(sheep.flock.map((e) => e.id)).toEqual([added.id]);
  });

  it('a reconcile reads the flock after the pet file has loaded, not before', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    stubFetch({ graphGate: gate });
    const settings = settingsWith(['aaa111:red:Rick']);
    const sheep = useSheepStore();
    const first = sheep.reconcile();
    // Shooed before the graph arrived.
    settings.values = { 'sheep.flock': [] };
    const second = sheep.reconcile();
    open();
    await Promise.all([first, second]);
    await flush();
    expect(Object.values(sheep.sprites)).toEqual([]);
  });
});

describe('sheep store (session reset)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    resetSheepWorldForTests();
    for (const k of Object.keys(h.values)) delete h.values[k];
    h.patches.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn<() => Promise<{ ok: boolean; json: () => Promise<unknown> }>>(async () => ({
        ok: true,
        json: async () => graph,
      })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('reset closes the flock, drops queued writes, and the next account spawns afresh', async () => {
    const settings = settingsWith(['aaa111:red:Rick']);
    const sheep = useSheepStore();
    await sheep.reconcile();
    await flush();
    expect(Object.keys(sheep.sprites)).toHaveLength(1);

    const pending = sheep.spawn('blue');
    sheep.reset();
    expect(sheep.sprites).toEqual({});
    await expect(pending).rejects.toThrow('signed out');
    expect(h.patches).toHaveLength(0);
    // Nothing keeps drawing after the pets are closed.
    vi.advanceTimersByTime(2000);
    expect(sheep.sprites).toEqual({});

    // The next account's flock (same entry id, even) spawns a running sheep.
    settings.values = { 'sheep.flock': ['aaa111:blue:Ben'] };
    settings.loaded = true;
    await sheep.reconcile();
    await flush();
    const sprites = Object.values(sheep.sprites);
    expect(sprites.map((s) => [s.key, s.color, s.name])).toEqual([['aaa111', 'blue', 'Ben']]);
    // ...and it is running: the walk's frames tick over.
    const frames = new Set<number>();
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(50);
      frames.add(Object.values(sheep.sprites)[0].frame);
    }
    expect(frames.size).toBeGreaterThan(1);
  });
});

describe('sheep store (debug trace)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    resetSheepWorldForTests();
    for (const k of Object.keys(h.values)) delete h.values[k];
    h.patches.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn<() => Promise<{ ok: boolean; json: () => Promise<unknown> }>>(async () => ({
        ok: true,
        json: async () => graph,
      })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('status lists each sheep, flags ghost sprites, and recounts what the flock did', async () => {
    settingsWith(['aaa111:red:Rick']);
    const sheep = useSheepStore();
    await sheep.reconcile();
    await flush();
    vi.advanceTimersByTime(100);
    const lines = sheep.status();
    expect(lines[0]).toMatch(
      /^Rick \(red\) #\d+: #1 walk at \d+,\d+ [←→] · drawn \d+\.\d\/s(, \d+\.\d\/s jumps)?$/,
    );
    expect(lines).toContain('recently:');
    expect(lines.some((l) => /^ {2}-\d+\.\ds Rick: respawn at \d+,\d+$/.test(l))).toBe(true);
    expect(lines.some((l) => /^ {2}-\d+\.\ds Rick: #1 walk at \d+,\d+$/.test(l))).toBe(true);
    expect(lines.some((l) => l.startsWith('ghost sprites'))).toBe(false);

    // A sprite nothing in the world owns is called out.
    sheep.sprites[999] = { ...Object.values(sheep.sprites)[0], id: 999 };
    expect(sheep.status()).toContain('ghost sprites: #999');
  });

  it('a sheep that arrives while the tab is hidden starts paused', async () => {
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      settingsWith(['aaa111:red']);
      const sheep = useSheepStore();
      await sheep.reconcile();
      await flush();
      expect(sheep.status()[0]).toMatch(/ paused/);
    } finally {
      vis.mockRestore();
    }
  });
});

describe('sheep store (phone layout)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    resetSheepWorldForTests();
    for (const k of Object.keys(h.values)) delete h.values[k];
    h.patches.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn<() => Promise<{ ok: boolean; json: () => Promise<unknown> }>>(async () => ({
        ok: true,
        json: async () => graph,
      })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('parking closes the flock and keeps it closed until the layout is back', async () => {
    settingsWith(['aaa111:red:Rick']);
    const sheep = useSheepStore();
    await sheep.reconcile();
    await flush();
    expect(Object.keys(sheep.sprites)).toHaveLength(1);

    sheep.park(true);
    expect(sheep.sprites).toEqual({});
    await sheep.reconcile();
    await flush();
    expect(sheep.sprites).toEqual({});
    // The flock setting itself is untouched: a /sheep on the phone still writes it.
    expect(sheep.flock).toHaveLength(1);
    expect(h.patches).toHaveLength(0);

    sheep.park(false);
    await sheep.reconcile();
    await flush();
    expect(Object.values(sheep.sprites).map((s) => s.key)).toEqual(['aaa111']);
  });

  it('a reconcile already loading the pet file spawns nothing if the flock gets parked meanwhile', async () => {
    settingsWith(['aaa111:red:Rick']);
    const sheep = useSheepStore();
    const pending = sheep.reconcile();
    sheep.park(true);
    await pending;
    await flush();
    expect(sheep.sprites).toEqual({});
  });
});
