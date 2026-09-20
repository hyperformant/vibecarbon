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
});
