import { stripVTControlCharacters } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Guided-setup guides must render as a single bordered p.note() box:
// p.log.info('') draws a `●` gutter dot + spacer line per call in every
// @clack/prompts 1.x release, which turned the guides into dot spam. That
// rule, and the token and S3 credential flows, are pinned for every provider
// in tests/unit/providers/guided-setup-credentials.test.ts; this file pins
// what the Hetzner guides say.
const clackMock = await vi.hoisted(async () => {
  const { clackFake } = await import('../../_shared/clack-fake.js');
  return clackFake({ fns: ['note'], log: ['info'] });
});
vi.mock('@clack/prompts', () => clackMock);

import {
  displayApiTokenGuide,
  displayS3CredentialsGuide,
} from '../../../src/lib/hetzner-guided-setup.js';

const strip = (s: unknown) => stripVTControlCharacters(String(s));

describe('hetzner-guided-setup guides', () => {
  beforeEach(() => {
    clackMock.note.mockReset();
    clackMock.log.info.mockReset();
  });

  describe('displayApiTokenGuide', () => {
    it('renders exactly one note box with the token steps', () => {
      displayApiTokenGuide('my-project');

      expect(clackMock.note).toHaveBeenCalledTimes(1);
      const [body, title] = clackMock.note.mock.calls[0];
      expect(strip(title)).toContain('Hetzner API Token');
      const text = strip(body);
      expect(text).toContain('https://console.hetzner.cloud/');
      expect(text).toContain('my-project');
      expect(text).toContain('Read & Write');
      expect(text).toContain('Copy the token immediately');
    });

    it('falls back to placeholder names when projectName is missing', () => {
      displayApiTokenGuide(undefined);
      const text = strip(clackMock.note.mock.calls[0][0]);
      expect(text).toContain('your-project');
      expect(text).toContain('"vibecarbon-deploy"');
    });

    // B2a: every guide is pinned to at most 3 numbered steps, the exact
    // console.hetzner.cloud/projects deep link, and the dedicated-keys
    // practice line — mirrors cloudflare-guided-setup.test.ts's identical
    // pins (Cloudflare "already complies").
    it('has at most 3 numbered steps', () => {
      displayApiTokenGuide('my-project');
      const text = strip(clackMock.note.mock.calls[0][0]);
      for (const n of [1, 2, 3]) expect(text).toContain(`${n}.`);
      expect(text).not.toContain('4.');
    });

    it('pins the exact console.hetzner.cloud/projects deep link', () => {
      displayApiTokenGuide('my-project');
      const text = strip(clackMock.note.mock.calls[0][0]);
      expect(text).toContain('https://console.hetzner.cloud/projects');
    });

    it('ends with the dedicated-keys-per-project practice line', () => {
      displayApiTokenGuide('my-project');
      const text = strip(clackMock.note.mock.calls[0][0]).toLowerCase();
      expect(text).toContain('dedicated');
      expect(text).toContain('project');
    });
  });

  describe('displayS3CredentialsGuide', () => {
    it('renders exactly one note box including the Why-S3 rationale', () => {
      displayS3CredentialsGuide('my-project');

      expect(clackMock.note).toHaveBeenCalledTimes(1);
      const [body, title] = clackMock.note.mock.calls[0];
      expect(strip(title)).toContain('Object Storage');
      const text = strip(body);
      expect(text).toContain('S3 credentials');
      expect(text).toContain('"my-project-s3"');
      expect(text).toContain('Copy BOTH credentials immediately');
      expect(text).toContain('database backups and file uploads');
    });

    it('has at most 3 numbered steps', () => {
      displayS3CredentialsGuide('my-project');
      const text = strip(clackMock.note.mock.calls[0][0]);
      for (const n of [1, 2, 3]) expect(text).toContain(`${n}.`);
      expect(text).not.toContain('4.');
    });

    it('pins the exact console.hetzner.cloud/projects deep link', () => {
      displayS3CredentialsGuide('my-project');
      const text = strip(clackMock.note.mock.calls[0][0]);
      expect(text).toContain('https://console.hetzner.cloud/projects');
    });

    it('ends with the dedicated-keys-per-project practice line', () => {
      displayS3CredentialsGuide('my-project');
      const text = strip(clackMock.note.mock.calls[0][0]).toLowerCase();
      expect(text).toContain('dedicated');
      expect(text).toContain('project');
    });
  });
});
