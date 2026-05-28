import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { titleFromMessage } from './topic-titler.js';

// Suppress logger output during tests
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock readEnvFile to provide a fake API key
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn((keys: string[]) => {
    if (keys.includes('ANTHROPIC_API_KEY')) {
      return { ANTHROPIC_API_KEY: 'sk-ant-test-key' };
    }
    return {};
  }),
}));

const originalFetch = global.fetch;

describe('titleFromMessage', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('returns null for empty input without calling API', async () => {
    expect(await titleFromMessage('')).toBeNull();
    expect(await titleFromMessage('   ')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('extracts the title from Anthropic response', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'Skills vs agents in Claude' }],
      }),
    });
    expect(
      await titleFromMessage('чем отличаются скиллы от агентов в клоде'),
    ).toBe('Skills vs agents in Claude');
  });

  it('strips wrapping quotes and trailing punctuation', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '"Какие новые письма пришли?"' }],
      }),
    });
    expect(await titleFromMessage('есть новые письма?')).toBe(
      'Какие новые письма пришли',
    );
  });

  it('returns null when API responds non-ok', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => '{"error":{"message":"rate limit"}}',
    });
    expect(await titleFromMessage('сообщение')).toBeNull();
  });

  it('returns null when API throws (network error)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('ECONNRESET'),
    );
    expect(await titleFromMessage('сообщение')).toBeNull();
  });

  it('returns null when response has error field', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        error: { message: 'invalid request' },
      }),
    });
    expect(await titleFromMessage('сообщение')).toBeNull();
  });

  it('returns null when response has no text content', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [] }),
    });
    expect(await titleFromMessage('сообщение')).toBeNull();
  });

  it('passes content as the user message, not as system prompt', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'title' }] }),
    });
    await titleFromMessage('hello world');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages).toEqual([{ role: 'user', content: 'hello world' }]);
    expect(body.system).toBeTypeOf('string');
    expect(body.system).not.toContain('hello world');
  });

  it('truncates over-long model output through generateTopicTitle', async () => {
    // Model gave us a 200-char "title" — must be capped
    const long = 'word '.repeat(50).trim();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: long }] }),
    });
    const out = await titleFromMessage('whatever');
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(128);
  });

  it('sends x-api-key header when ANTHROPIC_API_KEY is present', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'x' }] }),
    });
    await titleFromMessage('hi');
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['x-api-key']).toBe('sk-ant-test-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });
});
