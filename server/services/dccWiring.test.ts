// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// DCC wiring (#270, phase 0): the glue between an inbound CTCP `DCC SEND` and the
// download manager on IrcConnection. The wire parse is unit-pinned in
// dcc.test.ts; these exercise the PLUMBING — does an enabled user get a detected
// offer recorded as pending_approval with a surfaced status line, does a disabled
// user fall through to the ordinary unsupported-CTCP path with no row, and are
// non-SEND subtypes recorded-not.

// MUST be first — redirect DATABASE_PATH before the static imports below open
// the real data/lurker.db.
import '../test-utils/isolateDb.js';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import db from '../db/index.js';
import { createNetwork } from '../db/networks.js';
import { createUser } from '../db/users.js';
import {
  CAPABILITY_DCC_CHAT,
  CAPABILITY_DCC_RECEIVE,
  setUserCapability,
} from '../db/userCapabilities.js';
import {
  insertDccTransfer,
  listDccTransfers,
  markDccCompleted,
  markDccReceiving,
  updateDccTransferState,
} from '../db/dccTransfers.js';
import { crc32Hex, crc32Update } from './dcc.js';
import { setDccStorageLimit } from '../db/dccStorageLimits.js';
import { forgetDccFile } from '../db/dccFiles.js';
import { IrcConnection } from './ircConnection.js';

// Transfer rows reach the user's clients as `dcc-transfer` frames (#1084).
const userFrame = vi.fn<(frame: Record<string, unknown>) => void>();
const frames = () =>
  userFrame.mock.calls.map(
    ([frame]) => frame as { kind: string; transfer: Record<string, unknown> },
  );

beforeAll(() => {
  createUser('dcc-wire-alice'); // id 1
  createNetwork(1, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'alice' }); // network id 1
});

let tmpDir: string | null = null;
let activeSender: { close: () => void } | null = null;
afterEach(() => {
  // Isolate each test: the DB and env persist across a file's tests.
  delete process.env.LURKER_DCC_ENABLED;
  delete process.env.LURKER_DCC_DIR;
  delete process.env.LURKER_DCC_ALLOW_PRIVATE_HOSTS;
  delete process.env.LURKER_DCC_MAX_FILE_MB;
  setUserCapability(1, CAPABILITY_DCC_RECEIVE, false);
  db.prepare('DELETE FROM dcc_transfers').run();
  db.prepare('DELETE FROM dcc_files').run();
  setDccStorageLimit(1, null);
  activeSender?.close();
  activeSender = null;
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

function makeConn(networkFields: Record<string, unknown> = {}): IrcConnection {
  return new IrcConnection({
    network: {
      client_cert: null,
      client_key: null,
      proxy_enabled: 0,
      proxy_type: null,
      proxy_host: null,
      proxy_port: null,
      proxy_username: null,
      proxy_password: null,
      id: 1,
      user_id: 1,
      name: 'n',
      host: 'irc.example.test',
      port: 6697,
      tls: 1,
      trusted_certificates: 1,
      nick: 'alice',
      username: null,
      realname: null,
      server_password: null,
      autoconnect: 1,
      sasl_account: null,
      sasl_password: null,
      connect_commands: null,
      position: 0,
      casemapping: null,
      created_at: new Date().toISOString(),
      ...networkFields,
    },
    onEvent: () => {},
    onUserFrame: userFrame,
  });
}

function harness() {
  const conn = makeConn();
  const ctcpResponse = vi.fn<(target: string, type: string, ...p: string[]) => void>();
  const publishEphemeral = vi.fn<(event: Record<string, unknown>) => void>();
  conn.client.ctcpResponse = ctcpResponse;
  conn.publishEphemeral = publishEphemeral;
  // DCC status lines are stored lines in the peer's DM (#1085); the rest of
  // CTCP stays ephemeral.
  const publish = vi.spyOn(conn, 'publish');
  const ctcpLines = () =>
    [...publishEphemeral.mock.calls, ...publish.mock.calls]
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.type === 'ctcp' || e.type === 'dcc') as Array<{
      target: string;
      text: string;
    }>;
  return { conn, ctcpResponse, ctcpLines };
}

// Both tiers of the gate on: cell-wide master switch + per-user grant.
function enableDcc() {
  process.env.LURKER_DCC_ENABLED = '1';
  setUserCapability(1, CAPABILITY_DCC_RECEIVE, true);
}

function makePayload(n: number): Buffer {
  return Buffer.from(Array.from({ length: n }, (_, i) => i % 256));
}

// A fake DCC sender: writes the payload then half-closes.
function startSender(toSend: Buffer): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.on('error', () => {});
      sock.write(toSend, () => sock.end());
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, close: () => server.close() });
    });
  });
}

function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for condition'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('inbound DCC SEND — enabled', () => {
  it('records the offer as pending_approval and surfaces a status line', () => {
    enableDcc();
    const { conn, ctcpLines } = harness();

    conn.client.emit('ctcp request', {
      nick: '[EWG]MArchive',
      ident: 'a',
      hostname: 'h',
      type: 'DCC',
      message: 'DCC SEND scene.mkv 3232235777 50612 5368709120',
    });

    const rows = listDccTransfers(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      network_id: 1,
      peer_nick: '[EWG]MArchive',
      filename: 'scene.mkv',
      advertised_size: 5368709120, // > 4 GiB, exact
      state: 'pending_approval',
      passive: 0,
      received_bytes: 0,
    });
    const last = ctcpLines().at(-1);
    expect(last?.text).toBe('DCC: [EWG]MArchive offered "scene.mkv" (5.0 GB) via DCC SEND');
  });

  it('captures a passive offer with its token', () => {
    enableDcc();
    const { conn } = harness();
    conn.client.emit('ctcp request', {
      nick: 'bot',
      type: 'DCC',
      message: 'DCC SEND f.bin 16843009 0 1024 42',
    });
    const row = listDccTransfers(1)[0];
    expect(row.passive).toBe(1);
    expect(row.token).toBe(42);
    expect(row.state).toBe('pending_approval');
  });

  // CHAT used to land here too; it has its own handler now (dccChatWiring.test.ts).
  // RESUME is the remaining subtype we recognise but never receive.
  it('records nothing for a non-SEND subtype but still surfaces it', () => {
    enableDcc();
    const { conn, ctcpLines } = harness();
    conn.client.emit('ctcp request', {
      nick: 'bob',
      type: 'DCC',
      message: 'DCC RESUME show.mkv 50612 1024',
    });
    expect(listDccTransfers(1)).toHaveLength(0);
    expect(ctcpLines().at(-1)?.text).toBe('bob requested CTCP DCC (no reply)');
  });

  it('ignores our own DCC offer echoed back by an echo-message server', () => {
    enableDcc();
    const { conn } = harness();
    conn.client.emit('ctcp request', {
      nick: 'alice', // our own nick
      type: 'DCC',
      message: 'DCC SEND x 16843009 1 1',
    });
    expect(listDccTransfers(1)).toHaveLength(0);
  });
});

describe('inbound DCC SEND — disabled (gate closed)', () => {
  it('falls through to the ordinary unsupported-CTCP path with no row', () => {
    // master switch + capability both off (default)
    const { conn, ctcpLines } = harness();
    conn.client.emit('ctcp request', {
      nick: 'bot',
      type: 'DCC',
      message: 'DCC SEND f.bin 16843009 50612 1024',
    });
    expect(listDccTransfers(1)).toHaveLength(0);
    expect(ctcpLines().at(-1)?.text).toBe('bot requested CTCP DCC (no reply)');
  });

  it('stays closed when only the per-user grant is on (master off)', () => {
    setUserCapability(1, CAPABILITY_DCC_RECEIVE, true);
    const { conn } = harness();
    conn.client.emit('ctcp request', {
      nick: 'bot',
      type: 'DCC',
      message: 'DCC SEND f.bin 16843009 50612 1024',
    });
    expect(listDccTransfers(1)).toHaveLength(0);
  });

  // Chat without files (#1080): a file offer to a chat-only account reads as
  // it would to an account without DCC at all, and arms nothing.
  it('stays closed to file offers and XDCC triggers for a chat-only account', () => {
    process.env.LURKER_DCC_ENABLED = '1';
    setUserCapability(1, CAPABILITY_DCC_CHAT, true);
    try {
      const { conn, ctcpLines } = harness();
      conn.client.say = vi.fn<(target: string, text: string) => void>();
      conn.say('bot', 'xdcc send #1');
      conn.client.emit('ctcp request', {
        nick: 'bot',
        type: 'DCC',
        message: 'DCC SEND f.bin 16843009 50612 1024',
      });
      expect(listDccTransfers(1)).toHaveLength(0);
      expect(ctcpLines().at(-1)?.text).toBe('bot requested CTCP DCC (no reply)');
    } finally {
      setUserCapability(1, CAPABILITY_DCC_CHAT, false);
    }
  });
});

describe('arm-on-trigger + auto-accept', () => {
  it('arms a requested row when the user sends an XDCC trigger to a bot', () => {
    enableDcc();
    const { conn } = harness();
    conn.client.say = vi.fn<(target: string, text: string) => void>();
    conn.say('[EWG]MArchive', 'xdcc send #27228');
    const rows = listDccTransfers(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: 'requested',
      peer_nick: '[EWG]MArchive',
      filename: 'XDCC #27228',
      trigger_text: 'xdcc send #27228',
      advertised_size: 0,
    });
  });

  it('does not arm a channel-targeted trigger or when DCC is disabled', () => {
    const { conn } = harness();
    conn.client.say = vi.fn<(target: string, text: string) => void>();
    // disabled
    conn.say('bot', 'xdcc send #1');
    expect(listDccTransfers(1)).toHaveLength(0);
    // enabled but sent to a channel → not armed
    enableDcc();
    conn.say('#chan', 'xdcc send #1');
    expect(listDccTransfers(1)).toHaveLength(0);
  });

  it('auto-accepts a matching offer and streams the file to disk', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-dcc-e2e-'));
    process.env.LURKER_DCC_DIR = tmpDir;
    process.env.LURKER_DCC_ALLOW_PRIVATE_HOSTS = '1'; // the fake sender is on 127.0.0.1
    enableDcc();
    const payload = makePayload(40_000);
    const sender = await startSender(payload);
    activeSender = sender;

    const { conn } = harness();
    conn.client.say = vi.fn<(target: string, text: string) => void>();

    // 1. user fires the trigger → arms a requested row
    conn.say('[EWG]MArchive', 'xdcc send #1');
    // 2. bot answers with a DCC SEND offer (127.0.0.1 = 2130706433)
    conn.client.emit('ctcp request', {
      nick: '[EWG]MArchive',
      type: 'DCC',
      message: `DCC SEND payload.bin 2130706433 ${sender.port} ${payload.length}`,
    });

    // 3. the download runs to completion on its own socket
    await waitFor(() => listDccTransfers(1)[0]?.state === 'completed', 5000);

    const row = listDccTransfers(1)[0];
    expect(row.received_bytes).toBe(payload.length);
    expect(row.destination_path).toBe(path.join(tmpDir, 'dcc-wire-alice', 'payload.bin'));
    expect(fs.readFileSync(row.destination_path as string).equals(payload)).toBe(true);
    expect(row.crc_status).toBe('absent'); // filename carried no CRC → size is the integrity signal
    // A progress checkpoint goes out as the row its write returned (#1084).
    expect(
      frames().some(
        (f) => f.transfer.state === 'receiving' && Number(f.transfer.received_bytes) > 0,
      ),
    ).toBe(true);
    const sent = frames();
    expect(sent.filter((f) => f.kind === 'dcc-transfer').at(-1)?.transfer).toMatchObject({
      id: row.id,
      state: 'completed',
    });
    // And the file it produced is the account's now (#1133).
    expect(sent.at(-1)).toMatchObject({
      kind: 'dcc-file',
      file: { name: 'payload.bin', size: payload.length, origin: 'received', transfer_id: row.id },
    });
  });

  it('fails an armed passive offer when this server has nowhere to listen', () => {
    enableDcc();
    const { conn } = harness();
    conn.client.say = vi.fn<(target: string, text: string) => void>();
    conn.say('bot', 'xdcc send #2');
    conn.client.emit('ctcp request', {
      nick: 'bot',
      type: 'DCC',
      message: 'DCC SEND f.bin 2130706433 0 1024 7', // port 0 = passive
    });
    const row = listDccTransfers(1)[0];
    expect(row.state).toBe('failed');
    expect(row.error).toBe('this server has no listening port configured');
  });

  it('refuses an armed offer pointing at a private/loopback address (SSRF guard)', () => {
    enableDcc(); // note: LURKER_DCC_ALLOW_PRIVATE_HOSTS is NOT set
    const { conn } = harness();
    conn.client.say = vi.fn<(target: string, text: string) => void>();
    conn.say('bot', 'xdcc send #3');
    conn.client.emit('ctcp request', {
      nick: 'bot',
      type: 'DCC',
      message: 'DCC SEND f.bin 2130706433 8080 1024', // 2130706433 = 127.0.0.1
    });
    const row = listDccTransfers(1)[0];
    expect(row.state).toBe('failed');
    expect(row.error).toMatch(/blocked address/i);
  });

  it('refuses an armed offer with no advertised size', () => {
    enableDcc();
    const { conn } = harness();
    conn.client.say = vi.fn<(target: string, text: string) => void>();
    conn.say('bot', 'xdcc send #4');
    conn.client.emit('ctcp request', {
      nick: 'bot',
      type: 'DCC',
      message: 'DCC SEND f.bin 16843009 8080 0', // 1.1.1.1 (public), size 0
    });
    const row = listDccTransfers(1)[0];
    expect(row.state).toBe('failed');
    expect(row.error).toMatch(/no advertised/i);
  });

  // An XDCC request armed before the receive grant was revoked is something
  // the user already started (#1080): the bot's SEND still lands on the armed
  // row instead of reading as an unsolicited CTCP and stranding it.
  it('still matches an armed request whose receive grant was revoked meanwhile', () => {
    enableDcc();
    const { conn, ctcpLines } = harness();
    conn.client.say = vi.fn<(target: string, text: string) => void>();
    conn.say('bot', 'xdcc send #6');
    setUserCapability(1, CAPABILITY_DCC_RECEIVE, false);
    conn.client.emit('ctcp request', {
      nick: 'bot',
      type: 'DCC',
      message: 'DCC SEND f.bin 16843009 8080 0', // 1.1.1.1 (public), size 0
    });
    // Reached the armed path: refused there for its size, not left 'requested'.
    const row = listDccTransfers(1)[0];
    expect(row.state).toBe('failed');
    expect(row.error).toMatch(/no advertised/i);
    expect(ctcpLines().at(-1)?.text).not.toBe('bot requested CTCP DCC (no reply)');
  });

  // #1125: the admin's per-user limit, checked when a transfer is accepted.
  describe('storage limit', () => {
    const userDir = () => path.join(tmpDir!, 'dcc-wire-alice');
    const offer = (conn: IrcConnection, port: number, size: number, name = 'big.bin') => {
      conn.say('bot', 'xdcc send #9');
      conn.client.emit('ctcp request', {
        nick: 'bot',
        type: 'DCC',
        message: `DCC SEND ${name} 2130706433 ${port} ${size}`,
      });
    };
    const setup = () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-dcc-limit-'));
      process.env.LURKER_DCC_DIR = tmpDir;
      process.env.LURKER_DCC_ALLOW_PRIVATE_HOSTS = '1';
      enableDcc();
      fs.mkdirSync(userDir(), { recursive: true });
      const { conn } = harness();
      conn.client.say = vi.fn<(target: string, text: string) => void>();
      return conn;
    };

    // A finished file the user still has counts what it received.
    const received = (name: string, bytes: number) => {
      const id = insertDccTransfer(1, {
        network_id: 1,
        peer_nick: 'other',
        filename: name,
        advertised_size: bytes,
        state: 'pending_approval',
      });
      markDccReceiving(id, {
        filename: name,
        advertised_size: bytes,
        destination_path: path.join(userDir(), name),
        received_bytes: bytes,
      });
      markDccCompleted(id, bytes);
      return id;
    };

    it('refuses a transfer that would take the account over, and says so live', () => {
      const conn = setup();
      received('old.bin', 3000);
      setDccStorageLimit(1, 6000);
      offer(conn, 50612, 5000);
      const row = listDccTransfers(1)[0];
      expect(row.state).toBe('failed');
      expect(row.error).toMatch(/over your DCC storage limit \(2\.9 KB of 5\.9 KB used\)/);
      // An armed request has no HTTP reply to carry the row: the frame is it.
      expect(frames().at(-1)).toMatchObject({
        kind: 'dcc-transfer',
        transfer: { id: row.id, state: 'failed' },
      });
    });

    it('stops counting a file once it is deleted', () => {
      const conn = setup();
      const old = received('old.bin', 3000);
      const { file_id } = db.prepare('SELECT file_id FROM dcc_transfers WHERE id = ?').get(old) as {
        file_id: number;
      };
      forgetDccFile(1, file_id);
      setDccStorageLimit(1, 6000);
      offer(conn, 50612, 5000);
      expect(listDccTransfers(1)[0].error ?? '').not.toMatch(/storage limit/);
    });

    // A transfer in flight will still add its remaining bytes.
    it('counts what transfers in flight will still add', () => {
      const conn = setup();
      setDccStorageLimit(1, 6000);
      const busy = insertDccTransfer(1, {
        network_id: 1,
        peer_nick: 'other',
        filename: 'busy.bin',
        advertised_size: 4000,
        state: 'pending_approval',
      });
      markDccReceiving(busy, {
        filename: 'busy.bin',
        advertised_size: 4000,
        destination_path: path.join(userDir(), 'busy.bin'),
        received_bytes: 1000,
      });
      fs.writeFileSync(path.join(userDir(), 'busy.bin'), Buffer.alloc(1000));
      // On disk 1000 + still to come 3000 + this 2500 = 6500 > 6000.
      offer(conn, 50612, 2500);
      expect(listDccTransfers(1)[0].error).toMatch(/over your DCC storage limit/);
    });

    it('lets a transfer that fits run to completion', async () => {
      const conn = setup();
      setDccStorageLimit(1, 50_000);
      const payload = makePayload(40_000);
      const sender = await startSender(payload);
      activeSender = sender;
      offer(conn, sender.port, payload.length, 'fits.bin');
      await waitFor(() => listDccTransfers(1)[0]?.state === 'completed', 5000);
      expect(listDccTransfers(1)[0].received_bytes).toBe(payload.length);
    });
  });

  it('does not arm an xdcc trigger mentioned mid-sentence', () => {
    enableDcc();
    const { conn } = harness();
    conn.client.say = vi.fn<(target: string, text: string) => void>();
    conn.say('bot', 'hey did you ever get that xdcc send #5 file?');
    expect(listDccTransfers(1)).toHaveLength(0);
  });

  it('verifies a matching filename CRC32 as ok', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-dcc-crc-'));
    process.env.LURKER_DCC_DIR = tmpDir;
    process.env.LURKER_DCC_ALLOW_PRIVATE_HOSTS = '1';
    enableDcc();
    const payload = makePayload(20_000);
    const crc = crc32Hex(crc32Update(0, payload));
    const sender = await startSender(payload);
    activeSender = sender;

    const { conn } = harness();
    conn.client.say = vi.fn<(target: string, text: string) => void>();
    conn.say('bot', 'xdcc send #9');
    conn.client.emit('ctcp request', {
      nick: 'bot',
      type: 'DCC',
      message: `DCC SEND show_[${crc}].mkv 2130706433 ${sender.port} ${payload.length}`,
    });

    await waitFor(() => listDccTransfers(1)[0]?.state === 'completed', 5000);
    const row = listDccTransfers(1)[0];
    expect(row.crc_expected).toBe(crc);
    expect(row.crc_actual).toBe(crc);
    expect(row.crc_status).toBe('ok');
  });

  it('resumes a partial via DCC RESUME/ACCEPT and completes the file', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-dcc-resume-'));
    process.env.LURKER_DCC_DIR = tmpDir;
    process.env.LURKER_DCC_ALLOW_PRIVATE_HOSTS = '1';
    enableDcc();

    const full = makePayload(30_000);
    const have = 10_000;
    // Pre-seed a 10k partial AND a tracked prior transfer for it (resume is gated
    // on our own incomplete row, not a stray same-named file).
    const userDir = path.join(tmpDir, 'dcc-wire-alice');
    fs.mkdirSync(userDir, { recursive: true });
    const partialPath = path.join(userDir, 'show.mkv');
    fs.writeFileSync(partialPath, full.subarray(0, have));
    const priorId = insertDccTransfer(1, {
      network_id: 1,
      peer_nick: 'bot',
      filename: 'show.mkv',
      advertised_size: full.length,
      state: 'requested',
    });
    markDccReceiving(priorId, {
      filename: 'show.mkv',
      advertised_size: full.length,
      destination_path: partialPath,
      received_bytes: have,
    });
    updateDccTransferState(priorId, 'failed', 'interrupted');
    // The bot resumes from `have`, so it streams only the remaining bytes.
    const sender = await startSender(full.subarray(have));
    activeSender = sender;

    const { conn } = harness();
    conn.client.say = vi.fn<(target: string, text: string) => void>();
    const resumeReq = vi.fn<(target: string, type: string, ...p: string[]) => void>();
    conn.client.ctcpRequest = resumeReq;

    conn.say('bot', 'xdcc send #1');
    // Bot offers the full file; Lurker sees the partial and asks to resume.
    conn.client.emit('ctcp request', {
      nick: 'bot',
      type: 'DCC',
      message: `DCC SEND show.mkv 2130706433 ${sender.port} ${full.length}`,
    });
    expect(resumeReq).toHaveBeenCalledWith('bot', 'DCC', `RESUME show.mkv ${sender.port} ${have}`);
    // The resume took over the earlier row's file (#1125): that row let go of
    // it, and every open view hears so.
    expect(
      frames().some((f) => f.transfer.id === priorId && f.transfer.destination_path === null),
    ).toBe(true);

    // Bot accepts the resume → Lurker connects and appends.
    conn.client.emit('ctcp request', {
      nick: 'bot',
      type: 'DCC',
      message: `DCC ACCEPT show.mkv ${sender.port} ${have}`,
    });

    await waitFor(() => listDccTransfers(1)[0]?.state === 'completed', 5000);
    const row = listDccTransfers(1)[0];
    expect(row.received_bytes).toBe(full.length);
    expect(row.crc_status).toBe('absent'); // no CRC32 in the name to check against
    expect(fs.readFileSync(path.join(userDir, 'show.mkv')).equals(full)).toBe(true);
  });

  // #1082: a resume only hashes what it appends, so the whole file is read back
  // and checked against the name's CRC32 once it is all there.
  describe('a resumed file whose name carries a CRC32', () => {
    async function resume(partial: Buffer, full: Buffer) {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-dcc-resume-crc-'));
      process.env.LURKER_DCC_DIR = tmpDir;
      process.env.LURKER_DCC_ALLOW_PRIVATE_HOSTS = '1';
      enableDcc();
      const name = `show_[${crc32Hex(crc32Update(0, full))}].mkv`;
      const userDir = path.join(tmpDir, 'dcc-wire-alice');
      fs.mkdirSync(userDir, { recursive: true });
      const partialPath = path.join(userDir, name);
      fs.writeFileSync(partialPath, partial);
      const priorId = insertDccTransfer(1, {
        network_id: 1,
        peer_nick: 'bot',
        filename: name,
        advertised_size: full.length,
        state: 'requested',
      });
      markDccReceiving(priorId, {
        filename: name,
        advertised_size: full.length,
        destination_path: partialPath,
        received_bytes: partial.length,
      });
      updateDccTransferState(priorId, 'failed', 'interrupted');
      const sender = await startSender(full.subarray(partial.length));
      activeSender = sender;
      const { conn } = harness();
      conn.client.say = vi.fn<(target: string, text: string) => void>();
      conn.client.ctcpRequest = vi.fn<(target: string, type: string, ...p: string[]) => void>();
      conn.say('bot', 'xdcc send #1');
      conn.client.emit('ctcp request', {
        nick: 'bot',
        type: 'DCC',
        message: `DCC SEND ${name} 2130706433 ${sender.port} ${full.length}`,
      });
      conn.client.emit('ctcp request', {
        nick: 'bot',
        type: 'DCC',
        message: `DCC ACCEPT ${name} ${sender.port} ${partial.length}`,
      });
      await waitFor(() => listDccTransfers(1).some((t) => t.state === 'completed'), 5000);
      return listDccTransfers(1).find((t) => t.state === 'completed')!;
    }

    it('says it verified when the whole file matches', async () => {
      const full = makePayload(30_000);
      const row = await resume(full.subarray(0, 10_000), full);
      expect(row.crc_status).toBe('ok');
      expect(row.crc_actual).toBe(row.crc_expected);
      // It went through 'verifying' while it was read back.
      expect(frames().some((f) => f.transfer.state === 'verifying')).toBe(true);
    });

    it('catches a partial that was already bad', async () => {
      const full = makePayload(30_000);
      const partial = Buffer.from(full.subarray(0, 10_000));
      partial[5] ^= 0xff;
      const row = await resume(partial, full);
      expect(row.crc_status).toBe('mismatch');
    });
  });

  // #1127: a resume continues a file nothing is writing. A second offer of a
  // file still downloading starts a file of its own; a re-offer while a resume
  // waits on the bot's ACCEPT takes that resume over.
  describe('a second offer of the same file', () => {
    function setup() {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-dcc-second-offer-'));
      process.env.LURKER_DCC_DIR = tmpDir;
      process.env.LURKER_DCC_ALLOW_PRIVATE_HOSTS = '1';
      enableDcc();
      const { conn } = harness();
      conn.client.say = vi.fn<(target: string, text: string) => void>();
      const resumeReq = vi.fn<(target: string, type: string, ...p: string[]) => void>();
      conn.client.ctcpRequest = resumeReq;
      const offer = (port: number, size: number) => {
        conn.say('bot', 'xdcc send #1');
        conn.client.emit('ctcp request', {
          nick: 'bot',
          type: 'DCC',
          message: `DCC SEND show.mkv 2130706433 ${port} ${size}`,
        });
        // With #1 already out, the second offer waits for the user: Accept it,
        // as the DCC window would.
        const pending = listDccTransfers(1).find((t) => t.state === 'pending_approval');
        if (pending) conn.acceptPendingDcc(pending);
      };
      return { resumeReq, offer, userDir: path.join(tmpDir, 'dcc-wire-alice') };
    }

    it('leaves a file another receive is writing alone', async () => {
      const { resumeReq, offer, userDir } = setup();
      const full = makePayload(30_000);
      // A sender that sends a third of the file, then holds the connection.
      const socks: net.Socket[] = [];
      const server = net.createServer((sock) => {
        socks.push(sock);
        sock.on('error', () => {});
        sock.write(full.subarray(0, 10_000));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      activeSender = {
        close: () => {
          for (const sock of socks) sock.destroy();
          server.close();
        },
      };
      const port = (server.address() as net.AddressInfo).port;
      const live = path.join(userDir, 'show.mkv');
      offer(port, full.length);
      await waitFor(() => fs.existsSync(live) && fs.statSync(live).size === 10_000, 5000);

      offer(port, full.length);
      expect(resumeReq).not.toHaveBeenCalled();
      const paths = listDccTransfers(1)
        .filter((t) => t.state === 'receiving')
        .map((t) => t.destination_path);
      expect(paths).toHaveLength(2);
      expect(new Set(paths).size).toBe(2);
      expect(paths).toContain(live);
    });

    it('takes over a resume still waiting on the bot', () => {
      const { resumeReq, offer, userDir } = setup();
      fs.mkdirSync(userDir, { recursive: true });
      const partialPath = path.join(userDir, 'show.mkv');
      fs.writeFileSync(partialPath, makePayload(10_000));
      const priorId = insertDccTransfer(1, {
        network_id: 1,
        peer_nick: 'bot',
        filename: 'show.mkv',
        advertised_size: 30_000,
        state: 'requested',
      });
      markDccReceiving(priorId, {
        filename: 'show.mkv',
        advertised_size: 30_000,
        destination_path: partialPath,
        received_bytes: 10_000,
      });
      updateDccTransferState(priorId, 'failed', 'interrupted');
      offer(50_001, 30_000);
      const waiting = listDccTransfers(1).find((t) => t.state === 'receiving')!;
      offer(50_001, 30_000);
      expect(resumeReq).toHaveBeenCalledTimes(2);
      const rows = listDccTransfers(1);
      expect(rows.find((t) => t.id === waiting.id)).toMatchObject({
        state: 'stalled',
        error: 'superseded by a newer resume',
      });
      expect(rows.find((t) => t.state === 'receiving')?.destination_path).toBe(partialPath);
    });
  });

  // Revoking stops what starts next; a transfer already running finishes (#1080),
  // and the bot's ACCEPT for our RESUME is part of the running transfer.
  it('finishes a resume whose grant is revoked before the bot answers', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-dcc-resume-revoked-'));
    process.env.LURKER_DCC_DIR = tmpDir;
    process.env.LURKER_DCC_ALLOW_PRIVATE_HOSTS = '1';
    enableDcc();

    const full = makePayload(30_000);
    const have = 10_000;
    // Pre-seed a 10k partial AND a tracked prior transfer for it (resume is gated
    // on our own incomplete row, not a stray same-named file).
    const userDir = path.join(tmpDir, 'dcc-wire-alice');
    fs.mkdirSync(userDir, { recursive: true });
    const partialPath = path.join(userDir, 'show.mkv');
    fs.writeFileSync(partialPath, full.subarray(0, have));
    const priorId = insertDccTransfer(1, {
      network_id: 1,
      peer_nick: 'bot',
      filename: 'show.mkv',
      advertised_size: full.length,
      state: 'requested',
    });
    markDccReceiving(priorId, {
      filename: 'show.mkv',
      advertised_size: full.length,
      destination_path: partialPath,
      received_bytes: have,
    });
    updateDccTransferState(priorId, 'failed', 'interrupted');
    // The bot resumes from `have`, so it streams only the remaining bytes.
    const sender = await startSender(full.subarray(have));
    activeSender = sender;

    const { conn } = harness();
    conn.client.say = vi.fn<(target: string, text: string) => void>();
    const resumeReq = vi.fn<(target: string, type: string, ...p: string[]) => void>();
    conn.client.ctcpRequest = resumeReq;

    conn.say('bot', 'xdcc send #1');
    // Bot offers the full file; Lurker sees the partial and asks to resume.
    conn.client.emit('ctcp request', {
      nick: 'bot',
      type: 'DCC',
      message: `DCC SEND show.mkv 2130706433 ${sender.port} ${full.length}`,
    });
    expect(resumeReq).toHaveBeenCalledWith('bot', 'DCC', `RESUME show.mkv ${sender.port} ${have}`);

    setUserCapability(1, CAPABILITY_DCC_RECEIVE, false);
    conn.client.emit('ctcp request', {
      nick: 'bot',
      type: 'DCC',
      message: `DCC ACCEPT show.mkv ${sender.port} ${have}`,
    });

    await waitFor(() => listDccTransfers(1)[0]?.state === 'completed', 5000);
    const row = listDccTransfers(1)[0];
    expect(row.received_bytes).toBe(full.length);
    expect(row.crc_status).toBe('absent'); // no CRC32 in the name to check against
    expect(fs.readFileSync(path.join(userDir, 'show.mkv')).equals(full)).toBe(true);
  });

  it('flags a mismatched filename CRC32', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-dcc-crc-'));
    process.env.LURKER_DCC_DIR = tmpDir;
    process.env.LURKER_DCC_ALLOW_PRIVATE_HOSTS = '1';
    enableDcc();
    const payload = makePayload(12_345);
    const sender = await startSender(payload);
    activeSender = sender;

    const { conn } = harness();
    conn.client.say = vi.fn<(target: string, text: string) => void>();
    conn.say('bot', 'xdcc send #10');
    conn.client.emit('ctcp request', {
      nick: 'bot',
      type: 'DCC',
      message: `DCC SEND show_[DEADBEEF].mkv 2130706433 ${sender.port} ${payload.length}`,
    });

    await waitFor(() => listDccTransfers(1)[0]?.state === 'completed', 5000);
    const row = listDccTransfers(1)[0];
    expect(row.crc_expected).toBe('DEADBEEF');
    expect(row.crc_actual).toBe(crc32Hex(crc32Update(0, payload)));
    expect(row.crc_status).toBe('mismatch');
  });
});

describe('pending-offer actions (phase 2)', () => {
  it('records an unsolicited offer with its host/port and accepts it on demand', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-dcc-accept-'));
    process.env.LURKER_DCC_DIR = tmpDir;
    process.env.LURKER_DCC_ALLOW_PRIVATE_HOSTS = '1';
    enableDcc();
    const payload = makePayload(15_000);
    const sender = await startSender(payload);
    activeSender = sender;

    const { conn } = harness();
    // Unsolicited (no arming) → recorded as pending_approval with its host/port.
    conn.client.emit('ctcp request', {
      nick: 'bot',
      type: 'DCC',
      message: `DCC SEND show.mkv 2130706433 ${sender.port} ${payload.length}`,
    });
    const pending = listDccTransfers(1)[0];
    expect(pending.state).toBe('pending_approval');
    expect(pending.peer_host).toBe('127.0.0.1');
    expect(pending.peer_port).toBe(sender.port);

    // Accept it later → starts the download from the stored offer.
    conn.acceptPendingDcc(pending);
    await waitFor(() => listDccTransfers(1)[0]?.state === 'completed', 5000);
    const row = listDccTransfers(1)[0];
    expect(row.received_bytes).toBe(payload.length);
    expect(fs.readFileSync(path.join(tmpDir, 'dcc-wire-alice', 'show.mkv')).equals(payload)).toBe(
      true,
    );
  });

  it('rejects a pending offer', () => {
    enableDcc();
    const { conn } = harness();
    conn.client.emit('ctcp request', {
      nick: 'bot',
      type: 'DCC',
      message: 'DCC SEND f.bin 16843009 5000 100',
    });
    const id = listDccTransfers(1)[0].id;
    conn.rejectDcc(id);
    expect(listDccTransfers(1)[0].state).toBe('rejected');
  });

  it('cancels a still-pending offer', () => {
    enableDcc();
    const { conn } = harness();
    conn.client.emit('ctcp request', {
      nick: 'bot',
      type: 'DCC',
      message: 'DCC SEND f.bin 16843009 5000 100',
    });
    const id = listDccTransfers(1)[0].id;
    conn.cancelDcc(id);
    expect(listDccTransfers(1)[0].state).toBe('cancelled');
  });

  it('reject/cancel do not clobber a terminal (completed) transfer', () => {
    enableDcc();
    const { conn } = harness();
    const id = insertDccTransfer(1, {
      network_id: 1,
      peer_nick: 'bot',
      filename: 'done.bin',
      advertised_size: 100,
      state: 'requested',
    });
    updateDccTransferState(id, 'completed');
    conn.rejectDcc(id);
    expect(listDccTransfers(1)[0].state).toBe('completed');
    conn.cancelDcc(id);
    expect(listDccTransfers(1)[0].state).toBe('completed');
  });

  it('accepting a pending offer with no stored address fails it visibly', () => {
    enableDcc();
    const { conn } = harness();
    // A pending row whose peer_host/peer_port were never decoded (e.g. predates
    // the columns) — can't be dialed, so Accept must fail it, not silently no-op.
    insertDccTransfer(1, {
      network_id: 1,
      peer_nick: 'bot',
      filename: 'noaddr.bin',
      advertised_size: 100,
      state: 'pending_approval',
    });
    const row = listDccTransfers(1)[0];
    expect(row.peer_host).toBeNull();
    conn.acceptPendingDcc(row);
    const after = listDccTransfers(1)[0];
    expect(after.state).toBe('failed');
    expect(after.error).toMatch(/address/i);
  });

  it('cancelling during the resume wait clears the timeout (no late failure)', () => {
    vi.useFakeTimers();
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-dcc-cancel-resume-'));
      process.env.LURKER_DCC_DIR = tmpDir;
      process.env.LURKER_DCC_ALLOW_PRIVATE_HOSTS = '1';
      enableDcc();

      const full = makePayload(30_000);
      const have = 10_000;
      // Pre-seed a partial + a tracked prior incomplete row so the offer takes the
      // RESUME branch (which arms a 15s timer and waits for the bot's DCC ACCEPT,
      // starting NO receiver yet).
      const userDir = path.join(tmpDir, 'dcc-wire-alice');
      fs.mkdirSync(userDir, { recursive: true });
      const partialPath = path.join(userDir, 'show.mkv');
      fs.writeFileSync(partialPath, full.subarray(0, have));
      const priorId = insertDccTransfer(1, {
        network_id: 1,
        peer_nick: 'bot',
        filename: 'show.mkv',
        advertised_size: full.length,
        state: 'requested',
      });
      markDccReceiving(priorId, {
        filename: 'show.mkv',
        advertised_size: full.length,
        destination_path: partialPath,
        received_bytes: have,
      });
      updateDccTransferState(priorId, 'failed', 'interrupted');

      const { conn } = harness();
      conn.client.say = vi.fn<(target: string, text: string) => void>();
      conn.client.ctcpRequest = vi.fn<(target: string, type: string, ...p: string[]) => void>();

      conn.say('bot', 'xdcc send #1'); // arm a fresh requested row
      conn.client.emit('ctcp request', {
        nick: 'bot',
        type: 'DCC',
        message: `DCC SEND show.mkv 16843009 9999 ${full.length}`, // public host, resume branch
      });
      const armed = listDccTransfers(1).find((r) => r.id !== priorId)!;
      expect(armed.state).toBe('receiving'); // RESUME requested, awaiting ACCEPT

      conn.cancelDcc(armed.id);
      expect(listDccTransfers(1).find((r) => r.id === armed.id)!.state).toBe('cancelled');

      // The 15s resume timeout must have been cleared by the cancel — advancing
      // past it must NOT overwrite 'cancelled' with 'failed'.
      vi.advanceTimersByTime(20_000);
      expect(listDccTransfers(1).find((r) => r.id === armed.id)!.state).toBe('cancelled');
    } finally {
      vi.useRealTimers();
    }
  });

  // ⚠⚠ Proxied networks (#303). DCC leaves the tunnel in both directions — a
  // receive is a bare net.connect and an offer advertises a reachable address —
  // so it is refused. Gated at BOTH ends on purpose: the offer gate stops new
  // ones, and the accept gate stops the backlog, because a row recorded while
  // the network was direct is still sitting in the Transfers view after the
  // user configures a proxy and reconnects.
  describe('refused on a proxied network', () => {
    const PROXIED = {
      proxy_enabled: 1,
      proxy_type: 'socks5',
      proxy_host: '127.0.0.1',
      proxy_port: 9050,
    };

    it('ignores an incoming offer and says why', () => {
      enableDcc();
      const conn = makeConn(PROXIED);
      const published: Record<string, unknown>[] = [];
      conn.publish = (event: unknown) => {
        published.push(event as Record<string, unknown>);
      };
      conn.client.emit('ctcp request', {
        nick: 'bot',
        type: 'DCC',
        message: 'DCC SEND show.mkv 2130706433 5000 100',
      });
      expect(listDccTransfers(1)).toHaveLength(0);
      expect(String(published.find((e) => e.type === 'error')?.text)).toMatch(/proxy/i);
    });

    it('fails an already-pending offer rather than dialling out', () => {
      // The row is recorded on a DIRECT connection, then the user proxies the
      // network. Accepting must not reach for the peer.
      enableDcc();
      const direct = makeConn();
      direct.client.emit('ctcp request', {
        nick: 'bot',
        type: 'DCC',
        message: 'DCC SEND show.mkv 2130706433 5001 100',
      });
      const pending = listDccTransfers(1)[0];
      expect(pending.state).toBe('pending_approval');

      makeConn(PROXIED).acceptPendingDcc(pending);
      const after = listDccTransfers(1).find((r) => r.id === pending.id)!;
      expect(after.state).toBe('failed');
      expect(String(after.error ?? '')).toMatch(/proxy/i);
    });
  });
});
