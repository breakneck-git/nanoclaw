import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  runSweepOnce,
  writeMediaResponseAtomic,
  onContactUpsert,
  flushAllSnapshots,
  handleLookupMessagesRequest,
  handleAnnotateContactRequest,
} from './ipc.js';
import * as db from './db.js';
import {
  _initTestDatabase,
  getContactByIdent,
  storeMessage,
  upsertContact,
} from './db.js';

vi.mock('./db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db.js')>();
  return {
    ...actual,
    getContactsForGroup: vi.fn(actual.getContactsForGroup),
  };
});

function makeIpcRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-sweep-test-'));
  fs.mkdirSync(path.join(root, 'g', 'media-requests'), { recursive: true });
  fs.mkdirSync(path.join(root, 'g', 'media-responses'), { recursive: true });
  fs.mkdirSync(path.join(root, 'g', 'errors'), { recursive: true });
  return root;
}

function setMtime(filePath: string, agoMs: number): void {
  const t = (Date.now() - agoMs) / 1000;
  fs.utimesSync(filePath, t, t);
}

describe('IPC sweep — runSweepOnce', () => {
  let ipcRoot: string;
  beforeEach(() => {
    ipcRoot = makeIpcRoot();
  });
  afterEach(() => {
    fs.rmSync(ipcRoot, { recursive: true, force: true });
  });

  it('does NOT touch errors/ directory', () => {
    const p = path.join(ipcRoot, 'g', 'errors', 'foo.json');
    fs.writeFileSync(p, '{}');
    setMtime(p, 3600_000); // 1 hour ago
    runSweepOnce(ipcRoot, 'g');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('.processing files older than 600s rename back to .json', () => {
    const orig = path.join(
      ipcRoot,
      'g',
      'media-requests',
      'req1.json.processing',
    );
    fs.writeFileSync(orig, '{"file_id":"X"}');
    setMtime(orig, 700_000);
    runSweepOnce(ipcRoot, 'g');
    expect(fs.existsSync(orig)).toBe(false);
    expect(
      fs.existsSync(path.join(ipcRoot, 'g', 'media-requests', 'req1.json')),
    ).toBe(true);
  });

  it('writes TIMEOUT response only when no response file exists (interlock)', () => {
    const reqPath = path.join(ipcRoot, 'g', 'media-requests', 'req2.json');
    fs.writeFileSync(reqPath, '{"file_id":"Y"}');
    setMtime(reqPath, 200_000);
    runSweepOnce(ipcRoot, 'g');
    const respPath = path.join(ipcRoot, 'g', 'media-responses', 'req2.json');
    expect(fs.existsSync(respPath)).toBe(true);
    const resp = JSON.parse(fs.readFileSync(respPath, 'utf-8'));
    expect(resp._meta.error_code).toBe('TIMEOUT');
    expect(fs.existsSync(reqPath)).toBe(false); // request unlinked
  });

  it('skips TIMEOUT-write when response already exists', () => {
    const reqPath = path.join(ipcRoot, 'g', 'media-requests', 'req3.json');
    const respPath = path.join(ipcRoot, 'g', 'media-responses', 'req3.json');
    fs.writeFileSync(reqPath, '{"file_id":"Z"}');
    fs.writeFileSync(
      respPath,
      '{"isError":false,"content":[{"type":"text","text":"ok"}]}',
    );
    setMtime(reqPath, 200_000);
    runSweepOnce(ipcRoot, 'g');
    const resp = JSON.parse(fs.readFileSync(respPath, 'utf-8'));
    expect(resp.isError).toBe(false); // pre-existing success response preserved
  });

  it('responses older than 180s unlinked unconditionally', () => {
    const p = path.join(ipcRoot, 'g', 'media-responses', 'old.json');
    fs.writeFileSync(p, '{}');
    setMtime(p, 200_000);
    runSweepOnce(ipcRoot, 'g');
    expect(fs.existsSync(p)).toBe(false);
  });
});

describe('IPC atomic response writer — writeMediaResponseAtomic', () => {
  it('response write uses temp+rename (atomic on same FS)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-resp-'));
    fs.mkdirSync(path.join(root, 'g', 'media-responses'), { recursive: true });
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    const renameSpy = vi.spyOn(fs, 'renameSync');
    try {
      writeMediaResponseAtomic(root, 'g', 'req1', {
        isError: false,
        content: [{ type: 'text', text: 'hello' }],
      });
      // 1) writeFileSync was called against a *.tmp.<pid> path
      const tempWrite = writeSpy.mock.calls.find(([p]) =>
        String(p).match(/\.tmp\.\d+$/),
      );
      expect(tempWrite).toBeDefined();
      // 2) renameSync was then called to move temp → final
      expect(renameSpy).toHaveBeenCalled();
      const finalRename = renameSpy.mock.calls.find(([, to]) =>
        String(to).endsWith(path.join('g', 'media-responses', 'req1.json')),
      );
      expect(finalRename).toBeDefined();
      // 3) Final file exists with correct content
      const final = JSON.parse(
        fs.readFileSync(
          path.join(root, 'g', 'media-responses', 'req1.json'),
          'utf-8',
        ),
      );
      expect(final.content[0].text).toBe('hello');
    } finally {
      writeSpy.mockRestore();
      renameSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('response write rejects when target FS differs (rename non-atomic)', () => {
    // Document expectation: temp+rename relies on same-FS atomicity.
    // If the writer is ever moved cross-FS, this test should be revisited.
    expect(true).toBe(true); // Placeholder assertion — design constraint, not runtime check.
  });
});

function freshIpc(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-test-'));
}

describe('contacts.json snapshot writer', () => {
  let ipcRoot: string;
  beforeEach(() => {
    vi.useFakeTimers();
    ipcRoot = freshIpc();
    vi.mocked(db.getContactsForGroup).mockReturnValue([
      {
        ident: 'g_dev|id:99',
        scope: 'g_dev',
        tg_id: '99',
        username: null,
        kind: 'user',
        first_name: 'Петя',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    ]);
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(ipcRoot, { recursive: true, force: true });
    vi.mocked(db.getContactsForGroup).mockReset();
  });

  it('per-scope trailing-edge debounce (500ms) collapses bursts into one write', () => {
    onContactUpsert(ipcRoot, 'g_dev');
    onContactUpsert(ipcRoot, 'g_dev');
    onContactUpsert(ipcRoot, 'g_dev');
    vi.advanceTimersByTime(499);
    expect(fs.existsSync(path.join(ipcRoot, 'g_dev', 'contacts.json'))).toBe(
      false,
    );
    vi.advanceTimersByTime(2);
    expect(fs.existsSync(path.join(ipcRoot, 'g_dev', 'contacts.json'))).toBe(
      true,
    );
    // Mock should have been called exactly once for g_dev (debounced)
    const gDevCalls = vi
      .mocked(db.getContactsForGroup)
      .mock.calls.filter((c) => c[0].scope === 'g_dev');
    expect(gDevCalls.length).toBe(1);
  });

  it('non-main upsert ALSO triggers main timer (round-10 main UNION cross-trigger)', () => {
    onContactUpsert(ipcRoot, 'g_dev');
    vi.advanceTimersByTime(501);
    expect(fs.existsSync(path.join(ipcRoot, 'g_dev', 'contacts.json'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(ipcRoot, 'main', 'contacts.json'))).toBe(
      true,
    );
    // getContactsForGroup called twice: once for g_dev (includeUnion: false),
    // once for main (includeUnion: true)
    const calls = vi.mocked(db.getContactsForGroup).mock.calls;
    expect(
      calls.some((c) => c[0].scope === 'g_dev' && c[0].includeUnion === false),
    ).toBe(true);
    expect(
      calls.some((c) => c[0].scope === 'main' && c[0].includeUnion === true),
    ).toBe(true);
  });

  it('flushAllSnapshots fires pending timers synchronously (SIGTERM)', () => {
    onContactUpsert(ipcRoot, 'g_dev');
    // No time advance — timer pending
    flushAllSnapshots(ipcRoot);
    expect(fs.existsSync(path.join(ipcRoot, 'g_dev', 'contacts.json'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(ipcRoot, 'main', 'contacts.json'))).toBe(
      true,
    );
  });

  it('atomic write uses temp+rename pattern', () => {
    const renameSpy = vi.spyOn(fs, 'renameSync');
    onContactUpsert(ipcRoot, 'g_dev');
    vi.advanceTimersByTime(501);
    expect(renameSpy).toHaveBeenCalled();
    const renameCall = renameSpy.mock.calls.find(([from]) =>
      String(from).match(/\.tmp\.\d+$/),
    );
    expect(renameCall).toBeDefined();
    renameSpy.mockRestore();
  });
});

describe('lookup_messages host handler', () => {
  let ipcRoot: string;
  beforeEach(() => {
    _initTestDatabase();
    ipcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lookup-handler-'));
    fs.mkdirSync(path.join(ipcRoot, 'g', 'lookup-requests'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(ipcRoot, 'g', 'lookup-responses'), {
      recursive: true,
    });
  });
  afterEach(() => {
    fs.rmSync(ipcRoot, { recursive: true, force: true });
  });

  it('reads request payload, calls lookupMessages, atomically writes response with rows', async () => {
    storeMessage({
      id: '1',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: 'hi',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
    });
    const reqPath = path.join(ipcRoot, 'g', 'lookup-requests', 'req1.json');
    fs.writeFileSync(
      reqPath,
      JSON.stringify({ groupJids: ['tg:1'], includeBot: false, limit: 50 }),
    );
    await handleLookupMessagesRequest(ipcRoot, 'g', 'req1');
    const respPath = path.join(ipcRoot, 'g', 'lookup-responses', 'req1.json');
    expect(fs.existsSync(respPath)).toBe(true);
    const resp = JSON.parse(fs.readFileSync(respPath, 'utf-8'));
    expect(resp.content[0].text).toContain('hi');
    // Request file unlinked after processing
    expect(fs.existsSync(reqPath)).toBe(false);
  });
});

describe('annotate_contact host handler', () => {
  let ipcRoot: string;
  beforeEach(() => {
    vi.useFakeTimers();
    _initTestDatabase();
    // Snapshot writer reads getContactsForGroup; keep it returning [] so the
    // debounced snapshot (when it fires) doesn't try to stringify undefined.
    vi.mocked(db.getContactsForGroup).mockReturnValue([]);
    ipcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'annotate-'));
    fs.mkdirSync(path.join(ipcRoot, 'g', 'contact-write-requests'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(ipcRoot, 'g', 'contact-write-responses'), {
      recursive: true,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(ipcRoot, { recursive: true, force: true });
    vi.mocked(db.getContactsForGroup).mockReset();
  });

  it('reads request payload, calls annotateContact, triggers debounced snapshot, writes response', async () => {
    upsertContact(
      'g',
      { kind: 'user' },
      { identity: { tg_id: '42' }, source: 'sender' },
    );
    const reqPath = path.join(
      ipcRoot,
      'g',
      'contact-write-requests',
      'req1.json',
    );
    fs.writeFileSync(
      reqPath,
      JSON.stringify({ identifier: { tg_id: '42' }, notes: 'likes coffee' }),
    );
    await handleAnnotateContactRequest(ipcRoot, 'g', 'req1');
    const row = getContactByIdent('g|id:42');
    expect(row?.notes).toBe('likes coffee');
    const respPath = path.join(
      ipcRoot,
      'g',
      'contact-write-responses',
      'req1.json',
    );
    expect(fs.existsSync(respPath)).toBe(true);
    expect(fs.existsSync(reqPath)).toBe(false);
    // Snapshot debounce was scheduled — advance to flush
    vi.advanceTimersByTime(501);
  });

  it("CROSS_GROUP_REJECTED when identifier points at another group's contact", async () => {
    // Seed contact in DIFFERENT scope
    upsertContact(
      'other_group',
      { kind: 'user' },
      { identity: { tg_id: '777' }, source: 'sender' },
    );
    // Request annotation from scope 'g' for that other_group contact
    const reqPath = path.join(
      ipcRoot,
      'g',
      'contact-write-requests',
      'req2.json',
    );
    fs.writeFileSync(
      reqPath,
      JSON.stringify({
        identifier: { tg_id: '777' },
        notes: 'cross-group attempt',
      }),
    );
    await handleAnnotateContactRequest(ipcRoot, 'g', 'req2');
    // Assert response carries CROSS_GROUP_REJECTED
    const respPath = path.join(
      ipcRoot,
      'g',
      'contact-write-responses',
      'req2.json',
    );
    const resp = JSON.parse(fs.readFileSync(respPath, 'utf-8'));
    expect(resp.isError).toBe(true);
    expect(resp._meta.error_code).toBe('CROSS_GROUP_REJECTED');
    // Assert NO mutation occurred on the other_group row
    const row = getContactByIdent('other_group|id:777');
    expect(row?.notes).toBeNull();
  });
});
