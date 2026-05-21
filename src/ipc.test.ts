import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { runSweepOnce } from './ipc.js';

function makeIpcRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-sweep-test-'));
  fs.mkdirSync(path.join(root, 'g', 'media-requests'), { recursive: true });
  fs.mkdirSync(path.join(root, 'g', 'media-responses'), { recursive: true });
  fs.mkdirSync(path.join(root, 'g', 'errors'), { recursive: true });
  return root;
}

function setMtime(filePath: string, agoMs: number): void {
  const t = (Date.now() - agoMs) / 1000;
  fs.utimesSync(filePath, t, t);
}

describe('IPC sweep — runSweepOnce', () => {
  let ipcRoot: string;
  beforeEach(() => {
    ipcRoot = makeIpcRoot();
  });
  afterEach(() => {
    fs.rmSync(ipcRoot, { recursive: true, force: true });
  });

  it('does NOT touch errors/ directory', () => {
    const p = path.join(ipcRoot, 'g', 'errors', 'foo.json');
    fs.writeFileSync(p, '{}');
    setMtime(p, 3600_000); // 1 hour ago
    runSweepOnce(ipcRoot, 'g');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('.processing files older than 600s rename back to .json', () => {
    const orig = path.join(
      ipcRoot,
      'g',
      'media-requests',
      'req1.json.processing',
    );
    fs.writeFileSync(orig, '{"file_id":"X"}');
    setMtime(orig, 700_000);
    runSweepOnce(ipcRoot, 'g');
    expect(fs.existsSync(orig)).toBe(false);
    expect(
      fs.existsSync(path.join(ipcRoot, 'g', 'media-requests', 'req1.json')),
    ).toBe(true);
  });

  it('writes TIMEOUT response only when no response file exists (interlock)', () => {
    const reqPath = path.join(ipcRoot, 'g', 'media-requests', 'req2.json');
    fs.writeFileSync(reqPath, '{"file_id":"Y"}');
    setMtime(reqPath, 200_000);
    runSweepOnce(ipcRoot, 'g');
    const respPath = path.join(ipcRoot, 'g', 'media-responses', 'req2.json');
    expect(fs.existsSync(respPath)).toBe(true);
    const resp = JSON.parse(fs.readFileSync(respPath, 'utf-8'));
    expect(resp._meta.error_code).toBe('TIMEOUT');
    expect(fs.existsSync(reqPath)).toBe(false); // request unlinked
  });

  it('skips TIMEOUT-write when response already exists', () => {
    const reqPath = path.join(ipcRoot, 'g', 'media-requests', 'req3.json');
    const respPath = path.join(ipcRoot, 'g', 'media-responses', 'req3.json');
    fs.writeFileSync(reqPath, '{"file_id":"Z"}');
    fs.writeFileSync(
      respPath,
      '{"isError":false,"content":[{"type":"text","text":"ok"}]}',
    );
    setMtime(reqPath, 200_000);
    runSweepOnce(ipcRoot, 'g');
    const resp = JSON.parse(fs.readFileSync(respPath, 'utf-8'));
    expect(resp.isError).toBe(false); // pre-existing success response preserved
  });

  it('responses older than 180s unlinked unconditionally', () => {
    const p = path.join(ipcRoot, 'g', 'media-responses', 'old.json');
    fs.writeFileSync(p, '{}');
    setMtime(p, 200_000);
    runSweepOnce(ipcRoot, 'g');
    expect(fs.existsSync(p)).toBe(false);
  });
});
