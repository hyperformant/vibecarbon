import { stripVTControlCharacters } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// What the DigitalOcean guides say. That each guide is one note box and
// never p.log.info dot spam, and the token and Spaces credential flows, are
// pinned for every provider in
// tests/unit/providers/guided-setup-credentials.test.ts.
const clackMock = await vi.hoisted(async () => {
  const { clackFake } = await import('../../_shared/clack-fake.js');
  return clackFake({ fns: ['note'], log: ['info'] });
});
vi.mock('@clack/prompts', () => clackMock);

import {
  displayApiTokenGuide,
  displayS3CredentialsGuide,
} from '../../../src/lib/digitalocean-guided-setup.js';

const strip = (s: unknown) => stripVTControlCharacters(String(s));

// B2a: DO's guides were rewritten from the p.log.info() dot-spam pattern to
// a single p.note() box (mirrors hetzner/cloudflare-guided-setup.test.ts) —
// exported for the first time so this shape is directly testable.
describe('digitalocean-guided-setup guides', () => {
  beforeEach(() => {
    clackMock.note.mockReset();
    clackMock.log.info.mockReset();
  });

  describe('displayApiTokenGuide', () => {
    it('renders exactly one note box with the token steps', () => {
      displayApiTokenGuide('my-project');

      expect(clackMock.note).toHaveBeenCalledTimes(1);
      const [body, title] = clackMock.note.mock.calls[0];
      expect(strip(title)).toContain('DigitalOcean API Token');
      const text = strip(body);
      expect(text).toContain('https://cloud.digitalocean.com/account/api/tokens');
      expect(text).toContain('my-project');
      expect(text).toContain('Full Access');
      expect(text).toContain('Copy the token immediately');
    });

    it('has at most 3 numbered steps', () => {
      displayApiTokenGuide('my-project');
      const text = strip(clackMock.note.mock.calls[0][0]);
      for (const n of [1, 2, 3]) expect(text).toContain(`${n}.`);
      expect(text).not.toContain('4.');
    });

    it('ends with the dedicated-keys-per-project practice line', () => {
      displayApiTokenGuide('my-project');
      const text = strip(clackMock.note.mock.calls[0][0]).toLowerCase();
      expect(text).toContain('dedicated');
      expect(text).toContain('project');
    });

    it('step 1 creates the dedicated project and says deploy files resources into it', () => {
      displayApiTokenGuide('my-project');
      const text = strip(clackMock.note.mock.calls[0][0]);
      // Project creation still leads, but since ensureProjectAssignment
      // landed, deploy find-or-creates the project by the vibecarbon project
      // name and assigns droplets itself — the copy must promise exactly
      // that (name it to match, or let deploy create it), NOT the old
      // "set it as default" workaround.
      expect(text.indexOf('https://cloud.digitalocean.com/projects/new')).toBeGreaterThan(-1);
      expect(text.indexOf('https://cloud.digitalocean.com/projects/new')).toBeLessThan(
        text.indexOf('https://cloud.digitalocean.com/account/api/tokens'),
      );
      expect(text.toLowerCase()).toContain('automatically');
      expect(text.toLowerCase()).not.toContain('default');
    });

    it('tells the operator one token covers every environment', () => {
      displayApiTokenGuide('my-project');
      const text = strip(clackMock.note.mock.calls[0][0]).toLowerCase();
      // Verified behavior, not aspiration: the token is saved to .env.local
      // and resolved env-first on later deploys, and servers are name-scoped
      // `${projectName}-${environment}` (base.js) — so a second environment
      // needs no second token and never re-triggers this guide.
      expect(text).toContain('environment');
      expect(text).toContain('same token');
    });

    it('falls back to a placeholder name when projectName is missing', () => {
      displayApiTokenGuide(undefined);
      const text = strip(clackMock.note.mock.calls[0][0]);
      expect(text).toContain('"vibecarbon-deploy"');
    });
  });

  describe('displayS3CredentialsGuide (Spaces)', () => {
    it('renders exactly one note box pointing at the Spaces access-keys page', () => {
      displayS3CredentialsGuide('my-project');

      expect(clackMock.note).toHaveBeenCalledTimes(1);
      const [body, title] = clackMock.note.mock.calls[0];
      expect(strip(title)).toContain('Spaces');
      const text = strip(body);
      // Pinned URL: the console moved Spaces keys OUT of Applications & API.
      expect(text).toContain('https://cloud.digitalocean.com/spaces/access_keys');
      expect(text).toContain('Full Access');
      expect(text).toContain('Copy BOTH keys immediately');
    });

    it('includes the greyed-out "Create Access Key" gotcha', () => {
      displayS3CredentialsGuide('my-project');
      const text = strip(clackMock.note.mock.calls[0][0]).toLowerCase();
      expect(text).toContain('greyed out');
      expect(text).toContain('bucket');
    });

    it('has at most 3 numbered steps', () => {
      displayS3CredentialsGuide('my-project');
      const text = strip(clackMock.note.mock.calls[0][0]);
      for (const n of [1, 2, 3]) expect(text).toContain(`${n}.`);
      expect(text).not.toContain('4.');
    });

    it('ends with the dedicated-keys-per-project practice line', () => {
      displayS3CredentialsGuide('my-project');
      const text = strip(clackMock.note.mock.calls[0][0]).toLowerCase();
      expect(text).toContain('dedicated');
      expect(text).toContain('project');
    });
  });
});
