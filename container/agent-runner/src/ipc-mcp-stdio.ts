/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { safeTruncate } from './safe-truncate.js';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const MEDIA_REQ_DIR = path.join(IPC_DIR, 'media-requests');
const MEDIA_RESP_DIR = path.join(IPC_DIR, 'media-responses');
const LOOKUP_REQ_DIR = path.join(IPC_DIR, 'lookup-requests');
const LOOKUP_RESP_DIR = path.join(IPC_DIR, 'lookup-responses');
const CONTACT_WRITE_REQ_DIR = path.join(IPC_DIR, 'contact-write-requests');
const CONTACT_WRITE_RESP_DIR = path.join(IPC_DIR, 'contact-write-responses');
// Per-group credentials MVP: save_credential request/response namespace.
// Kept separate from contact-write-* so payload validation and security
// posture stay independent.
const CREDENTIAL_REQ_DIR = path.join(IPC_DIR, 'credential-requests');
const CREDENTIAL_RESP_DIR = path.join(IPC_DIR, 'credential-responses');
const CONTACTS_JSON_PATH = path.join(IPC_DIR, 'contacts.json');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

/**
 * Validate that a "YYYY-MM-DDTHH:MM[:SS]" string is a real calendar date.
 * Plain `new Date("2026-02-30T15:30:00")` rolls forward to Mar 2 and
 * isNaN returns false — silently scheduling the task on the wrong day.
 * We parse, then round-trip back to the same components and compare.
 */
function isValidLocalTimestamp(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return false;
  const [, y, mo, d, h, mi, sec] = m;
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    sec ? Number(sec) : 0,
  );
  if (isNaN(date.getTime())) return false;
  return (
    date.getFullYear() === Number(y) &&
    date.getMonth() === Number(mo) - 1 &&
    date.getDate() === Number(d) &&
    date.getHours() === Number(h) &&
    date.getMinutes() === Number(mi) &&
    date.getSeconds() === (sec ? Number(sec) : 0)
  );
}

function writeIpcFile(
  dir: string,
  data: object,
  filenameOverride?: string,
): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename =
    filenameOverride ??
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

function generateReqId(): string {
  return `${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

/**
 * Poll for a host-written response file. Used by tools that round-trip
 * through the host (view_media, lookup_messages, annotate_contact). The
 * host writes the response atomically (temp+rename), so once `existsSync`
 * is true the file should be complete. Defense-in-depth catches partial
 * reads or invalid JSON if the rename ever races.
 *
 * On timeout returns a structured error response with `isError: true`
 * and `_meta.error_code = 'TIMEOUT'` so the agent can surface the code.
 */
async function pollResponseFile(
  responseDir: string,
  reqId: string,
  timeoutMs: number = 120000,
  intervalMs: number = 100,
): Promise<CallToolResult> {
  const responsePath = path.join(responseDir, `${reqId}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(responsePath)) {
      try {
        const raw = fs.readFileSync(responsePath, 'utf-8');
        // Host writes responses conforming to MCP CallToolResult — relay
        // directly to the SDK. We don't re-validate here; the host owns
        // the schema and the SDK will catch protocol-level breakage.
        const parsed = JSON.parse(raw) as CallToolResult;
        // Best-effort cleanup — don't fail if unlink races
        try {
          fs.unlinkSync(responsePath);
        } catch {}
        return parsed;
      } catch {
        // Partial read or invalid JSON — wait and retry (atomic temp+rename
        // should prevent this, but defense-in-depth)
        await new Promise((r) => setTimeout(r, intervalMs));
        continue;
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return {
    isError: true,
    _meta: { error_code: 'TIMEOUT', retryable: true },
    content: [
      {
        type: 'text',
        text: 'TIMEOUT: no response within ' + timeoutMs + 'ms',
      },
    ],
  };
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
    script: z.string().optional().describe('Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      // Strict decimal-integer regex: rejects "1e10" (1e10 ms ≈ 115 days,
      // probably not intended), "0xff", "300000abc", " 300000", etc.
      if (!/^[1-9]\d*$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be a positive decimal integer of milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      // Strict shape — JS Date.parse accepts every ISO prefix (e.g. "2026-02"
      // → 2026-02-01T00:00:00Z), so require an explicit full local timestamp
      // before falling through to Date parsing.
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00" — full YYYY-MM-DDTHH:MM[:SS] required.` }],
          isError: true,
        };
      }
      if (!isValidLocalTimestamp(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}" — that calendar date does not exist (e.g. Feb 30 rolls forward to Mar 2).` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      script: args.script || undefined,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${safeTruncate(t.prompt, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
    script: z.string().optional().describe('New script for the task. Set to empty string to remove the script.'),
  },
  async (args) => {
    // Validate per schedule_type. Require schedule_type when schedule_value
    // is updated, otherwise we can't pick the right validator and either
    // (a) misvalidate good input or (b) let garbage through unchecked.
    if (args.schedule_value !== undefined && args.schedule_type === undefined) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'When updating schedule_value, schedule_type must also be provided so the value can be validated.',
          },
        ],
        isError: true,
      };
    }

    if (args.schedule_value !== undefined && args.schedule_type !== undefined) {
      if (args.schedule_type === 'cron') {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
            isError: true,
          };
        }
      } else if (args.schedule_type === 'interval') {
        if (!/^[1-9]\d*$/.test(args.schedule_value)) {
          return {
            content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be a positive decimal integer of milliseconds (e.g., "300000" for 5 min).` }],
            isError: true,
          };
        }
      } else if (args.schedule_type === 'once') {
        if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
          return {
            content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
            isError: true,
          };
        }
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(args.schedule_value)) {
          return {
            content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00" — full YYYY-MM-DDTHH:MM[:SS] required.` }],
            isError: true,
          };
        }
        if (!isValidLocalTimestamp(args.schedule_value)) {
          return {
            content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}" — that calendar date does not exist (e.g. Feb 30 rolls forward to Mar 2).` }],
            isError: true,
          };
        }
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.script !== undefined) data.script = args.script;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363000000000000@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'view_media',
  "Fetch a Telegram media file by `file_id`. Use when the user asks to look at / view / show / посмотри / покажи a photo, image, sticker, document, or PDF you have a `file_id` for. Pass `tg_message_id` alongside `file_id` — it's the `<m id=\"...\">` value on the message that contained the file_id; used by the host for cross-group authorization. `mode` default `auto`: images → image content, PDFs → extracted text. `mode:'image'` with `pages:'1-3'` for visual PDF rendering (max 10 pages). On failure the response text starts with the error code followed by `:` — e.g. `TIMEOUT: ...`, `FILE_TOO_LARGE: ...`, `FILE_EXPIRED: ...`, `EXTRACTOR_MISSING: ...`, `EXTRACTOR_OUTPUT_INVALID: ...`, `NO_TEXT_LAYER: ... (PDF has no extractable text — retry with mode:'image' and a small pages range to render the scan)`, `UNSUPPORTED_TYPE: ...`, `PAGES_OUT_OF_RANGE: ...`, `UPSTREAM_ERROR: ...`, `CROSS_GROUP_REJECTED: ...`. Parse the prefix from the first line and relay the code to the user.",
  {
    file_id: z
      .string()
      .describe('The Telegram file_id from <m><media file_id="...">'),
    tg_message_id: z
      .string()
      .describe(
        'The <m id="..."> value of the message that contained the file_id (for cross-group authorization)',
      ),
    mode: z
      .enum(['auto', 'image', 'text'])
      .optional()
      .describe(
        "auto (default): images → image content, PDFs → text. image: visual rendering. text: forced extraction.",
      ),
    pages: z
      .string()
      .optional()
      .describe('Page range for PDFs in image mode, e.g. "1-3". Max 10 pages.'),
  },
  async (args) => {
    const reqId = generateReqId();
    writeIpcFile(
      MEDIA_REQ_DIR,
      {
        type: 'view_media',
        reqId,
        file_id: args.file_id,
        tg_message_id: args.tg_message_id,
        mode: args.mode,
        pages: args.pages,
        chatJid,
        groupFolder,
      },
      `${reqId}.json`,
    );
    return pollResponseFile(MEDIA_RESP_DIR, reqId, 120000, 100);
  },
);

server.tool(
  'lookup_messages',
  "Search this group's stored message history. Use when the user references something older than the recent context, when walking a reply chain (`<reply mid=\"X\">`), or to find a specific message. Filters: `tg_message_id`, `sender_id`, `since`/`until`, `query` (case-insensitive substring on text — incl. Cyrillic; `%` and `_` in the query are escaped and matched literally). `include_bot` default `false`; pass `true` to UNION the bot's own past replies into the result (not \"only bot\"). Default returns last 50; max 200.",
  {
    tg_message_id: z.string().optional(),
    sender_id: z.string().optional(),
    since: z.string().optional().describe('ISO timestamp'),
    until: z.string().optional().describe('ISO timestamp'),
    query: z
      .string()
      .optional()
      .describe('Case-insensitive substring on text (Cyrillic supported)'),
    include_bot: z
      .boolean()
      .optional()
      .describe(
        'Default false. When true, includes bot replies in results.',
      ),
    limit: z.number().optional().describe('Default 50; max 200'),
  },
  async (args) => {
    const reqId = generateReqId();
    writeIpcFile(
      LOOKUP_REQ_DIR,
      {
        type: 'lookup_messages',
        reqId,
        tg_message_id: args.tg_message_id,
        sender_id: args.sender_id,
        since: args.since,
        until: args.until,
        query: args.query,
        include_bot: args.include_bot,
        limit: args.limit,
        chatJid,
        groupFolder,
      },
      `${reqId}.json`,
    );
    return pollResponseFile(LOOKUP_RESP_DIR, reqId, 120000, 100);
  },
);

server.tool(
  'lookup_contacts',
  "Search this group's known people/contacts. Use when the user references a person by name / nickname / `@username` / phone. `query` for free-text; `username` exact (lowercase, no `@`); `tg_id` exact. Returns up to `limit` rows (default 50). Reads a snapshot file refreshed within ~500ms of last upsert — enrichment from `@mention` resolution may not be reflected on the same turn; if a row is missing or `enriched=0`, say so honestly.",
  {
    query: z.string().optional().describe('Free-text search'),
    username: z
      .string()
      .optional()
      .describe('Exact username (lowercase, no @)'),
    tg_id: z.string().optional().describe('Exact tg_id'),
    limit: z.number().optional().describe('Default 50'),
  },
  async (args) => {
    try {
      const raw = fs.readFileSync(CONTACTS_JSON_PATH, 'utf-8');
      const contacts: Array<Record<string, unknown>> = JSON.parse(raw);
      const limit = args.limit ?? 50;
      const lowerQuery = args.query?.toLowerCase();
      const lowerUsername = args.username?.toLowerCase();
      const filtered = contacts
        .filter((c) => {
          if (args.tg_id && c.tg_id !== args.tg_id) return false;
          if (lowerUsername && c.username !== lowerUsername) return false;
          if (lowerQuery) {
            const haystack = [
              c.first_name,
              c.last_name,
              c.title,
              c.username,
              c.bio,
              c.notes,
            ]
              .filter((v): v is string => typeof v === 'string' && v.length > 0)
              .join(' ')
              .toLowerCase();
            if (!haystack.includes(lowerQuery)) return false;
          }
          return true;
        })
        .slice(0, limit);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(filtered, null, 2) },
        ],
      };
    } catch (err) {
      // ENOENT = no snapshot yet (host hasn't written contacts.json — first
      // run, or empty contacts table)
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { content: [{ type: 'text' as const, text: '[]' }] };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: 'lookup_contacts failed: ' + String(err),
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'annotate_contact',
  'Attach a note or tag. Identify by ONE of `ident`, `username`, `tg_id`. `notes` REPLACES previous notes (use for the canonical summary); `tags` APPENDS unique comma-separated tags.',
  {
    ident: z.string().optional(),
    username: z.string().optional(),
    tg_id: z.string().optional(),
    notes: z.string().optional().describe('REPLACES previous notes'),
    tags: z
      .string()
      .optional()
      .describe('APPENDS unique comma-separated tags'),
  },
  async (args) => {
    if (!args.ident && !args.username && !args.tg_id) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'annotate_contact: must provide ident, username, or tg_id',
          },
        ],
        isError: true,
      };
    }
    const reqId = generateReqId();
    writeIpcFile(
      CONTACT_WRITE_REQ_DIR,
      {
        type: 'annotate_contact',
        reqId,
        ident: args.ident,
        username: args.username,
        tg_id: args.tg_id,
        notes: args.notes,
        tags: args.tags,
        chatJid,
        groupFolder,
      },
      `${reqId}.json`,
    );
    return pollResponseFile(CONTACT_WRITE_RESP_DIR, reqId, 120000, 100);
  },
);

server.tool(
  'save_credential',
  `Persist a user-provided API key for an external service so the agent can use it on the next container start. Use ONLY when the user explicitly pastes a credential into chat (e.g. "вот мой Notion токен: secret_xxxxx" or "мой Google Maps ключ: AIza..."). Supported services: 'notion' (sets NOTION_API_KEY) and 'google-maps' (sets GOOGLE_MAPS_API_KEY).

The credential is stored in this group's private env file (data/env/<folder>.env, mode 0600 on host) — never logged, never sent anywhere except this host. After a successful save, the container will exit and restart automatically; the new value is active on the next message. Tell the user to wait a few seconds before testing.

DO NOT use for OAuth-based services (gmail, calendar, drive). Those need a separate Device Code Flow tool (coming later). DO NOT echo the credential back to the user — confirm by service name only ("Saved your Notion token, give it ~5 seconds and try again"). On error, the response text starts with the error code (e.g. UNSUPPORTED_SERVICE, INVALID_VALUE, CROSS_GROUP_REJECTED, UPSTREAM_ERROR) — relay the code and a short human message, never the value.`,
  {
    service: z
      .enum(['notion', 'google-maps'])
      .describe(
        "Which service this credential is for. 'notion' stores under NOTION_API_KEY, 'google-maps' under GOOGLE_MAPS_API_KEY.",
      ),
    value: z
      .string()
      .min(1)
      .describe(
        'The API key / token string (will be stored verbatim, mode 0600 on host). Must not contain newlines or control characters.',
      ),
  },
  async (args) => {
    const reqId = generateReqId();
    writeIpcFile(
      CREDENTIAL_REQ_DIR,
      {
        type: 'save_credential',
        reqId,
        service: args.service,
        // The value is included in the request file (mode 0600 inherited from
        // the IPC mount permissions on host). The host watcher reads, writes
        // the env file, and unlinks the request promptly. The credential is
        // NEVER logged on either side (see ipc-credential-handler.ts).
        value: args.value,
        chatJid,
        groupFolder,
      },
      `${reqId}.json`,
    );
    return pollResponseFile(CREDENTIAL_RESP_DIR, reqId, 30000, 100);
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
