// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { deleteUser } from '../db/users.js';
import { dccPathsOwnedBy } from '../db/dccFiles.js';
import { removeDccFilesOf } from './dccPaths.js';
import ircManager from './ircManager.js';

/**
 * Delete an account and what it owns. Its live IRC connections (and its WS
 * sockets, via the 'user-disposed' listener in wsHub) go first, so in-flight
 * events stop trying to persist against the about-to-be-deleted networks.
 * Otherwise the next incoming PRIVMSG crashes the process on a FOREIGN KEY
 * violation in messages.network_id. Its DCC files (#1152) go last: their paths
 * are read while the rows that name them exist, and removed once the delete has
 * gone through, so a delete that fails leaves the account whole.
 */
export function deleteAccount(user: { id: number; username: string }, reason: string): void {
  ircManager.disposeUser(user.id, reason);
  const dccPaths = dccPathsOwnedBy(user.id);
  deleteUser(user.id);
  removeDccFilesOf(user.username, dccPaths);
}
