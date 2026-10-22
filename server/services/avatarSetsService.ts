// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Uploaded avatar tile sets (/api/avatar-sets, #607). Reads a zip of images,
// keeps the ones that are images (by their bytes, never their names), sorts
// them by name so the tile numbering is stable, normalises each to one
// square WebP, and stores the set. Emits 'change' so wsHub can tell the
// user's other devices to refetch, the themes contract. Deleting a set resets
// a look.avatars.set pointer aimed at it, as deleting a theme does.
//
// The zip is the user's own upload, decoded in-process like any image they
// upload — not a fetch of something another user named.

import { EventEmitter } from 'events';
import fs from 'node:fs';
import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import {
  AVATAR_SET_IMAGE_MAX_BYTES,
  AVATAR_SET_MAX_TILES,
  AVATAR_SET_UNPACKED_MAX_BYTES,
  AVATAR_SET_MIN_TILES,
  AVATAR_SET_ZIP_MAX_ENTRIES,
  AVATAR_TILE_SIZE,
  MAX_AVATAR_SETS_PER_USER,
  avatarSetNameError,
  normalizeAvatarSetName,
  type AvatarSetSummary,
} from '../../shared/avatarSets.js';
import {
  countAvatarSetsForUser,
  createAvatarSet,
  deleteAvatarSet,
  findAvatarSetByName,
  getAvatarSet,
  getAvatarTile,
  listAvatarSetsForUser,
} from '../db/avatarSets.js';
import { getUserSettings } from '../db/settings.js';
import settingsService from './settingsService.js';

export const AVATAR_SET_POINTER_KEY = 'look.avatars.set';

type Result<T = undefined> =
  | (T extends undefined ? { ok: true } : { ok: true } & T)
  | { ok: false; error: string; status?: number };

export interface SkippedEntry {
  name: string;
  reason: string;
}

export interface ImageEntry {
  name: string;
  data: Buffer;
}

const IMAGE_MIMES = new Set(['image/png', 'image/webp', 'image/jpeg', 'image/gif', 'image/avif']);

// '' when the name is usable, else the reason: the shared rules plus
// per-user uniqueness.
function nameError(userId: number, raw: string): string {
  const shared = avatarSetNameError(raw);
  if (shared) return shared;
  const existing = findAvatarSetByName(userId, normalizeAvatarSetName(raw));
  return existing ? `a set named "${existing.name}" already exists` : '';
}

// Everything in the zip that could be a tile, by name. Directories, hidden
// files and macOS resource forks are dropped on the name alone; everything
// else is read and judged by its bytes later. Caps are enforced while
// walking, so a zip bomb stops at the first oversize entry rather than after.
function readZipImages(
  zipPath: string,
): Promise<{ images: ImageEntry[]; skipped: SkippedEntry[] }> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip: ZipFile | undefined) => {
      if (err || !zip) {
        reject(new Error('not a zip file'));
        return;
      }
      const images: ImageEntry[] = [];
      const skipped: SkippedEntry[] = [];
      let seen = 0;
      let unpacked = 0;
      const fail = (e: Error) => {
        zip.close();
        reject(e);
      };
      zip.on('error', fail);
      zip.on('end', () => resolve({ images, skipped }));
      zip.on('entry', (entry: Entry) => {
        seen += 1;
        if (seen > AVATAR_SET_ZIP_MAX_ENTRIES) {
          fail(new Error(`more than ${AVATAR_SET_ZIP_MAX_ENTRIES} entries in the zip`));
          return;
        }
        const name = entry.fileName;
        const base = name.split('/').pop() ?? '';
        if (name.endsWith('/') || !base || base.startsWith('.') || name.includes('__MACOSX/')) {
          zip.readEntry();
          return;
        }
        if (entry.uncompressedSize > AVATAR_SET_IMAGE_MAX_BYTES) {
          skipped.push({ name, reason: 'too large' });
          zip.readEntry();
          return;
        }
        // Past the tile limit nothing more is read; the name is still listed
        // in the skips, so the author knows which ones were left out.
        if (images.length >= AVATAR_SET_MAX_TILES) {
          skipped.push({ name, reason: `past the ${AVATAR_SET_MAX_TILES}-tile limit` });
          zip.readEntry();
          return;
        }
        // The whole zip's decompressed bytes, held at once: a cap the sizes
        // in the headers can't talk their way past, since the stream below
        // counts what actually comes out.
        if (unpacked + entry.uncompressedSize > AVATAR_SET_UNPACKED_MAX_BYTES) {
          fail(new Error('the images unpack to more than this server will hold at once'));
          return;
        }
        zip.openReadStream(entry, (e2, stream) => {
          if (e2 || !stream) {
            fail(e2 ?? new Error('failed to read a zip entry'));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length;
            unpacked += chunk.length;
            // The header lied; stop reading this one — or everything, past
            // the budget for the whole zip.
            if (unpacked > AVATAR_SET_UNPACKED_MAX_BYTES) {
              fail(new Error('the images unpack to more than this server will hold at once'));
              stream.destroy();
            } else if (size > AVATAR_SET_IMAGE_MAX_BYTES) stream.destroy(new Error('oversize'));
            else chunks.push(chunk);
          });
          stream.on('error', () => {
            if (unpacked > AVATAR_SET_UNPACKED_MAX_BYTES) return; // failed above
            skipped.push({ name, reason: 'too large' });
            zip.readEntry();
          });
          stream.on('end', () => {
            images.push({ name, data: Buffer.concat(chunks) });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

// One tile from one image, or the reason it isn't one. Static images only:
// an animated tile would move in every row, and the normaliser flattens to a
// single frame anyway, so saying no is more honest than keeping frame one.
async function normaliseTile(data: Buffer): Promise<{ tile: Buffer } | { reason: string }> {
  const type = await fileTypeFromBuffer(data);
  if (!type || !IMAGE_MIMES.has(type.mime)) return { reason: 'not an image' };
  try {
    const meta = await sharp(data).metadata();
    if ((meta.pages ?? 1) > 1) return { reason: 'animated' };
    // Already a tile (an exported set coming back): keep the bytes, so a
    // round trip is exact rather than one more lossy encode.
    if (
      type.mime === 'image/webp' &&
      meta.width === AVATAR_TILE_SIZE &&
      meta.height === AVATAR_TILE_SIZE
    ) {
      return { tile: data };
    }
    const tile = await sharp(data)
      .rotate()
      .resize(AVATAR_TILE_SIZE, AVATAR_TILE_SIZE, { fit: 'cover' })
      .webp({ quality: 82, alphaQuality: 90 })
      .toBuffer();
    return { tile };
  } catch {
    return { reason: 'could not be decoded' };
  }
}

class AvatarSetsService extends EventEmitter {
  list(userId: number): AvatarSetSummary[] {
    return listAvatarSetsForUser(userId);
  }

  get(userId: number, id: number): AvatarSetSummary | null {
    return getAvatarSet(userId, id);
  }

  tile(userId: number, setId: number, idx: number): Buffer | null {
    return getAvatarTile(userId, setId, idx);
  }

  /** A set from a zip on disk (the upload route's temp file). */
  async createFromZip(
    userId: number,
    rawName: unknown,
    zipPath: string,
  ): Promise<Result<{ set: AvatarSetSummary; skipped: SkippedEntry[] }>> {
    // The name and the cap are checked once, in createFromImages — reading a
    // zip for a name that then fails is cheap next to normalising its images.
    let read: { images: ImageEntry[]; skipped: SkippedEntry[] };
    try {
      read = await readZipImages(zipPath);
    } catch (e) {
      return { ok: false, error: (e as Error).message || 'could not read the zip' };
    }
    return this.createFromImages(userId, rawName, read.images, read.skipped);
  }

  /**
   * A set from images already in memory: the zip path above, and the import
   * path, whose archive entries get the same judgement a fresh upload does.
   * Sorted by name so the tile numbering is the author's file order.
   */
  async createFromImages(
    userId: number,
    rawName: unknown,
    images: ImageEntry[],
    skipped: SkippedEntry[] = [],
  ): Promise<Result<{ set: AvatarSetSummary; skipped: SkippedEntry[] }>> {
    const refused = this.refusal(userId, rawName);
    if (refused) return refused;
    const sorted = [...images].sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const tiles: Buffer[] = [];
    const notes = [...skipped];
    for (const image of sorted) {
      if (tiles.length >= AVATAR_SET_MAX_TILES) {
        notes.push({ name: image.name, reason: `past the ${AVATAR_SET_MAX_TILES}-tile limit` });
        continue;
      }
      const result = await normaliseTile(image.data);
      if ('tile' in result) tiles.push(result.tile);
      else notes.push({ name: image.name, reason: result.reason });
    }
    if (tiles.length < AVATAR_SET_MIN_TILES) {
      const why = notes.length
        ? ` (${notes.length} skipped: ${notes
            .slice(0, 3)
            .map((n) => `${n.name}: ${n.reason}`)
            .join(', ')}${notes.length > 3 ? ', …' : ''})`
        : '';
      return {
        ok: false,
        error: `a set needs at least ${AVATAR_SET_MIN_TILES} usable images, found ${tiles.length}${why}`,
      };
    }
    // The normaliser took a while: another upload may have taken the name or
    // the last slot meanwhile, and the UNIQUE constraint backstops the race.
    const late = this.refusal(userId, rawName);
    if (late) return late;
    let set: AvatarSetSummary;
    try {
      set = createAvatarSet(userId, normalizeAvatarSetName(rawName as string), tiles);
    } catch (e) {
      if ((e as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) {
        return {
          ok: false,
          error: `a set named "${normalizeAvatarSetName(rawName as string)}" already exists`,
        };
      }
      throw e;
    }
    this.emit('change', { userId });
    return { ok: true, set, skipped: notes };
  }

  // Why a set can't be made, or null: the name rules and the per-user cap.
  private refusal(
    userId: number,
    rawName: unknown,
  ): { ok: false; error: string; status?: number } | null {
    if (typeof rawName !== 'string') return { ok: false, error: 'name is required' };
    const err = nameError(userId, rawName);
    if (err) return { ok: false, error: err };
    if (countAvatarSetsForUser(userId) >= MAX_AVATAR_SETS_PER_USER) {
      return { ok: false, error: `avatar set limit reached (${MAX_AVATAR_SETS_PER_USER})` };
    }
    return null;
  }

  remove(userId: number, id: number): Result {
    if (!deleteAvatarSet(userId, id))
      return { ok: false, error: 'avatar set not found', status: 404 };
    // A pointer at the deleted set would dangle (the client falls back to the
    // bundled set, silently). Reset it server-side so every device re-tiles
    // in step. Exact-string match, as the themes pointer is matched.
    const stored = getUserSettings(userId);
    if (stored[AVATAR_SET_POINTER_KEY] === String(id)) {
      settingsService.update(userId, {}, [AVATAR_SET_POINTER_KEY]);
    }
    this.emit('change', { userId });
    return { ok: true };
  }
}

/** Best-effort removal of an upload's temp file. */
export async function discardZip(path: string | undefined): Promise<void> {
  if (!path) return;
  try {
    await fs.promises.unlink(path);
  } catch {
    /* already gone */
  }
}

const avatarSetsService = new AvatarSetsService();
export default avatarSetsService;
