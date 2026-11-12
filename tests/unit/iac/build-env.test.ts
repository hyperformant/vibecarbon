import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — JS module without types
import { buildEnv } from '../../../src/lib/iac/index.js';

// buildEnv is the seam that assembles the env-var bag Pulumi's Automation
// API spawns its child process with. It provider-dispatches the CLI token
// env var name via getProviderClass(provider).CLI_TOKEN_ENV (hetzner ->
// HCLOUD_TOKEN, digitalocean -> DIGITALOCEAN_TOKEN) instead of hardcoding
// HCLOUD_TOKEN — see task C4. buildEnv spreads process.env, so every test
// here must stub/delete the token env vars first (never assert absolute
// absence — that would be a false negative against a dev shell that
// happens to export HCLOUD_TOKEN etc.).
//
// DO k8s 401 RCA (M3 Task 9a): buildEnv used to default a missing
// `options.provider` to 'hetzner'. A call site that forgot to pass
// `provider` alongside a DigitalOcean `providerToken` silently exported
// that token as HCLOUD_TOKEN — DIGITALOCEAN_TOKEN was never set, and
// Pulumi's DigitalOcean provider ran unauthenticated (401 on every
// resource create). There is now NO default: a `providerToken` with no
// `provider` to name its env var is always a caller bug and buildEnv
// throws instead of silently guessing hetzner.

const TOKEN_ENV_VARS = [
  'HCLOUD_TOKEN',
  'DIGITALOCEAN_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'PULUMI_CONFIG_PASSPHRASE',
  'PULUMI_CONFIG_PASSPHRASE_FILE',
  'VIBECARBON_STATE_PASSPHRASE',
  'PULUMI_SKIP_UPDATE_CHECK',
  'PULUMI_BACKEND_URL',
];

const PASSPHRASE = 'A'.repeat(43);

beforeEach(() => {
  for (const key of TOKEN_ENV_VARS) vi.stubEnv(key, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildEnv', () => {
  it('throws when providerToken is set without provider (no silent hetzner default)', () => {
    expect(() => buildEnv({ providerToken: 'some-secret-token' })).toThrow(/provider/i);
  });

  it('never sets HCLOUD_TOKEN or DIGITALOCEAN_TOKEN when the throw path fires', () => {
    try {
      buildEnv({ providerToken: 'some-secret-token' });
    } catch {
      /* expected */
    }
    expect(process.env.HCLOUD_TOKEN).toBeUndefined();
    expect(process.env.DIGITALOCEAN_TOKEN).toBeUndefined();
  });

  it('does not throw when neither provider nor providerToken is set (e.g. listStacks probes)', () => {
    expect(() => buildEnv({ s3Config: { bucket: 'b' } })).not.toThrow();
  });

  describe.each([
    ['hetzner', 'HCLOUD_TOKEN', 'DIGITALOCEAN_TOKEN'],
    ['digitalocean', 'DIGITALOCEAN_TOKEN', 'HCLOUD_TOKEN'],
  ])('provider: %s', (provider, ownTokenEnv, otherTokenEnv) => {
    it(`sets ${ownTokenEnv} from providerToken and leaves ${otherTokenEnv} unset`, () => {
      const env = buildEnv({ provider, providerToken: 'secret-token' });
      expect(env[ownTokenEnv]).toBe('secret-token');
      expect(env[otherTokenEnv]).toBeUndefined();
    });

    it('omits the token env var when providerToken is not given', () => {
      const env = buildEnv({ provider });
      expect(env[ownTokenEnv]).toBeUndefined();
    });

    it('sets AWS access/secret keys from s3Config creds', () => {
      const env = buildEnv({
        provider,
        providerToken: 'secret-token',
        s3Config: { accessKey: 'AKIA-TEST', secretKey: 's3cret' },
      });
      expect(env.AWS_ACCESS_KEY_ID).toBe('AKIA-TEST');
      expect(env.AWS_SECRET_ACCESS_KEY).toBe('s3cret');
    });

    it('sets PULUMI_CONFIG_PASSPHRASE to the project passphrase', () => {
      vi.stubEnv('VIBECARBON_STATE_PASSPHRASE', PASSPHRASE);
      const env = buildEnv({ provider, providerToken: 'secret-token' });
      expect(env.PULUMI_CONFIG_PASSPHRASE).toBe(PASSPHRASE);
    });

    it('leaves both passphrase vars unset (never an empty string) without a project passphrase', () => {
      const env = buildEnv({ provider, providerToken: 'secret-token' });
      expect(env.PULUMI_CONFIG_PASSPHRASE).toBeUndefined();
      expect(env.PULUMI_CONFIG_PASSPHRASE_FILE).toBeUndefined();
    });

    it('drops an inherited PULUMI_CONFIG_PASSPHRASE and _FILE', () => {
      vi.stubEnv('PULUMI_CONFIG_PASSPHRASE', 'from-another-project');
      vi.stubEnv('PULUMI_CONFIG_PASSPHRASE_FILE', '/tmp/other-project-passphrase');
      const none = buildEnv({ provider });
      expect(none.PULUMI_CONFIG_PASSPHRASE).toBeUndefined();
      expect(none.PULUMI_CONFIG_PASSPHRASE_FILE).toBeUndefined();
      vi.stubEnv('VIBECARBON_STATE_PASSPHRASE', PASSPHRASE);
      const own = buildEnv({ provider });
      expect(own.PULUMI_CONFIG_PASSPHRASE).toBe(PASSPHRASE);
      expect(own.PULUMI_CONFIG_PASSPHRASE_FILE).toBeUndefined();
    });

    it('the spawned pulumi child sees no inherited passphrase var (the SDK spreads process.env under envVars)', () => {
      vi.stubEnv('PULUMI_CONFIG_PASSPHRASE', 'from-another-project');
      vi.stubEnv('PULUMI_CONFIG_PASSPHRASE_FILE', '/tmp/other-project-passphrase');
      const probe = (env: Record<string, string | undefined>) =>
        JSON.parse(
          execFileSync(
            process.execPath,
            [
              '-e',
              'console.log(JSON.stringify([process.env.PULUMI_CONFIG_PASSPHRASE ?? null, process.env.PULUMI_CONFIG_PASSPHRASE_FILE ?? null]))',
            ],
            // Same merge the Automation SDK's execa call performs.
            { env: { ...process.env, ...env }, encoding: 'utf8' },
          ),
        );
      expect(probe(buildEnv({ provider }))).toEqual([null, null]);
      vi.stubEnv('VIBECARBON_STATE_PASSPHRASE', PASSPHRASE);
      expect(probe(buildEnv({ provider }))).toEqual([PASSPHRASE, null]);
      expect(probe(buildEnv({ provider, decrypts: false }))).toEqual([PASSPHRASE, null]);
    });

    it('refuses a malformed project passphrase, unless the caller decrypts nothing', () => {
      vi.stubEnv('VIBECARBON_STATE_PASSPHRASE', 'short');
      expect(() => buildEnv({ provider })).toThrow(/too weak/);
      const env = buildEnv({ provider, decrypts: false });
      expect(env.PULUMI_CONFIG_PASSPHRASE).toBeUndefined();
    });

    it('sets PULUMI_SKIP_UPDATE_CHECK', () => {
      const env = buildEnv({ provider, providerToken: 'secret-token' });
      expect(env.PULUMI_SKIP_UPDATE_CHECK).toBe('true');
    });

    it('disables the DIY backend checkpoint-backup copy', () => {
      // Every `up` otherwise writes the live checkpoint, its .bak, a
      // timestamped .pulumi/backups/ copy and two .pulumi/history/ entries —
      // five state-backend writes for a stack with no resources at all
      // (measured on pulumi 3.231.0). This drops one of the five against a
      // store whose documented request ceiling we have never modelled, and
      // request volume is what the run 31898658781 evidence points at.
      const env = buildEnv({ provider, providerToken: 'secret-token' });
      expect(env.PULUMI_DIY_BACKEND_DISABLE_CHECKPOINT_BACKUPS).toBe('true');
    });

    it("drops an operator's RETAIN_CHECKPOINTS, whose copies would keep pre-seal plain values", () => {
      // Both spellings the CLI reads (3.259.0). Each would keep a timestamped
      // full copy of every checkpoint beside the stack file, which nothing
      // removes; the history is the recovery copy. Undefined, not deleted, so
      // the SDK's {...process.env, ...envVars} spawn cannot bring them back.
      process.env.PULUMI_DIY_BACKEND_RETAIN_CHECKPOINTS = 'true';
      process.env.PULUMI_RETAIN_CHECKPOINTS = 'true';
      const env = buildEnv({ provider, providerToken: 'secret-token' });
      for (const key of ['PULUMI_DIY_BACKEND_RETAIN_CHECKPOINTS', 'PULUMI_RETAIN_CHECKPOINTS']) {
        expect(key in env, key).toBe(true);
        expect(env[key], key).toBeUndefined();
      }
    });

    it('does not skip checkpoints, which destroy correctness depends on', () => {
      // PULUMI_SKIP_CHECKPOINTS exists on this CLI and would cut far more
      // writes, but it keeps only the FINAL deployment: an update that dies
      // mid-way leaves resources created and unrecorded. Our destroy path and
      // its leak ledger are built on state reflecting what was created, so
      // this is one volume reduction we deliberately decline. Pinned so a
      // future optimisation pass has to argue with the reason, not discover it.
      const env = buildEnv({ provider, providerToken: 'secret-token' });
      expect(env.PULUMI_SKIP_CHECKPOINTS).toBeUndefined();
    });

    it('spreads process.env underneath the computed keys', () => {
      vi.stubEnv('VC_BUILD_ENV_PROBE', 'present');
      const env = buildEnv({ provider, providerToken: 'secret-token' });
      expect(env.VC_BUILD_ENV_PROBE).toBe('present');
    });
  });
});

describe('buildEnv — PULUMI_BACKEND_URL reaches the child normalized', () => {
  // Pulumi lets the env var override projectSettings.backend.url inside the
  // child process, so a shell export with paste artifacts (quotes, trailing
  // newline) would steer the child at a backend the CLI's own
  // resolveBackendUrl() never saw. .env.local values are already unquoted
  // by parseDotenv; only a shell export produces this, which is exactly the
  // case a spread of process.env forwards verbatim.
  it('strips quotes/whitespace from a shell-exported PULUMI_BACKEND_URL', () => {
    vi.stubEnv('PULUMI_BACKEND_URL', '"s3://acme-state?endpoint=fsn1.example"\n');
    const env = buildEnv({ s3Config: { bucket: 'b' } });
    expect(env.PULUMI_BACKEND_URL).toBe('s3://acme-state?endpoint=fsn1.example');
  });

  it('leaves PULUMI_BACKEND_URL absent when the shell does not export it', () => {
    delete process.env.PULUMI_BACKEND_URL;
    const env = buildEnv({ s3Config: { bucket: 'b' } });
    expect('PULUMI_BACKEND_URL' in env).toBe(false);
  });

  it('drops a blank export rather than forwarding an empty override', () => {
    vi.stubEnv('PULUMI_BACKEND_URL', '   ');
    const env = buildEnv({ s3Config: { bucket: 'b' } });
    expect('PULUMI_BACKEND_URL' in env).toBe(false);
  });
});
