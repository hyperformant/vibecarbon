#!/usr/bin/env node
/**
 * Regenerate the command and flag docs from each command's SPEC.
 * Usage: pnpm docs:cli
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOC_TARGETS, generateAll } from '../src/lib/cli/docs-gen.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const current = new Map(DOC_TARGETS.map((p) => [p, readFileSync(join(root, p), 'utf-8')]));
let next;
try {
  next = await generateAll(current);
} catch (err) {
  console.error(`docs:cli failed: ${err.message}`);
  process.exit(1);
}

for (const [path, text] of next) {
  if (text === current.get(path)) {
    console.log(`up to date  ${path}`);
  } else {
    writeFileSync(join(root, path), text);
    console.log(`updated     ${path}`);
  }
}
