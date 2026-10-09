// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Destination resolution + filename safety for DCC downloads (#270). The download
// root is operator config; received files land under <root>/<username>/ so
// accounts on a shared cell never clobber each other and the auth'd download
// endpoint can scope retrieval by owner. Phase 1 supports a single root
// (LURKER_DCC_DIR); the resolver is shaped so multiple named destinations (a
// picker) become an additive change, not a reshape of stored paths.
//
// The DCC SEND filename is ATTACKER-CONTROLLED — the remote peer chooses it — so
// sanitizeDccFilename is the security boundary: its result is always a single
// path component (no separator, never '.'/'..'), so a malicious name cannot
// escape the user's directory. resolveDccDestination adds defense-in-depth by
// re-checking the joined path stays inside the user dir.

import fs from 'fs';
import path from 'path';
import { capUtf8, utf8Bytes } from '../utils/capUtf8.js';

// ext4 and APFS allow 255 BYTES per name, not 255 characters (#1051): an emoji
// is four bytes, a CJK character three.
const MAX_FILENAME_BYTES = 255;
// When a name has to be cut, an extension up to this long is kept whole. A
// longer one is treated as the tail of the name and cut along with the rest.
const MAX_EXT_BYTES = 16;
const FALLBACK_NAME = 'dcc-download';

/** The configured DCC download root, or null when unset (downloads can't run). */
export function dccRoot(): string | null {
  const raw = (process.env.LURKER_DCC_DIR ?? '').trim();
  return raw === '' ? null : raw;
}

// `name` split at its extension, unless that's too long to be one.
function splitExt(name: string): { base: string; ext: string } {
  const ext = path.extname(name);
  if (ext === '' || utf8Bytes(ext) > MAX_EXT_BYTES) return { base: name, ext: '' };
  return { base: name.slice(0, -ext.length), ext };
}

// `base` + `suffix` + `ext`, with `base` cut so the whole fits one name. The
// suffix is the collision counter, so a repeat download of a name already at
// the limit gives up name, not the counter or the extension.
function fitName(base: string, ext: string, suffix = ''): string {
  const room = MAX_FILENAME_BYTES - utf8Bytes(suffix) - utf8Bytes(ext);
  const cut = capUtf8(base, room);
  // Only a cut is trimmed: a space it lands on is debris, one the name came
  // with is the name.
  return (cut === base ? base : cut.trimEnd()) + suffix + ext;
}

// `name` de-collided with `suffix` before its extension, whatever that
// extension's length, as long as the result fits. Only a name that has to be
// cut to make room goes through fitName and its short-extension rule.
function withSuffix(name: string, suffix: string): string {
  const ext = path.extname(name);
  const whole = name.slice(0, name.length - ext.length) + suffix + ext;
  if (utf8Bytes(whole) <= MAX_FILENAME_BYTES) return whole;
  const split = splitExt(name);
  return fitName(split.base, split.ext, suffix);
}

/**
 * Reduce an attacker-controlled DCC filename to a safe single path component:
 * take only the basename (both POSIX and Windows separators), drop control chars
 * / NUL, trim whitespace, clamp to 255 UTF-8 bytes (preserving a short
 * extension), and reject bare '.'/'..'. Returns a non-empty safe name, falling
 * back to a default when nothing usable remains. The result NEVER contains a
 * path separator.
 */
export function sanitizeDccFilename(raw: string): string {
  // Normalise Windows separators to '/', then take the basename — after this
  // there is no separator of either kind left in the string.
  let name = raw.replace(/\\/g, '/');
  name = name.slice(name.lastIndexOf('/') + 1);
  // Strip control chars (incl. NUL 0x00 and DEL 0x7f).
  name = [...name]
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c >= 0x20 && c !== 0x7f;
    })
    .join('');
  name = name.trim();
  if (utf8Bytes(name) > MAX_FILENAME_BYTES) {
    const { base, ext } = splitExt(name);
    name = fitName(base, ext);
  }
  // Checked after the cut, which can leave one of these: '..' followed by a run
  // of combining marks keeps only the first '.'.
  if (name === '' || name === '.' || name === '..') return FALLBACK_NAME;
  return name;
}

/**
 * Resolve the on-disk path to write a user's download to, creating the per-user
 * directory. De-collides by appending " (n)" before the extension so a repeat
 * download never overwrites. Throws if no root is configured or — defense in
 * depth — the resolved path would somehow escape the user directory.
 */
export function resolveDccDestination(username: string, rawFilename: string): string {
  const root = dccRoot();
  if (!root) throw new Error('DCC download directory is not configured (set LURKER_DCC_DIR)');
  const userDir = path.join(root, sanitizeDccFilename(username));
  fs.mkdirSync(userDir, { recursive: true });

  const safeName = sanitizeDccFilename(rawFilename);
  let candidate = path.join(userDir, safeName);
  if (fs.existsSync(candidate)) {
    let n = 1;
    do {
      candidate = path.join(userDir, withSuffix(safeName, ` (${n})`));
      n += 1;
    } while (fs.existsSync(candidate));
  }
  // Checked on the name we actually return, de-collided or not.
  const rel = path.relative(userDir, candidate);
  // An escape is '..' as a whole path segment; a name that merely starts with
  // two dots ('..mkv', '...') is an ordinary file in the user dir.
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error('refusing unsafe DCC destination path');
  }
  return candidate;
}

/**
 * Whether `dir`'s filesystem has room for `bytes` plus a safety margin. Used to
 * refuse a transfer that would fill the cell disk (the offer's advertised size is
 * attacker-controlled, but the receiver also caps writes at it). Fails OPEN — if
 * statfs can't be read, we don't block the transfer.
 */
export function hasFreeSpaceFor(
  dir: string,
  bytes: number,
  marginBytes = 64 * 1024 * 1024,
): boolean {
  try {
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize >= bytes + marginBytes;
  } catch {
    return true;
  }
}
