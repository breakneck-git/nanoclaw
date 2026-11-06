import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('env module without a .env file', () => {
  const cwd = process.cwd();
  afterEach(() => process.chdir(cwd));

  // env.ts is the first module some entry points load (container-runtime.ts).
  // With no .env, readEnvFile logs — that must not hit an uninitialised
  // logger through an import cycle.
  it('loads first and returns {} for missing keys', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-noenv-'));
    process.chdir(dir);
    vi.resetModules();
    const env = await import('./env.js');
    expect(env.readEnvFile(['ASSISTANT_NAME'])).toEqual({});
  });
});
