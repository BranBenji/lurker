// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Runs before every server test file (vitest.config.ts setupFiles).

// The outbound queue paces every line a registered connection writes, by what
// the server charges for it: five short lines at once, then one every 2 s
// (sendPacer.ts, #1149). An integration test that joins a few channels or
// restores a handful would otherwise spend its time waiting on the pacer, so
// pacing is off for the suite, and on only where a test is about it:
// `process.env.LURKER_SEND_PACING = '1'` in that file or describe.
process.env.LURKER_SEND_PACING = '0';
