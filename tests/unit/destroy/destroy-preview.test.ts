/**
 * The destroy preview must not claim resources exist when the only evidence is
 * a name in .vibecarbon.json.
 *
 * RCA (excitingai, 2026-10-16): the deploy saved its skeleton env entry (bucket
 * names, deploy mode) BEFORE creating anything, on purpose, so destroy can
 * always find what a failed deploy may have left behind. The deploy then
 * failed at its first S3 call. The preview listed the SSH key (a name it
 * prints unconditionally) and the storage bucket as things that "will be
 * permanently deleted"; neither existed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { destroyPreviewBody, readS3SetupCompleted } from '../../../src/lib/destroy/preview.js';

const strip = (s: string) =>
  s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');

const SKELETON = {
  envName: 'prod',
  status: 'deploying',
  deployMode: 'compose',
  provider: 'hetzner',
  region: 'hil',
  s3: { bucket: 'excitingai-88d16c-prod-storage', region: 'fsn1' },
  backupS3: { bucket: 'excitingai-88d16c-backups', region: 'fsn1' },
};

describe('destroyPreviewBody', () => {
  it('labels what a stopped deploy only recorded as "may not exist"', () => {
    const body = strip(
      destroyPreviewBody({
        envConfig: SKELETON,
        projectName: 'excitingai',
        envName: 'prod',
        purgeBackups: false,
        s3SetupCompleted: false,
      }),
    );
    expect(body).toMatch(/excitingai-prod .*may not exist/);
    expect(body).toMatch(
      /excitingai-88d16c-prod-storage \(kept; deleted with -purge\) .*may not exist/,
    );
    expect(body).toMatch(/excitingai-88d16c-backups .*may not exist/);
    expect(body).toContain('Destroy checks each one and skips what is already gone');
  });

  it('lists a finished deploy plainly, with no "may not exist" caveat', () => {
    const body = strip(
      destroyPreviewBody({
        envConfig: {
          ...SKELETON,
          status: 'deployed',
          servers: [{ name: 'excitingai-prod', ip: '203.0.113.7' }],
        },
        projectName: 'excitingai',
        envName: 'prod',
        purgeBackups: false,
        s3SetupCompleted: true,
      }),
    );
    expect(body).not.toContain('may not exist');
    expect(body).toContain('excitingai-prod (203.0.113.7)');
    expect(body).toContain('Bucket: excitingai-88d16c-prod-storage (kept; deleted with -purge)');
    expect(body).not.toContain('all objects will be deleted');
  });

  it('trusts the buckets once the S3 step completed, even if a later step failed', () => {
    const body = strip(
      destroyPreviewBody({
        envConfig: SKELETON,
        projectName: 'excitingai',
        envName: 'prod',
        purgeBackups: false,
        s3SetupCompleted: true,
      }),
    );
    expect(body).not.toMatch(/prod-storage .*may not exist/);
    expect(body).toMatch(/excitingai-prod .*may not exist/);
  });
});

describe('destroyPreviewBody app bucket under -purge', () => {
  it('says the environment’s own bucket will be deleted', () => {
    const body = strip(
      destroyPreviewBody({
        envConfig: { ...SKELETON, status: 'deployed' },
        projectName: 'excitingai',
        envName: 'prod',
        purgeBackups: true,
        s3SetupCompleted: true,
      }),
    );
    expect(body).toContain(
      'Bucket: excitingai-88d16c-prod-storage (WILL BE DELETED, because you passed -purge)',
    );
    expect(body).not.toContain('kept; deleted with -purge');
  });
});

describe('readS3SetupCompleted', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the deploy-state record of the S3 step', () => {
    dir = mkdtempSync(join(tmpdir(), 'vc-preview-'));
    expect(readS3SetupCompleted(dir, 'prod')).toBe(false);
    mkdirSync(join(dir, '.vibecarbon'));
    writeFileSync(
      join(dir, '.vibecarbon', 'deploy-state-prod.json'),
      JSON.stringify({ version: 2, steps: { 's3-setup': { status: 'started' } } }),
    );
    expect(readS3SetupCompleted(dir, 'prod')).toBe(false);
    writeFileSync(
      join(dir, '.vibecarbon', 'deploy-state-prod.json'),
      JSON.stringify({ version: 2, steps: { 's3-setup': { status: 'completed' } } }),
    );
    expect(readS3SetupCompleted(dir, 'prod')).toBe(true);
  });
});
