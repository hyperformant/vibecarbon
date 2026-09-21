import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { parse as dotenvParse } from 'dotenv';
import { expand } from 'dotenv-expand';
import { describe, expect, it } from 'vitest';
import { dotenvValueProblem, formatDotenvLine } from '../../../src/lib/dotenv.js';
import { ORACLE_VALUES, REFUSED_VALUES } from '../../fixtures/dotenv-oracle-values.js';

// Synthetic values only. Every accepted value must read back identically from
// Node, dotenv and dotenv-expand; refused values must be refused. The Compose
// leg of the same oracle lives in tests/integration/docker/dotenv-compose-oracle.test.ts.
const text = Object.entries(ORACLE_VALUES)
  .map(([k, v]) => formatDotenvLine(k, v))
  .join('\n');

describe('dotenv oracle: Node, dotenv, dotenv-expand read the writer identically', () => {
  it('util.parseEnv', () => {
    expect(parseEnv(text)).toEqual(ORACLE_VALUES);
  });
  it('dotenv.parse', () => {
    expect(dotenvParse(text)).toEqual(ORACLE_VALUES);
  });
  it('dotenv-expand (what Vite applies)', () => {
    // Vite reads only VITE_* keys, where the writer refuses "$". Under any
    // other key dotenv-expand still expands "$HOME"; that key is excluded
    // here and the divergence is the documented reason for the refusal.
    const { DOLLAR: _skip, ...viteVisible } = ORACLE_VALUES;
    const parsed = dotenvParse(text);
    const expanded = expand({ parsed: { ...parsed }, processEnv: {} }).parsed ?? {};
    for (const [k, v] of Object.entries(viteVisible)) expect(expanded[k]).toBe(v);
  });
  it('refuses the unrepresentable set', () => {
    for (const [k, v] of Object.entries(REFUSED_VALUES)) {
      const key = k === 'VITE_DOLLAR' ? 'VITE_PUBLIC_URL' : k;
      expect(dotenvValueProblem(key, v), k).not.toBeNull();
    }
  });
  it('the template .env.example header states the VITE_* "$" rule the hand-editor needs', () => {
    // The header tells users to single-quote "$" — exactly what is refused for
    // VITE_* keys (dotenv-expand expands "$" inside single quotes too), so
    // the exception has to be stated beside the rule.
    const header = readFileSync(
      join(import.meta.dirname, '../../../carbon/.env.example'),
      'utf-8',
    ).slice(0, 800);
    expect(header).toMatch(
      /Never put \$ in a VITE_\* value: Vite expands it in the browser build\./,
    );
  });
});
