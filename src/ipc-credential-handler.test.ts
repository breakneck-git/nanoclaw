/**
 * Host-side `save_credential` IPC handler tests.
 *
 * The handler writes per-group env files at data/env/<folder>.env with mode
 * 0600. Container restarts pick up the new value on next start. Security
 * invariants tested here:
 *   1. Value is NEVER logged (NOTHING in the log args contains the value).
 *   2. File is written with mode 0600 (atomic temp+rename).
 *   3. Updating an existing file replaces the matching key, preserves others.
 *   4. Unsupported service returns UNSUPPORTED_SERVICE error.
 *   5. Malformed value (newlines, special chars) returns INVALID_VALUE error.
 *   6. Cross-group reject when payload.groupFolder mismatches dispatch group.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock logger BEFORE importing the handler so we capture log calls.
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock config so DATA_DIR points at the test temp root we set up per-test.
// The handler reads DATA_DIR via static import, so we control it via the
// CWD-derived default and reset before each test.
let tmpDataDir: string;
vi.mock('./config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config.js')>();
  return {
    ...actual,
    // DATA_DIR is dynamically resolved per-test via a getter.
    get DATA_DIR() {
      return tmpDataDir;
    },
  };
});

import { logger } from './logger.js';
import {
  handleSaveCredentialRequest,
  processSaveCredential,
} from './ipc-credential-handler.js';

function freshDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'credential-handler-'));
}

describe('processSaveCredential', () => {
  beforeEach(() => {
    tmpDataDir = freshDataDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it('writes a new env file with NOTION_API_KEY when none exists', () => {
    const resp = processSaveCredential({
      reqId: 'r1',
      service: 'notion',
      value: 'secret_notiontoken_123',
      groupFolder: 'telegram_dana',
    });

    expect(resp.isError).toBeFalsy();
    const envPath = path.join(tmpDataDir, 'env', 'telegram_dana.env');
    expect(fs.existsSync(envPath)).toBe(true);
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('NOTION_API_KEY=secret_notiontoken_123');
  });

  it('writes google-maps key under GOOGLE_MAPS_API_KEY', () => {
    const resp = processSaveCredential({
      reqId: 'r2',
      service: 'google-maps',
      value: 'AIzaSyDxxxxxx',
      groupFolder: 'telegram_dana',
    });

    expect(resp.isError).toBeFalsy();
    const content = fs.readFileSync(
      path.join(tmpDataDir, 'env', 'telegram_dana.env'),
      'utf-8',
    );
    expect(content).toContain('GOOGLE_MAPS_API_KEY=AIzaSyDxxxxxx');
  });

  it('updates an existing env file: replaces matching key, preserves other keys', () => {
    const envDir = path.join(tmpDataDir, 'env');
    fs.mkdirSync(envDir, { recursive: true });
    const envPath = path.join(envDir, 'telegram_dana.env');
    fs.writeFileSync(
      envPath,
      'NOTION_API_KEY=old_value\nGOOGLE_MAPS_API_KEY=keep_me\n',
      { mode: 0o600 },
    );

    processSaveCredential({
      reqId: 'r3',
      service: 'notion',
      value: 'new_value',
      groupFolder: 'telegram_dana',
    });

    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('NOTION_API_KEY=new_value');
    expect(content).not.toContain('NOTION_API_KEY=old_value');
    expect(content).toContain('GOOGLE_MAPS_API_KEY=keep_me');
  });

  it('written file has mode 0600 (owner-only read/write)', () => {
    processSaveCredential({
      reqId: 'r4',
      service: 'notion',
      value: 'secret_xxx',
      groupFolder: 'telegram_dana',
    });

    const envPath = path.join(tmpDataDir, 'env', 'telegram_dana.env');
    const mode = fs.statSync(envPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('returns UNSUPPORTED_SERVICE error for unknown service', () => {
    const resp = processSaveCredential({
      reqId: 'r5',
      // @ts-expect-error — intentionally violating the type for test
      service: 'pagerduty',
      value: 'anything',
      groupFolder: 'telegram_dana',
    });

    expect(resp.isError).toBe(true);
    expect(resp._meta.error_code).toBe('UNSUPPORTED_SERVICE');
    expect(resp._meta.retryable).toBe(false);
    expect(resp.content[0].text).toContain('UNSUPPORTED_SERVICE');
  });

  it('rejects values containing newlines (env-file corruption guard)', () => {
    const resp = processSaveCredential({
      reqId: 'r6',
      service: 'notion',
      value: 'has\nnewline_break',
      groupFolder: 'telegram_dana',
    });

    expect(resp.isError).toBe(true);
    expect(resp._meta.error_code).toBe('INVALID_VALUE');
    // Confirm no file was written despite the call.
    const envPath = path.join(tmpDataDir, 'env', 'telegram_dana.env');
    expect(fs.existsSync(envPath)).toBe(false);
  });

  it('rejects empty values', () => {
    const resp = processSaveCredential({
      reqId: 'r7',
      service: 'notion',
      value: '',
      groupFolder: 'telegram_dana',
    });

    expect(resp.isError).toBe(true);
    expect(resp._meta.error_code).toBe('INVALID_VALUE');
  });

  it('NEVER logs the credential value (mask check across all log levels)', () => {
    const secret = 'secret_THIS_MUST_NEVER_LEAK_xyz123';
    processSaveCredential({
      reqId: 'r8',
      service: 'notion',
      value: secret,
      groupFolder: 'telegram_dana',
    });

    const allLogCalls = [
      ...vi.mocked(logger.debug).mock.calls,
      ...vi.mocked(logger.info).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
      ...vi.mocked(logger.error).mock.calls,
    ];
    for (const call of allLogCalls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(secret);
    }
  });

  it('response text does NOT echo the credential value', () => {
    const secret = 'secret_DO_NOT_ECHO_token';
    const resp = processSaveCredential({
      reqId: 'r9',
      service: 'notion',
      value: secret,
      groupFolder: 'telegram_dana',
    });
    expect(JSON.stringify(resp)).not.toContain(secret);
  });

  it('rejects payload when payload.groupFolder is invalid (path traversal guard)', () => {
    const resp = processSaveCredential({
      reqId: 'r10',
      service: 'notion',
      value: 'secret_xxx',
      groupFolder: '../etc/passwd',
    });
    expect(resp.isError).toBe(true);
    expect(resp._meta.error_code).toBe('INVALID_GROUP_FOLDER');
    // Confirm no file was written outside data/env/
    const escapedPath = path.join(tmpDataDir, 'env', '..', 'etc', 'passwd.env');
    expect(fs.existsSync(escapedPath)).toBe(false);
  });

  it('writes atomically via temp file + rename', () => {
    const renameSpy = vi.spyOn(fs, 'renameSync');
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    try {
      processSaveCredential({
        reqId: 'r11',
        service: 'notion',
        value: 'secret_atomic_test',
        groupFolder: 'telegram_dana',
      });
      // writeFileSync was called on a *.tmp.<pid> path
      const tmpWrite = writeSpy.mock.calls.find(([p]) =>
        /\.tmp\.\d+$/.test(String(p)),
      );
      expect(tmpWrite).toBeDefined();
      // renameSync moved it to the final path
      const finalRename = renameSpy.mock.calls.find(([, to]) =>
        String(to).endsWith(
          path.join('env', 'telegram_dana.env'),
        ),
      );
      expect(finalRename).toBeDefined();
    } finally {
      writeSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  it('auto-creates data/env/ when it does not exist', () => {
    // Fresh dir: no env/ subdir
    expect(
      fs.existsSync(path.join(tmpDataDir, 'env')),
    ).toBe(false);

    processSaveCredential({
      reqId: 'r12',
      service: 'notion',
      value: 'secret_mkdir_test',
      groupFolder: 'telegram_dana',
    });

    expect(fs.existsSync(path.join(tmpDataDir, 'env'))).toBe(true);
  });
});

describe('handleSaveCredentialRequest (file-driven)', () => {
  let ipcRoot: string;

  beforeEach(() => {
    tmpDataDir = freshDataDir();
    ipcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-ipc-'));
    fs.mkdirSync(
      path.join(ipcRoot, 'telegram_dana', 'credential-requests'),
      { recursive: true },
    );
    fs.mkdirSync(
      path.join(ipcRoot, 'telegram_dana', 'credential-responses'),
      { recursive: true },
    );
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    fs.rmSync(ipcRoot, { recursive: true, force: true });
  });

  it('reads request, writes per-group env file, writes response, unlinks request', async () => {
    const reqPath = path.join(
      ipcRoot,
      'telegram_dana',
      'credential-requests',
      'req1.json',
    );
    fs.writeFileSync(
      reqPath,
      JSON.stringify({
        reqId: 'req1',
        service: 'notion',
        value: 'secret_handler_test',
        groupFolder: 'telegram_dana',
      }),
    );

    await handleSaveCredentialRequest(ipcRoot, 'telegram_dana', 'req1');

    // Per-group env file written under DATA_DIR
    const envPath = path.join(tmpDataDir, 'env', 'telegram_dana.env');
    expect(fs.existsSync(envPath)).toBe(true);
    expect(fs.readFileSync(envPath, 'utf-8')).toContain(
      'NOTION_API_KEY=secret_handler_test',
    );
    // Response written under ipcRoot
    const respPath = path.join(
      ipcRoot,
      'telegram_dana',
      'credential-responses',
      'req1.json',
    );
    expect(fs.existsSync(respPath)).toBe(true);
    // Request unlinked
    expect(fs.existsSync(reqPath)).toBe(false);
  });

  it('CROSS_GROUP_REJECTED when payload.groupFolder mismatches dispatch group', async () => {
    const reqPath = path.join(
      ipcRoot,
      'telegram_dana',
      'credential-requests',
      'attack.json',
    );
    fs.writeFileSync(
      reqPath,
      JSON.stringify({
        reqId: 'attack',
        service: 'notion',
        value: 'secret_attack',
        // Agent claims to be main, but request file is in telegram_dana's
        // namespace. The handler must REJECT and write nothing.
        groupFolder: 'telegram_main',
      }),
    );

    await handleSaveCredentialRequest(ipcRoot, 'telegram_dana', 'attack');

    // No env file was written for EITHER group
    expect(
      fs.existsSync(path.join(tmpDataDir, 'env', 'telegram_dana.env')),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(tmpDataDir, 'env', 'telegram_main.env')),
    ).toBe(false);

    // Response carries CROSS_GROUP_REJECTED
    const respPath = path.join(
      ipcRoot,
      'telegram_dana',
      'credential-responses',
      'attack.json',
    );
    const resp = JSON.parse(fs.readFileSync(respPath, 'utf-8'));
    expect(resp.isError).toBe(true);
    expect(resp._meta.error_code).toBe('CROSS_GROUP_REJECTED');
  });
});
