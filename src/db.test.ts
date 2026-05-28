import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  annotateContact,
  buildQueryParam,
  createTask,
  db,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getContactsForGroup,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  lookupMessages,
  promoteContactIdent,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
  storeOutboundMessage,
  updateTask,
  upsertContact,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('persists thread_id round-trip through storeMessage → getNewMessages → getMessagesSince', () => {
    storeChatMetadata('tg:99', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'topic-1',
      chat_jid: 'tg:99',
      sender: '5',
      sender_name: 'Alice',
      content: 'topic message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: false,
      thread_id: '42',
    });

    const since = getMessagesSince('tg:99', '2024-01-01T00:00:00.000Z', 'Andy');
    expect(since[0].thread_id).toBe('42');

    const { messages } = getNewMessages(
      ['tg:99'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages[0].thread_id).toBe('42');
  });

  it('stores thread_id=null when not provided (non-topic chats)', () => {
    storeChatMetadata('tg:99', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'no-topic-1',
      chat_jid: 'tg:99',
      sender: '5',
      sender_name: 'Alice',
      content: 'plain DM',
      timestamp: '2024-01-01T00:00:06.000Z',
      is_from_me: false,
    });

    const since = getMessagesSince('tg:99', '2024-01-01T00:00:00.000Z', 'Andy');
    expect(since[0].thread_id).toBeNull();
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });

  it('filters pre-migration bot messages via content-prefix backstop', () => {
    storeMessage({
      id: 'a',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: 'hi',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
    });
    // Row written before is_bot_message column existed; is_bot_message=0 but content has bot prefix:
    storeMessage({
      id: 'b',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: 'Andy: old reply',
      timestamp: '2026-05-20T10:00:01Z',
      is_from_me: false,
      is_bot_message: false,
    });
    const { messages: rows } = getNewMessages(
      ['tg:1'],
      '2026-05-20T09:00:00Z',
      'Andy',
      50,
    );
    expect(rows.map((r) => r.id)).toEqual(['a']); // 'b' filtered by NOT LIKE 'Andy:%'
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and drains oldest unseen first (FIFO)', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    // FIFO drain: oldest unseen first, so subsequent polls pick up the
    // remainder. Previously this returned newest-N and advanced the cursor
    // past the truncated tail, silently dropping the oldest entries.
    expect(messages[0].content).toBe('message 1');
    expect(messages[2].content).toBe('message 3');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    // newTimestamp is the newest of the returned batch (the (limit)-th
    // oldest unseen), so the next poll continues from there.
    expect(newTimestamp).toBe('2024-01-01T00:00:03.000Z');
  });

  it('getMessagesSince caps to limit and drains oldest unseen first (FIFO)', () => {
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 1');
    expect(messages[2].content).toBe('message 3');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      50,
    );
    expect(messages).toHaveLength(10);
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

describe('registered group enabledMcp', () => {
  it('round-trips a populated CSV whitelist', () => {
    setRegisteredGroup('tg:restricted', {
      name: 'Restricted User',
      folder: 'telegram_restricted',
      trigger: '@Andy',
      added_at: '2026-05-25T00:00:00.000Z',
      enabledMcp: ['nanoclaw'],
    });
    const group = getAllRegisteredGroups()['tg:restricted'];
    expect(group.enabledMcp).toEqual(['nanoclaw']);
  });

  it('round-trips an empty array (lockdown — only mcp__nanoclaw__*)', () => {
    setRegisteredGroup('tg:1', {
      name: 'Locked',
      folder: 'telegram_locked',
      trigger: '@Andy',
      added_at: '2026-05-25T00:00:00.000Z',
      enabledMcp: [],
    });
    const group = getAllRegisteredGroups()['tg:1'];
    expect(group.enabledMcp).toEqual([]);
  });

  it('legacy rows (undefined enabledMcp) keep returning undefined', () => {
    setRegisteredGroup('tg:legacy', {
      name: 'Legacy',
      folder: 'telegram_legacy',
      trigger: '@Andy',
      added_at: '2026-05-25T00:00:00.000Z',
    });
    const group = getAllRegisteredGroups()['tg:legacy'];
    expect(group.enabledMcp).toBeUndefined();
  });

  it('multi-entry whitelist preserves order and trims whitespace defensively', () => {
    // Bypass setRegisteredGroup so we can verify parseEnabledMcp tolerates
    // stray whitespace if a manual SQL write ever lands one in the column.
    setRegisteredGroup('tg:multi', {
      name: 'Multi',
      folder: 'telegram_multi',
      trigger: '@Andy',
      added_at: '2026-05-25T00:00:00.000Z',
    });
    db.prepare(
      `UPDATE registered_groups SET enabled_mcp = ? WHERE jid = ?`,
    ).run('nanoclaw, gmail ,notion', 'tg:multi');
    const group = getAllRegisteredGroups()['tg:multi'];
    expect(group.enabledMcp).toEqual(['nanoclaw', 'gmail', 'notion']);
  });
});

describe('getContactsForGroup scope isolation', () => {
  // Tests use generic tg_id placeholders ('1' for main, '2' for restricted)
  // to keep real per-install identifiers out of the test corpus. Same
  // behavior; smaller footprint.

  it('returns only contacts in the requested scope when includeUnion=false', () => {
    upsertContact(
      'telegram_main',
      { kind: 'user', first_name: 'MainContact' },
      { identity: { tg_id: '1' }, source: 'sender' },
    );
    upsertContact(
      'telegram_other',
      { kind: 'user', first_name: 'OtherContact' },
      { identity: { tg_id: '2' }, source: 'sender' },
    );
    const otherRows = getContactsForGroup({
      scope: 'telegram_other',
      includeUnion: false,
    });
    expect(otherRows).toHaveLength(1);
    expect(otherRows[0].first_name).toBe('OtherContact');
    expect(otherRows[0].tg_id).toBe('2');
    // Defense in depth: the main contact must NOT leak through.
    expect(otherRows.some((r) => r.tg_id === '1')).toBe(false);
  });

  it('non-main scope ignores includeUnion=true (only includes own scope)', () => {
    // The includeUnion union view is ONLY available to scope='main'. A
    // non-main scope must not be able to widen its visibility by passing
    // includeUnion=true.
    upsertContact(
      'telegram_main',
      { kind: 'user', first_name: 'MainOnly' },
      { identity: { tg_id: '1' }, source: 'sender' },
    );
    upsertContact(
      'telegram_other',
      { kind: 'user', first_name: 'OtherOnly' },
      { identity: { tg_id: '2' }, source: 'sender' },
    );
    const rows = getContactsForGroup({
      scope: 'telegram_other',
      includeUnion: true,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].tg_id).toBe('2');
  });
});

// --- contacts table ---

describe('contacts table', () => {
  beforeEach(() => _initTestDatabase());

  it('inserts and reads a contacts row with all columns', () => {
    db.prepare(
      `
      INSERT INTO contacts (
        ident, scope, tg_id, username, kind, is_bot,
        first_name, last_name, title, phone, link, bio,
        first_seen, last_seen, seen_count, source, enriched, notes, tags
      ) VALUES (
        'g_main|id:42', 'g_main', '42', 'vasya', 'user', 0,
        'Вася', 'Иванов', NULL, NULL, NULL, NULL,
        '2026-05-20T10:00:00Z', '2026-05-20T10:00:00Z', 1, 'sender', 0, NULL, NULL
      )
    `,
    ).run();
    const row = db
      .prepare(`SELECT * FROM contacts WHERE ident = ?`)
      .get('g_main|id:42') as {
      ident: string;
      tg_id: string;
      username: string;
    };
    expect(row.ident).toBe('g_main|id:42');
    expect(row.tg_id).toBe('42');
    expect(row.username).toBe('vasya');
  });
});

describe('database init idempotency + UDF', () => {
  it('_initTestDatabase is idempotent across consecutive calls', () => {
    _initTestDatabase();
    _initTestDatabase();
    // If addMetaColumnIfMissing fails on the second call, this throws "duplicate column: meta"
    const cols = db.prepare('PRAGMA table_info(messages)').all() as Array<{
      name: string;
    }>;
    expect(cols.some((c) => c.name === 'meta')).toBe(true);
  });

  it('lower_unicode UDF lowercases Cyrillic', () => {
    _initTestDatabase();
    const result = db.prepare(`SELECT lower_unicode('Привет') AS r`).get() as {
      r: string;
    };
    expect(result.r).toBe('привет');
  });
});

describe('promoteContactIdent', () => {
  // Note: top-level beforeEach already calls _initTestDatabase, no inner beforeEach needed.

  it('tg_id non-NULL after promotion when un-row had NULL tg_id (round-7 invariant)', () => {
    db.prepare(
      `INSERT INTO contacts (ident, scope, tg_id, username, kind, is_bot, first_seen, last_seen, seen_count, source, enriched)
                VALUES ('g|un:vasya', 'g', NULL, 'vasya', 'user', 0, '2026-05-20T10:00:00Z', '2026-05-20T10:00:00Z', 1, 'mention', 0)`,
    ).run();
    promoteContactIdent('g', 'vasya', '42');
    const row = db
      .prepare(`SELECT tg_id FROM contacts WHERE ident = ?`)
      .get('g|id:42') as { tg_id: string };
    expect(row.tg_id).toBe('42');
    expect(
      db.prepare(`SELECT 1 FROM contacts WHERE ident = ?`).get('g|un:vasya'),
    ).toBeUndefined();
  });

  it('preserves id-row notes when both rows have non-null notes (notes-loss known limitation)', () => {
    db.prepare(
      `INSERT INTO contacts (ident, scope, tg_id, username, kind, is_bot, first_seen, last_seen, seen_count, source, enriched, notes)
                VALUES ('g|id:42', 'g', '42', NULL, 'user', 0, '2026-05-20T10:00:00Z', '2026-05-20T10:00:00Z', 1, 'sender', 0, 'id-notes')`,
    ).run();
    db.prepare(
      `INSERT INTO contacts (ident, scope, tg_id, username, kind, is_bot, first_seen, last_seen, seen_count, source, enriched, notes)
                VALUES ('g|un:vasya', 'g', NULL, 'vasya', 'user', 0, '2026-05-20T10:00:00Z', '2026-05-20T10:00:00Z', 1, 'mention', 0, 'un-notes')`,
    ).run();
    promoteContactIdent('g', 'vasya', '42');
    const row = db
      .prepare(`SELECT notes FROM contacts WHERE ident = ?`)
      .get('g|id:42') as { notes: string };
    expect(row.notes).toBe('id-notes');
  });

  it('does NOT crash when un-row absent (no-op early return)', () => {
    expect(() => promoteContactIdent('g', 'nobody', '999')).not.toThrow();
  });

  it('unions tags from both id-row and un-row', () => {
    db.prepare(
      `INSERT INTO contacts (ident, scope, tg_id, username, kind, is_bot, first_seen, last_seen, seen_count, source, enriched, tags)
              VALUES ('g|id:42', 'g', '42', NULL, 'user', 0, '2026-05-20T10:00:00Z', '2026-05-20T10:00:00Z', 1, 'sender', 0, 'a,b')`,
    ).run();
    db.prepare(
      `INSERT INTO contacts (ident, scope, tg_id, username, kind, is_bot, first_seen, last_seen, seen_count, source, enriched, tags)
              VALUES ('g|un:vasya', 'g', NULL, 'vasya', 'user', 0, '2026-05-20T10:00:00Z', '2026-05-20T10:00:00Z', 1, 'mention', 0, 'b,c')`,
    ).run();
    promoteContactIdent('g', 'vasya', '42');
    const row = db
      .prepare(`SELECT tags FROM contacts WHERE ident = ?`)
      .get('g|id:42') as { tags: string };
    expect(row.tags.split(',').sort()).toEqual(['a', 'b', 'c']);
  });

  it('adopts un-row notes when id-row notes is NULL', () => {
    db.prepare(
      `INSERT INTO contacts (ident, scope, tg_id, username, kind, is_bot, first_seen, last_seen, seen_count, source, enriched, notes)
              VALUES ('g|id:42', 'g', '42', NULL, 'user', 0, '2026-05-20T10:00:00Z', '2026-05-20T10:00:00Z', 1, 'sender', 0, NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO contacts (ident, scope, tg_id, username, kind, is_bot, first_seen, last_seen, seen_count, source, enriched, notes)
              VALUES ('g|un:vasya', 'g', NULL, 'vasya', 'user', 0, '2026-05-20T10:00:00Z', '2026-05-20T10:00:00Z', 1, 'mention', 0, 'from-un')`,
    ).run();
    promoteContactIdent('g', 'vasya', '42');
    const row = db
      .prepare(`SELECT notes FROM contacts WHERE ident = ?`)
      .get('g|id:42') as { notes: string };
    expect(row.notes).toBe('from-un');
  });
});

describe('upsertContact', () => {
  it('INSERTs on first call', () => {
    upsertContact(
      'g',
      { kind: 'user', first_name: 'Вася' },
      { identity: { tg_id: '42', username: 'vasya' }, source: 'sender' },
    );
    const row = db
      .prepare(`SELECT * FROM contacts WHERE ident = ?`)
      .get('g|id:42') as { first_name: string; username: string };
    expect(row.first_name).toBe('Вася');
    expect(row.username).toBe('vasya');
  });

  it('UPDATEs with COALESCE rules on second call (does not overwrite non-null with null)', () => {
    upsertContact(
      'g',
      { kind: 'user', first_name: 'Вася', last_name: 'Иванов' },
      { identity: { tg_id: '42' }, source: 'sender' },
    );
    upsertContact(
      'g',
      { kind: 'user' },
      { identity: { tg_id: '42' }, source: 'sender' },
    );
    const row = db
      .prepare(
        `SELECT first_name, last_name, seen_count FROM contacts WHERE ident = ?`,
      )
      .get('g|id:42') as {
      first_name: string;
      last_name: string;
      seen_count: number;
    };
    expect(row.first_name).toBe('Вася');
    expect(row.last_name).toBe('Иванов');
    expect(row.seen_count).toBe(2);
  });

  it('main scope sees UNION via getContactsForGroup({scope: "main", includeUnion: true})', () => {
    upsertContact(
      'g_dev',
      { kind: 'user', first_name: 'Петя' },
      { identity: { tg_id: '99' }, source: 'sender' },
    );
    const rows = getContactsForGroup({ scope: 'main', includeUnion: true });
    expect(rows.find((r) => r.tg_id === '99')).toBeDefined();
  });

  it('annotateContact REPLACES notes and APPENDS-UNIQUE tags', () => {
    upsertContact(
      'g',
      { kind: 'user' },
      { identity: { tg_id: '42' }, source: 'sender' },
    );
    annotateContact({ tg_id: '42' }, { notes: 'first', tags: 'a,b' });
    annotateContact({ tg_id: '42' }, { notes: 'second', tags: 'b,c' });
    const row = db
      .prepare(`SELECT notes, tags FROM contacts WHERE ident = ?`)
      .get('g|id:42') as { notes: string; tags: string };
    expect(row.notes).toBe('second');
    expect(row.tags.split(',').sort()).toEqual(['a', 'b', 'c']);
  });

  it('is_bot survives subsequent patch that omits is_bot (sticky non-null)', () => {
    upsertContact(
      'g',
      { kind: 'user', is_bot: 1 },
      { identity: { tg_id: '42' }, source: 'sender' },
    );
    upsertContact(
      'g',
      { first_name: 'updated' },
      { identity: { tg_id: '42' }, source: 'sender' },
    );
    const row = db
      .prepare(`SELECT is_bot, first_name FROM contacts WHERE ident = ?`)
      .get('g|id:42') as { is_bot: number; first_name: string };
    expect(row.is_bot).toBe(1);
    expect(row.first_name).toBe('updated');
  });

  it('kind survives subsequent patch that omits kind (sticky non-null)', () => {
    upsertContact(
      'g',
      { kind: 'channel', title: 'Durov' },
      { identity: { tg_id: '99' }, source: 'sender' },
    );
    upsertContact(
      'g',
      { title: 'Durov Updated' },
      { identity: { tg_id: '99' }, source: 'sender' },
    );
    const row = db
      .prepare(`SELECT kind, title FROM contacts WHERE ident = ?`)
      .get('g|id:99') as { kind: string; title: string };
    expect(row.kind).toBe('channel');
    expect(row.title).toBe('Durov Updated');
  });

  it('identity: username-only branch builds ident with |un: prefix and lowercased username', () => {
    upsertContact(
      'g',
      { kind: 'user', first_name: 'Вася' },
      { identity: { username: 'VASYA' }, source: 'mention' },
    );
    // Lowered username in both ident and stored username column:
    const row = db
      .prepare(`SELECT ident, username FROM contacts WHERE ident = ?`)
      .get('g|un:vasya') as { ident: string; username: string };
    expect(row.ident).toBe('g|un:vasya');
    expect(row.username).toBe('vasya');
  });

  it('identity: name-only branch builds ident with |name: prefix and lowercased name', () => {
    upsertContact(
      'g',
      { kind: 'user', first_name: 'John' },
      { identity: { name: 'John Smith' }, source: 'vcard' },
    );
    const row = db
      .prepare(`SELECT ident FROM contacts WHERE ident = ?`)
      .get('g|name:john smith') as { ident: string } | undefined;
    expect(row?.ident).toBe('g|name:john smith');
  });

  it('throws when identity is completely empty', () => {
    expect(() =>
      upsertContact('g', { kind: 'user' }, { identity: {}, source: 'sender' }),
    ).toThrow(/upsertContact:.*identity/i);
  });

  it('tg_id takes precedence over username when both present', () => {
    upsertContact(
      'g',
      { kind: 'user' },
      { identity: { tg_id: '42', username: 'vasya' }, source: 'sender' },
    );
    // Should land at g|id:42 (NOT g|un:vasya):
    expect(
      db.prepare(`SELECT 1 FROM contacts WHERE ident = ?`).get('g|id:42'),
    ).toBeDefined();
    expect(
      db.prepare(`SELECT 1 FROM contacts WHERE ident = ?`).get('g|un:vasya'),
    ).toBeUndefined();
  });
});

describe('lookupMessages', () => {
  it('Cyrillic case-insensitive search via lower_unicode', () => {
    storeMessage({
      id: '1',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: 'Петя пришёл',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
    });
    const rows = lookupMessages({
      groupJids: ['tg:1'],
      query: 'петя',
      includeBot: false,
      limit: 50,
    });
    expect(rows.length).toBe(1);
    expect(rows[0].content).toBe('Петя пришёл');
  });

  it('LIKE wildcard % is escaped (literal match)', () => {
    storeMessage({
      id: '1',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: 'тратил 50% налога',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessage({
      id: '2',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: 'тратил 5000 рублей',
      timestamp: '2026-05-20T10:01:00Z',
      is_from_me: false,
      is_bot_message: false,
    });
    const rows = lookupMessages({
      groupJids: ['tg:1'],
      query: '50%',
      includeBot: false,
      limit: 50,
    });
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('1');
  });

  it('include_bot=true UNIONs bot rows with user rows', () => {
    storeMessage({
      id: 'u1',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: 'hi',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessage({
      id: 'b1',
      chat_jid: 'tg:1',
      sender: 'bot',
      sender_name: 'Andy',
      content: 'hello',
      timestamp: '2026-05-20T10:01:00Z',
      is_from_me: true,
      is_bot_message: true,
    });
    const without = lookupMessages({
      groupJids: ['tg:1'],
      includeBot: false,
      limit: 50,
    });
    const withBot = lookupMessages({
      groupJids: ['tg:1'],
      includeBot: true,
      limit: 50,
    });
    expect(without.length).toBe(1);
    expect(withBot.length).toBe(2);
  });

  it('empty filters return rows clamped to limit (max 200)', () => {
    for (let i = 0; i < 250; i++) {
      storeMessage({
        id: `m${i}`,
        chat_jid: 'tg:1',
        sender: 'u',
        sender_name: 'U',
        content: `msg${i}`,
        timestamp: `2026-05-20T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
        is_from_me: false,
        is_bot_message: false,
      });
    }
    const rows = lookupMessages({
      groupJids: ['tg:1'],
      includeBot: false,
      limit: 500,
    });
    expect(rows.length).toBe(200); // server clamps to 200
  });

  it('descending order by timestamp (empty filters)', () => {
    for (let i = 0; i < 5; i++) {
      storeMessage({
        id: `m${i}`,
        chat_jid: 'tg:1',
        sender: 'u',
        sender_name: 'U',
        content: `msg${i}`,
        timestamp: `2026-05-20T10:00:0${i}Z`,
        is_from_me: false,
        is_bot_message: false,
      });
    }
    const rows = lookupMessages({
      groupJids: ['tg:1'],
      includeBot: false,
      limit: 50,
    });
    expect(rows[0].id).toBe('m4'); // newest first
    expect(rows[4].id).toBe('m0'); // oldest last
  });

  it('multi-JID IN-clause merges rows from multiple groups + excludes non-listed', () => {
    storeMessage({
      id: 'a',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: 'from1',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessage({
      id: 'b',
      chat_jid: 'tg:2',
      sender: 'u',
      sender_name: 'U',
      content: 'from2',
      timestamp: '2026-05-20T10:00:01Z',
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessage({
      id: 'c',
      chat_jid: 'tg:3',
      sender: 'u',
      sender_name: 'U',
      content: 'from3',
      timestamp: '2026-05-20T10:00:02Z',
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessage({
      id: 'd',
      chat_jid: 'tg:OTHER',
      sender: 'u',
      sender_name: 'U',
      content: 'from4',
      timestamp: '2026-05-20T10:00:03Z',
      is_from_me: false,
      is_bot_message: false,
    });
    const rows = lookupMessages({
      groupJids: ['tg:1', 'tg:2', 'tg:3'],
      includeBot: false,
      limit: 50,
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
    expect(rows.find((r) => r.id === 'd')).toBeUndefined();
  });

  it('non-finite limit (NaN) defaults to 50 instead of crashing', () => {
    for (let i = 0; i < 100; i++) {
      storeMessage({
        id: `n${i}`,
        chat_jid: 'tg:1',
        sender: 'u',
        sender_name: 'U',
        content: `n${i}`,
        timestamp: `2026-05-20T10:${String(i).padStart(2, '0')}:00Z`,
        is_from_me: false,
        is_bot_message: false,
      });
    }
    const rows = lookupMessages({
      groupJids: ['tg:1'],
      includeBot: false,
      limit: NaN,
    });
    expect(rows.length).toBe(50);
  });

  it('non-boolean includeBot defaults to false (only user rows)', () => {
    storeMessage({
      id: 'u1',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: 'hi',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessage({
      id: 'b1',
      chat_jid: 'tg:1',
      sender: 'bot',
      sender_name: 'Andy',
      content: 'hello',
      timestamp: '2026-05-20T10:01:00Z',
      is_from_me: true,
      is_bot_message: true,
    });
    const rows = lookupMessages({
      groupJids: ['tg:1'],
      // @ts-expect-error — testing runtime defense against non-boolean truthy values
      includeBot: 'false',
      limit: 50,
    });
    expect(rows.length).toBe(1); // string 'false' is NOT === true → bot row excluded
    expect(rows[0].id).toBe('u1');
  });

  it('senderId filter selects only matching sender', () => {
    storeMessage({
      id: 'a',
      chat_jid: 'tg:1',
      sender: 'alice',
      sender_name: 'A',
      content: 'hi',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessage({
      id: 'b',
      chat_jid: 'tg:1',
      sender: 'bob',
      sender_name: 'B',
      content: 'hi',
      timestamp: '2026-05-20T10:00:01Z',
      is_from_me: false,
      is_bot_message: false,
    });
    const rows = lookupMessages({
      groupJids: ['tg:1'],
      senderId: 'alice',
      includeBot: false,
      limit: 50,
    });
    expect(rows.length).toBe(1);
    expect(rows[0].sender).toBe('alice');
  });

  it('since filter excludes rows with timestamp < since (inclusive boundary)', () => {
    storeMessage({
      id: 'a',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: 'old',
      timestamp: '2026-05-20T09:00:00Z',
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessage({
      id: 'b',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: 'boundary',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessage({
      id: 'c',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: 'new',
      timestamp: '2026-05-20T11:00:00Z',
      is_from_me: false,
      is_bot_message: false,
    });
    const rows = lookupMessages({
      groupJids: ['tg:1'],
      since: '2026-05-20T10:00:00Z',
      includeBot: false,
      limit: 50,
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['b', 'c']); // inclusive boundary
  });

  it('until filter excludes rows with timestamp > until (inclusive boundary)', () => {
    storeMessage({
      id: 'a',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: 'old',
      timestamp: '2026-05-20T09:00:00Z',
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessage({
      id: 'b',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: 'boundary',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessage({
      id: 'c',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: 'new',
      timestamp: '2026-05-20T11:00:00Z',
      is_from_me: false,
      is_bot_message: false,
    });
    const rows = lookupMessages({
      groupJids: ['tg:1'],
      until: '2026-05-20T10:00:00Z',
      includeBot: false,
      limit: 50,
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('tgMessageId filter returns only that specific message', () => {
    storeMessage({
      id: 'target',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: 'find me',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessage({
      id: 'other',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: 'skip me',
      timestamp: '2026-05-20T10:00:01Z',
      is_from_me: false,
      is_bot_message: false,
    });
    const rows = lookupMessages({
      groupJids: ['tg:1'],
      tgMessageId: 'target',
      includeBot: false,
      limit: 50,
    });
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('target');
  });

  it('empty-string filter values are normalized to null (no degraded match)', () => {
    storeMessage({
      id: 'a',
      chat_jid: 'tg:1',
      sender: 'alice',
      sender_name: 'A',
      content: 'hi',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
    });
    // Empty senderId should NOT filter to sender='' (which would match zero rows); should be treated as "no filter"
    const rows = lookupMessages({
      groupJids: ['tg:1'],
      senderId: '',
      includeBot: false,
      limit: 50,
    });
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('a');
  });
});

describe('buildQueryParam', () => {
  it('returns null for empty/undefined', () => {
    expect(buildQueryParam(undefined)).toBe(null);
    expect(buildQueryParam('')).toBe(null);
  });

  it('escapes %, _, \\ and wraps in %...%', () => {
    expect(buildQueryParam('abc')).toBe('%abc%');
    expect(buildQueryParam('50%')).toBe('%50\\%%');
    expect(buildQueryParam('foo_bar')).toBe('%foo\\_bar%');
    expect(buildQueryParam('back\\slash')).toBe('%back\\\\slash%');
  });
});

describe('messages.meta projection', () => {
  it('storeMessage with meta + getNewMessages preserves meta column', () => {
    storeMessage({
      id: '1',
      chat_jid: 'tg:1',
      sender: 'u1',
      sender_name: 'U',
      content: 'hi',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
      meta: '<m id="1"/>',
    });
    const { messages: rows } = getNewMessages(
      ['tg:1'],
      '2026-05-20T09:00:00Z',
      'Andy',
      50,
    );
    expect(rows[0].meta).toBe('<m id="1"/>');
  });

  it('photo-no-caption admitted via relaxed WHERE (content="" AND meta != NULL)', () => {
    storeMessage({
      id: '2',
      chat_jid: 'tg:1',
      sender: 'u1',
      sender_name: 'U',
      content: '',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
      meta: '<m id="2"><media file_id="X"/></m>',
    });
    const { messages: rows } = getNewMessages(
      ['tg:1'],
      '2026-05-20T09:00:00Z',
      'Andy',
      50,
    );
    expect(rows.find((r) => r.id === '2')).toBeDefined();
  });

  it('getMessagesSince also includes meta column', () => {
    storeMessage({
      id: '3',
      chat_jid: 'tg:1',
      sender: 'u',
      sender_name: 'U',
      content: 'x',
      timestamp: '2026-05-20T10:00:00Z',
      is_from_me: false,
      is_bot_message: false,
      meta: '<m id="3"/>',
    });
    const rows = getMessagesSince('tg:1', '2026-05-20T09:00:00Z', 'Andy', 50);
    expect(rows[0].meta).toBe('<m id="3"/>');
  });
});

describe('storeOutboundMessage', () => {
  it('synthetic-id path: undefined messageId + undefined senderId', () => {
    storeOutboundMessage('tg:1', 'hello');
    const row = db
      .prepare(`SELECT * FROM messages WHERE chat_jid = ?`)
      .get('tg:1') as {
      id: string;
      sender: string;
      meta: string | null;
      is_bot_message: number;
    };
    expect(row.id).toMatch(/^out-/);
    expect(row.sender).toBe('bot');
    expect(row.meta).toBe('<m kind="outbound-synthetic"/>');
    expect(row.is_bot_message).toBe(1);
  });

  it('channel-id path: real messageId + senderId', () => {
    storeOutboundMessage('tg:1', 'hello', 'TG_MID_123', '987654');
    const row = db
      .prepare(`SELECT * FROM messages WHERE chat_jid = ?`)
      .get('tg:1') as { id: string; sender: string; meta: string | null };
    expect(row.id).toBe('TG_MID_123');
    expect(row.sender).toBe('987654');
    expect(row.meta).toBeNull();
  });

  it("empty-string messageId '' treated as missing (truthy fallback)", () => {
    storeOutboundMessage('tg:1', 'hello', '');
    const row = db
      .prepare(`SELECT * FROM messages WHERE chat_jid = ?`)
      .get('tg:1') as { id: string; sender: string };
    expect(row.id).toMatch(/^out-/);
    expect(row.sender).toBe('bot');
  });

  it('auto-seeds chats row on first send to new jid via INSERT OR IGNORE', () => {
    storeOutboundMessage('tg:never_seen', 'hello');
    const chat = db
      .prepare(`SELECT * FROM chats WHERE jid = ?`)
      .get('tg:never_seen');
    expect(chat).toBeDefined();
  });
});
