import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { _initTestDatabase, storeMessage } from './db.js';
import {
  handleViewMediaRequest,
  ViewMediaPayload,
  _internal,
} from './ipc-media-handler.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock of the grammy `Bot` surface that the handler touches
 * (`bot.api.getFile`, and the `token` field used to construct download URLs).
 *
 * Pass an override fn to simulate getFile success/failure.
 */
function mockBot(
  getFile: (fileId: string) => Promise<unknown> | unknown = async () => ({
    file_id: 'X',
    file_path: 'photos/file_0.jpg',
    file_size: 100,
  }),
): {
  api: { getFile: ReturnType<typeof vi.fn> };
  token: string;
} {
  return {
    api: { getFile: vi.fn((id: string) => Promise.resolve(getFile(id))) },
    token: 'TEST_BOT_TOKEN',
  };
}

function makePayload(p: Partial<ViewMediaPayload> = {}): ViewMediaPayload {
  return {
    reqId: 'req-1',
    file_id: 'X',
    tg_message_id: '1',
    chatJid: 'tg:1',
    groupFolder: 'tg-group',
    ...p,
  };
}

// Track all fetch installs so afterEach can restore.
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// CROSS_GROUP_REJECTED two-query algorithm
// ---------------------------------------------------------------------------

describe('view_media authorization (CROSS_GROUP_REJECTED)', () => {
  beforeEach(() => _initTestDatabase());

  it('ALLOW when message id exists in requesting group jids', async () => {
    storeMessage({
      id: '1',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: 'x',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
      meta: '<m id="1"><media file_id="X" mime="image/jpeg"/></m>',
    });
    const result = _internal.checkAuthorization('1', ['tg:1']);
    expect(result).toBe('allow');
  });

  it('REJECT when message id exists ONLY in another group', async () => {
    storeMessage({
      id: '1',
      chat_jid: 'tg:OTHER',
      sender: 'u',
      sender_name: 'U',
      content: 'x',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
      meta: '<m id="1"><media file_id="X"/></m>',
    });
    const result = _internal.checkAuthorization('1', ['tg:REQUESTING']);
    expect(result).toBe('reject');
  });

  it('ALLOW when message id does not exist anywhere (external_reply pass-through)', async () => {
    // No row inserted at all.
    const result = _internal.checkAuthorization('1', ['tg:REQUESTING']);
    expect(result).toBe('allow');
  });

  it('full handler returns CROSS_GROUP_REJECTED when row owned by another group', async () => {
    storeMessage({
      id: '1',
      chat_jid: 'tg:OTHER',
      sender: 'u',
      sender_name: 'U',
      content: 'x',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
      meta: '<m id="1"><media file_id="X"/></m>',
    });
    const bot = mockBot();
    const result = await handleViewMediaRequest(
      makePayload({ file_id: 'X', tg_message_id: '1' }),
      ['tg:REQUESTING'],
      bot as any,
    );
    expect(result.isError).toBe(true);
    expect(result._meta.error_code).toBe('CROSS_GROUP_REJECTED');
    expect(result.content[0].text).toMatch(/^CROSS_GROUP_REJECTED:/);
    // Critical: getFile must NOT be called once authorization fails.
    expect(bot.api.getFile).not.toHaveBeenCalled();
  });

  it('restricted-user scenario: restricted container cannot view media from main user message', async () => {
    // Main user receives an attachment in their chat.
    storeMessage({
      id: 'main-attach',
      chat_jid: 'tg:MAIN',
      sender: 'main-uid',
      sender_name: 'Main',
      content: '',
      timestamp: '2026-05-25T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
      meta: '<m id="main-attach"><media file_id="MAIN_FILE" mime="image/jpeg" size="1234"/></m>',
    });
    // Restricted user's container asks for that file_id by guessing the
    // tg_message_id (the only metadata they could plausibly forge).
    const bot = mockBot();
    const result = await handleViewMediaRequest(
      makePayload({ file_id: 'MAIN_FILE', tg_message_id: 'main-attach' }),
      ['tg:RESTRICTED'], // restricted user's jid set ONLY
      bot as any,
    );
    expect(result.isError).toBe(true);
    expect(result._meta.error_code).toBe('CROSS_GROUP_REJECTED');
    // Hardened: getFile must NEVER be reached — that would have hit Telegram
    // for main user's content with the bot token even on the reject path.
    expect(bot.api.getFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// FILE_TOO_LARGE pre-check (no getFile)
// ---------------------------------------------------------------------------

describe('view_media FILE_TOO_LARGE pre-check', () => {
  beforeEach(() => _initTestDatabase());

  it('returns FILE_TOO_LARGE when meta.size > 20MB without calling getFile', async () => {
    storeMessage({
      id: '1',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: '',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
      meta: '<m id="1"><media file_id="X" size="22000000"/></m>',
    });
    const bot = mockBot();
    const result = await handleViewMediaRequest(
      makePayload({ file_id: 'X', tg_message_id: '1' }),
      ['tg:1'],
      bot as any,
    );
    expect(result.isError).toBe(true);
    expect(result._meta.error_code).toBe('FILE_TOO_LARGE');
    expect(result.content[0].text).toMatch(/^FILE_TOO_LARGE:/);
    expect(bot.api.getFile).not.toHaveBeenCalled();
  });

  it('does NOT pre-check when meta has no size attribute', async () => {
    storeMessage({
      id: '1',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: '',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
      meta: '<m id="1"><media file_id="X" mime="image/jpeg"/></m>',
    });
    // Mock fetch to return a small (decodable) jpeg.
    const { default: sharp } = await import('sharp');
    const jpegBytes = await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 3,
        background: { r: 1, g: 2, b: 3 },
      },
    })
      .jpeg()
      .toBuffer();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        jpegBytes.buffer.slice(
          jpegBytes.byteOffset,
          jpegBytes.byteOffset + jpegBytes.byteLength,
        ),
    }) as any;
    const bot = mockBot();
    const result = await handleViewMediaRequest(
      makePayload({ file_id: 'X', tg_message_id: '1' }),
      ['tg:1'],
      bot as any,
    );
    expect(bot.api.getFile).toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// PDF — NO_TEXT_LAYER / EXTRACTOR_OUTPUT_INVALID classification
// ---------------------------------------------------------------------------

describe('view_media PDF classification (no shell-out)', () => {
  it('NO_TEXT_LAYER: exit 0, empty stdout, empty stderr', () => {
    const resp = _internal.classifyPdftotext({
      status: 0,
      stdout: '',
      stderr: '',
      binaryFound: true,
    });
    expect(resp).not.toBeNull();
    expect(resp!._meta.error_code).toBe('NO_TEXT_LAYER');
    expect(resp!.content[0].text).toMatch(/^NO_TEXT_LAYER:/);
  });

  it('EXTRACTOR_OUTPUT_INVALID: empty stdout + Syntax Error stderr', () => {
    const resp = _internal.classifyPdftotext({
      status: 1,
      stdout: '',
      stderr: "Syntax Error: Couldn't find trailer dictionary\n",
      binaryFound: true,
    });
    expect(resp!._meta.error_code).toBe('EXTRACTOR_OUTPUT_INVALID');
  });

  it('EXTRACTOR_OUTPUT_INVALID: exit nonzero + empty stdout + non-corruption stderr', () => {
    const resp = _internal.classifyPdftotext({
      status: 99,
      stdout: '',
      stderr: 'some unrelated diagnostic\n',
      binaryFound: true,
    });
    expect(resp!._meta.error_code).toBe('EXTRACTOR_OUTPUT_INVALID');
  });

  it('happy path: stdout non-empty → null (caller emits text content)', () => {
    const resp = _internal.classifyPdftotext({
      status: 0,
      stdout: 'Hello world',
      stderr: '',
      binaryFound: true,
    });
    expect(resp).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PAGES_OUT_OF_RANGE parsing
// ---------------------------------------------------------------------------

describe('view_media parsePagesRange', () => {
  it('valid 1-1 (default)', () => {
    const r = _internal.parsePagesRange(undefined);
    expect('start' in r && r.start === 1 && r.end === 1).toBe(true);
  });

  it('valid 2-5', () => {
    const r = _internal.parsePagesRange('2-5');
    expect('start' in r && r.start === 2 && r.end === 5).toBe(true);
  });

  it('invalid format', () => {
    const r = _internal.parsePagesRange('garbage');
    expect('isError' in r && r.isError).toBe(true);
    expect((r as any)._meta.error_code).toBe('PAGES_OUT_OF_RANGE');
  });

  it('end < start', () => {
    const r = _internal.parsePagesRange('5-2');
    expect((r as any)._meta.error_code).toBe('PAGES_OUT_OF_RANGE');
  });

  it('exceeds 10-page cap', () => {
    const r = _internal.parsePagesRange('1-11');
    expect((r as any)._meta.error_code).toBe('PAGES_OUT_OF_RANGE');
  });

  it('boundary: 1-10 OK', () => {
    const r = _internal.parsePagesRange('1-10');
    expect('start' in r && r.start === 1 && r.end === 10).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Happy path: image JPEG
// ---------------------------------------------------------------------------

describe('view_media happy path', () => {
  beforeEach(() => _initTestDatabase());

  it('returns image content for JPEG download', async () => {
    // Build a small real JPEG via sharp so the routing image branch can
    // round-trip it (re-encode + base64).
    const { default: sharp } = await import('sharp');
    const jpegBytes = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .jpeg()
      .toBuffer();

    storeMessage({
      id: '1',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: '',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
      meta: '<m id="1"><media type="photo" file_id="X" mime="image/jpeg"/></m>',
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        jpegBytes.buffer.slice(
          jpegBytes.byteOffset,
          jpegBytes.byteOffset + jpegBytes.byteLength,
        ),
    }) as any;

    const bot = mockBot();
    const result = await handleViewMediaRequest(
      makePayload({ file_id: 'X', tg_message_id: '1' }),
      ['tg:1'],
      bot as any,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('image');
    expect(result.content[0].mimeType).toBe('image/jpeg');
    expect(result.content[0].data).toBeTruthy();
    // base64 string of nonzero length
    expect(result.content[0].data!.length).toBeGreaterThan(0);
  });

  it('returns text content for plain text/* (UTF-8 decode)', async () => {
    storeMessage({
      id: '1',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: '',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
      meta: '<m id="1"><media file_id="X" mime="text/plain"/></m>',
    });
    const txt = Buffer.from('Hello, мир!', 'utf-8');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        txt.buffer.slice(txt.byteOffset, txt.byteOffset + txt.byteLength),
    }) as any;

    const bot = mockBot();
    const result = await handleViewMediaRequest(
      makePayload({ file_id: 'X', tg_message_id: '1' }),
      ['tg:1'],
      bot as any,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toBe('Hello, мир!');
  });
});

// ---------------------------------------------------------------------------
// UPSTREAM_ERROR — 4xx non-retryable
// ---------------------------------------------------------------------------

describe('view_media UPSTREAM_ERROR', () => {
  beforeEach(() => _initTestDatabase());

  it('returns UPSTREAM_ERROR on non-retryable 400 from getFile', async () => {
    storeMessage({
      id: '1',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: '',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
      meta: '<m id="1"><media file_id="X" mime="image/jpeg"/></m>',
    });
    // Use grammy's actual GrammyError class to ensure description-matching paths.
    const { GrammyError } = await import('grammy');
    const err = new GrammyError(
      'Call to "getFile" failed!',
      {
        ok: false,
        error_code: 400,
        description: 'Bad Request: file not found',
      },
      'getFile',
      { file_id: 'X' },
    );
    const bot = mockBot(() => {
      throw err;
    });
    const result = await handleViewMediaRequest(
      makePayload({ file_id: 'X', tg_message_id: '1' }),
      ['tg:1'],
      bot as any,
    );
    expect(result.isError).toBe(true);
    expect(result._meta.error_code).toBe('UPSTREAM_ERROR');
    // No retry for 4xx non-rate-limit → called only once.
    expect(bot.api.getFile).toHaveBeenCalledTimes(1);
  });

  it('returns FILE_EXPIRED when getFile description contains "file is too old"', async () => {
    storeMessage({
      id: '1',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: '',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
      meta: '<m id="1"><media file_id="X" mime="image/jpeg"/></m>',
    });
    const { GrammyError } = await import('grammy');
    const err = new GrammyError(
      'Call to "getFile" failed!',
      {
        ok: false,
        error_code: 400,
        description: 'Bad Request: file is too old',
      },
      'getFile',
      { file_id: 'X' },
    );
    const bot = mockBot(() => {
      throw err;
    });
    const result = await handleViewMediaRequest(
      makePayload({ file_id: 'X', tg_message_id: '1' }),
      ['tg:1'],
      bot as any,
    );
    expect(result.isError).toBe(true);
    expect(result._meta.error_code).toBe('FILE_EXPIRED');
    // FILE_EXPIRED is non-retryable.
    expect(bot.api.getFile).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// UNSUPPORTED_TYPE — HEIC / unclassified mime
// ---------------------------------------------------------------------------

describe('view_media UNSUPPORTED_TYPE', () => {
  beforeEach(() => _initTestDatabase());

  it('returns UNSUPPORTED_TYPE for HEIC mime', async () => {
    storeMessage({
      id: '1',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: '',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
      meta: '<m id="1"><media file_id="X" mime="image/heic"/></m>',
    });
    // Any bytes — we never decode because the mime is rejected up front.
    const bogus = Buffer.from([0, 1, 2, 3]);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        bogus.buffer.slice(
          bogus.byteOffset,
          bogus.byteOffset + bogus.byteLength,
        ),
    }) as any;

    const bot = mockBot();
    const result = await handleViewMediaRequest(
      makePayload({ file_id: 'X', tg_message_id: '1' }),
      ['tg:1'],
      bot as any,
    );
    expect(result.isError).toBe(true);
    expect(result._meta.error_code).toBe('UNSUPPORTED_TYPE');
  });
});

// ---------------------------------------------------------------------------
// _internal.lookupCachedFileSize regex
// ---------------------------------------------------------------------------

describe('view_media meta-parsing', () => {
  beforeEach(() => _initTestDatabase());

  it('lookupCachedFileSize handles size BEFORE file_id', () => {
    storeMessage({
      id: '1',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: '',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
      meta: '<m id="1"><media size="500000" file_id="X" mime="image/jpeg"/></m>',
    });
    expect(_internal.lookupCachedFileSize('1', 'X')).toBe(500000);
  });

  it('lookupCachedFileSize handles size AFTER file_id', () => {
    storeMessage({
      id: '1',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: '',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
      meta: '<m id="1"><media file_id="X" mime="image/jpeg" size="500000"/></m>',
    });
    expect(_internal.lookupCachedFileSize('1', 'X')).toBe(500000);
  });

  it('lookupCachedFileSize returns null when size missing', () => {
    storeMessage({
      id: '1',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: '',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
      meta: '<m id="1"><media file_id="X" mime="image/jpeg"/></m>',
    });
    expect(_internal.lookupCachedFileSize('1', 'X')).toBeNull();
  });

  it('lookupCachedFileSize returns null when row absent', () => {
    expect(_internal.lookupCachedFileSize('nope', 'X')).toBeNull();
  });
});
