/**
 * Truncate a string by Unicode code points so that surrogate pairs are never
 * split. Plain `String.prototype.slice` operates on UTF-16 code units, which
 * can cut an emoji (e.g. 🐬 = high+low surrogate) in half and leave an orphan
 * high surrogate. When that string is later JSON-serialized and sent to the
 * Claude API the request fails with `invalid_request_error: no low surrogate
 * in string`.
 */
export function safeTruncate(s: string, maxCodePoints: number): string {
  if (s.length <= maxCodePoints) return s;
  const arr = Array.from(s);
  if (arr.length <= maxCodePoints) return s;
  return arr.slice(0, maxCodePoints).join('');
}
