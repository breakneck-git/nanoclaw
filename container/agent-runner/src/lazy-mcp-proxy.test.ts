/**
 * Tests for the lazy MCP proxy.
 *
 * We don't fork real binaries — instead we inject a stub ChildFactory that
 * lets us count forks, control listTools()/callTool() results, and assert
 * the lifecycle (lazy fork on first tools/call, reuse on second, death-aware
 * behavior, cache persistence between runs).
 *
 * The MCP Server itself is exercised through its public setRequestHandler
 * surface via direct handler invocation — wiring a real StdioServerTransport
 * would require piping stdin/stdout and add zero confidence to the proxy's
 * own logic, which is what we care about here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ChildFactory,
  buildConfigFromArgs,
  createProxy,
  ensureCachedTools,
  parseCliArgs,
  readCache,
  writeCacheAtomic,
} from './lazy-mcp-proxy.js';

/**
 * Capture all requests sent to setRequestHandler so we can dispatch them
 * directly without a transport. The Server's setRequestHandler wraps
 * handlers in zod validation; we side-step that by holding references the
 * handlers register internally via the protocol layer.
 *
 * We use the test-only proxy wrapper below: createProxy returns a server,
 * and we register a passthrough captor on top.
 */
interface FakeClient {
  listTools: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function makeFakeClient(opts: {
  tools?: unknown[];
  callToolResult?: unknown;
  callToolThrows?: Error;
} = {}): FakeClient {
  // `as any` casts unblock the SDK's strict Client signature in mocks —
  // the production proxy only uses listTools/callTool/close so this is safe.
  return {
    listTools: vi.fn(async () => ({ tools: opts.tools ?? [{ name: 'demo', inputSchema: { type: 'object' as const } }] })) as any,
    callTool: vi.fn(async (params: { name: string; arguments?: unknown }) => {
      if (opts.callToolThrows) throw opts.callToolThrows;
      return (
        opts.callToolResult ?? {
          content: [{ type: 'text', text: `called ${params.name}` }],
        }
      );
    }) as any,
    close: vi.fn(async () => { /* no-op */ }) as any,
  };
}

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-mcp-test-'));
});

afterEach(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('cache persistence', () => {
  it('writes cache atomically and reads it back', () => {
    const cachePath = path.join(tempDir, 'srv.json');
    writeCacheAtomic(cachePath, {
      version: '1',
      serverName: 'srv',
      savedAt: '2026-05-22T00:00:00Z',
      tools: [{ name: 'a', inputSchema: { type: 'object' as const } }],
    });
    const loaded = readCache(cachePath);
    expect(loaded?.tools).toHaveLength(1);
    expect(loaded?.tools[0].name).toBe('a');
  });

  it('readCache returns null on missing file', () => {
    expect(readCache(path.join(tempDir, 'nope.json'))).toBeNull();
  });

  it('readCache returns null on corrupt JSON', () => {
    const cachePath = path.join(tempDir, 'bad.json');
    fs.writeFileSync(cachePath, '{ this is not json');
    expect(readCache(cachePath)).toBeNull();
  });

  it('readCache returns null on schema mismatch', () => {
    const cachePath = path.join(tempDir, 'wrong.json');
    fs.writeFileSync(cachePath, JSON.stringify({ tools: 'not an array' }));
    expect(readCache(cachePath)).toBeNull();
  });
});

describe('ensureCachedTools', () => {
  it('forks once on cache miss and persists cache', async () => {
    const fake = makeFakeClient({ tools: [{ name: 't1', inputSchema: { type: 'object' as const } }] });
    const childFactory: ChildFactory = vi.fn(async () => ({ client: fake as any, pid: 1234 }));

    const tools = await ensureCachedTools(
      { name: 'srv', command: 'fake', args: [], env: {}, cacheDir: tempDir },
      childFactory,
    );

    expect(tools).toHaveLength(1);
    expect((tools[0] as { name: string }).name).toBe('t1');
    expect(childFactory).toHaveBeenCalledTimes(1);
    expect(fake.listTools).toHaveBeenCalledTimes(1);
    expect(fake.close).toHaveBeenCalledTimes(1); // temporary child disposed

    // Cache file was written
    const cachePath = path.join(tempDir, 'srv.json');
    const cached = readCache(cachePath);
    expect(cached?.serverName).toBe('srv');
    expect(cached?.tools).toHaveLength(1);
  });

  it('uses existing cache without forking', async () => {
    const cachePath = path.join(tempDir, 'srv.json');
    writeCacheAtomic(cachePath, {
      version: '1',
      serverName: 'srv',
      savedAt: '2026-05-22T00:00:00Z',
      tools: [{ name: 'precached', inputSchema: { type: 'object' as const } }],
    });

    const childFactory: ChildFactory = vi.fn(async () => ({
      client: makeFakeClient() as any,
      pid: null,
    }));

    const tools = await ensureCachedTools(
      { name: 'srv', command: 'fake', args: [], env: {}, cacheDir: tempDir },
      childFactory,
    );

    expect(tools).toHaveLength(1);
    expect((tools[0] as { name: string }).name).toBe('precached');
    expect(childFactory).not.toHaveBeenCalled();
  });

  it('closes temporary child even when listTools throws', async () => {
    const fake = makeFakeClient();
    fake.listTools.mockRejectedValue(new Error('upstream broken'));
    const childFactory: ChildFactory = vi.fn(async () => ({ client: fake as any, pid: 1 }));

    await expect(
      ensureCachedTools(
        { name: 'srv', command: 'fake', args: [], env: {}, cacheDir: tempDir },
        childFactory,
      ),
    ).rejects.toThrow('upstream broken');
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
});

describe('proxy lifecycle', () => {
  it('bootstrap warms cache; tools/list returns cached tools without forking', async () => {
    const fake = makeFakeClient({ tools: [{ name: 'cached', inputSchema: { type: 'object' as const } }] });
    const childFactory: ChildFactory = vi.fn(async () => ({ client: fake as any, pid: 7 }));

    const { runtime, bootstrap } = createProxy(
      { name: 'srv', command: 'fake', args: [], env: {}, cacheDir: tempDir },
      childFactory,
    );

    await bootstrap();
    // bootstrap forked once to seed the cache
    expect(childFactory).toHaveBeenCalledTimes(1);
    expect(runtime.cachedTools).toHaveLength(1);
    expect((runtime.cachedTools[0] as { name: string }).name).toBe('cached');
    expect(runtime.childPromise).toBeNull(); // no live child yet
  });

  it('bootstrap reads cache from disk without forking when cache exists', async () => {
    const cachePath = path.join(tempDir, 'srv.json');
    writeCacheAtomic(cachePath, {
      version: '1',
      serverName: 'srv',
      savedAt: 'x',
      tools: [{ name: 'fromdisk', inputSchema: { type: 'object' as const } }],
    });
    const childFactory: ChildFactory = vi.fn(async () => ({ client: makeFakeClient() as any, pid: 0 }));

    const { runtime, bootstrap } = createProxy(
      { name: 'srv', command: 'fake', args: [], env: {}, cacheDir: tempDir },
      childFactory,
    );

    await bootstrap();
    expect(childFactory).not.toHaveBeenCalled();
    expect((runtime.cachedTools[0] as { name: string }).name).toBe('fromdisk');
  });

  it('runtime is clean after bootstrap (no live child yet)', async () => {
    const fake = makeFakeClient({ tools: [{ name: 't', inputSchema: { type: 'object' as const } }] });
    const childFactory: ChildFactory = vi.fn(async () => ({ client: fake as any, pid: 9 }));

    const { runtime, bootstrap } = createProxy(
      { name: 'srv', command: 'fake', args: [], env: {}, cacheDir: tempDir },
      childFactory,
    );

    await bootstrap();
    // bootstrap forked once for tool-cache harvest, then disposed the child.
    expect(childFactory).toHaveBeenCalledTimes(1);
    // No live child yet — lazy fork triggers on first tools/call.
    expect(runtime.childPromise).toBeNull();
    expect(runtime.childDead).toBe(false);
  });

  it('shutdown closes a forked child if one was opened', async () => {
    const fake = makeFakeClient();
    const childFactory: ChildFactory = vi.fn(async () => ({ client: fake as any, pid: 100 }));

    const { runtime, bootstrap, shutdown } = createProxy(
      { name: 'srv', command: 'fake', args: [], env: {}, cacheDir: tempDir },
      childFactory,
    );
    await bootstrap();

    // Pretend a callTool happened by manually seeding the runtime — this
    // is a white-box assertion that shutdown actually closes a live child.
    runtime.childPromise = Promise.resolve({ client: fake as any, pid: 100 });
    await shutdown();
    expect(fake.close).toHaveBeenCalled();
  });

  it('shutdown is idempotent', async () => {
    const childFactory: ChildFactory = vi.fn(async () => ({ client: makeFakeClient() as any, pid: 1 }));
    const { bootstrap, shutdown, runtime } = createProxy(
      { name: 'srv', command: 'fake', args: [], env: {}, cacheDir: tempDir },
      childFactory,
    );
    await bootstrap();
    await shutdown();
    expect(runtime.shuttingDown).toBe(true);
    await shutdown(); // second call returns immediately
    expect(runtime.shuttingDown).toBe(true);
  });
});

describe('CLI arg parsing', () => {
  it('parses all known flags', () => {
    const parsed = parseCliArgs([
      '--name', 'google-maps',
      '--command', 'mcp-server-google-maps',
      '--args-json', '["a","b"]',
      '--env-json', '{"K":"V"}',
      '--cache-dir', '/tmp/cache',
    ]);
    expect(parsed.name).toBe('google-maps');
    expect(parsed.command).toBe('mcp-server-google-maps');
    expect(parsed.argsJson).toBe('["a","b"]');
    expect(parsed.envJson).toBe('{"K":"V"}');
    expect(parsed.cacheDir).toBe('/tmp/cache');
  });

  it('ignores unknown flags without crashing', () => {
    const parsed = parseCliArgs(['--name', 'x', '--bogus', 'y', '--command', 'c']);
    expect(parsed.name).toBe('x');
    expect(parsed.command).toBe('c');
  });

  it('buildConfigFromArgs defaults args/env and cache dir', () => {
    const cfg = buildConfigFromArgs({ name: 'a', command: 'b' });
    expect(cfg.args).toEqual([]);
    expect(cfg.env).toEqual({});
    expect(cfg.cacheDir).toMatch(/\.mcp-cache$/);
  });

  it('buildConfigFromArgs parses JSON', () => {
    const cfg = buildConfigFromArgs({
      name: 'a',
      command: 'b',
      argsJson: '["x"]',
      envJson: '{"K":"V"}',
      cacheDir: '/x',
    });
    expect(cfg.args).toEqual(['x']);
    expect(cfg.env).toEqual({ K: 'V' });
    expect(cfg.cacheDir).toBe('/x');
  });

  it('buildConfigFromArgs rejects non-array argsJson', () => {
    expect(() => buildConfigFromArgs({ name: 'a', command: 'b', argsJson: '"not-array"' })).toThrow();
  });

  it('buildConfigFromArgs rejects non-object envJson', () => {
    expect(() => buildConfigFromArgs({ name: 'a', command: 'b', envJson: '[1,2]' })).toThrow();
  });

  it('buildConfigFromArgs requires --name and --command', () => {
    expect(() => buildConfigFromArgs({ command: 'b' })).toThrow(/--name/);
    expect(() => buildConfigFromArgs({ name: 'a' })).toThrow(/--command/);
  });
});

/**
 * Behavioral tests: drive the proxy's tools/call handler end-to-end by
 * issuing requests through a fake transport. We use the Server's protocol
 * directly via `request()` so we test exactly the code path the agent hits.
 */
describe('proxy request handling', () => {
  /**
   * Tiny pair of fake transports that ferry messages between an in-process
   * client and the proxy's Server. We can't use StdioServerTransport here
   * because that hard-binds to process.stdin/stdout. Instead, we hand-roll
   * a Transport pair and connect both ends.
   */
  function makeTransportPair(): [import('@modelcontextprotocol/sdk/shared/transport.js').Transport, import('@modelcontextprotocol/sdk/shared/transport.js').Transport] {
    type Transport = import('@modelcontextprotocol/sdk/shared/transport.js').Transport;
    type Message = Parameters<NonNullable<Transport['onmessage']>>[0];

    const aToB: Message[] = [];
    const bToA: Message[] = [];

    const a: Transport = {
      async start() { /* no-op */ },
      async send(msg) {
        aToB.push(msg);
        // Deliver async so we mimic real transport ordering
        queueMicrotask(() => {
          if (b.onmessage) b.onmessage(msg);
        });
      },
      async close() { if (a.onclose) a.onclose(); },
    };
    const b: Transport = {
      async start() { /* no-op */ },
      async send(msg) {
        bToA.push(msg);
        queueMicrotask(() => {
          if (a.onmessage) a.onmessage(msg);
        });
      },
      async close() { if (b.onclose) b.onclose(); },
    };
    return [a, b];
  }

  it('first tools/call forks the child; second reuses it', async () => {
    const fake = makeFakeClient({ tools: [{ name: 'get_directions', inputSchema: { type: 'object' as const } }] });
    let factoryCalls = 0;
    const childFactory: ChildFactory = async () => {
      factoryCalls++;
      return { client: fake as any, pid: 42 };
    };

    const { server, bootstrap } = createProxy(
      { name: 'srv', command: 'fake', args: [], env: {}, cacheDir: tempDir },
      childFactory,
    );
    await bootstrap();
    expect(factoryCalls).toBe(1); // bootstrap

    // Connect server to a fake transport pair and drive it via a real Client
    // — guarantees we exercise the actual handler wiring.
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const [clientSide, serverSide] = makeTransportPair();
    const client = new Client({ name: 'test-client', version: '1' }, { capabilities: {} });

    await Promise.all([
      server.connect(serverSide),
      client.connect(clientSide),
    ]);

    // Tool list comes from cache — no extra fork
    const list1 = await client.listTools();
    expect(list1.tools).toHaveLength(1);
    expect(factoryCalls).toBe(1);

    // First tools/call → fork
    const call1 = await client.callTool({ name: 'get_directions', arguments: {} });
    expect(factoryCalls).toBe(2);
    expect(fake.callTool).toHaveBeenCalledTimes(1);
    expect((call1 as { content: { text: string }[] }).content[0].text).toContain('get_directions');

    // Second tools/call → reuse
    await client.callTool({ name: 'get_directions', arguments: { foo: 1 } });
    expect(factoryCalls).toBe(2);
    expect(fake.callTool).toHaveBeenCalledTimes(2);

    await client.close();
    await server.close();
  });

  it('returns isError when upstream callTool throws (does not crash)', async () => {
    const fake = makeFakeClient({ callToolThrows: new Error('upstream blew up') });
    const childFactory: ChildFactory = async () => ({ client: fake as any, pid: 7 });

    const { server, bootstrap } = createProxy(
      { name: 'srv', command: 'fake', args: [], env: {}, cacheDir: tempDir },
      childFactory,
    );
    await bootstrap();

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const [clientSide, serverSide] = makeTransportPair();
    const client = new Client({ name: 'test-client', version: '1' }, { capabilities: {} });

    await Promise.all([
      server.connect(serverSide),
      client.connect(clientSide),
    ]);

    const result = await client.callTool({ name: 'demo', arguments: {} });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(result)).toContain('upstream blew up');

    await client.close();
    await server.close();
  });

  it('returns isError when child has been marked dead', async () => {
    const fake = makeFakeClient();
    const childFactory: ChildFactory = async () => ({ client: fake as any, pid: 1 });

    const { server, runtime, bootstrap } = createProxy(
      { name: 'srv', command: 'fake', args: [], env: {}, cacheDir: tempDir },
      childFactory,
    );
    await bootstrap();
    runtime.childDead = true; // simulate prior crash

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const [clientSide, serverSide] = makeTransportPair();
    const client = new Client({ name: 'test-client', version: '1' }, { capabilities: {} });

    await Promise.all([
      server.connect(serverSide),
      client.connect(clientSide),
    ]);

    const result = await client.callTool({ name: 'demo', arguments: {} });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(result)).toContain('upstream MCP server died');

    await client.close();
    await server.close();
  });

  it('prompts/list and resources/list return empty', async () => {
    const fake = makeFakeClient();
    const childFactory: ChildFactory = async () => ({ client: fake as any, pid: 1 });

    const { server, bootstrap } = createProxy(
      { name: 'srv', command: 'fake', args: [], env: {}, cacheDir: tempDir },
      childFactory,
    );
    await bootstrap();

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const [clientSide, serverSide] = makeTransportPair();
    const client = new Client({ name: 'test-client', version: '1' }, { capabilities: {} });
    await Promise.all([
      server.connect(serverSide),
      client.connect(clientSide),
    ]);

    const prompts = await client.listPrompts();
    expect(prompts.prompts).toEqual([]);
    const resources = await client.listResources();
    expect(resources.resources).toEqual([]);
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates).toEqual([]);

    await client.close();
    await server.close();
  });
});
