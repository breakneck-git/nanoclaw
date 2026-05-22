/**
 * Lazy MCP Proxy
 *
 * Stands in for a real MCP server (talked to over stdio by the agent).
 * - tools/list responds from a disk cache without forking the real server.
 * - tools/call lazily forks the real server on first invocation, performs the
 *   MCP initialize handshake, then proxies the call. Subsequent calls reuse
 *   the same child process.
 * - prompts/list, resources/list, resources/templates/list return empty.
 * - The first time the proxy starts (no cache yet) it briefly forks the real
 *   server, calls tools/list, persists the result, and kills the temporary
 *   child. After that the cache survives container restarts because the
 *   cache dir lives on a host-mounted volume.
 *
 * Usage:
 *   node lazy-mcp-proxy.js \
 *     --name google-maps \
 *     --command mcp-server-google-maps \
 *     --args-json '[]' \
 *     --env-json '{"GOOGLE_MAPS_API_KEY":"..."}' \
 *     [--cache-dir /workspace/ipc/.mcp-cache]
 *
 * The proxy MUST NOT crash on any error path — MCP expects graceful error
 * responses, not process exits. All logging goes to stderr so stdout stays
 * a clean JSON-RPC channel.
 */

import fs from 'fs';
import path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  PingRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

// Note: the SDK types Tool but exposes it via z.infer; we only need a subset
// for cache marshalling, so define a structural copy that matches what the
// SDK returns from listTools().
interface CachedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { type: 'object'; properties?: Record<string, object>; required?: string[]; [k: string]: unknown };
  outputSchema?: { type: 'object'; properties?: Record<string, object>; required?: string[]; [k: string]: unknown };
  annotations?: Record<string, unknown>;
  execution?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  icons?: unknown[];
}

interface CacheFile {
  version: string;
  serverName: string;
  savedAt: string;
  tools: CachedTool[];
}

const CACHE_VERSION = '1';
const DEFAULT_CACHE_DIR = '/workspace/ipc/.mcp-cache';

export interface ProxyConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cacheDir: string;
}

export interface ChildFactoryParams {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Abstraction over creating + connecting the upstream MCP client. Pulled
 * into the config so tests can stub it without spawning real binaries.
 */
export interface ChildFactory {
  (params: ChildFactoryParams): Promise<{
    client: Pick<Client, 'listTools' | 'callTool' | 'close'>;
    pid: number | null;
  }>;
}

const defaultChildFactory: ChildFactory = async ({ command, args, env }) => {
  // Pass current PATH so the binary can resolve; merge the real-server
  // env on top. NEVER log env values to stderr — only keys.
  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...process.env as Record<string, string>, ...env },
    stderr: 'inherit',
  });
  const client = new Client(
    { name: 'lazy-mcp-proxy-client', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return { client, pid: transport.pid };
};

function logStderr(name: string, ...parts: unknown[]): void {
  // eslint-disable-next-line no-console
  console.error(`[lazy-proxy:${name}]`, ...parts);
}

/**
 * Atomic cache write: temp file + rename. Same pattern as
 * ipc-mcp-stdio.ts writeIpcFile().
 */
export function writeCacheAtomic(cachePath: string, cache: CacheFile): void {
  const dir = path.dirname(cachePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(cache, null, 2));
  fs.renameSync(tempPath, cachePath);
}

export function readCache(cachePath: string): CacheFile | null {
  if (!fs.existsSync(cachePath)) return null;
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CacheFile>;
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray(parsed.tools) &&
      typeof parsed.version === 'string' &&
      typeof parsed.serverName === 'string'
    ) {
      return parsed as CacheFile;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build a generic JSON-RPC error response body for the agent. We avoid
 * throwing McpError out of handlers so the JSON-RPC layer logs cleanly.
 * tools/call expects a CallToolResult — return isError=true content so the
 * agent sees a tool error rather than a transport error.
 */
function toolErrorResult(message: string): {
  isError: true;
  content: [{ type: 'text'; text: string }];
} {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

interface ProxyRuntime {
  cachedTools: CachedTool[];
  // Memoized child connection. `null` => not yet forked. Promise => in-flight.
  // We hold the Promise (not the result) so concurrent tools/call requests
  // share one fork rather than racing.
  childPromise: Promise<{ client: Pick<Client, 'listTools' | 'callTool' | 'close'>; pid: number | null }> | null;
  // True once a child has been forked AND closed (died). We never re-fork
  // automatically — return errors to the agent so it can retry.
  childDead: boolean;
  shuttingDown: boolean;
}

/**
 * Ensure the tool cache exists. If it doesn't, fork a temporary child,
 * harvest its tool list, persist the cache, and dispose the child.
 *
 * Returns the cached tools (whether freshly built or already present).
 */
export async function ensureCachedTools(
  config: ProxyConfig,
  childFactory: ChildFactory,
): Promise<CachedTool[]> {
  const cachePath = path.join(config.cacheDir, `${config.name}.json`);
  const existing = readCache(cachePath);
  if (existing) {
    logStderr(config.name, `loaded ${existing.tools.length} tools from cache (${cachePath})`);
    return existing.tools;
  }

  logStderr(config.name, `cache miss at ${cachePath}, forking temporary child to harvest tools`);
  const { client } = await childFactory({
    command: config.command,
    args: config.args,
    env: config.env,
  });

  let tools: CachedTool[];
  try {
    const result = await client.listTools();
    tools = result.tools as CachedTool[];
  } finally {
    // Always close the temporary child, even if listTools threw. This is the
    // one place we proactively kill the child — every other path keeps the
    // long-lived child alive.
    try {
      await client.close();
    } catch (err) {
      logStderr(config.name, 'failed to close temporary child:', err instanceof Error ? err.message : String(err));
    }
  }

  const cache: CacheFile = {
    version: CACHE_VERSION,
    serverName: config.name,
    savedAt: new Date().toISOString(),
    tools,
  };
  try {
    writeCacheAtomic(cachePath, cache);
    logStderr(config.name, `persisted ${tools.length} tools to ${cachePath}`);
  } catch (err) {
    // If the cache dir is read-only or otherwise broken we still want the
    // proxy to serve traffic — just log and continue with the in-memory list.
    logStderr(
      config.name,
      'failed to persist cache, continuing in-memory only:',
      err instanceof Error ? err.message : String(err),
    );
  }
  return tools;
}

/**
 * Fork-once child for tools/call. Returns the same Promise on every call so
 * concurrent invocations share a single fork. If the child has died we do
 * NOT auto-respawn — that's a deliberate choice so the agent observes the
 * failure and can decide whether to retry.
 */
async function getOrForkChild(
  config: ProxyConfig,
  childFactory: ChildFactory,
  runtime: ProxyRuntime,
): Promise<{ client: Pick<Client, 'listTools' | 'callTool' | 'close'>; pid: number | null }> {
  if (runtime.childDead) {
    throw new Error('upstream MCP server died; client should retry to spawn a fresh proxy');
  }
  if (runtime.childPromise) return runtime.childPromise;

  logStderr(config.name, 'forking upstream MCP server (first tools/call)');
  runtime.childPromise = childFactory({
    command: config.command,
    args: config.args,
    env: config.env,
  }).catch((err) => {
    // Don't memoize a rejected fork — allow the next tools/call to retry.
    runtime.childPromise = null;
    throw err;
  });

  const result = await runtime.childPromise;
  logStderr(config.name, `upstream connected (pid=${result.pid ?? 'unknown'})`);
  return result;
}

/**
 * Build (but don't start) the proxy server. Exposed for testing: lets us
 * exercise the handlers without binding to stdin/stdout.
 */
export function createProxy(
  config: ProxyConfig,
  childFactory: ChildFactory = defaultChildFactory,
): {
  server: Server;
  runtime: ProxyRuntime;
  bootstrap: () => Promise<void>;
  shutdown: () => Promise<void>;
} {
  const runtime: ProxyRuntime = {
    cachedTools: [],
    childPromise: null,
    childDead: false,
    shuttingDown: false,
  };

  const server = new Server(
    { name: `lazy-mcp-proxy-${config.name}`, version: '1.0.0' },
    {
      capabilities: {
        tools: {},
        // Advertise empty prompts/resources so the agent SDK can probe them
        // without seeing MethodNotFound errors. The handlers return empty.
        prompts: {},
        resources: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: runtime.cachedTools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const { client } = await getOrForkChild(config, childFactory, runtime);
      const result = await client.callTool({ name, arguments: args });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logStderr(config.name, `tools/call(${name}) failed:`, msg);
      return toolErrorResult(`lazy-mcp-proxy error: ${msg}`);
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
  server.setRequestHandler(PingRequestSchema, async () => ({}));

  async function bootstrap(): Promise<void> {
    // Resolve the tool cache before connecting the transport so the very
    // first tools/list from the agent doesn't race ensureCachedTools().
    try {
      runtime.cachedTools = await ensureCachedTools(config, childFactory);
    } catch (err) {
      logStderr(
        config.name,
        'failed to obtain tool cache:',
        err instanceof Error ? err.message : String(err),
        '— serving empty tool list',
      );
      runtime.cachedTools = [];
    }
  }

  async function shutdown(): Promise<void> {
    if (runtime.shuttingDown) return;
    runtime.shuttingDown = true;
    if (runtime.childPromise) {
      try {
        const { client } = await runtime.childPromise;
        await client.close();
      } catch (err) {
        logStderr(config.name, 'shutdown close error:', err instanceof Error ? err.message : String(err));
      }
    }
  }

  return { server, runtime, bootstrap, shutdown };
}

interface ParsedArgs {
  name?: string;
  command?: string;
  argsJson?: string;
  envJson?: string;
  cacheDir?: string;
}

export function parseCliArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = argv[i + 1];
    switch (flag) {
      case '--name':
        out.name = val;
        i++;
        break;
      case '--command':
        out.command = val;
        i++;
        break;
      case '--args-json':
        out.argsJson = val;
        i++;
        break;
      case '--env-json':
        out.envJson = val;
        i++;
        break;
      case '--cache-dir':
        out.cacheDir = val;
        i++;
        break;
      default:
        // ignore unknown flags rather than crash — proxy must stay alive
        break;
    }
  }
  return out;
}

export function buildConfigFromArgs(parsed: ParsedArgs): ProxyConfig {
  if (!parsed.name) throw new Error('--name is required');
  if (!parsed.command) throw new Error('--command is required');

  let args: string[] = [];
  if (parsed.argsJson) {
    try {
      const v = JSON.parse(parsed.argsJson);
      if (!Array.isArray(v)) throw new Error('--args-json must be a JSON array');
      args = v.map((x) => String(x));
    } catch (err) {
      throw new Error(
        `invalid --args-json: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  let env: Record<string, string> = {};
  if (parsed.envJson) {
    try {
      const v = JSON.parse(parsed.envJson);
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        throw new Error('--env-json must be a JSON object');
      }
      env = Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, String(val)]),
      );
    } catch (err) {
      throw new Error(
        `invalid --env-json: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    name: parsed.name,
    command: parsed.command,
    args,
    env,
    cacheDir: parsed.cacheDir || DEFAULT_CACHE_DIR,
  };
}

async function runCli(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  let config: ProxyConfig;
  try {
    config = buildConfigFromArgs(parsed);
  } catch (err) {
    // Without a name we can't even tag the log line — fall back to 'unknown'.
    logStderr(parsed.name || 'unknown', 'configuration error:', err instanceof Error ? err.message : String(err));
    // Exit non-zero so the SDK transport sees the failure.
    process.exit(2);
  }

  // Avoid leaking secret values: log only key names from env.
  logStderr(
    config.name,
    `starting (command=${config.command}, env keys=[${Object.keys(config.env).join(',')}])`,
  );

  const { server, bootstrap, shutdown } = createProxy(config);

  // Best-effort cleanup. We don't await — Node exits, and the child receives
  // SIGTERM via its parent dying. We still try to close cleanly for IDE/dev.
  const cleanup = () => {
    shutdown().catch(() => { /* ignore */ });
  };
  process.on('exit', cleanup);
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });

  // Suppress crashes from unhandled rejections / exceptions in this process.
  // We log and keep running so the JSON-RPC channel stays open for the agent.
  process.on('unhandledRejection', (reason) => {
    logStderr(config.name, 'unhandledRejection:', reason instanceof Error ? reason.message : String(reason));
  });
  process.on('uncaughtException', (err) => {
    logStderr(config.name, 'uncaughtException:', err.message);
  });

  await bootstrap();

  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
    logStderr(config.name, 'proxy ready (stdio)');
  } catch (err) {
    logStderr(config.name, 'failed to start stdio transport:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Detect "run as CLI" without crashing in test environment. import.meta.url
// matches process.argv[1] when this file is the entrypoint.
const isMain = (() => {
  try {
    const here = new URL(import.meta.url).pathname;
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return here === entry;
  } catch {
    return false;
  }
})();

if (isMain) {
  runCli().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[lazy-proxy] fatal:', err instanceof Error ? err.stack || err.message : String(err));
    process.exit(1);
  });
}

// Re-export internals for testing
export { ErrorCode, McpError };
