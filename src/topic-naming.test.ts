import { describe, it, expect } from 'vitest';
import { generateTopicTitle } from './topic-naming.js';

describe('generateTopicTitle', () => {
  it('returns null for empty input', () => {
    expect(generateTopicTitle('')).toBeNull();
    expect(generateTopicTitle('   ')).toBeNull();
    expect(generateTopicTitle('\n\n')).toBeNull();
  });

  it('returns null when only a trigger prefix is present', () => {
    expect(generateTopicTitle('@Andy ')).toBeNull();
    expect(generateTopicTitle('@andy_bot   ')).toBeNull();
  });

  it('passes through short messages verbatim', () => {
    expect(generateTopicTitle('есть новые письма?')).toBe('есть новые письма?');
  });

  it('strips leading @mention trigger', () => {
    expect(generateTopicTitle('@Andy чем отличаются скиллы от агентов')).toBe(
      'чем отличаются скиллы от агентов',
    );
  });

  it('collapses newlines and tabs into single spaces', () => {
    expect(generateTopicTitle('line1\n\nline2\tend')).toBe('line1 line2 end');
  });

  it('truncates long messages at a word boundary near 64 chars', () => {
    const long =
      'а это очень длинное сообщение которое должно быть обрезано на границе слова и закончиться многоточием';
    const out = generateTopicTitle(long);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(65);
    expect(out).toMatch(/…$/);
    // Should not split a word — last char before ellipsis must not be a partial word
    // (i.e. the original message had a space right before our cut point)
    const beforeEllipsis = out!.slice(0, -1); // strip the ellipsis
    expect(
      long.startsWith(beforeEllipsis + ' ') || long === beforeEllipsis,
    ).toBe(true);
  });

  it('hard-cuts when no good word boundary in the back half', () => {
    // 100-char string with no spaces at all — must still produce ≤65 chars
    const noSpaces = 'a'.repeat(100);
    const out = generateTopicTitle(noSpaces);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(65);
    expect(out).toMatch(/…$/);
  });

  it('respects Telegram hard limit of 128 chars', () => {
    // Even at extremes the result must never exceed 128 chars
    const huge = 'word '.repeat(200);
    const out = generateTopicTitle(huge);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(128);
  });

  it('preserves emoji and Cyrillic', () => {
    expect(generateTopicTitle('Купить молоко 🥛 завтра')).toBe(
      'Купить молоко 🥛 завтра',
    );
  });
});
