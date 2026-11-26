/**
 * The compose deploy's "How would you like to deploy?" prompt says what
 * push mode does now: GitHub Actions builds the app image, and the deploy
 * has the server pull it. The workflow never deploys (it is the only one
 * vibecarbon installs, and it only builds), so a hint that says GitHub
 * Actions deploys sends the operator looking for a deploy run that never
 * comes.
 */
import { describe, expect, it } from 'vitest';
import { readRepoFile } from '../../_shared/source-files.js';

/** The `hint` of the prompt option with this value, as the source spells it. */
function hintOf(value: string): string {
  const src = readRepoFile('src/lib/deploy/prompts.js');
  const at = src.indexOf(
    `value: '${value}',`,
    src.indexOf("message: 'How would you like to deploy?'"),
  );
  expect(at, value).toBeGreaterThan(-1);
  const m = src.slice(at, at + 300).match(/hint: '([^']*)'/);
  expect(m, value).not.toBeNull();
  return m?.[1] ?? '';
}

describe('the push build mode says what it does', () => {
  it('GitHub Actions builds the image and the server pulls it; nothing says Actions deploys', () => {
    const hint = hintOf('push');
    expect(hint).toBe('GitHub Actions builds the image, then the server pulls it (~3 min)');
    expect(hint).not.toMatch(/deploy/i);
  });
});
