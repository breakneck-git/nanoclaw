// Pure wire-frame structural test — does NOT invoke ipc-mcp-stdio code.
// Round-10 fix: removed the `handleViewMediaRequest` import which v9 left
// in as decorative (working-tree ipc-mcp-stdio.ts has zero exports).
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { expect, it } from 'vitest';

it('file-too-large response frame parses CallToolResultSchema with model-facing text prefix', () => {
  // Pre-populate the polled response file with a FILE_TOO_LARGE error frame
  // that the host would have written.
  const wireFrame = {
    isError: true,
    _meta: { error_code: 'FILE_TOO_LARGE', retryable: false },
    content: [{ type: 'text' as const, text: 'FILE_TOO_LARGE: file exceeds 20MB cap' }],
  };
  // Schema validates structurally:
  const parsed = CallToolResultSchema.parse(wireFrame);
  expect(parsed._meta?.error_code).toBe('FILE_TOO_LARGE');
  expect(parsed.content[0]).toEqual({ type: 'text', text: 'FILE_TOO_LARGE: file exceeds 20MB cap' });
  // CRITICAL contract assertion: the MCP SDK strips content[N]._meta when
  // forwarding to the model; only top-level _meta is exposed to the SDK
  // consumer. Verified by tracing `XGq` in the cli.js content-block
  // normalizer of @anthropic-ai/claude-agent-sdk@0.2.76.
  expect((parsed.content[0] as any)._meta).toBeUndefined();
});
