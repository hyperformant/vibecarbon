import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A compose env deployed on the default size persists no serverType. scale
// must then read the box's size as the compose default (4 GB), never the k8s
// db default (a 2 GB role): reading cpx12 would show a 4 GB box as 2 GB and
// turn `scale -type cpx22` (a no-op) into a full server replacement.

const infos: string[] = [];
const notes: string[] = [];
vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    intro() {},
    note: (msg: string) => notes.push(msg),
    outro() {},
    spinner: () => ({ start() {}, stop() {}, message() {} }),
    log: {
      info: (msg: string) => infos.push(msg),
      warn() {},
      step() {},
      success() {},
      message() {},
      error() {},
    },
  };
});

let projectConfig: Record<string, unknown> = {};
vi.mock('../../../src/lib/project-guard.js', () => ({
  assertInProjectDir: () => projectConfig,
}));
vi.mock('../../../src/lib/cli/intro.js', () => ({ introCommand: () => {} }));
vi.mock('../../../src/lib/project.js', () => ({ repairLegacyEnvQuoting: () => {} }));
vi.mock('../../../src/lib/operator-ip.js', () => ({
  ensureOperatorIpAccess: async () => ({ added: false }),
}));
vi.mock('../../../src/lib/deploy/compose/server-state-sync.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    assertComposeScaleKeepsState: () => {},
    resolveServerStateOptions: async () => ({}),
  };
});

const { run } = await import('../../../src/scale.js');
const { HetznerProvider } = await import('../../../src/lib/providers/hetzner.js');
const { seedCatalog } = await import('../helpers/catalog-fixtures.js');

let restore: () => void;
beforeEach(() => {
  infos.length = 0;
  notes.length = 0;
  restore = seedCatalog(HetznerProvider, '2026-10-22/hetzner');
  vi.spyOn(HetznerProvider, 'promptApiToken').mockResolvedValue('tok' as never);
  // The catalog is already seeded: no network.
  vi.spyOn(HetznerProvider, 'fetchServerTypes').mockResolvedValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  restore();
});

describe('compose scale with no persisted serverType', () => {
  it('shows the compose default as the current type, so -type of the same size is a no-op', async () => {
    projectConfig = {
      projectName: 'proj',
      environments: {
        prod: {
          status: 'deployed',
          provider: 'hetzner',
          deployMode: 'compose',
          region: 'nbg1',
          servers: [{ id: 1, ip: '203.0.113.10' }],
        },
      },
    };
    await run(['prod', '-y', '-type', 'cpx22']);
    expect(notes.join('\n')).toMatch(/Server type\s+\S*cpx22/);
    expect(infos.join('\n')).toMatch(/Already using .*cpx22.*nothing to change/);
  });

  it('an env deployed before the top-level serverType reads the server record, not the new default', async () => {
    projectConfig = {
      projectName: 'proj',
      environments: {
        prod: {
          status: 'deployed',
          provider: 'hetzner',
          deployMode: 'compose',
          region: 'nbg1',
          servers: [{ id: 1, ip: '203.0.113.10', serverType: 'cpx32' }],
        },
      },
    };
    await run(['prod', '-y', '-type', 'cpx32']);
    expect(notes.join('\n')).toMatch(/Server type\s+\S*cpx32/);
    expect(infos.join('\n')).toMatch(/Already using .*cpx32.*nothing to change/);
  });
});
