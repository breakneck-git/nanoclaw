export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
  /**
   * Optional per-group MCP server whitelist. When set, the container only
   * registers the listed MCP servers (plus `nanoclaw`, always included).
   * When undefined (legacy), all MCP servers are registered — preserves the
   * existing behavior for the main group and any pre-migration rows.
   *
   * Stored on disk as a CSV in `registered_groups.enabled_mcp`.
   */
  enabledMcp?: string[];
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
  /** Channel-specific structured metadata (JSON-serialized) for rich message capture. */
  meta?: string;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
  /**
   * Forum topic the task delivers into, captured at creation time. `null`/
   * undefined means the General topic. Pinning this (instead of routing to the
   * chat's live last-active thread) keeps a reminder in the thread it was set
   * up in — and pre-thread tasks (no value) land in General.
   */
  thread_id?: string | null;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface SendMessageOptions {
  /**
   * Channel-specific thread/topic identifier. For Telegram supergroup forums
   * this is `message_thread_id` — required to reply inside the same topic.
   * Channels that don't support threads ignore it.
   */
  threadId?: string;
}

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(
    jid: string,
    text: string,
    opts?: SendMessageOptions,
  ): Promise<{ messageId?: string } | void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  // `opts.threadId` routes the indicator to a specific forum topic when set.
  setTyping?(
    jid: string,
    isTyping: boolean,
    opts?: SendMessageOptions,
  ): Promise<void>;
  // Optional: edit an already-sent message in place. Implemented by channels
  // that support live updates (Telegram). Retained as a general capability;
  // streaming no longer uses it (see sendMessageDraft).
  editMessage?(
    jid: string,
    messageId: string,
    text: string,
    opts?: SendMessageOptions,
  ): Promise<void>;
  // Optional: native streaming preview. Telegram's sendMessageDraft (Bot API
  // 9.5) renders an ephemeral, animated "draft" bubble that updates in place
  // as tokens arrive — the purpose-built streaming primitive, smoother than
  // editMessage and with no edit rate-limit. `draftId` must be a stable
  // non-zero integer for the whole turn (same id ⇒ animated update). The
  // draft is a preview only; the orchestrator sends the real, persisted
  // message via sendMessage once the turn completes. Private chats only.
  // Channels without this capability skip live streaming (final message only).
  sendMessageDraft?(
    jid: string,
    draftId: number,
    text: string,
    opts?: SendMessageOptions,
  ): Promise<void>;
  // Optional: send a local file as an attachment (Telegram document). Channels
  // without this capability can't deliver files. `opts.caption` adds text,
  // `opts.threadId` routes it into a forum topic.
  sendFile?(
    jid: string,
    filePath: string,
    opts?: { caption?: string; threadId?: string },
  ): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
  // Optional: channel-specific identifier for the bot/sender (e.g. bot user ID).
  botSenderId?(): string | undefined;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
