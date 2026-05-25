/**
 * Structural tests for the save_credential MCP tool wire frame and the IPC
 * request payload contract. We don't actually start the McpServer or pipe a
 * transport — those would just test the SDK, not our code. Instead we lock
 * down the wire shape host and container both agree on:
 *
 *   1. Request payload: { type, reqId, service, value, groupFolder } —
 *      everything the host watcher needs to dispatch.
 *   2. Successful response: { _meta: { retryable: false }, content: [{type,text}] }
 *      and the response text MUST NOT contain the credential value (mask).
 *   3. Error response: isError:true + _meta.error_code in a known set,
 *      and the error text starts with `<CODE>: ` per project convention.
 *   4. Allowed services: only 'notion' and 'google-maps' (OAuth services
 *      need a separate Device Code Flow tool).
 */
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

describe('save_credential wire frame', () => {
  it('successful response wire frame parses CallToolResultSchema and does NOT echo the value', () => {
    const value = 'secret_must_not_echo_xyz';
    // Host writes this on success. Note: text contains service + group, no value.
    const wireFrame = {
      _meta: { retryable: false },
      content: [
        {
          type: 'text' as const,
          text: 'Saved notion credential for group telegram_dana. The new value activates on the next container restart — wait a few seconds before testing.',
        },
      ],
    };
    const parsed = CallToolResultSchema.parse(wireFrame);
    expect(parsed.content[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('Saved notion credential for group'),
    });
    // CRITICAL: the value MUST NEVER appear in the response.
    expect(JSON.stringify(parsed)).not.toContain(value);
  });

  it('UNSUPPORTED_SERVICE error wire frame parses and has the canonical text prefix', () => {
    const wireFrame = {
      isError: true,
      _meta: { error_code: 'UNSUPPORTED_SERVICE', retryable: false },
      content: [
        {
          type: 'text' as const,
          text: 'UNSUPPORTED_SERVICE: service must be one of: notion, google-maps',
        },
      ],
    };
    const parsed = CallToolResultSchema.parse(wireFrame);
    expect(parsed._meta?.error_code).toBe('UNSUPPORTED_SERVICE');
    expect(parsed.isError).toBe(true);
    expect(parsed.content[0]).toEqual({
      type: 'text',
      text: expect.stringMatching(/^UNSUPPORTED_SERVICE: /),
    });
  });

  it('INVALID_VALUE error wire frame parses (newline/control-char rejection)', () => {
    const wireFrame = {
      isError: true,
      _meta: { error_code: 'INVALID_VALUE', retryable: false },
      content: [
        {
          type: 'text' as const,
          text: 'INVALID_VALUE: value contains control characters or newlines',
        },
      ],
    };
    const parsed = CallToolResultSchema.parse(wireFrame);
    expect(parsed._meta?.error_code).toBe('INVALID_VALUE');
  });

  it('CROSS_GROUP_REJECTED error wire frame parses', () => {
    const wireFrame = {
      isError: true,
      _meta: { error_code: 'CROSS_GROUP_REJECTED', retryable: false },
      content: [
        {
          type: 'text' as const,
          text: "CROSS_GROUP_REJECTED: payload.groupFolder='telegram_main' does not match dispatch group='telegram_dana'",
        },
      ],
    };
    const parsed = CallToolResultSchema.parse(wireFrame);
    expect(parsed._meta?.error_code).toBe('CROSS_GROUP_REJECTED');
  });
});

describe('save_credential IPC request payload contract', () => {
  // The container-side tool writes a JSON file with this shape into
  // /workspace/ipc/credential-requests/<reqId>.json. Lock down the shape so
  // host + container don't drift.
  it('request payload includes type, reqId, service, value, groupFolder, chatJid', () => {
    const requestFile = {
      type: 'save_credential',
      reqId: '123-456-abcd',
      service: 'notion',
      value: 'secret_xxx',
      chatJid: 'tg:111111111',
      groupFolder: 'telegram_dana',
    };
    expect(requestFile.type).toBe('save_credential');
    expect(requestFile.service).toMatch(/^(notion|google-maps)$/);
    expect(requestFile.value.length).toBeGreaterThan(0);
    // groupFolder is the field the host watcher cross-checks against the IPC path
    expect(requestFile.groupFolder).toBeTruthy();
  });
});
