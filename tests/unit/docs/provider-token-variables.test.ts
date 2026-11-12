import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The variable the docs tell you to put a provider's API token in is the one
 * that provider's deploy reads.
 *
 * A rotation that follows the docs and sets a variable the deploy never reads
 * deploys with the old token: the check that the token sees the cluster passes
 * (the old token does), nothing on the cluster changes, and the next step
 * says to revoke the old token, which the cluster still runs on. So this
 * reads what each deploy takes, from the provider registry (TOKEN_ENV, the
 * variable each provider's promptApiToken reads, and CLI_TOKEN_ENV, the one
 * buildEnv sets for Pulumi from it), and holds docs/security.md's rotation
 * steps and the provider guides to it. No hand list: a provider with a k8s
 * tier is one the rotation steps cover.
 */

const { PROVIDERS } = await import('../../../src/lib/providers/index.js');
const { buildEnv } = await import('../../../src/lib/iac/index.js');

const K8S_PROVIDERS = Object.entries(PROVIDERS).filter(([, P]) =>
  P.SUPPORTED_TIERS.includes('k8s'),
);
const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf-8');
const SECURITY = read('docs/security.md');
/** The token's row in the infrastructure secrets table. */
const ROW = SECURITY.split('\n').find((line) => line.startsWith('| `HETZNER_API_TOKEN`')) ?? '';
/** The rotation steps, heading to the next section. */
const ROTATION = (() => {
  const at = SECURITY.indexOf('#### `HETZNER_API_TOKEN`');
  return SECURITY.slice(at, SECURITY.indexOf('\n**Kubernetes clusters made by', at));
})();
const step = (n: number) => ROTATION.split('\n').find((line) => line.startsWith(`${n}. `)) ?? '';
/** Sentences, for checking what each says around a name. */
const sentences = (text: string) => text.split(/(?<=\.)\s+(?=[A-Z`])/);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("what each provider's deploy reads its token from", () => {
  it('there are k8s providers, each with its own token variable and its own Pulumi variable', () => {
    expect(K8S_PROVIDERS.length).toBeGreaterThan(0);
    for (const [id, P] of K8S_PROVIDERS) {
      expect(P.TOKEN_ENV, id).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(P.CLI_TOKEN_ENV, id).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(P.CLI_TOKEN_ENV, id).not.toBe(P.TOKEN_ENV);
    }
  });

  it.each(K8S_PROVIDERS)(
    '%s: the deploy takes TOKEN_ENV, whatever the Pulumi variable holds',
    async (_id, Provider) => {
      const token = 'vc-sentinel-token-env-0123456789abcdef';
      vi.stubEnv(Provider.TOKEN_ENV, token);
      vi.stubEnv(Provider.CLI_TOKEN_ENV, 'vc-sentinel-token-pulumi-var');
      // The provider's check of a token found in the environment: it passes.
      vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }));
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      expect(await Provider.promptApiToken('proj')).toBe(token);
    },
  );

  it.each(K8S_PROVIDERS)(
    '%s: the deploy sets the Pulumi variable from that token, so exporting it changes nothing',
    (id, Provider) => {
      vi.stubEnv(Provider.CLI_TOKEN_ENV, 'vc-sentinel-token-exported');
      const env = buildEnv({ provider: id, providerToken: 'vc-sentinel-token-deploy' });
      expect(env[Provider.CLI_TOKEN_ENV]).toBe('vc-sentinel-token-deploy');
    },
  );
});

describe('docs/security.md names the variable each deploy reads', () => {
  const [[, first], ...rest] = K8S_PROVIDERS;

  it("the token's row and the rotation steps cover every k8s provider, by its TOKEN_ENV", () => {
    expect(ROW).toContain(
      `| \`${first.TOKEN_ENV}\` (and ${rest.map(([, P]) => `\`${P.TOKEN_ENV}\``).join(', ')})`,
    );
    expect(ROTATION.startsWith(`#### \`${first.TOKEN_ENV}\``)).toBe(true);
    expect(ROTATION).toContain(
      `The same steps rotate ${rest.map(([, P]) => `\`${P.TOKEN_ENV}\``).join(' and ')}`,
    );
  });

  it('step 3 puts the token in that variable, says the shell wins, and that the Pulumi one changes nothing', () => {
    const three = step(3);
    expect(three).toContain(`in the project's \`.env.local\` as \`${first.TOKEN_ENV}\``);
    expect(three).toContain('export it under that name in the shell you deploy from');
    expect(three).toContain('The shell wins over `.env.local`');
    expect(three).toContain(`The deploy reads only \`${first.TOKEN_ENV}\``);
    expect(three).toContain(`exporting \`${first.CLI_TOKEN_ENV}\` changes nothing`);
  });

  it("the other providers' step 3 is named with their own variables", () => {
    const same = sentences(ROTATION).find((s) => s.startsWith('In step 3 the variable is')) ?? '';
    expect(same).toContain(rest.map(([, P]) => `\`${P.TOKEN_ENV}\``).join(' or '));
    expect(same).toContain(rest.map(([, P]) => `\`${P.CLI_TOKEN_ENV}\``).join(' or '));
    expect(same).toContain('sets for Pulumi');
  });

  it('a Pulumi variable is only ever named as one the deploy sets itself', () => {
    for (const [id, P] of K8S_PROVIDERS) {
      const naming = sentences(SECURITY).filter((s) => s.includes(`\`${P.CLI_TOKEN_ENV}\``));
      expect(naming.length, id).toBeGreaterThan(0);
      for (const s of naming) {
        expect(s, `${id}: ${s}`).toMatch(/changes nothing|sets for Pulumi/);
      }
    }
  });
});

describe('no doc tells you to set a token variable the deploy does not read', () => {
  const docs = readdirSync(join(ROOT, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => [`docs/${name}`, read(`docs/${name}`)] as const);

  it.each(K8S_PROVIDERS)('%s: no "export" or "stored as" of the Pulumi variable', (_id, P) => {
    for (const [path, text] of docs) {
      expect(text, path).not.toMatch(new RegExp(`export \`?${P.CLI_TOKEN_ENV}\\b`));
      expect(text, path).not.toMatch(new RegExp(`Stored as \`${P.CLI_TOKEN_ENV}\``));
    }
  });

  it.each(K8S_PROVIDERS)(
    "%s: the provider's own guide, where there is one, names the variable its deploy reads",
    (id, P) => {
      const guide = docs.find(([path]) => path === `docs/deploy-${id}.md`);
      if (!guide) return;
      const prerequisites = guide[1].slice(guide[1].indexOf('## Prerequisites'));
      expect(prerequisites.slice(0, prerequisites.indexOf('\n---'))).toContain(
        `\`${P.TOKEN_ENV}\``,
      );
    },
  );
});
