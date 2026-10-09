// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The gSheep colors shipped under public/sheep/ (one sprite sheet each).

export const SHEEP_COLORS = ['red', 'blue', 'green', 'orange', 'pink', 'purple', 'yellow'] as const;
export type SheepColor = (typeof SHEEP_COLORS)[number];

export function isSheepColor(s: string): s is SheepColor {
  return (SHEEP_COLORS as readonly string[]).includes(s);
}

export const SHEEP_SCALES = [1, 2, 3] as const;
export type SheepScale = (typeof SHEEP_SCALES)[number];

export function isSheepScale(n: number): n is SheepScale {
  return (SHEEP_SCALES as readonly number[]).includes(n);
}
