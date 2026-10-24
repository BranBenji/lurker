// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  formatRatio,
  harmonies,
  hsvToRgb,
  mix,
  parseComputedRgb,
  parseHex,
  rgbToHsv,
  toHex,
} from './color.js';

describe('parseHex / toHex', () => {
  it('reads every hex length and discards alpha', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('#f0f8')).toEqual({ r: 255, g: 0, b: 255 });
    expect(parseHex('#a99dec')).toEqual({ r: 0xa9, g: 0x9d, b: 0xec });
    expect(parseHex('#A99DEC80')).toEqual({ r: 0xa9, g: 0x9d, b: 0xec });
    // Zero alpha paints nothing: no RGB to report.
    expect(parseHex('#0000')).toBeNull();
    expect(parseHex('#a99dec00')).toBeNull();
    expect(parseHex(' #212022 ')).toEqual({ r: 0x21, g: 0x20, b: 0x22 });
  });

  it('rejects what is not a hex literal', () => {
    for (const bad of ['a99dec', '#a99de', '#gggggg', 'var(--fg)', 'rgb(1,2,3)', '']) {
      expect(parseHex(bad)).toBeNull();
    }
  });

  it('writes lower-case #rrggbb and clamps', () => {
    expect(toHex({ r: 0xa9, g: 0x9d, b: 0xec })).toBe('#a99dec');
    expect(toHex({ r: 300, g: -4, b: 7.6 })).toBe('#ff0008');
  });
});

describe('rgb <-> hsv', () => {
  it('round-trips the registry palette', () => {
    for (const hex of [
      '#212022',
      '#fcfcfa',
      '#a99dec',
      '#b3db82',
      '#f9d978',
      '#ed6c89',
      '#38353b',
    ]) {
      const rgb = parseHex(hex)!;
      expect(toHex(hsvToRgb(rgbToHsv(rgb)))).toBe(hex);
    }
  });

  it('places the primaries on the hue wheel', () => {
    expect(rgbToHsv({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 1, v: 1 });
    expect(rgbToHsv({ r: 0, g: 255, b: 0 })).toEqual({ h: 120, s: 1, v: 1 });
    expect(rgbToHsv({ r: 0, g: 0, b: 255 })).toEqual({ h: 240, s: 1, v: 1 });
    expect(rgbToHsv({ r: 128, g: 128, b: 128 })).toMatchObject({ h: 0, s: 0 });
  });

  it('wraps hue in either direction', () => {
    expect(toHex(hsvToRgb({ h: 360, s: 1, v: 1 }))).toBe('#ff0000');
    expect(toHex(hsvToRgb({ h: -120, s: 1, v: 1 }))).toBe('#0000ff');
  });
});

describe('contrast', () => {
  it('matches the WCAG reference points', () => {
    const white = { r: 255, g: 255, b: 255 };
    const black = { r: 0, g: 0, b: 0 };
    expect(contrastRatio(white, black)).toBeCloseTo(21, 5);
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
    // #767676 on white is the canonical "just passes AA" grey.
    expect(contrastRatio(parseHex('#767676')!, white)).toBeCloseTo(4.54, 2);
  });

  it('formats to one decimal', () => {
    expect(formatRatio(4.54)).toBe('4.5:1');
    expect(formatRatio(21)).toBe('21.0:1');
  });
});

describe('harmonies', () => {
  it('rotates hue and keeps saturation and value', () => {
    const base = parseHex('#a99dec')!;
    const list = harmonies(base);
    const labels = list.map((s) => s.label);
    expect(labels).toEqual([
      'complement',
      'triad',
      'triad',
      'analogous',
      'analogous',
      'lighter',
      'lighter',
      'darker',
      'darker',
    ]);
    const baseHsv = rgbToHsv(base);
    const comp = rgbToHsv(parseHex(list[0].hex)!);
    expect(Math.abs(Math.abs(comp.h - baseHsv.h) - 180)).toBeLessThan(2);
    expect(comp.s).toBeCloseTo(baseHsv.s, 1);
    expect(comp.v).toBeCloseTo(baseHsv.v, 1);
  });

  it('drops the rotations of a grey and never repeats a swatch', () => {
    const list = harmonies({ r: 128, g: 128, b: 128 });
    expect(list.map((s) => s.label)).toEqual(['lighter', 'lighter', 'darker', 'darker']);
    expect(new Set(list.map((s) => s.hex)).size).toBe(list.length);
    // White has nowhere lighter to go.
    const white = harmonies({ r: 255, g: 255, b: 255 });
    expect(white.map((s) => s.label)).toEqual(['darker', 'darker']);
  });
});

describe('mix / parseComputedRgb', () => {
  it('mixes linearly', () => {
    expect(mix({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, 0.5)).toEqual({
      r: 128,
      g: 128,
      b: 128,
    });
  });

  it('reads both computed-style spellings and refuses others', () => {
    expect(parseComputedRgb('rgb(169, 157, 236)')).toEqual({ r: 169, g: 157, b: 236 });
    expect(parseComputedRgb('rgba(169, 157, 236, 0.5)')).toEqual({ r: 169, g: 157, b: 236 });
    expect(parseComputedRgb('rgb(169 157 236 / 0.5)')).toEqual({ r: 169, g: 157, b: 236 });
    expect(parseComputedRgb('rgb(169 157 236 / 50%)')).toEqual({ r: 169, g: 157, b: 236 });
    // transparent, in every spelling a browser serialises it with.
    expect(parseComputedRgb('rgba(0, 0, 0, 0)')).toBeNull();
    expect(parseComputedRgb('rgba(0, 0, 0, 0.0)')).toBeNull();
    expect(parseComputedRgb('rgb(0 0 0 / 0%)')).toBeNull();
    expect(parseComputedRgb('oklch(0.7 0.1 300)')).toBeNull();
    expect(parseComputedRgb('')).toBeNull();
  });
});
