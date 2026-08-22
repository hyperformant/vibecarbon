/**
 * `vibecarbon create` must generate a name-specific logo (Space Grotesk
 * wordmark) into the new project, replacing the shipped Vibecarbon wordmark,
 * while leaving the hex icon untouched.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { destroyRealProject, realProject } from '../_harness/real-project';

const templateAsset = (name: string) =>
  readFileSync(join(process.cwd(), 'carbon/src/client/assets', name), 'utf8');

describe('create generates a name-specific logo', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) destroyRealProject(dir);
    dir = undefined;
  });

  it('replaces the Vibecarbon wordmark with a generated one and keeps the icon', () => {
    dir = realProject();
    const wordmark = readFileSync(join(dir, 'src/client/assets/logo-wordmark-dark.svg'), 'utf8');

    // Generation ran: the wordmark differs from the shipped Vibecarbon one and
    // carries our generator's fingerprint (fill="#ffffff"; the original is "white").
    expect(wordmark).not.toBe(templateAsset('logo-wordmark-dark.svg'));
    expect(wordmark).toContain('fill="#ffffff"');
    expect(wordmark).toMatch(/viewBox="0 0 [\d.]+ 1012"/);

    // The hex icon is left exactly as shipped.
    expect(readFileSync(join(dir, 'src/client/assets/logo-icon.svg'), 'utf8')).toBe(
      templateAsset('logo-icon.svg'),
    );
  });
});
