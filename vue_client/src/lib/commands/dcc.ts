// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Parser for the /dcc command (#270) — the slash-command surface over DCC.
// `list` opens the DCC window and `files` lists the files the account keeps
// (#1133); accept / reject / cancel act on one transfer
// by its numeric id (the id shown in the list), download saves a completed
// one through the browser, and delete removes its file from the server; `clear`
// takes one finished transfer off the list, or every one, keeping the files;
// `send` offers one of the files to a peer (#1086); `chat` opens a direct chat
// with a peer and `close` ends one.
//
// Pure and dependency-free so it unit-tests outside the Vue SFC, like the other
// command parsers.
//
// ⚠ The transfer verbs are user-wide, but chat and send are per-network — they
// ride that network's connection — so the SFC has to refuse them from the
// network-agnostic system buffer rather than routing with a null networkId.

import { isSinglePeerTarget } from '../../../../shared/channels.js';

export type DccCommand =
  | { kind: 'list' }
  | { kind: 'files' }
  | { kind: 'accept'; id: number }
  | { kind: 'reject'; id: number }
  | { kind: 'cancel'; id: number }
  | { kind: 'download'; id: number }
  | { kind: 'delete'; id: number }
  /** A queued XDCC pack that ended without its file, asked for again (#1085). */
  | { kind: 'retry'; id: number }
  /** One transfer by id, or null for every finished one. */
  | { kind: 'clear'; id: number | null }
  /** `file` is a name, or an id as /dcc files shows it; null to pick one. */
  | { kind: 'send'; nick: string; passive: boolean; file: string | null }
  | { kind: 'chat'; nick: string; passive: boolean }
  | { kind: 'chatClose'; nick: string }
  | { kind: 'error'; message: string };

const ACCEPT = new Set(['accept', 'ok', 'yes', 'get']);
const REJECT = new Set(['reject', 'deny', 'no']);
const CANCEL = new Set(['cancel', 'abort', 'stop']);
const LIST = new Set(['list', 'ls']);
const FILES = new Set(['files']);
// Not `get`: irssi's `/dcc get` accepts an offer, and it does here too.
const DOWNLOAD = new Set(['download', 'save']);
const DELETE = new Set(['delete', 'rm']);
const RETRY = new Set(['retry']);
// The verbs that act on one transfer by id.
const BY_ID: ReadonlyArray<
  [ReadonlySet<string>, 'accept' | 'reject' | 'cancel' | 'download' | 'delete' | 'retry']
> = [
  [ACCEPT, 'accept'],
  [REJECT, 'reject'],
  [CANCEL, 'cancel'],
  [DOWNLOAD, 'download'],
  [DELETE, 'delete'],
  [RETRY, 'retry'],
];

const USAGE =
  'usage: /dcc [list] · /dcc files · /dcc accept|reject|cancel|download|delete|retry <id> · ' +
  '/dcc clear [<id>] · ' +
  '/dcc send [-passive] <nick> [<file>] · ' +
  '/dcc chat [-passive] <nick> · ' +
  '/dcc close chat <nick>';

// A nick is any non-whitespace token; the server does the real validation. A
// leading `=` is refused here because that is a DCC-chat BUFFER name, and
// `/dcc chat =bob` almost certainly means the user typed the buffer rather than
// the peer — accepting it would open a chat with a peer literally called "=bob".
//
// ⚠ A channel is refused too: `/dcc chat #room` would broadcast the offer to
// the whole channel. All four sigils — a `#`-only test is this codebase's most
// repeated bug — and a list or STATUSMSG target (`bob,#room`, `@#room`), which
// reaches one as well.
function parseNick(raw: string | undefined): string | null {
  const n = (raw || '').trim();
  if (!n || n.startsWith('=') || !isSinglePeerTarget(n)) return null;
  return n;
}

// Parse a positive integer transfer id, or null. Rejects empty, non-numeric, and
// non-positive values so a fat-fingered id surfaces a usage hint rather than
// POSTing to /api/dcc/NaN/accept.
function parseId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function parseDccCommand(argLine: string): DccCommand {
  const trimmed = (argLine || '').trim();
  if (!trimmed) return { kind: 'list' };

  const parts = trimmed.split(/\s+/);
  const verb = parts[0].toLowerCase();

  if (LIST.has(verb)) return { kind: 'list' };
  if (FILES.has(verb)) return { kind: 'files' };
  if (verb === 'clear') {
    if (!parts[1]) return { kind: 'clear', id: null };
    const id = parseId(parts[1]);
    return id != null
      ? { kind: 'clear', id }
      : { kind: 'error', message: 'usage: /dcc clear [<id>]' };
  }

  // The chat verbs follow irssi's syntax exactly, so a habit carried over from
  // irssi does what it did there:
  //
  //   DCC CHAT [-passive] <nick>      dcc-chat.c:442
  //   DCC CLOSE <type> <nick>         dcc.c:490
  //
  // ⚠ Type-first on close is the whole reason this is strict. An earlier
  // `/dcc close <nick>` shorthand read the word after `close` as the nick, so
  // irssi's `/dcc close chat bob` closed a chat with a peer literally named
  // "chat", said "no live DCC chat", and left the real one open. Accepting only
  // irssi's shape leaves nothing ambiguous to guess about.
  //
  // `-passive` is opt-in rather than a fallback: WeeChat and HexDroid mishandle
  // a passive offer into a silent dial to port 0.
  if (verb === 'chat') {
    const flags = parts.slice(1).filter((p) => p.startsWith('-'));
    const rest = parts.slice(1).filter((p) => !p.startsWith('-'));
    const unknown = flags.find((f) => f.toLowerCase() !== '-passive');
    if (unknown) {
      return {
        kind: 'error',
        message: `unknown option "${unknown}". usage: /dcc chat [-passive] <nick>`,
      };
    }
    // ⚠ `/dcc chat close bob` isn't a command, and read literally it would OFFER
    // a chat to a peer named "close". Catch the intent instead.
    if (rest.length > 1) {
      return {
        kind: 'error',
        message:
          rest[0].toLowerCase() === 'close'
            ? 'to end a chat: /dcc close chat <nick>'
            : 'usage: /dcc chat [-passive] <nick>',
      };
    }
    const nick = parseNick(rest[0]);
    if (!nick) return { kind: 'error', message: 'usage: /dcc chat [-passive] <nick>' };
    return { kind: 'chat', nick, passive: flags.length > 0 };
  }
  // irssi's `DCC SEND [-passive] <nick> <file>` (dcc-send.c:164), with the
  // file optional: without one, the DCC window opens to pick or upload it. The
  // file is the rest of the line, so a name with spaces needs no quotes.
  if (verb === 'send') {
    const usage = 'usage: /dcc send [-passive] <nick> [<file>]';
    let rest = trimmed.slice(parts[0].length).trim();
    let passive = false;
    while (rest.startsWith('-')) {
      const flag = rest.split(/\s+/, 1)[0];
      if (flag.toLowerCase() !== '-passive') {
        return { kind: 'error', message: `unknown option "${flag}". ${usage}` };
      }
      passive = true;
      rest = rest.slice(flag.length).trim();
    }
    const nickRaw = rest.split(/\s+/, 1)[0];
    const nick = parseNick(nickRaw);
    if (!nick) return { kind: 'error', message: usage };
    const file = rest.slice(nickRaw.length).trim();
    return { kind: 'send', nick, passive, file: file || null };
  }
  if (verb === 'close') {
    const type = (parts[1] || '').toLowerCase();
    if (type === 'chat') {
      const nick = parseNick(parts[2]);
      return nick && !parts[3]
        ? { kind: 'chatClose', nick }
        : { kind: 'error', message: 'usage: /dcc close chat <nick>' };
    }
    // irssi's file-transfer types. Transfers close by id here, so point there
    // rather than reading "send" as a peer's nick.
    if (type === 'send' || type === 'get') {
      return {
        kind: 'error',
        message: 'file transfers close by id: /dcc list, then /dcc cancel <id>',
      };
    }
    return { kind: 'error', message: 'usage: /dcc close chat <nick>' };
  }

  const kind = BY_ID.find(([words]) => words.has(verb))?.[1];
  if (kind) {
    const id = parseId(parts[1]);
    if (id == null) return { kind: 'error', message: `usage: /dcc ${kind} <id>` };
    return { kind, id };
  }

  return { kind: 'error', message: `unknown subcommand "${parts[0]}". ${USAGE}` };
}
