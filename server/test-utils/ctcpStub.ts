// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { IrcConnection } from '../services/ircConnection.js';

/**
 * Observe the CTCP requests a connection sends. They go through the outbound
 * queue and out of client.raw as `PRIVMSG <target> :\x01<TYPE> <payload>\x01`
 * (#1149); this reads each back out as (target, type, payload) for assertions
 * written against client.ctcpRequest. Every other line goes on to whatever
 * client.raw was.
 */
export function stubCtcpRequest(
  conn: IrcConnection,
  ctcpRequest: (target: string, type: string, ...params: string[]) => void,
): void {
  const client = conn.client as unknown as {
    raw(...args: string[]): void;
    rawString(...args: string[]): string;
  };
  const raw = client.raw.bind(client);
  // The framework's own ctcpRequest/ctcpResponse call raw with the command's
  // parts; a queued line arrives whole. Both read the same way.
  client.raw = (...args: string[]) => {
    const line = args.length === 1 ? args[0] : client.rawString(...args);
    // eslint-disable-next-line no-control-regex
    const m = /^PRIVMSG (\S+) :\u0001(\S+)(?: ([^\u0001]*))?\u0001$/.exec(line);
    if (m) ctcpRequest(m[1], m[2], ...(m[3] === undefined ? [] : [m[3]]));
    else raw(...args);
  };
}
