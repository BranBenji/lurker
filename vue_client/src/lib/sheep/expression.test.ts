// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { emptyContext, evaluate, isDynamic, isScreen } from './expression.js';

const ctx = () => ({
  ...emptyContext(),
  screenW: 1280,
  screenH: 800,
  areaW: 1280,
  areaH: 760,
  imageW: 40,
  imageH: 40,
  random: 37,
  randS: 50,
});

describe('sheep expression evaluator', () => {
  it('reads plain integers on the fast path, including negatives', () => {
    expect(evaluate('-2', ctx())).toBe(-2);
    expect(evaluate(' 15 ', ctx())).toBe(15);
    expect(evaluate('', ctx())).toBe(0);
  });

  it('keeps Int32 semantics: integer division truncates', () => {
    // random/5+10 is how gSheep picks a whole number of walk repeats.
    expect(evaluate('random/5+10', ctx())).toBe(17);
    expect(evaluate('7/2', ctx())).toBe(3);
    expect(evaluate('-7/2', ctx())).toBe(-3);
    expect(evaluate('5/0', ctx())).toBe(0);
  });

  it('promotes to double when a decimal literal is involved, truncating only at the end', () => {
    expect(evaluate('imageW*0.9', ctx())).toBe(36);
    expect(evaluate('7/2.0', ctx())).toBe(3);
    expect(evaluate('100*0.5/3', ctx())).toBe(16);
  });

  it('resolves the screen and pet identifiers', () => {
    expect(evaluate('screenW+10', ctx())).toBe(1290);
    expect(evaluate('areaH-imageH', ctx())).toBe(720);
    expect(evaluate('0-imageH-10', ctx())).toBe(-50);
    expect(evaluate('unknownIdent+1', ctx())).toBe(1);
  });

  it('honours precedence and parentheses', () => {
    expect(evaluate('random*(screenW-imageW-50)/100+25', ctx())).toBe(
      Math.trunc((37 * (1280 - 40 - 50)) / 100) + 25,
    );
    expect(evaluate('areaH/2-(randS*areaH/2)/120-imageH', ctx())).toBe(
      Math.trunc(760 / 2) - Math.trunc(Math.trunc((50 * 760) / 2) / 120) - 40,
    );
    expect(evaluate('2+3*4', ctx())).toBe(14);
    expect(evaluate('(2+3)*4', ctx())).toBe(20);
    expect(evaluate('-(2+3)', ctx())).toBe(-5);
  });

  it('supports Convert(expr, System.Int32)', () => {
    expect(evaluate('Convert(imageW*0.9, System.Int32)', ctx())).toBe(36);
    expect(evaluate('Convert(7/2.0, System.Int32)*2', ctx())).toBe(6);
  });

  it('mirrors imageW for a child placed relative to a flipped parent', () => {
    const c = { ...ctx(), parentFlipped: true, imageX: 100, imageY: 50 };
    // imageX-imageW*0.9 → imageX+imageW*0.9
    expect(evaluate('imageX-imageW*0.9', c)).toBe(136);
    // bare imageW → (-imageW)
    expect(evaluate('imageX+imageW', c)).toBe(60);
  });

  it('classifies dynamic and screen-dependent texts', () => {
    expect(isDynamic('random/5+10')).toBe(true);
    expect(isDynamic('imageX-imageW')).toBe(true);
    expect(isDynamic('screenW+10')).toBe(false);
    expect(isScreen('screenW+10')).toBe(true);
    expect(isScreen('areaH-imageH')).toBe(true);
    expect(isScreen('-2')).toBe(false);
  });
});
