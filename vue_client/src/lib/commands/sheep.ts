// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Parser for the undocumented /sheep command (deliberately absent from
// /commands). Pure like the other command parsers; the SFC's runSheep maps
// the parsed intent onto the sheep store.

import { isSheepColor, SHEEP_COLORS, type SheepColor, type SheepScale } from '../sheep/colors.js';

export type SheepCommand =
  | { kind: 'spawn'; color: SheepColor | 'random' }
  | { kind: 'off'; all: boolean }
  | { kind: 'list' }
  | { kind: 'sounds'; on: boolean | null }
  | { kind: 'scale'; scale: SheepScale | null }
  | { kind: 'about' }
  | { kind: 'debug' }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

const SPAWN = new Set(['', 'on', 'add', 'more', 'spawn', 'new']);
const OFF = new Set(['off', 'kill', 'stop', 'bye', 'shoo', 'remove']);
const ALL = new Set(['all', 'everyone', 'everything']);
const LIST = new Set(['list', 'ls', 'who']);
const SOUNDS = new Set(['sounds', 'sound', 'audio']);
const SCALE = new Set(['scale', 'size']);
const ABOUT = new Set(['about', 'credits']);
const DEBUG = new Set(['debug', 'status']);
const HELP = new Set(['help', '?']);

export const SHEEP_USAGE_LINES = [
  'sheep:',
  `  /sheep [color]         — one more sheep (${SHEEP_COLORS.join(', ')}; random if you don't say)`,
  '  /sheep off             — shoo the newest sheep; /sheep off all shoos them all',
  '  /sheep list            — who is here',
  '  /sheep sounds [on|off]',
  '  /sheep scale [1|2|3]',
  '  /sheep about',
  '  right-click a sheep to shoo it or change its color',
];

const USAGE =
  'usage: /sheep [color] · /sheep off [all] · /sheep list · /sheep sounds on|off · /sheep scale 1|2|3';

export function parseSheepCommand(argLine: string): SheepCommand {
  const words = (argLine || '').trim().split(/\s+/).filter(Boolean);
  const verb = (words[0] || '').toLowerCase();
  const arg = (words[1] || '').toLowerCase();

  if (SPAWN.has(verb)) {
    if (!arg || arg === 'random') return { kind: 'spawn', color: 'random' };
    if (isSheepColor(arg)) return { kind: 'spawn', color: arg };
    return { kind: 'error', message: `no ${arg} sheep — ${SHEEP_COLORS.join(', ')}, or random` };
  }
  // A bare color spawns one: /sheep blue.
  if (isSheepColor(verb)) return { kind: 'spawn', color: verb };
  if (verb === 'random') return { kind: 'spawn', color: 'random' };

  if (OFF.has(verb)) {
    if (!arg) return { kind: 'off', all: false };
    if (ALL.has(arg)) return { kind: 'off', all: true };
    return { kind: 'error', message: 'off, or off all' };
  }
  if (LIST.has(verb)) return { kind: 'list' };
  if (ABOUT.has(verb)) return { kind: 'about' };
  if (DEBUG.has(verb)) return { kind: 'debug' };
  if (HELP.has(verb)) return { kind: 'help' };

  if (SOUNDS.has(verb)) {
    if (!arg) return { kind: 'sounds', on: null };
    if (arg === 'on' || arg === 'off') return { kind: 'sounds', on: arg === 'on' };
    return { kind: 'error', message: 'sounds on, or sounds off' };
  }

  if (SCALE.has(verb)) {
    if (!arg) return { kind: 'scale', scale: null };
    if (arg === '1' || arg === '2' || arg === '3') {
      return { kind: 'scale', scale: Number(arg) as SheepScale };
    }
    return { kind: 'error', message: 'scale is 1, 2 or 3' };
  }

  return { kind: 'error', message: USAGE };
}
