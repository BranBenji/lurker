// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// What push.lurker.chat says about this server's key (lurker-dev/RELAY_PLAN.md
// §6.5), as the server reads its /status answer and the admin pane renders it.
// One definition for both sides: the pane's switch over `state` is exhaustive, so
// a state added here fails the client's typecheck until it has words.

export type RelayStatus =
  /** Pushes are accepted: comped, or paid through `paidThrough` (ISO). */
  | { state: 'active'; comped: boolean; paidThrough: string | null }
  /** Not accepted: an unknown key (`registered` false) or a lapsed one. */
  | { state: 'inactive'; registered: boolean }
  /** The relay rejected our signature (401). */
  | { state: 'unauthorized' }
  /** Any other 4xx: the relay answered, and said no to the question itself. */
  | { state: 'refused'; httpStatus: number }
  /** No usable answer: network error, timeout, 5xx, or an unparseable body. */
  | { state: 'unreachable'; reason: string };
