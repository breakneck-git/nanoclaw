#!/usr/bin/env node
/**
 * Repair Claude Agent SDK transcripts that contain orphan UTF-16 high
 * surrogates (escaped as "\uD8XX..\uDBXX" without a following
 * "\uDCXX..\uDFXX"). Those slip into the conversation history when a
 * tool result truncates a string with `.slice()` mid-emoji. On the next
 * resume the SDK ships the broken JSON to Claude and gets back:
 *
 *   API Error: 400 invalid_request_error:
 *     The request body is not valid JSON: no low surrogate in string
 *
 * Usage:
 *   node scripts/scrub-orphan-surrogates.mjs <file.jsonl> [<file.jsonl> ...]
 *
 * Each orphan high-surrogate escape is rewritten to � (replacement char).
 * Backups are written next to each file as `<file>.bak-<timestamp>`.
 * Files without orphan surrogates are left untouched.
 */
import fs from 'node:fs';

const ORPHAN_HIGH_SURROGATE_ESCAPE =
  /\\u(d[89ab][0-9a-f]{2})(?!\\u(d[cdef][0-9a-f]{2}))/gi;
const ORPHAN_LOW_SURROGATE_ESCAPE =
  /(?<!\\u(d[89ab][0-9a-f]{2}))\\u(d[cdef][0-9a-f]{2})/gi;

function scrubFile(file) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    console.error(`SKIP ${file}: ${err.message}`);
    return;
  }

  const orphanHigh = (content.match(ORPHAN_HIGH_SURROGATE_ESCAPE) || []).length;
  const orphanLow = (content.match(ORPHAN_LOW_SURROGATE_ESCAPE) || []).length;

  if (orphanHigh === 0 && orphanLow === 0) {
    console.log(`OK   ${file}: no orphan surrogates`);
    return;
  }

  const backup = `${file}.bak-${Date.now()}`;
  fs.copyFileSync(file, backup);

  const patched = content
    .replace(ORPHAN_HIGH_SURROGATE_ESCAPE, '\\ufffd')
    .replace(ORPHAN_LOW_SURROGATE_ESCAPE, '\\ufffd');

  fs.writeFileSync(file, patched);
  console.log(
    `FIX  ${file}: high=${orphanHigh} low=${orphanLow} (backup: ${backup})`,
  );
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: scrub-orphan-surrogates.mjs <file.jsonl> [...]');
  process.exit(1);
}

for (const f of files) scrubFile(f);
