// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import fs from 'fs';

/** Free space a write must leave on its disk. Received DCC files and upload
 *  sessions usually share a disk with the database, so this is what keeps a
 *  large file from leaving SQLite nowhere to write (#1125, #650). */
export const FREE_DISK_FLOOR_BYTES = 1024 * 1024 * 1024;

/**
 * Whether `dir`'s filesystem has room for `bytes` plus a safety margin. Fails
 * OPEN — if statfs can't be read, nothing is blocked.
 */
export function hasFreeSpaceFor(
  dir: string,
  bytes: number,
  marginBytes = FREE_DISK_FLOOR_BYTES,
): boolean {
  try {
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize >= bytes + marginBytes;
  } catch {
    return true;
  }
}
