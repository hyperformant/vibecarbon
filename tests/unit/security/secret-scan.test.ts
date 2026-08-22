import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  refuseIfSecretsPresent,
  SECRET_RULES,
  scanContent,
  scanTree,
} from '../../../src/lib/secret-scan.js';

describe('secret-scan', () => {
  describe('AWS', () => {
    it('flags AWS access keys', () => {
      const f = scanContent('export AWS_KEY="AKIAIOSFODNN7EXAMPLE"');
      expect(f.some((x) => x.ruleId === 'aws-access-key')).toBe(true);
    });

    it('flags AWS secret access key when assigned to a familiar name', () => {
      const f = scanContent('aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"');
      expect(f.some((x) => x.ruleId === 'aws-secret-key')).toBe(true);
    });
  });

  describe('GitHub', () => {
    it('flags personal access tokens (ghp_)', () => {
      const f = scanContent('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789');
      expect(f.some((x) => x.ruleId === 'github-pat')).toBe(true);
    });

    it('flags fine-grained PATs (ghs_)', () => {
      const f = scanContent('token: ghs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(f.some((x) => x.ruleId === 'github-pat')).toBe(true);
    });
  });

  describe('Stripe', () => {
    it('flags live keys', () => {
      const f = scanContent('STRIPE_SECRET=sk_live_51HxY5QH0FvW9aBcDeFgHiJkLmNoPqRsT');
      expect(f.some((x) => x.ruleId === 'stripe-live-key')).toBe(true);
    });

    it('flags test keys (still sensitive)', () => {
      const f = scanContent('STRIPE_SECRET=sk_test_51HxY5QH0FvW9aBcDeFgHiJkLmNoPqRsT');
      expect(f.some((x) => x.ruleId === 'stripe-test-key')).toBe(true);
    });
  });

  describe('Slack', () => {
    it('flags bot tokens', () => {
      const f = scanContent('SLACK_TOKEN=xoxb-1234567890-1234567890-abcdefghijklmnopqrstuvwx');
      expect(f.some((x) => x.ruleId === 'slack-token')).toBe(true);
    });
  });

  describe('OpenAI / Anthropic', () => {
    it('flags Anthropic keys', () => {
      const f = scanContent(
        'ANTHROPIC=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ',
      );
      expect(f.some((x) => x.ruleId === 'anthropic-key')).toBe(true);
    });

    it('flags OpenAI keys', () => {
      // sk- followed by 20+ alphanumeric. Avoid matching Anthropic format
      // (sk-ant-) by using a non-ant prefix in the value.
      const f = scanContent('OPENAI=sk-projaaaaaaaaaaaaaaaaaaaa');
      expect(f.some((x) => x.ruleId === 'openai-key')).toBe(true);
    });
  });

  describe('Google', () => {
    it('flags API keys (AIza prefix)', () => {
      // Real Google API keys are AIza + exactly 35 of [A-Za-z0-9_-].
      const key = `AIza${'A'.repeat(35)}`;
      const f = scanContent(`GOOGLE_KEY=${key}`);
      expect(f.some((x) => x.ruleId === 'google-api-key')).toBe(true);
    });

    it('flags service account JSON when private_key block is nearby', () => {
      const sa = JSON.stringify({
        type: 'service_account',
        project_id: 'demo',
        private_key_id: 'abc123',
        private_key: '-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n',
        client_email: 'svc@demo.iam.gserviceaccount.com',
      });
      const f = scanContent(sa);
      expect(f.some((x) => x.ruleId === 'google-service-account-json')).toBe(true);
    });

    it('does NOT flag the literal string "service_account" without a private key nearby', () => {
      const f = scanContent('// docs: see "type": "service_account" handling');
      expect(f.some((x) => x.ruleId === 'google-service-account-json')).toBe(false);
    });
  });

  describe('Private keys', () => {
    it('flags PEM private key blocks of every flavor', () => {
      const flavors = [
        '-----BEGIN PRIVATE KEY-----',
        '-----BEGIN RSA PRIVATE KEY-----',
        '-----BEGIN EC PRIVATE KEY-----',
        '-----BEGIN OPENSSH PRIVATE KEY-----',
      ];
      for (const block of flavors) {
        const f = scanContent(`some preamble\n${block}\nMIIE...`);
        expect(f.some((x) => x.ruleId === 'private-key-block')).toBe(true);
      }
    });
  });

  describe('Hetzner / Cloudflare (context-gated)', () => {
    it('flags Hetzner tokens when nearby identifier is suggestive', () => {
      const token = 'a'.repeat(64);
      const f = scanContent(`HCLOUD_TOKEN="${token}"`);
      expect(f.some((x) => x.ruleId === 'hetzner-token')).toBe(true);
    });

    it('does NOT flag a 64-char string in a docs file with no Hetzner context', () => {
      const token = 'a'.repeat(64);
      const f = scanContent(`expectedHash: "${token}"`);
      expect(f.some((x) => x.ruleId === 'hetzner-token')).toBe(false);
    });

    it('flags Cloudflare tokens when nearby identifier is suggestive', () => {
      // Cloudflare API tokens are 40 chars from [A-Za-z0-9_-].
      const token = `AbCdEfGhIjKlMnOpQrStUvWxYz${'A'.repeat(14)}`; // 40 chars exactly
      const f = scanContent(`CLOUDFLARE_API_TOKEN=${token}`);
      expect(f.some((x) => x.ruleId === 'cloudflare-api-token')).toBe(true);
    });

    it('does NOT flag commit-sha-shaped strings even with cloudflare nearby', () => {
      const f = scanContent('// see commit cloudflare a1b2c3d4e5f6789012345678901234567890abcd');
      expect(f.some((x) => x.ruleId === 'cloudflare-api-token')).toBe(false);
    });

    it('does NOT flag an all-lowercase hyphenated identifier with cloudflare nearby', () => {
      // Regression for 2026-05-19 matrix run bq5c4h9l5 — vibecarbon writes
      // server names like `${projectName}-${env}-${role}` into
      // .vibecarbon.json. With the e2e naming convention the substring
      // `testapp-compose-ha-1779192954739-jknrxf-` is exactly 40 chars from
      // [A-Za-z0-9_-]; combined with `dnsProvider: 'cloudflare'` in the
      // same file it tripped the rule and fast-failed every compose-ha
      // warm-deploy. Real Cloudflare tokens are high-entropy mixed-case;
      // hyphenated all-lowercase identifiers are not credentials.
      const projectish = 'testapp-compose-ha-1779192954739-jknrxf-';
      const json = `{
        "dnsProvider": "cloudflare",
        "servers": [{"name": "${projectish}e2-primary"}]
      }`;
      const f = scanContent(json);
      expect(f.some((x) => x.ruleId === 'cloudflare-api-token')).toBe(false);
    });
  });

  describe('DigitalOcean / Linode (C3)', () => {
    it('flags DigitalOcean personal access tokens (dop_v1_)', () => {
      const token = `dop_v1_${'a1b2c3'.repeat(10)}abcd`; // 64 hex chars
      const f = scanContent(`DIGITALOCEAN_TOKEN=${token}`);
      expect(f.some((x) => x.ruleId === 'digitalocean-token')).toBe(true);
    });

    it('flags DigitalOcean OAuth tokens (doo_v1_)', () => {
      const token = `doo_v1_${'a1b2c3'.repeat(10)}abcd`; // 64 hex chars
      const f = scanContent(`token: ${token}`);
      expect(f.some((x) => x.ruleId === 'digitalocean-token')).toBe(true);
    });

    it('flags DigitalOcean refresh tokens (dor_v1_)', () => {
      const token = `dor_v1_${'a1b2c3'.repeat(10)}abcd`; // 64 hex chars
      const f = scanContent(`token: ${token}`);
      expect(f.some((x) => x.ruleId === 'digitalocean-token')).toBe(true);
    });

    it('flags Linode tokens when nearby identifier is suggestive', () => {
      const token = 'a'.repeat(64);
      const f = scanContent(`LINODE_TOKEN="${token}"`);
      expect(f.some((x) => x.ruleId === 'linode-token')).toBe(true);
    });

    it('does NOT flag a 64-char string in a docs file with no Linode context', () => {
      const token = 'a'.repeat(64);
      const f = scanContent(`expectedHash: "${token}"`);
      expect(f.some((x) => x.ruleId === 'linode-token')).toBe(false);
    });

    it('does NOT flag an unquoted hex commit sha mentioned near the word "linode" in prose', () => {
      // 64-char hex string — same length as a real Linode token and
      // hex is a subset of the alnum charset the rule targets — but it
      // appears unquoted/undelimited in prose, which the candidate
      // pattern (quoted/delimited 64-char alnum) does not match. This
      // proves context alone isn't sufficient to trip the rule; the
      // delimiter requirement still gates it, even with "linode" right
      // next to it.
      const sha = '1234567890abcdef'.repeat(4); // 64 hex chars
      const f = scanContent(`Deployed the linode integration; see commit ${sha} for the fix.`);
      expect(f.some((x) => x.ruleId === 'linode-token')).toBe(false);
    });
  });

  describe('Vultr', () => {
    // Vultr API keys are 36 UPPERCASE alphanumeric chars (live-probed
    // 2026-08-08 — see the step-0 audit). Uppercase-only is what carries
    // the specificity here; the context gate covers the rest.
    const KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

    it('flags Vultr API keys when a nearby identifier is suggestive', () => {
      const f = scanContent(`VULTR_API_KEY=${KEY}`);
      expect(f.some((x) => x.ruleId === 'vultr-token')).toBe(true);
    });

    it('flags them under the VULTR_API_TOKEN spelling too (our env var name)', () => {
      const f = scanContent(`VULTR_API_TOKEN="${KEY}"`);
      expect(f.some((x) => x.ruleId === 'vultr-token')).toBe(true);
    });

    it('does NOT flag a 36-char uppercase string with no Vultr context', () => {
      const f = scanContent(`checksum: ${KEY}`);
      expect(f.some((x) => x.ruleId === 'vultr-token')).toBe(false);
    });

    it('does NOT flag a lowercase 36-char string next to the word "vultr"', () => {
      // Charset gate: a lowercase/mixed run is not a Vultr key, so prose
      // and slugs near "vultr" stay quiet even though context matches.
      const lower = KEY.toLowerCase();
      const f = scanContent(`The vultr fixture uses the id ${lower} throughout.`);
      expect(f.some((x) => x.ruleId === 'vultr-token')).toBe(false);
    });

    it('does NOT flag an uppercase UUID near "vultr" (hyphens break the charset run)', () => {
      // A canonical UUID is also 36 chars, but its hyphens split it into
      // runs far shorter than 36 — the rule cannot fire on one.
      const uuid = '550E8400-E29B-41D4-A716-446655440000';
      const f = scanContent(`vultr subscription id: ${uuid}`);
      expect(f.some((x) => x.ruleId === 'vultr-token')).toBe(false);
    });
  });

  describe('Scaleway', () => {
    // Access key: SCW + 17 uppercase alphanumerics (SDK validator
    // ^SCW[A-Z0-9]{17}$) — the prefix is distinctive, so NO context gate.
    const ACCESS_KEY = 'SCWN63TF9BMCPVNARV5A'; // Scaleway's own docs example
    const SECRET_UUID = '7363616c-6577-6179-8888-746573746b65';

    it('flags an access key anywhere — no context needed (self-prefixed)', () => {
      const f = scanContent(`some unrelated fixture value ${ACCESS_KEY} in prose`);
      expect(f.some((x) => x.ruleId === 'scaleway-access-key')).toBe(true);
    });

    it('does NOT flag a 20-char uppercase run without the SCW prefix', () => {
      const f = scanContent('checksum: ABCN63TF9BMCPVNARV5A');
      expect(f.some((x) => x.ruleId === 'scaleway-access-key')).toBe(false);
    });

    it('flags a UUID assigned to SCALEWAY_SECRET_KEY (the assignment IS the context)', () => {
      const f = scanContent(`SCALEWAY_SECRET_KEY=${SECRET_UUID}`);
      expect(f.some((x) => x.ruleId === 'scaleway-secret-key')).toBe(true);
    });

    it('flags the quoted/colon spellings too', () => {
      const f = scanContent(`scw_secret_key: "${SECRET_UUID}"`);
      expect(f.some((x) => x.ruleId === 'scaleway-secret-key')).toBe(true);
    });

    it('does NOT flag SCALEWAY_DEFAULT_PROJECT_ID — a UUID identifier, not a credential', () => {
      // The audit is explicit: the project id belongs on the CI scrub list
      // but must NOT trip the secret-scan — conflating the two is how
      // redaction lists get ignored. This is exactly why the rule is
      // assignment-anchored rather than proximity-gated: the project id
      // sits on the ADJACENT line of any Scaleway .env block, well within
      // a ±128-char context window.
      const f = scanContent(
        `SCALEWAY_SECRET_KEY=REDACTED\nSCALEWAY_DEFAULT_PROJECT_ID=${SECRET_UUID}\n`,
      );
      expect(f.some((x) => x.ruleId === 'scaleway-secret-key')).toBe(false);
    });

    it('does NOT flag a bare UUID near the word "scaleway" in prose', () => {
      const f = scanContent(`The scaleway zone fixture uses id ${SECRET_UUID} throughout.`);
      expect(f.some((x) => x.ruleId === 'scaleway-secret-key')).toBe(false);
    });
  });

  describe('Supabase service-role JWT', () => {
    function makeJwt(payload: Record<string, unknown>): string {
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
        .toString('base64url')
        .replace(/=+$/, '');
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url').replace(/=+$/, '');
      const sig = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      return `${header}.${body}.${sig}`;
    }

    it('flags JWTs with role=service_role', () => {
      const jwt = makeJwt({ role: 'service_role', iss: 'supabase' });
      const f = scanContent(`SERVICE_ROLE_KEY: ${jwt}`);
      expect(f.some((x) => x.ruleId === 'supabase-service-role-jwt')).toBe(true);
    });

    it('flags JWTs with role=admin', () => {
      const jwt = makeJwt({ role: 'admin' });
      const f = scanContent(`KEY: ${jwt}`);
      expect(f.some((x) => x.ruleId === 'supabase-service-role-jwt')).toBe(true);
    });

    it('does NOT flag anon-role JWTs (intentionally public)', () => {
      const jwt = makeJwt({ role: 'anon', iss: 'supabase' });
      const f = scanContent(`ANON_KEY: ${jwt}`);
      expect(f.some((x) => x.ruleId === 'supabase-service-role-jwt')).toBe(false);
    });

    it('does NOT flag the post-PR-1AJ placeholder shape', () => {
      // After PR 1AJ the local-overlay secrets.yaml uses these:
      const placeholder = 'REPLACE-WITH-LOCAL-SERVICE-ROLE-JWT-FROM-supabase-status';
      const f = scanContent(`SERVICE_ROLE_KEY: "${placeholder}"`);
      // Generic-secret-assignment shouldn't fire (placeholder-prefix bail-out),
      // and JWT rule doesn't match because there's no eyJ shape.
      expect(f).toHaveLength(0);
    });
  });

  describe('Generic secret assignment', () => {
    it('flags high-entropy values assigned to secret-named variables', () => {
      const f = scanContent('api_key = "x9P2vK7qLm3nB8fHjR4tWyZcUaEdSgIo"');
      expect(f.some((x) => x.ruleId === 'generic-secret-assignment')).toBe(true);
    });

    it('does NOT flag obvious placeholders', () => {
      expect(
        scanContent('password = "REPLACE-WITH-YOUR-PASSWORD-HERE-LATER"').some(
          (x) => x.ruleId === 'generic-secret-assignment',
        ),
      ).toBe(false);
      expect(
        scanContent('api_key = "PLACEHOLDER-FILL-IN-DURING-SETUP-PROCESS"').some(
          (x) => x.ruleId === 'generic-secret-assignment',
        ),
      ).toBe(false);
      expect(
        scanContent('password = "local-dev-password-12345"').some(
          (x) => x.ruleId === 'generic-secret-assignment',
        ),
      ).toBe(false);
    });

    it('does NOT flag low-entropy strings', () => {
      const f = scanContent('password = "aaaaaaaaaaaaaaaaaaaaaaaaaaa"');
      expect(f.some((x) => x.ruleId === 'generic-secret-assignment')).toBe(false);
    });
  });

  describe('allowlist', () => {
    it('suppresses literal substrings', () => {
      const f = scanContent('AKIAIOSFODNN7EXAMPLE', { allowlist: ['AKIAIOSFODNN7EXAMPLE'] });
      expect(f).toHaveLength(0);
    });

    it('suppresses via regex: prefix', () => {
      const f = scanContent('export X=ghp_abcdefghijklmnopqrstuvwxyz0123456789', {
        allowlist: ['regex:^ghp_[a-z0-9]+$'],
      });
      expect(f).toHaveLength(0);
    });

    it('ignores comment lines and empty entries', () => {
      const f = scanContent('AKIAIOSFODNN7EXAMPLE', { allowlist: ['', '# comment'] });
      expect(f.length).toBeGreaterThan(0);
    });
  });

  describe('finding metadata', () => {
    it('reports line and column 1-indexed', () => {
      const content = 'line1\nline2\nGITHUB=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n';
      const f = scanContent(content);
      const hit = f.find((x) => x.ruleId === 'github-pat');
      expect(hit).toBeDefined();
      expect(hit?.line).toBe(3);
      expect(hit?.column).toBe(8);
    });

    it('truncates very long matches', () => {
      const long = `ghp_${'a'.repeat(200)}`;
      const f = scanContent(long);
      const hit = f.find((x) => x.ruleId === 'github-pat');
      expect(hit?.match.length).toBeLessThan(long.length);
      expect(hit?.match).toContain('…');
    });
  });

  describe('rule registry', () => {
    it('every rule has a unique id and a non-empty description', () => {
      const ids = new Set<string>();
      for (const r of SECRET_RULES) {
        expect(r.id).toBeTruthy();
        expect(r.description).toBeTruthy();
        expect(ids.has(r.id)).toBe(false);
        ids.add(r.id);
      }
    });
  });

  describe('scanTree no-git fallback', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'vibecarbon-secret-scan-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('skips local-only env files when there is no .git directory', () => {
      // These are universally gitignored; without git there is no
      // .gitignore to honor, so the scanner must skip them by name.
      writeFileSync(join(dir, '.env'), 'DB_PASSWORD="FbZoUqXQ2Fltli48JUWecIcW3fMEHlxV"\n');
      writeFileSync(join(dir, '.env.local'), 'API_KEY="yLBO6riWx1J5ag051BEABD6la2TmVsa7"\n');
      writeFileSync(
        join(dir, '.env.production.local'),
        'SECRET="rxc4HxGpDTMIqhkqsb8kQJRsnQaB8N3E2XJg640"\n',
      );

      const findings = scanTree(dir);
      expect(findings).toEqual([]);
    });

    it('still scans .env.example (committed) and other non-env files', () => {
      writeFileSync(join(dir, '.env'), 'PASSWORD="FbZoUqXQ2Fltli48JUWecIcW3fMEHlxV"\n');
      writeFileSync(join(dir, '.env.example'), 'PASSWORD="FbZoUqXQ2Fltli48JUWecIcW3fMEHlxV"\n');
      writeFileSync(
        join(dir, 'config.js'),
        'export const PASSWORD = "FbZoUqXQ2Fltli48JUWecIcW3fMEHlxV";\n',
      );

      const findings = scanTree(dir);
      const files = findings.map((f) => f.file).sort();
      expect(files).toEqual(['.env.example', 'config.js']);
    });
  });

  describe('refuseIfSecretsPresent (shared pre-flight gate)', () => {
    // One definition in the lib — deploy.js and add.js were carrying
    // divergent private copies of this exact gate.
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'vibecarbon-secret-refuse-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it('exits 1 and names the refused action when the tree has secrets', async () => {
      writeFileSync(
        join(dir, 'config.js'),
        'export const PASSWORD = "FbZoUqXQ2Fltli48JUWecIcW3fMEHlxV";\n',
      );
      const stderr: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
        stderr.push(String(s));
        return true;
      });
      const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`exit:${code}`);
      }) as never);

      await expect(refuseIfSecretsPresent('deploy', dir)).rejects.toThrow('exit:1');
      expect(exit).toHaveBeenCalledWith(1);
      const out = stderr.join('');
      expect(out).toContain('Refusing to deploy: secrets detected');
      expect(out).toContain('config.js');
    });

    it('returns without exiting on a clean tree', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`exit:${code}`);
      }) as never);
      await refuseIfSecretsPresent('add', dir);
      expect(exit).not.toHaveBeenCalled();
    });
  });

  describe('clean inputs', () => {
    it('returns no findings on a normal source file', () => {
      const code = `
        import { foo } from './bar';
        export function hello(name: string) {
          console.log('Hello, ' + name);
        }
      `;
      expect(scanContent(code)).toHaveLength(0);
    });

    it('returns [] on empty / null / non-string input', () => {
      expect(scanContent('')).toEqual([]);
      // @ts-expect-error testing runtime guard
      expect(scanContent(undefined)).toEqual([]);
      // @ts-expect-error testing runtime guard
      expect(scanContent(123)).toEqual([]);
    });
  });
});
