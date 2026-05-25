/**
 * Per-group MCP server whitelist (companion of the host-side `enabled_mcp`
 * column wired in `src/db.ts` + `src/container-runner.ts`).
 *
 * The host injects `NANOCLAW_ENABLE_MCP=<csv>` into the container env when a
 * restricted group runs. This module is the container-side translation:
 *
 *   - `parseEnabledMcp(env)` — turn the raw env value into a Set or null
 *     (null === "no restriction", legacy behavior). The empty string is
 *     legitimately distinct from null: it means "only the always-included
 *     `nanoclaw` server", which is the strictest available whitelist short
 *     of disabling MCP entirely (and the agent loop needs nanoclaw to talk
 *     to the host, so it's not optional).
 *
 *   - `filterMcpServers(servers, env)` — apply the whitelist to a
 *     `mcpServers` map. `nanoclaw` is preserved unconditionally; everything
 *     else is kept only if its name appears in the whitelist.
 *
 *   - `filterAllowedToolPatterns(patterns, env)` — apply the whitelist to
 *     the `allowedTools` array. We drop `mcp__<name>__*` patterns whose
 *     server name isn't in the whitelist, so the SDK doesn't expose ghost
 *     tool surfaces (and the user-facing tool list reflects reality). Non
 *     -MCP patterns (`Bash`, `Read`, raw built-ins) are kept as-is.
 *
 * The split into a small module + unit tests is deliberate: the full
 * `runQuery` function is huge and hard to test end-to-end (it spawns
 * child processes and runs an MCP server). Pure functions for the filter
 * logic make the security-critical seam covered.
 */

/** Always-included MCP server — the agent talks to the host through this. */
export const ALWAYS_INCLUDED_MCP = 'nanoclaw';

/**
 * Parse the raw env var into one of three states:
 *   - `null`               → no restriction (legacy behavior)
 *   - `Set<string>` (size 0)  → lockdown (only ALWAYS_INCLUDED_MCP retained)
 *   - `Set<string>` (size >0) → whitelist of additional server names
 *
 * Returns `null` (no restriction) when the env is `undefined`, missing, or
 * the literal `'null'` (defensive against environments that stringify the
 * value en route). Empty string is the explicit lockdown signal, NOT
 * "missing" — the host writes literal empty string when `enabledMcp = []`.
 */
export function parseEnabledMcp(env: string | undefined): Set<string> | null {
  if (env === undefined) return null;
  // Treat 'null'/'undefined' as legacy too (defensive — some shells stringify
  // unset env vars on inheritance). Distinct from '' which is "lockdown".
  if (env === 'null' || env === 'undefined') return null;
  const parts = env
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return new Set(parts);
}

/**
 * Apply the MCP server whitelist to the `mcpServers` map handed to
 * `query({ options: { mcpServers } })`. The key shape mirrors what the SDK
 * expects (server name → config object). We never mutate `servers`.
 *
 * When `whitelist === null`, the map is returned unchanged (legacy).
 *
 * When `whitelist !== null`, the output contains:
 *   - `ALWAYS_INCLUDED_MCP` (if present in the input) — unconditional.
 *     If it's missing from the input, we don't synthesize it; that would
 *     hide a configuration error from the caller.
 *   - Every entry whose name appears in `whitelist`.
 *
 * The implementation uses `Object.fromEntries` (faster than for-loop on
 * any V8 we've ever seen, and easier to read).
 */
export function filterMcpServers<T>(
  servers: Record<string, T>,
  env: string | undefined,
): Record<string, T> {
  const whitelist = parseEnabledMcp(env);
  if (whitelist === null) return servers;
  return Object.fromEntries(
    Object.entries(servers).filter(
      ([name]) => name === ALWAYS_INCLUDED_MCP || whitelist.has(name),
    ),
  );
}

/**
 * Apply the MCP server whitelist to an `allowedTools` array.
 *
 * Tool patterns look like `mcp__<name>__*` for MCP-routed tools and like
 * `Bash` / `Read` / `Write` (no underscore prefix) for SDK built-ins. We
 * only filter the MCP-routed ones — built-ins pass through untouched.
 *
 * Cosmetic: the SDK would refuse to dispatch a call to a missing server
 * anyway, so leaving these patterns in `allowedTools` is not a security
 * leak; we filter them so `/tools` listings show the same set the user
 * actually has access to (and reduce model confusion about what's
 * available).
 *
 * The regex anchors the prefix to avoid matching anything weird like
 * `mcp__foo__bar` where `foo` happens to be the substring of a whitelisted
 * server name. `mcp__nanoclaw__*` is unconditionally allowed.
 */
const MCP_PATTERN_RE = /^mcp__([^_]+(?:_[^_]+)*)__/;

export function filterAllowedToolPatterns(
  patterns: readonly string[],
  env: string | undefined,
): string[] {
  const whitelist = parseEnabledMcp(env);
  if (whitelist === null) return [...patterns];
  return patterns.filter((p) => {
    const m = MCP_PATTERN_RE.exec(p);
    if (!m) return true; // built-in, e.g. 'Bash' — keep
    const serverName = m[1];
    return serverName === ALWAYS_INCLUDED_MCP || whitelist.has(serverName);
  });
}
