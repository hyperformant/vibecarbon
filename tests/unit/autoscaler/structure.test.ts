/**
 * Structural pins for the carbon-autoscaler service module graph
 * (src/autoscaler/{proto,config,groups,node-template,service,server,
 * healthcheck}.js).
 *
 * (a) Laziness: `server.js` is the entry point wired into the CA sidecar
 * container — it must never pull the Pulumi IaC runtime into its module
 * graph, even transitively through `../lib/providers/index.js` (whose
 * provider classes DO import `@pulumi/*`, but only inside per-method
 * dynamic imports — see tests/unit/providers/iac-dispatch-laziness.test.ts
 * and tests/unit/iac/converge-cluster-laziness.test.ts, whose exact
 * mechanism this test mirrors). If a future edit turned any of those
 * dynamic imports static, merely importing server.js would pay the full
 * Pulumi SDK load cost on every autoscaler pod start.
 *
 * (b) Neutrality: none of these modules may hardcode a provider name —
 * the whole point of the externalgrpc service is to run identically over
 * whichever provider `getProvider(config.provider, token)` resolves to
 * (config.js/groups.test.ts already establish 'testprov'/'testprov://' as
 * the neutral fixture convention). A literal `hetzner`/`hcloud` token in
 * autoscaler source code would mean some code path silently assumes one
 * specific provider.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@pulumi/pulumi', () => {
  throw new Error('@pulumi/pulumi must not load eagerly');
});
vi.mock('@pulumi/hcloud', () => {
  throw new Error('@pulumi/hcloud must not load eagerly');
});
vi.mock('@pulumi/digitalocean', () => {
  throw new Error('@pulumi/digitalocean must not load eagerly');
});

describe('server.js never loads @pulumi/* eagerly', () => {
  it('importing server.js does not touch @pulumi/*', async () => {
    await expect(import('../../../src/autoscaler/server.js')).resolves.toBeDefined();
  });

  // Self-check: proves the mock is actually armed (not silently bypassed by
  // module caching or a wrong specifier) — without this, the assertion
  // above could pass vacuously even if the mock never fired.
  it("self-check: the mock is armed — importing hetzner.js's program module trips it", async () => {
    const { HetznerProvider } = await import('../../../src/lib/providers/hetzner.js');
    await expect(
      HetznerProvider.getComposeProgram({ projectName: 'p', environment: 'e' }),
    ).rejects.toThrow(/error when mocking a module/);
  });
});

const AUTOSCALER_DIR = join(process.cwd(), 'src', 'autoscaler');
const FORBIDDEN_PROVIDER_TOKEN = /\bhetzner\b|\bhcloud\b/i;

// Strips block comments and line comments so matches inside explanatory
// prose (allowed) don't get confused with matches inside real code tokens
// (forbidden). Order matters: strip block comments first, so a line-comment
// marker that happens to sit inside a block comment doesn't truncate the
// block-comment strip early.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function autoscalerJsFiles(): string[] {
  return readdirSync(AUTOSCALER_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => join(AUTOSCALER_DIR, entry.name));
}

describe('src/autoscaler/*.js is provider-neutral (no hetzner/hcloud in code)', () => {
  it('no autoscaler source file references hetzner/hcloud outside comments', () => {
    const files = autoscalerJsFiles();
    // Sanity: the walk actually found the module set (proto/config/groups/
    // node-template/service/server/healthcheck.js) rather than an empty or
    // wrong directory.
    expect(files.length).toBeGreaterThanOrEqual(7);

    const offenders: Array<{ file: string; match: string }> = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      const match = code.match(FORBIDDEN_PROVIDER_TOKEN);
      if (match) offenders.push({ file, match: match[0] });
    }
    expect(offenders).toEqual([]);
  });

  // Positive control: proves FORBIDDEN_PROVIDER_TOKEN + stripComments
  // actually catch a code-level reference while tolerating the same word
  // in a comment — without this, the assertion above could pass vacuously
  // against a broken regex or a strip that ate too much/too little.
  it('pattern control: catches a code token but ignores the same word in a comment', () => {
    const commentOnly = '// historically Hetzner used an hcloud:// prefix here\nconst x = 1;\n';
    const codeToken = "const prefix = 'hcloud://';\n";
    const blockComment = '/* hcloud is one example provider */\nconst y = 2;\n';

    expect(FORBIDDEN_PROVIDER_TOKEN.test(stripComments(commentOnly))).toBe(false);
    expect(FORBIDDEN_PROVIDER_TOKEN.test(stripComments(codeToken))).toBe(true);
    expect(FORBIDDEN_PROVIDER_TOKEN.test(stripComments(blockComment))).toBe(false);
  });
});
