// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Parser for the /xdcc command (#1085) — the XDCC queue, in EasyXdcc's verbs
// (the HexChat plugin's command set, which the operator picked):
//
//   /xdcc add <bot> <pack>                 queue one pack
//   /xdcc addl <bot> <first> <last>        queue a range
//   /xdcc addm <bot> <pack> <pack> …       queue several
//   /xdcc queue [<bot>]                    show the queue
//   /xdcc rmp | rmpl | rmpm <bot> …        take packs out, same arguments
//   /xdcc rmbot <bot>                      drop that bot's whole queue
//
// EasyXdcc's start/stop/auto/save/load/purge are left out: the queue lives on
// the server, so it always runs and survives restarts. A pack is a number,
// with or without its `#` (⚠ the XDCC pack sigil, not a channel). `add` also
// takes a range, `29-32`, for anyone who doesn't remember addl.
//
// Pure and dependency-free so it unit-tests outside the Vue SFC.

import { isSinglePeerTarget } from '../../../../shared/channels.js';

export type XdccCommand =
  | { kind: 'add'; bot: string; packs: number[] }
  /** `packs` null drops the bot's whole queue. */
  | { kind: 'remove'; bot: string; packs: number[] | null }
  | { kind: 'queue'; bot: string | null }
  | { kind: 'error'; message: string };

// The server's own guard against a typo like `addl bot 1 100000`.
export const XDCC_MAX_PACKS = 500;

export const XDCC_USAGE =
  'usage: /xdcc add <bot> <pack> · /xdcc addl <bot> <first> <last> · ' +
  '/xdcc addm <bot> <pack> <pack>… · /xdcc queue [<bot>] · ' +
  '/xdcc rmp|rmpl|rmpm <bot> … · /xdcc rmbot <bot>';

function parseBot(raw: string | undefined): string | null {
  const n = (raw || '').trim();
  if (!n || n.startsWith('=') || !isSinglePeerTarget(n)) return null;
  return n;
}

function parsePack(raw: string | undefined): number | null {
  const m = /^#?(\d{1,9})$/.exec((raw || '').trim());
  return m ? Number(m[1]) : null;
}

// first..last, either way round, as a list.
function range(first: number, last: number): number[] {
  const lo = Math.min(first, last);
  const hi = Math.max(first, last);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

// `29`, `#29`, or a range `29-32` / `#29-#32`.
function parsePackOrRange(raw: string): number[] | null {
  const m = /^#?(\d{1,9})-#?(\d{1,9})$/.exec(raw.trim());
  if (m) return range(Number(m[1]), Number(m[2]));
  const one = parsePack(raw);
  return one === null ? null : [one];
}

function packsFor(verb: 'one' | 'range' | 'many', args: string[]): number[] | { error: string } {
  if (verb === 'range') {
    const [a, b] = [parsePack(args[0]), parsePack(args[1])];
    if (a === null || b === null || args.length !== 2) return { error: 'needs <first> <last>' };
    const packs = range(a, b);
    return packs.length > XDCC_MAX_PACKS
      ? { error: `at most ${XDCC_MAX_PACKS} packs at a time` }
      : packs;
  }
  if (args.length === 0) return { error: 'needs a pack number' };
  if (verb === 'one' && args.length !== 1) return { error: 'takes one pack; addm takes several' };
  const packs: number[] = [];
  for (const a of args) {
    const p = parsePackOrRange(a);
    if (!p) return { error: `"${a}" is not a pack number` };
    packs.push(...p);
  }
  if (packs.length > XDCC_MAX_PACKS) return { error: `at most ${XDCC_MAX_PACKS} packs at a time` };
  return packs.filter((p, i) => packs.indexOf(p) === i);
}

const VERBS: Record<string, { op: 'add' | 'remove'; verb: 'one' | 'range' | 'many' }> = {
  add: { op: 'add', verb: 'one' },
  addl: { op: 'add', verb: 'range' },
  addm: { op: 'add', verb: 'many' },
  rmp: { op: 'remove', verb: 'one' },
  rmpl: { op: 'remove', verb: 'range' },
  rmpm: { op: 'remove', verb: 'many' },
};

export function parseXdccCommand(argLine: string): XdccCommand {
  const [rawVerb, ...rest] = argLine.trim().split(/\s+/).filter(Boolean);
  const verb = (rawVerb || '').toLowerCase();
  if (!verb) return { kind: 'queue', bot: null };
  if (verb === 'queue' || verb === 'list') {
    if (rest.length > 1) return { kind: 'error', message: XDCC_USAGE };
    if (rest.length === 0) return { kind: 'queue', bot: null };
    const bot = parseBot(rest[0]);
    return bot ? { kind: 'queue', bot } : { kind: 'error', message: `"${rest[0]}" is not a nick` };
  }
  if (verb === 'rmbot') {
    const bot = parseBot(rest[0]);
    if (!bot || rest.length !== 1) return { kind: 'error', message: 'rmbot needs a bot nick' };
    return { kind: 'remove', bot, packs: null };
  }
  const spec = VERBS[verb];
  if (!spec) return { kind: 'error', message: XDCC_USAGE };
  const bot = parseBot(rest[0]);
  if (!bot) {
    return {
      kind: 'error',
      message: rest[0] ? `"${rest[0]}" is not a nick` : `${verb} needs a bot nick`,
    };
  }
  const packs = packsFor(spec.verb, rest.slice(1));
  if (!Array.isArray(packs)) return { kind: 'error', message: `${verb} ${packs.error}` };
  return spec.op === 'add' ? { kind: 'add', bot, packs } : { kind: 'remove', bot, packs };
}
