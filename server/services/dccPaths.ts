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
import { FREE_DISK_FLOOR_BYTES } from '../utils/diskSpace.js';

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

/** Where `username`'s received files land: <root>/<username>, the name made
 *  safe the same way a filename is. Null when no root is configured. */
export function dccUserDir(username: string): string | null {
  const root = dccRoot();
  return root ? path.join(root, sanitizeDccFilename(username)) : null;
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
export function resolveDccDestination(
  username: string,
  rawFilename: string,
  // A path a transfer row already owns, whether or not its file exists yet: two
  // offers of one name accepted before either writes a byte would otherwise
  // both get the same path (#1125).
  claimed: (p: string) => boolean = () => false,
): string {
  const userDir = dccUserDir(username);
  if (!userDir) throw new Error('DCC download directory is not configured (set LURKER_DCC_DIR)');
  fs.mkdirSync(userDir, { recursive: true });

  const taken = (p: string) => fs.existsSync(p) || claimed(p);
  const safeName = sanitizeDccFilename(rawFilename);
  let candidate = path.join(userDir, safeName);
  if (taken(candidate)) {
    let n = 1;
    do {
      candidate = path.join(userDir, withSuffix(safeName, ` (${n})`));
      n += 1;
    } while (taken(candidate));
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
 * Remove a deleted account's DCC files (#1152): exactly the paths its rows own,
 * and then its folder, only if that leaves it empty. Never the folder as a
 * whole: it is named for the username made safe, so two accounts can share
 * one (a case-twin on a case-insensitive disk, two names that sanitize alike),
 * and a recursive delete would take the other's files. A path outside the
 * account's folder under the current root (LURKER_DCC_DIR moved since) is left
 * alone. Returns how many files went.
 */
export function removeDccFilesOf(username: string, paths: readonly string[]): number {
  const userDir = dccUserDir(username);
  if (!userDir) return 0;
  const inside = (p: string) => {
    const rel = path.relative(userDir, p);
    return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
  };
  let removed = 0;
  for (const p of paths) {
    if (!inside(p) || !fs.existsSync(p)) continue;
    try {
      fs.rmSync(p, { force: true });
      removed++;
    } catch (err) {
      console.warn(`[dcc] couldn't remove ${p}:`, err);
    }
  }
  try {
    fs.rmdirSync(userDir); // only when empty
  } catch {
    // Not empty (another account's files, or something put there by hand), or
    // never made.
  }
  return removed;
}

/** Free space a transfer must leave on the download dir's disk (#1125): the
 *  instance floor, shared with upload sessions. A transfer is refused when its
 *  advertised size wouldn't leave it (the receiver also caps writes at that
 *  size). */
export const DCC_FREE_DISK_FLOOR_BYTES = FREE_DISK_FLOOR_BYTES;

/** The size of the file at `p`, or null when there is none (#1125). Symlinks
 *  count as themselves. */
export function dccFileBytes(p: string | null): number | null {
  if (!p) return null;
  try {
    return fs.lstatSync(p).size;
  } catch {
    return null;
  }
}
