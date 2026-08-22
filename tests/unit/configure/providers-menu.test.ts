/**
 * Providers section of `vibecarbon configure` (B1 + B2 + B2a + B3 — see
 * the providers-configure-env-local-credentials plan).
 * Covers:
 *   - FEATURES[0] wiring in src/configure.js (B1)
 *   - PROVIDER_MENU structure + promptProviders flow in
 *     src/lib/configure-providers.js (B2)
 * Guide-content pins (steps/URLs/practice line) live in the per-provider
 * guided-setup test files (hetzner/digitalocean/cloudflare-guided-setup.test.ts),
 * mirroring where the guide functions themselves live.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const clackMock = vi.hoisted(() => ({
  select: vi.fn(),
  confirm: vi.fn(),
  password: vi.fn(),
  isCancel: vi.fn((v: unknown) => v === Symbol.for('cancel')),
  cancel: vi.fn(),
  note: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
  },
}));
vi.mock('@clack/prompts', () => clackMock);

const hetznerGuided = vi.hoisted(() => ({
  getApiToken: vi.fn(),
  getS3Credentials: vi.fn(),
}));
vi.mock('../../../src/lib/hetzner-guided-setup.js', () => hetznerGuided);

const digitaloceanGuided = vi.hoisted(() => ({
  getApiToken: vi.fn(),
  getS3Credentials: vi.fn(),
}));
vi.mock('../../../src/lib/digitalocean-guided-setup.js', () => digitaloceanGuided);

const vultrGuided = vi.hoisted(() => ({
  getApiToken: vi.fn(),
  getS3Credentials: vi.fn(),
}));
vi.mock('../../../src/lib/vultr-guided-setup.js', () => vultrGuided);

// EXTRA_ENV_KEYS is read at configure-providers import time (the
// multi-var credential seam) — the mock must carry the real module's
// value or the scaleway entry silently loses its companions.
const scalewayGuided = vi.hoisted(() => ({
  getApiToken: vi.fn(),
  getS3Credentials: vi.fn(),
  EXTRA_ENV_KEYS: ['SCALEWAY_ACCESS_KEY', 'SCALEWAY_DEFAULT_PROJECT_ID'],
}));
vi.mock('../../../src/lib/scaleway-guided-setup.js', () => scalewayGuided);

const cloudflareGuided = vi.hoisted(() => ({
  getApiToken: vi.fn(),
}));
vi.mock('../../../src/lib/cloudflare-guided-setup.js', () => cloudflareGuided);

const bootstrapState = vi.hoisted(() => ({ keys: new Set<string>() }));
vi.mock('../../../src/lib/project.js', () => ({
  getBootstrappedKeys: () => bootstrapState.keys,
}));

import { PROVIDER_MENU, promptProviders } from '../../../src/lib/configure-providers.js';

function entry(id: string) {
  const e = PROVIDER_MENU.find((e) => e.id === id);
  if (!e) throw new Error(`no PROVIDER_MENU entry for ${id}`);
  return e;
}

describe('PROVIDER_MENU structure', () => {
  it('orders Compute (Hetzner, DigitalOcean) → DNS (Cloudflare) → Docker Hub (info row)', () => {
    expect(PROVIDER_MENU.map((e) => e.id)).toEqual([
      'hetzner',
      'digitalocean',
      'linode',
      'vultr',
      'scaleway',
      'cloudflare',
      'docker-hub',
    ]);
  });

  it('labels Linode by name only', () => {
    expect(entry('linode').label).toBe('Linode');
    expect(entry('linode').hint).toMatch(/^Compute/);
  });

  it('labels Vultr by name only', () => {
    expect(entry('vultr').label).toBe('Vultr');
    expect(entry('vultr').hint).toMatch(/^Compute/);
  });

  it('labels Scaleway by name only', () => {
    expect(entry('scaleway').label).toBe('Scaleway');
    expect(entry('scaleway').hint).toMatch(/^Compute/);
  });

  it('labels DigitalOcean by name only — no subordinating suffix', () => {
    expect(entry('digitalocean').label).toBe('DigitalOcean');
  });

  it('labels Hetzner by name only', () => {
    expect(entry('hetzner').label).toBe('Hetzner Cloud');
  });

  it('hints are grouped by prefix: Compute / DNS / Registry', () => {
    expect(entry('hetzner').hint).toMatch(/^Compute/);
    expect(entry('digitalocean').hint).toMatch(/^Compute/);
    expect(entry('vultr').hint).toMatch(/^Compute/);
    expect(entry('cloudflare').hint).toMatch(/^DNS/);
    expect(entry('docker-hub').hint).toMatch(/^Registry/);
  });

  it('envKeys match the config-registry operator-secret keys per provider', () => {
    expect(entry('hetzner').envKeys).toEqual([
      'HETZNER_API_TOKEN',
      'HETZNER_ACCESS_KEY',
      'HETZNER_SECRET_KEY',
    ]);
    expect(entry('digitalocean').envKeys).toEqual([
      'DIGITALOCEAN_API_TOKEN',
      'DIGITALOCEAN_ACCESS_KEY',
      'DIGITALOCEAN_SECRET_KEY',
    ]);
    expect(entry('linode').envKeys).toEqual([
      'LINODE_API_TOKEN',
      'LINODE_ACCESS_KEY',
      'LINODE_SECRET_KEY',
    ]);
    expect(entry('vultr').envKeys).toEqual([
      'VULTR_API_TOKEN',
      'VULTR_ACCESS_KEY',
      'VULTR_SECRET_KEY',
    ]);
    // Scaleway is a credential TRIPLE with NO separate storage pair (the
    // same IAM keys sign S3) — token + EXTRA_ENV_KEYS companions.
    expect(entry('scaleway').envKeys).toEqual([
      'SCALEWAY_SECRET_KEY',
      'SCALEWAY_ACCESS_KEY',
      'SCALEWAY_DEFAULT_PROJECT_ID',
    ]);
    expect(entry('cloudflare').envKeys).toEqual(['CLOUDFLARE_API_TOKEN']);
  });

  it('vultr envKeys exclude the cluster key — it rides run(), not the storage pair', () => {
    // VULTR_STORAGE_REGION is a registered operator key (the
    // per-subscription key model makes the cluster required config), but
    // STORAGE_KEYS_BY_PROVIDER must stay a PAIR — runComputeEntry gates the
    // storage prompt on `length === 2` and indexes [0]/[1]. The cluster
    // reaches the write loop through the guided module's return value
    // instead (see the vultr full-accept flow test below).
    expect(entry('vultr').envKeys).not.toContain('VULTR_STORAGE_REGION');
  });

  it('Docker Hub row has no envKeys — it is never part of the .env.local store', () => {
    expect(entry('docker-hub').envKeys).toEqual([]);
  });
});

describe('PROVIDER_MENU isConfigured', () => {
  it('hetzner: token alone counts (S3 is optional)', () => {
    const hz = entry('hetzner');
    expect(hz.isConfigured({})).toBe(false);
    expect(hz.isConfigured({ HETZNER_API_TOKEN: 'x' })).toBe(true);
    expect(hz.isConfigured({ HETZNER_API_TOKEN: 'x', HETZNER_ACCESS_KEY: 'a' })).toBe(true);
  });

  it('linode: token alone counts (the token+storage requirement is the DO-only owner-pinned asymmetry)', () => {
    const ln = entry('linode');
    expect(ln.isConfigured({})).toBe(false);
    expect(ln.isConfigured({ LINODE_API_TOKEN: 'x' })).toBe(true);
  });

  it('vultr: token alone counts (same as Linode — DO is the only both-required entry)', () => {
    const vu = entry('vultr');
    expect(vu.isConfigured({})).toBe(false);
    expect(vu.isConfigured({ VULTR_API_TOKEN: 'x' })).toBe(true);
  });

  it('scaleway: requires the WHOLE triple — a partial set fails at deploy start by design (buildIacEnv)', () => {
    const sw = entry('scaleway');
    expect(sw.isConfigured({})).toBe(false);
    expect(sw.isConfigured({ SCALEWAY_SECRET_KEY: 'x' })).toBe(false);
    expect(sw.isConfigured({ SCALEWAY_SECRET_KEY: 'x', SCALEWAY_ACCESS_KEY: 'a' })).toBe(false);
    expect(
      sw.isConfigured({
        SCALEWAY_SECRET_KEY: 'x',
        SCALEWAY_ACCESS_KEY: 'a',
        SCALEWAY_DEFAULT_PROJECT_ID: 'p',
      }),
    ).toBe(true);
  });

  it('digitalocean: requires token AND both Spaces keys', () => {
    const doEntry = entry('digitalocean');
    expect(doEntry.isConfigured({ DIGITALOCEAN_API_TOKEN: 'x' })).toBe(false);
    expect(
      doEntry.isConfigured({
        DIGITALOCEAN_API_TOKEN: 'x',
        DIGITALOCEAN_ACCESS_KEY: 'a',
        DIGITALOCEAN_SECRET_KEY: 'b',
      }),
    ).toBe(true);
  });

  it('cloudflare: token-only', () => {
    const cf = entry('cloudflare');
    expect(cf.isConfigured({})).toBe(false);
    expect(cf.isConfigured({ CLOUDFLARE_API_TOKEN: 'x' })).toBe(true);
  });

  it('docker hub: always false — informational, never "configured" in the project store', () => {
    expect(entry('docker-hub').isConfigured({})).toBe(false);
    expect(entry('docker-hub').isConfigured({ DOCKER_HUB_USERNAME: 'x' })).toBe(false);
  });
});

describe('promptProviders', () => {
  beforeEach(() => {
    clackMock.select.mockReset();
    clackMock.confirm.mockReset();
    clackMock.password.mockReset();
    clackMock.note.mockReset();
    clackMock.log.warn.mockReset();
    clackMock.log.info.mockReset();
    hetznerGuided.getApiToken.mockReset();
    hetznerGuided.getS3Credentials.mockReset();
    digitaloceanGuided.getApiToken.mockReset();
    digitaloceanGuided.getS3Credentials.mockReset();
    vultrGuided.getApiToken.mockReset();
    vultrGuided.getS3Credentials.mockReset();
    cloudflareGuided.getApiToken.mockReset();
    bootstrapState.keys = new Set();
    delete process.env.HETZNER_API_TOKEN;
    delete process.env.CLOUDFLARE_API_TOKEN;
  });

  it('cancelling the top select returns null', async () => {
    clackMock.select.mockResolvedValueOnce(Symbol.for('cancel'));
    const result = await promptProviders({});
    expect(result).toBeNull();
  });

  it('shows the ✓ configured suffix only for entries isConfigured() finds true', async () => {
    clackMock.select.mockResolvedValueOnce(Symbol.for('cancel'));
    await promptProviders({ CLOUDFLARE_API_TOKEN: 'tok' });

    const call = clackMock.select.mock.calls[0][0];
    const cf = call.options.find((o: { value: string }) => o.value === 'cloudflare');
    const hz = call.options.find((o: { value: string }) => o.value === 'hetzner');
    expect(cf.label).toContain('✓ configured');
    expect(hz.label).not.toContain('✓ configured');
  });

  describe('shell-override warning (A2 provenance)', () => {
    it('warns when a key is set in process.env but was NOT loaded by bootstrap', async () => {
      process.env.HETZNER_API_TOKEN = 'shell-value';
      bootstrapState.keys = new Set(); // not bootstrapped — must be a shell export
      clackMock.select.mockResolvedValueOnce('hetzner');
      hetznerGuided.getApiToken.mockResolvedValue('shell-value');
      clackMock.confirm.mockResolvedValue(false); // decline storage setup

      await promptProviders({});

      expect(clackMock.log.warn).toHaveBeenCalledWith(expect.stringContaining('HETZNER_API_TOKEN'));
    });

    it('does not warn when the key was loaded from .env.local by bootstrap', async () => {
      process.env.HETZNER_API_TOKEN = 'file-value';
      bootstrapState.keys = new Set(['HETZNER_API_TOKEN']);
      clackMock.select.mockResolvedValueOnce('hetzner');
      hetznerGuided.getApiToken.mockResolvedValue('file-value');
      clackMock.confirm.mockResolvedValue(false);

      await promptProviders({});

      expect(clackMock.log.warn).not.toHaveBeenCalled();
    });

    it('does not warn when the key is unset in process.env', async () => {
      clackMock.select.mockResolvedValueOnce('cloudflare');
      cloudflareGuided.getApiToken.mockResolvedValue('fresh-tok');

      await promptProviders({});

      expect(clackMock.log.warn).not.toHaveBeenCalled();
    });
  });

  describe('already-configured entry: overwrite gate', () => {
    it('shows a masked "current settings" note before asking to overwrite', async () => {
      clackMock.select.mockResolvedValueOnce('cloudflare');
      clackMock.confirm.mockResolvedValueOnce(false); // decline overwrite

      await promptProviders({ CLOUDFLARE_API_TOKEN: 'abcdefghijklmnop' });

      expect(clackMock.note).toHaveBeenCalledTimes(1);
      const [body, title] = clackMock.note.mock.calls[0];
      expect(String(title)).toBe('Cloudflare: current settings');
      expect(String(body)).toContain('CLOUDFLARE_API_TOKEN');
      expect(String(body)).not.toContain('abcdefghijklmnop'); // masked, never raw
    });

    it('declining the overwrite confirm returns null and never touches the guided module', async () => {
      clackMock.select.mockResolvedValueOnce('hetzner');
      clackMock.confirm.mockResolvedValueOnce(false);

      const result = await promptProviders({ HETZNER_API_TOKEN: 'existing' });

      expect(result).toBeNull();
      expect(hetznerGuided.getApiToken).not.toHaveBeenCalled();
    });

    it('cancelling the overwrite confirm returns null', async () => {
      clackMock.select.mockResolvedValueOnce('hetzner');
      clackMock.confirm.mockResolvedValueOnce(Symbol.for('cancel'));

      const result = await promptProviders({ HETZNER_API_TOKEN: 'existing' });

      expect(result).toBeNull();
    });

    it('accepting the overwrite confirm runs the guided prompt with {force:true, save:false}', async () => {
      clackMock.select.mockResolvedValueOnce('hetzner');
      clackMock.confirm
        .mockResolvedValueOnce(true) // overwrite confirm
        .mockResolvedValueOnce(false); // storage setup confirm
      hetznerGuided.getApiToken.mockResolvedValue('new-token');

      const result = await promptProviders({ HETZNER_API_TOKEN: 'existing' });

      expect(hetznerGuided.getApiToken).toHaveBeenCalledWith(undefined, {
        force: true,
        save: false,
      });
      expect(result).toEqual({ HETZNER_API_TOKEN: 'new-token' });
    });

    it('hetzner summary notes when S3 credentials are unset', async () => {
      clackMock.select.mockResolvedValueOnce('hetzner');
      clackMock.confirm.mockResolvedValueOnce(false);

      await promptProviders({ HETZNER_API_TOKEN: 'tokenvalue123' });

      const [body] = clackMock.note.mock.calls[0];
      expect(String(body).toLowerCase()).toContain('s3');
    });
  });

  describe('unconfigured entry: straight to the guided prompt', () => {
    it('skips the overwrite confirm entirely', async () => {
      clackMock.select.mockResolvedValueOnce('hetzner');
      clackMock.confirm.mockResolvedValueOnce(false); // storage-setup confirm only
      hetznerGuided.getApiToken.mockResolvedValue('tok');

      const result = await promptProviders({});

      expect(clackMock.confirm).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ HETZNER_API_TOKEN: 'tok' });
    });

    it('passes the project name through from ctx.projectConfig.projectName', async () => {
      clackMock.select.mockResolvedValueOnce('hetzner');
      clackMock.confirm.mockResolvedValueOnce(false);
      hetznerGuided.getApiToken.mockResolvedValue('tok');

      await promptProviders({}, { projectConfig: { projectName: 'acme' } });

      expect(hetznerGuided.getApiToken).toHaveBeenCalledWith('acme', { force: true, save: false });
    });
  });

  describe('storage confirm gates the second (S3/Spaces) prompt', () => {
    it('accepting calls getS3Credentials and merges both keys into the result', async () => {
      clackMock.select.mockResolvedValueOnce('hetzner');
      clackMock.confirm.mockResolvedValueOnce(true);
      hetznerGuided.getApiToken.mockResolvedValue('tok');
      hetznerGuided.getS3Credentials.mockResolvedValue({ accessKey: 'AK', secretKey: 'SK' });

      const result = await promptProviders({});

      expect(hetznerGuided.getS3Credentials).toHaveBeenCalledWith(undefined, {
        force: true,
        save: false,
      });
      expect(result).toEqual({
        HETZNER_API_TOKEN: 'tok',
        HETZNER_ACCESS_KEY: 'AK',
        HETZNER_SECRET_KEY: 'SK',
      });
    });

    it('declining never calls getS3Credentials', async () => {
      clackMock.select.mockResolvedValueOnce('hetzner');
      clackMock.confirm.mockResolvedValueOnce(false);
      hetznerGuided.getApiToken.mockResolvedValue('tok');

      const result = await promptProviders({});

      expect(hetznerGuided.getS3Credentials).not.toHaveBeenCalled();
      expect(result).toEqual({ HETZNER_API_TOKEN: 'tok' });
    });

    it('the confirm message names both S3 and Spaces (provider-neutral)', async () => {
      clackMock.select.mockResolvedValueOnce('hetzner');
      clackMock.confirm.mockResolvedValueOnce(false);
      hetznerGuided.getApiToken.mockResolvedValue('tok');

      await promptProviders({});

      const call = clackMock.confirm.mock.calls[0][0];
      expect(call.message).toContain('S3/Spaces');
    });
  });

  it('digitalocean full-accept flow returns an object with exactly the entry envKeys', async () => {
    clackMock.select.mockResolvedValueOnce('digitalocean');
    clackMock.confirm.mockResolvedValueOnce(true);
    digitaloceanGuided.getApiToken.mockResolvedValue('do-tok');
    digitaloceanGuided.getS3Credentials.mockResolvedValue({ accessKey: 'SPK', secretKey: 'SPS' });

    const result = await promptProviders({});

    expect(Object.keys(result).sort()).toEqual([...entry('digitalocean').envKeys].sort());
  });

  describe('vultr full-accept flow (per-subscription cluster)', () => {
    it('writes the cluster the guided module returned to Provider.S3_REGION_ENV', async () => {
      clackMock.select.mockResolvedValueOnce('vultr');
      clackMock.confirm.mockResolvedValueOnce(true);
      vultrGuided.getApiToken.mockResolvedValue('vu-tok');
      vultrGuided.getS3Credentials.mockResolvedValue({
        accessKey: 'VAK',
        secretKey: 'VSK',
        region: 'sjc1',
      });

      const result = await promptProviders({});

      expect(result).toEqual({
        VULTR_API_TOKEN: 'vu-tok',
        VULTR_ACCESS_KEY: 'VAK',
        VULTR_SECRET_KEY: 'VSK',
        VULTR_STORAGE_REGION: 'sjc1',
      });
    });

    it('omits the cluster key when the guided module returns no region', async () => {
      // The passthrough is generic over Provider.S3_REGION_ENV, so it must
      // stay inert for every provider whose guided module returns only the
      // credential pair (hetzner/digitalocean/linode today).
      clackMock.select.mockResolvedValueOnce('vultr');
      clackMock.confirm.mockResolvedValueOnce(true);
      vultrGuided.getApiToken.mockResolvedValue('vu-tok');
      vultrGuided.getS3Credentials.mockResolvedValue({ accessKey: 'VAK', secretKey: 'VSK' });

      const result = await promptProviders({});

      expect(Object.keys(result)).not.toContain('VULTR_STORAGE_REGION');
    });
  });

  describe('scaleway full-accept flow (triple credential, no storage pair)', () => {
    it('folds the EXTRA_ENV_KEYS companions from process.env into the write set', async () => {
      // getApiToken's contract: it prompts the triple and sets all three
      // on process.env (in-process coherence); run() folds the companions
      // from there since only the token rides the return value.
      clackMock.select.mockResolvedValueOnce('scaleway');
      scalewayGuided.getApiToken.mockImplementation(async () => {
        process.env.SCALEWAY_ACCESS_KEY = 'SCWTESTTESTTESTTEST1';
        process.env.SCALEWAY_DEFAULT_PROJECT_ID = '11111111-2222-3333-4444-555555555555';
        return 'scw-secret';
      });
      try {
        const result = await promptProviders({});

        expect(result).toEqual({
          SCALEWAY_SECRET_KEY: 'scw-secret',
          SCALEWAY_ACCESS_KEY: 'SCWTESTTESTTESTTEST1',
          SCALEWAY_DEFAULT_PROJECT_ID: '11111111-2222-3333-4444-555555555555',
        });
        // No separate storage credential exists on Scaleway (same IAM pair
        // signs S3) — the storage confirm must never appear.
        expect(clackMock.confirm).not.toHaveBeenCalled();
        expect(scalewayGuided.getS3Credentials).not.toHaveBeenCalled();
      } finally {
        delete process.env.SCALEWAY_ACCESS_KEY;
        delete process.env.SCALEWAY_DEFAULT_PROJECT_ID;
      }
    });
  });

  it('cloudflare entry never offers the storage-setup confirm', async () => {
    clackMock.select.mockResolvedValueOnce('cloudflare');
    cloudflareGuided.getApiToken.mockResolvedValue('cf-tok');

    const result = await promptProviders({});

    expect(cloudflareGuided.getApiToken).toHaveBeenCalledWith(undefined, {
      force: true,
      save: false,
    });
    expect(result).toEqual({ CLOUDFLARE_API_TOKEN: 'cf-tok' });
    expect(clackMock.confirm).not.toHaveBeenCalled();
  });

  describe('Docker Hub row', () => {
    it('prints an informational note and returns {} — no writes', async () => {
      clackMock.select.mockResolvedValueOnce('docker-hub');

      const result = await promptProviders({});

      expect(result).toEqual({});
      expect(clackMock.note).toHaveBeenCalledTimes(1);
      const [body, title] = clackMock.note.mock.calls[0];
      expect(String(title)).toMatch(/Docker Hub/);
      expect(String(body)).toContain('DOCKER_HUB_USERNAME');
      expect(String(body)).toContain('DOCKER_HUB_TOKEN');
      expect(String(body)).toContain('https://hub.docker.com/settings/security');
    });

    it('never asks an overwrite confirm (isConfigured is always false)', async () => {
      clackMock.select.mockResolvedValueOnce('docker-hub');

      await promptProviders({});

      expect(clackMock.confirm).not.toHaveBeenCalled();
    });
  });
});
