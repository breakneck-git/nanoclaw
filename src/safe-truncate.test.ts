import { describe, it, expect } from 'vitest';

import { safeTruncate } from './safe-truncate.js';

describe('safeTruncate', () => {
  it('returns the input when shorter than the limit', () => {
    expect(safeTruncate('hello', 10)).toBe('hello');
  });

  it('truncates ASCII at the requested code-point boundary', () => {
    expect(safeTruncate('abcdef', 3)).toBe('abc');
  });

  it('keeps a surrogate pair intact when the limit falls on it', () => {
    // 🐬 (U+1F42C) — one code point, two UTF-16 code units.
    // Naive .slice(0, 2) on "a🐬b" would leave an orphan high surrogate.
    expect(safeTruncate('a🐬b', 2)).toBe('a🐬');
  });

  it('drops a surrogate pair entirely when the limit excludes it', () => {
    expect(safeTruncate('a🐬b', 1)).toBe('a');
  });

  it('produces no orphan high surrogates regardless of cut point', () => {
    const s = 'prefix🐬🐬🐬tail';
    for (let n = 0; n <= Array.from(s).length; n++) {
      const out = safeTruncate(s, n);
      for (let i = 0; i < out.length; i++) {
        const code = out.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = out.charCodeAt(i + 1);
          expect(
            next >= 0xdc00 && next <= 0xdfff,
            `orphan high surrogate at i=${i} for n=${n} (out=${JSON.stringify(out)})`,
          ).toBe(true);
        }
      }
    }
  });
});
