/**
 * Tests for the container-side MCP whitelist filter (companion of the
 * host-side `enabled_mcp` column).
 *
 * The functions under test are pure (no I/O, no side effects), so we drive
 * them with synthetic inputs and assert on the filtered output. The
 * security-critical guarantees we lock in:
 *
 *   1. `null` whitelist means legacy / no restriction.
 *   2. Empty whitelist (`''`) is a lockdown signal, NOT "missing".
 *   3. `nanoclaw` is ALWAYS preserved when the input contains it.
 *   4. Unknown server names in the whitelist are not synthesized — only
 *      servers actually present in the input map can survive the filter.
 *   5. Allowed-tools filtering doesn't accidentally strip SDK built-ins.
 *
 * If you change the parser semantics, update the matching host-side test
 * in src/container-runner.test.ts so the seam stays in sync.
 */

import { describe, it, expect } from 'vitest';
import {
  ALWAYS_INCLUDED_MCP,
  filterAllowedToolPatterns,
  filterMcpServers,
  parseEnabledMcp,
} from './mcp-whitelist.js';

// ---------------------------------------------------------------------------
// parseEnabledMcp
// ---------------------------------------------------------------------------

describe('parseEnabledMcp', () => {
  it('returns null when env is undefined (legacy / no restriction)', () => {
    expect(parseEnabledMcp(undefined)).toBeNull();
  });

  it('returns null when env is literal "null" (defensive)', () => {
    expect(parseEnabledMcp('null')).toBeNull();
    expect(parseEnabledMcp('undefined')).toBeNull();
  });

  it('returns an empty Set for empty string (explicit lockdown)', () => {
    const s = parseEnabledMcp('');
    expect(s).not.toBeNull();
    expect(s!.size).toBe(0);
  });

  it('parses a single-entry whitelist', () => {
    const s = parseEnabledMcp('nanoclaw');
    expect(s).toEqual(new Set(['nanoclaw']));
  });

  it('parses multi-entry CSV with whitespace tolerance', () => {
    const s = parseEnabledMcp('nanoclaw, gmail ,notion ');
    expect(s).toEqual(new Set(['nanoclaw', 'gmail', 'notion']));
  });

  it('drops empty segments (e.g. trailing comma)', () => {
    const s = parseEnabledMcp('nanoclaw,,gmail,');
    expect(s).toEqual(new Set(['nanoclaw', 'gmail']));
  });
});

// ---------------------------------------------------------------------------
// filterMcpServers
// ---------------------------------------------------------------------------

describe('filterMcpServers', () => {
  const allServers = {
    nanoclaw: { command: 'node', args: ['mcp.js'] },
    gmail: { command: 'gmail-mcp' },
    notion: { command: 'notion-mcp' },
    'google-calendar': { command: 'gcal-mcp' },
    'google-maps': { command: 'gmaps-mcp' },
    'google-drive': { command: 'gdrive-mcp' },
  };

  it('returns the input unchanged when whitelist env is undefined', () => {
    const out = filterMcpServers(allServers, undefined);
    expect(Object.keys(out).sort()).toEqual(Object.keys(allServers).sort());
  });

  it('keeps ONLY nanoclaw when whitelist is empty string (lockdown)', () => {
    const out = filterMcpServers(allServers, '');
    expect(Object.keys(out)).toEqual(['nanoclaw']);
  });

  it('keeps nanoclaw + listed servers, drops the rest', () => {
    const out = filterMcpServers(allServers, 'gmail,notion');
    expect(Object.keys(out).sort()).toEqual(['gmail', 'nanoclaw', 'notion']);
    // The included server configs are passed through unchanged.
    expect(out.gmail).toBe(allServers.gmail);
  });

  it('drops main user MCP plugins when restricted user is in whitelist', () => {
    // Dana scenario: NANOCLAW_ENABLE_MCP=nanoclaw → only nanoclaw stays,
    // every Google/Notion server is dropped — proves the isolation seam.
    const out = filterMcpServers(allServers, 'nanoclaw');
    expect(Object.keys(out)).toEqual(['nanoclaw']);
    expect(out.gmail).toBeUndefined();
    expect(out.notion).toBeUndefined();
    expect(out['google-calendar']).toBeUndefined();
    expect(out['google-maps']).toBeUndefined();
    expect(out['google-drive']).toBeUndefined();
  });

  it('does not synthesize servers that are in the whitelist but not the input', () => {
    // Whitelist may legitimately mention a server the container doesn't
    // actually have configured. We don't conjure one.
    const partial = { nanoclaw: allServers.nanoclaw };
    const out = filterMcpServers(partial, 'gmail,nanoclaw');
    expect(Object.keys(out)).toEqual(['nanoclaw']);
  });

  it('preserves nanoclaw unconditionally even when not in whitelist', () => {
    // Lockdown safety — the agent loop is broken without nanoclaw, so we
    // always keep it (matches ALWAYS_INCLUDED_MCP contract).
    const out = filterMcpServers(allServers, 'gmail');
    expect(Object.keys(out).sort()).toEqual(['gmail', 'nanoclaw']);
  });

  it('ALWAYS_INCLUDED_MCP constant matches the implementation', () => {
    expect(ALWAYS_INCLUDED_MCP).toBe('nanoclaw');
  });
});

// ---------------------------------------------------------------------------
// filterAllowedToolPatterns
// ---------------------------------------------------------------------------

describe('filterAllowedToolPatterns', () => {
  const fullPatterns = [
    'Bash',
    'Read',
    'Write',
    'Edit',
    'mcp__nanoclaw__*',
    'mcp__gmail__*',
    'mcp__notion__*',
    'mcp__google-calendar__*',
    'mcp__google-maps__*',
    'mcp__google-drive__*',
  ];

  it('returns input unchanged when whitelist is undefined', () => {
    const out = filterAllowedToolPatterns(fullPatterns, undefined);
    expect(out).toEqual(fullPatterns);
  });

  it('keeps SDK built-ins regardless of whitelist (Bash/Read/etc.)', () => {
    const out = filterAllowedToolPatterns(fullPatterns, 'nanoclaw');
    expect(out).toContain('Bash');
    expect(out).toContain('Read');
    expect(out).toContain('Write');
    expect(out).toContain('Edit');
  });

  it('drops mcp__<name>__* patterns for servers not in whitelist', () => {
    const out = filterAllowedToolPatterns(fullPatterns, 'nanoclaw');
    expect(out).toContain('mcp__nanoclaw__*');
    expect(out).not.toContain('mcp__gmail__*');
    expect(out).not.toContain('mcp__notion__*');
    expect(out).not.toContain('mcp__google-calendar__*');
    expect(out).not.toContain('mcp__google-maps__*');
    expect(out).not.toContain('mcp__google-drive__*');
  });

  it('keeps mcp__<name>__* patterns for servers in whitelist', () => {
    const out = filterAllowedToolPatterns(fullPatterns, 'gmail,notion');
    expect(out).toContain('mcp__nanoclaw__*');
    expect(out).toContain('mcp__gmail__*');
    expect(out).toContain('mcp__notion__*');
    expect(out).not.toContain('mcp__google-calendar__*');
  });

  it('handles server names with hyphens correctly', () => {
    // 'google-calendar' has a hyphen; our regex must not break on it.
    const out = filterAllowedToolPatterns(
      ['mcp__google-calendar__*', 'mcp__gmail__*'],
      'google-calendar',
    );
    expect(out).toContain('mcp__google-calendar__*');
    expect(out).not.toContain('mcp__gmail__*');
  });

  it('returns mutable array (input must not be aliased)', () => {
    const out = filterAllowedToolPatterns(fullPatterns, undefined);
    expect(out).not.toBe(fullPatterns);
    out.push('test'); // mutating output must not mutate input
    expect(fullPatterns).not.toContain('test');
  });
});
